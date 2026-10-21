import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { closeSync, lstatSync, openSync } from "node:fs";
import type { SubjectState } from "../../core/state.ts";
import { assertSubjectState } from "../../core/validation.ts";
import { changeCoreLifecycle, CoreRevisionConflictError, runSubjectCycle } from "../../core/cycle.ts";
import { assertData, timestamp } from "../../core/guards.ts";
import type { CycleAuthority, CycleInput } from "../../core/cycle.ts";
import type { SubjectAttempt, SubjectBudget, SubjectStore, DialoguePair, TurnCommit } from "../../runtime/subject-store.ts";
import type { LearningAttempt, LearningAttemptDetail, LearningResult, LearningStatus, LearningStore } from "../../runtime/learning-store.ts";
import type { LearningPack } from "../../core/learning.ts";
import { assertLearningPack, gradeAnswers } from "../../core/learning.ts";

const APPLICATION_ID = 0x44535732; // DSW2: separate identity from legacy Dawn and chat databases.
const DB_VERSION = 2;
const LEARNING_DB_VERSION = 3;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_WIRE_BYTES = 64 * 1024;
const MAX_HISTORY_CHARS = 24_000;
const MAX_HISTORY_PAIRS = 8;
const SAFE_CANDIDATES = ["world_belief", "memory_correction", "growth_candidate"] as const;

function exactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`Invalid ${name}`);
  }
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) throw new Error(`Invalid ${name} fields`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`Invalid ${name} field`);
  }
  return value as Record<string, unknown>;
}

function validLimit(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error("Subject call limit must be an integer from 1 to 10000");
  }
}
function safeRevision(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid subject revision");
}
function validRequestId(value: unknown): asserts value is string {
  // Protocol correlation ids deliberately allow more characters than core domain ids.
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid request id");
}
function validUser(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_MESSAGE_CHARS) throw new Error("Invalid user message");
}
function validUsage(value: unknown): asserts value is TurnCommit["usage"] {
  const usage = exactRecord(value, ["modelId", "inputTokens", "outputTokens"], "model usage");
  if (typeof usage.modelId !== "string" || !usage.modelId.trim() || usage.modelId.length > 256 ||
      !Number.isSafeInteger(usage.inputTokens) || (usage.inputTokens as number) < 0 ||
      !Number.isSafeInteger(usage.outputTokens) || (usage.outputTokens as number) < 0) {
    throw new Error("Invalid model usage");
  }
}
function encodeJson(value: unknown, name: string): string {
  assertData(value);
  // Serialize a detached null-prototype copy, so inherited or own toJSON hooks never run.
  const safeCopy = (item: unknown): unknown => {
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) {
      const copy = Object.setPrototypeOf([], null) as unknown[];
      for (let index = 0; index < item.length; index++) {
        copy[index] = safeCopy(Object.getOwnPropertyDescriptor(item, String(index))!.value);
      }
      return copy;
    }
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      copy[key] = safeCopy(Object.getOwnPropertyDescriptor(item, key)!.value);
    }
    return copy;
  };
  const encoded = JSON.stringify(safeCopy(value));
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > MAX_JSON_BYTES) throw new Error(`${name} exceeds JSON size limit`);
  let decoded: unknown;
  try { decoded = JSON.parse(encoded); } catch { throw new Error(`${name} is not valid JSON`); }
  if (!isDeepStrictEqual(value, decoded)) throw new Error(`${name} is not losslessly JSON serializable`);
  return encoded;
}
function decodeJson(value: unknown, name: string): unknown {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_JSON_BYTES) throw new Error(`Invalid ${name} JSON`);
  try { return JSON.parse(value) as unknown; } catch { throw new Error(`Invalid ${name} JSON`); }
}
function encodeSnapshot(state: SubjectState): string {
  assertSubjectState(state);
  return encodeJson(state, "Subject snapshot");
}
function decodeSnapshot(value: unknown): SubjectState {
  const state = decodeJson(value, "subject snapshot");
  assertSubjectState(state);
  return state;
}
function encodeEvent(event: unknown): string { return encodeJson(event, "Subject event"); }
function validateModelCycleAuthority(value: unknown): asserts value is CycleAuthority {
  const authority = exactRecord(value, ["allow", "availableBudget", "stopRequested", "evaluations"], "cycle authority");
  if (!Array.isArray(authority.allow) || authority.allow.some(type => !(SAFE_CANDIDATES as readonly unknown[]).includes(type)) ||
      authority.availableBudget !== 0 || authority.stopRequested !== false ||
      !Array.isArray(authority.evaluations) || authority.evaluations.length !== 0) {
    throw new Error("Model turn cannot perform trusted growth evaluations or unapproved changes");
  }
}

interface ReplayCheckpoint {
  readonly bootstrapJson: string;
  readonly eventJsons: readonly string[];
  readonly state: SubjectState;
  readonly cycleInputs: ReadonlyMap<number, CycleInput>;
}

interface StoredLearningAttempt {
  readonly sequence: number;
  readonly id: string;
  readonly goalId: string;
  readonly phase: "study" | "assessment";
  readonly expectedRevision: number;
  readonly status: "pending" | "completed" | "failed";
  readonly resultJSON: string | null;
  readonly at: string | null;
}

interface StoredAttempt {
  readonly sequence: number;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly user: string;
  readonly status: "pending" | "completed" | "failed";
  readonly reply: string | null;
  readonly model: string | null;
  readonly usage: string | null;
}

/** Durable six-core subject state and the precharged model-turn ledger; no migration or refund path. */
export class SqliteSubjectStore implements SubjectStore, LearningStore {
  readonly #db: DatabaseSync;
  readonly #dbVersion: number;
  #closed = false;
  #checkpoint: ReplayCheckpoint | undefined;

  private constructor(db: DatabaseSync, dbVersion = DB_VERSION) { this.#db = db; this.#dbVersion = dbVersion; }

  /** Explicit, exclusive initialization. The parent directory must already exist. */
  static create(path: string, initial: SubjectState, limit: number, signal: AbortSignal): SqliteSubjectStore {
    return this.#create(path, initial, limit, signal);
  }

  /** Creates an independent v3 learning-enabled subject; no v2 file is upgraded. */
  static createLearning(path: string, initial: SubjectState, limit: number, pack: LearningPack,
    learningLimit: number, signal: AbortSignal): SqliteSubjectStore {
    validLimit(limit);
    if (!Number.isSafeInteger(learningLimit) || learningLimit < 2 || learningLimit > 32 || learningLimit > limit) {
      throw new Error("Learning limit must be an integer from 2 to 32 and no greater than the subject limit");
    }
    assertLearningPack(pack);
    return this.#create(path, initial, limit, signal, { pack, learningLimit });
  }

  static #create(path: string, initial: SubjectState, limit: number, signal: AbortSignal,
    learning?: { readonly pack: LearningPack; readonly learningLimit: number }): SqliteSubjectStore {
    signal.throwIfAborted();
    validLimit(limit);
    assertSubjectState(initial);
    if (initial.revision !== 0) throw new Error("New subject database requires revision zero");
    const snapshot = encodeSnapshot(initial);
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
      db.exec(`
        CREATE TABLE subject (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          revision INTEGER NOT NULL CHECK(revision >= 0),
          snapshot TEXT NOT NULL
        ) STRICT;
        CREATE TABLE bootstrap (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          snapshot TEXT NOT NULL
        ) STRICT;
        CREATE TABLE events (
          revision INTEGER PRIMARY KEY CHECK(revision > 0),
          "eventJSON" TEXT NOT NULL
        ) STRICT;
        CREATE TABLE attempts (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          requestId TEXT NOT NULL UNIQUE,
          expectedRevision INTEGER NOT NULL CHECK(expectedRevision >= 0),
          user TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
          reply TEXT,
          model TEXT,
          usage TEXT,
          CHECK(
            (status IN ('pending', 'failed') AND reply IS NULL AND model IS NULL AND usage IS NULL) OR
            (status = 'completed' AND reply IS NOT NULL AND model IS NOT NULL AND usage IS NOT NULL)
          )
        ) STRICT;
        CREATE TABLE meta (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          "limit" INTEGER NOT NULL CHECK("limit" BETWEEN 1 AND 10000)
        ) STRICT;
        PRAGMA application_id = ${APPLICATION_ID};
      `);
      if (learning) {
        db.exec(`
          CREATE TABLE learning_pack (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), packJSON TEXT NOT NULL) STRICT;
          CREATE TABLE learning_grant (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1), "limit" INTEGER NOT NULL CHECK("limit" BETWEEN 2 AND 32),
            status TEXT NOT NULL CHECK(status IN ('active', 'stopped'))
          ) STRICT;
          CREATE TABLE learning_attempts (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, goalId TEXT NOT NULL,
            phase TEXT NOT NULL CHECK(phase IN ('study', 'assessment')), expectedRevision INTEGER NOT NULL CHECK(expectedRevision >= 0),
            status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')), resultJSON TEXT, at TEXT,
            CHECK((status = 'completed' AND resultJSON IS NOT NULL AND at IS NOT NULL) OR
              (status IN ('pending', 'failed') AND resultJSON IS NULL AND at IS NULL))
          ) STRICT;
          PRAGMA user_version = ${LEARNING_DB_VERSION};
        `);
      } else db.exec(`PRAGMA user_version = ${DB_VERSION};`);
      db.prepare("INSERT INTO subject (singleton, revision, snapshot) VALUES (1, 0, ?)").run(snapshot);
      db.prepare("INSERT INTO bootstrap (singleton, snapshot) VALUES (1, ?)").run(snapshot);
      db.prepare('INSERT INTO meta (singleton, "limit") VALUES (1, ?)').run(limit);
      if (learning) {
        db.prepare("INSERT INTO learning_pack (singleton, packJSON) VALUES (1, ?)").run(encodeJson(learning.pack, "Learning pack"));
        db.prepare('INSERT INTO learning_grant (singleton, "limit", status) VALUES (1, ?, \'active\')').run(learning.learningLimit);
      }
      signal.throwIfAborted();
      db.exec("COMMIT");
      return new SqliteSubjectStore(db, learning ? LEARNING_DB_VERSION : DB_VERSION);
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      db.close();
      // Keep failed initialization visible; never unlink or silently replace it.
      throw error;
    }
  }

  /** Existing matching DSW2 schema v2/v3 only. It never adopts or upgrades another file. */
  static open(path: string, signal: AbortSignal): SqliteSubjectStore {
    signal.throwIfAborted();
    if (!lstatSync(path).isFile()) throw new Error("Subject database must be a regular non-symlink file");
    const db = new DatabaseSync(path);
    try {
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      const app = db.prepare("PRAGMA application_id").get()?.application_id;
      if ((version !== DB_VERSION && version !== LEARNING_DB_VERSION) || app !== APPLICATION_ID) throw new Error("Unsupported subject database identity or schema version; no migration performed");
      db.exec("PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;");
      const store = new SqliteSubjectStore(db, version as number);
      store.#transaction("BEGIN", () => store.#readValidated(), signal);
      return store;
    } catch (error) { db.close(); throw error; }
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("Subject store is closed");
  }

  #transaction<T>(begin: "BEGIN" | "BEGIN IMMEDIATE", work: () => T, signal: AbortSignal): T {
    this.#ensureOpen();
    signal.throwIfAborted();
    this.#db.exec(begin);
    try {
      signal.throwIfAborted();
      const result = work();
      signal.throwIfAborted();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  #metaLimit(): number {
    const row = this.#db.prepare('SELECT "limit" FROM meta WHERE singleton = 1').get();
    if (!row) throw new Error("Missing subject budget metadata");
    validLimit(row.limit);
    return row.limit;
  }

  #learningConfiguration(): { pack: LearningPack; limit: number; status: "active" | "stopped" } | undefined {
    if (this.#dbVersion !== LEARNING_DB_VERSION) return undefined;
    const packRow = this.#db.prepare("SELECT packJSON FROM learning_pack WHERE singleton = 1").get();
    const grant = this.#db.prepare('SELECT "limit", status FROM learning_grant WHERE singleton = 1').get();
    if (!packRow || !grant || typeof packRow.packJSON !== "string" ||
        (grant.status !== "active" && grant.status !== "stopped") || typeof grant.limit !== "number" ||
        !Number.isSafeInteger(grant.limit) || grant.limit < 2 || grant.limit > 32 || grant.limit > this.#metaLimit()) {
      throw new Error("Missing or invalid learning grant/pack");
    }
    const pack = decodeJson(packRow.packJSON, "learning pack");
    assertLearningPack(pack);
    if (encodeJson(pack, "learning pack") !== packRow.packJSON) throw new Error("Non-canonical learning pack");
    return { pack, limit: grant.limit, status: grant.status };
  }

  #storedLearningAttempts(): StoredLearningAttempt[] {
    if (this.#dbVersion !== LEARNING_DB_VERSION) return [];
    return this.#db.prepare(`SELECT sequence, id, goalId, phase, expectedRevision, status, resultJSON, at
      FROM learning_attempts ORDER BY sequence`).all() as unknown as StoredLearningAttempt[];
  }

  #validateLearningAttempts(_sharedLimit: number, currentRevision: number): StoredLearningAttempt[] {
    const rows = this.#storedLearningAttempts();
    const configuration = this.#learningConfiguration();
    if (configuration && rows.length > configuration.limit) throw new Error("Learning attempt budget exceeds its grant");
    if (!configuration) {
      if (rows.length) throw new Error("Learning attempts exist without a learning grant");
      return rows;
    }
    if (rows.filter(row => row.status === "pending").length > 1) throw new Error("Multiple pending learning calls");
    const goals = new Map(configuration.pack.goals.map(goal => [goal.id, goal]));
    const byGoal = new Map<string, StoredLearningAttempt[]>();
    rows.forEach((row, index) => {
      if (!Number.isSafeInteger(row.sequence) || row.sequence !== index + 1 || row.id !== `learning_${row.sequence}` ||
          !goals.has(row.goalId) || (row.phase !== "study" && row.phase !== "assessment") ||
          !Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 0 || row.expectedRevision > currentRevision ||
          !["pending", "completed", "failed"].includes(row.status)) throw new Error("Invalid learning attempt ledger");
      const list = byGoal.get(row.goalId) ?? [];
      list.push(row); byGoal.set(row.goalId, list);
      if (row.status === "completed") {
        const result = decodeJson(row.resultJSON, "learning result");
        this.#validateLearningResult(result, goals.get(row.goalId)!, row.phase);
        if (typeof row.at !== "string") throw new Error("Missing learning completion time");
        // Core timestamp validation occurs while deterministically replaying generated cycles.
        if (row.expectedRevision >= currentRevision) throw new Error("Completed learning attempt has impossible revision");
      } else if (row.resultJSON !== null || row.at !== null) throw new Error("Invalid incomplete learning attempt");
    });
    for (const attempts of byGoal.values()) {
      if (attempts.length > 2 || attempts[0]?.phase !== "study" || attempts[1]?.phase !== undefined && attempts[1].phase !== "assessment") {
        throw new Error("Invalid learning goal attempt order");
      }
      const [study, assessment] = attempts;
      if (assessment && (study!.status !== "completed" || assessment.status === "pending" && study!.status !== "completed")) {
        throw new Error("Assessment attempt without a completed study");
      }
    }
    return rows;
  }

  #validateLearningResult(value: unknown, goal: LearningPack["goals"][number], phase: "study" | "assessment"): asserts value is LearningResult {
    const result = exactRecord(value, ["notes", "answers"], "learning result");
    if (typeof result.notes !== "string" || !Array.isArray(result.answers)) throw new Error("Invalid learning result");
    if (phase === "study") {
      if (!result.notes.trim() || result.notes.length > 4000) throw new Error("Invalid study result");
      for (const item of result.answers) {
        const value = exactRecord(item, ["id", "answer"], "practice answer");
        if (typeof value.id !== "string" || typeof value.answer !== "string" || value.answer.length > 1024) throw new Error("Invalid practice answer");
      }
      gradeAnswers(goal.practice, result.answers);
      return;
    }
    if (result.notes !== "" || result.answers.length > goal.assessment.length) throw new Error("Invalid assessment result");
    const seen = new Set<string>();
    for (const item of result.answers) {
      const answer = exactRecord(item, ["id", "answer"], "learning answer");
      if (typeof answer.id !== "string" || typeof answer.answer !== "string" ||
          answer.answer.length > 1024 || seen.has(answer.id)) throw new Error("Invalid or duplicate learning answer");
      seen.add(answer.id);
    }
    gradeAnswers(goal.assessment, result.answers);
  }

  #learningAuthority(): CycleAuthority {
    return { allow: [], availableBudget: 0, stopRequested: false, evaluations: [] };
  }

  #makeLearningCycles(state: SubjectState, attempt: StoredLearningAttempt,
    result: LearningResult, at: string): CycleInput[] {
    timestamp(at);
    const config = this.#learningConfiguration();
    if (!config) throw new Error("No learning authorization");
    const goal = config.pack.goals.find(item => item.id === attempt.goalId);
    if (!goal) throw new Error("Unknown learning goal");
    this.#validateLearningResult(result, goal, attempt.phase);
    if (state.revision !== attempt.expectedRevision) throw new CoreRevisionConflictError();
    const prefix = attempt.id;
    const readingId = `${prefix}_source`;
    const experiences = attempt.phase === "study" ? [
      { id: readingId, kind: "reading" as const, origin: "document" as const, content: goal.material },
      { id: `${prefix}_notes`, kind: "reflection" as const, origin: "inference" as const, content: result.notes, sourceIds: [readingId] },
      { id: `${prefix}_result`, kind: "activity_result" as const, origin: "observation" as const,
        content: this.#gradeSummary(gradeAnswers(goal.practice, result.answers)), sourceIds: [readingId, `${prefix}_notes`] },
    ] : [
      { id: readingId, kind: "reflection" as const, origin: "inference" as const,
        content: `基于此前已完成的学习笔记开始独立测验：${goal.title}`, sourceIds: [`learning_${this.#studySequence(attempt.goalId)}_notes`] },
      { id: `${prefix}_result`, kind: "activity_result" as const, origin: "observation" as const,
        content: this.#gradeSummary(gradeAnswers(goal.assessment, result.answers)), sourceIds: [readingId] },
    ];
    let revision = state.revision;
    return experiences.map((entry, index) => {
      const cycleId = `${prefix}_cycle_${index + 1}`;
      const experience = {
        id: entry.id, subjectId: state.self.identity.id, scopeId: state.scopeId,
        kind: entry.kind, origin: entry.origin, content: entry.content, topics: [...goal.topics],
        occurredAt: at, recordedAt: at, sourceIds: entry.sourceIds ?? [],
      };
      const activities = attempt.phase === "study" && index === 1 ? [{
        id: `learn_${createHash("sha256").update(goal.id).digest("hex").slice(0, 32)}`, kind: "learn" as const, description: goal.title, topics: [...goal.topics],
        evidenceIds: [experience.id], cost: 0, available: true,
      }] : [];
      const input: CycleInput = { cycleId, expectedRevision: revision, at, experience, appraisal: null, candidates: [], activities };
      revision++;
      return input;
    });
  }

  #studySequence(goalId: string): number {
    const study = this.#db.prepare("SELECT sequence FROM learning_attempts WHERE goalId = ? AND phase = 'study' AND status = 'completed'").get(goalId);
    if (!study || !Number.isSafeInteger(study.sequence)) throw new Error("Assessment requires completed study notes");
    return study.sequence as number;
  }

  #gradeSummary(grade: { correct: number; total: number; passed: boolean }): string {
    return `本轮本地评分：答对 ${grade.correct}/${grade.total}；${grade.passed ? "通过" : "未通过"}。`;
  }

  #learningEventResult(attempt: StoredLearningAttempt, result: LearningResult): { notes: string; grade: ReturnType<typeof gradeAnswers> } {
    const config = this.#learningConfiguration();
    const goal = config?.pack.goals.find(item => item.id === attempt.goalId);
    if (!goal) throw new Error("Unknown learning goal");
    return { notes: attempt.phase === "study" ? result.notes : "", grade: gradeAnswers(attempt.phase === "study" ? goal.practice : goal.assessment, result.answers) };
  }

  #hasLearningCapacity(state: SubjectState, cycles: number): boolean {
    return state.experiences.length + cycles <= 1000 && state.memory.records.length + cycles <= 1000 &&
      state.processedCycleIds.length + cycles <= 1000;
  }

  #learningStatusValue(state: SubjectState): LearningStatus | undefined {
    const config = this.#learningConfiguration();
    if (!config) return undefined;
    const rows = this.#validateLearningAttempts(config.limit, this.#currentRevision());
    const attempts: LearningAttemptDetail[] = rows.map(row => ({
      id: row.id, goalId: row.goalId, phase: row.phase, status: row.status,
      result: row.status === "completed" ? decodeJson(row.resultJSON, "learning result") as LearningResult : null,
    }));
    const failedGoals = new Set(rows.filter(row => row.status === "failed").map(row => row.goalId));
    const completedGoals = new Set(rows.filter(row => row.phase === "assessment" && row.status === "completed" &&
      gradeAnswers(config.pack.goals.find(goal => goal.id === row.goalId)!.assessment,
        (decodeJson(row.resultJSON, "learning result") as LearningResult).answers).passed).map(row => row.goalId));
    const failedAssessmentGoals = new Set(rows.filter(row => row.phase === "assessment" && row.status === "completed" &&
      !gradeAnswers(config.pack.goals.find(goal => goal.id === row.goalId)!.assessment,
        (decodeJson(row.resultJSON, "learning result") as LearningResult).answers).passed).map(row => row.goalId));
    for (const goalId of failedAssessmentGoals) failedGoals.add(goalId);
    const terminal = new Set([...failedGoals, ...completedGoals]).size === config.pack.goals.length;
    const subjectLimit = this.#metaLimit();
    const sharedCount = this.#db.prepare("SELECT (SELECT COUNT(*) FROM attempts) + (SELECT COUNT(*) FROM learning_attempts) AS amount").get()?.amount;
    if (!Number.isSafeInteger(sharedCount)) throw new Error("Invalid shared budget count");
    const hasStudyToResume = rows.some(row => row.phase === "study" && row.status === "completed" &&
      !failedGoals.has(row.goalId) && !completedGoals.has(row.goalId));
    const minimumNextCost = hasStudyToResume ? 1 : 2;
    const exhausted = config.limit - rows.length < minimumNextCost || subjectLimit - (sharedCount as number) < minimumNextCost ||
      !this.#hasLearningCapacity(state, hasStudyToResume ? 2 : 5);
    const status = config.status === "stopped" ? "stopped" : terminal ? "completed" : exhausted ? "exhausted" : "active";
    return { status, pack: structuredClone(config.pack), limit: config.limit, reserved: rows.length, attempts };
  }

  #currentRevision(): number {
    const row = this.#db.prepare("SELECT revision FROM subject WHERE singleton = 1").get();
    if (!row || !Number.isSafeInteger(row.revision)) throw new Error("Missing subject revision");
    return row.revision as number;
  }

  #validateAttempts(limit: number, currentRevision: number): void {
    let expectedSequence = 1;
    const rows = this.#db.prepare(`SELECT sequence, requestId, expectedRevision, user, status, reply, model, usage
      FROM attempts ORDER BY sequence`).iterate() as Iterable<StoredAttempt>;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.sequence) || row.sequence !== expectedSequence++ ||
          !Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 0 || row.expectedRevision > currentRevision ||
          !["pending", "completed", "failed"].includes(row.status)) throw new Error("Invalid subject attempt ledger");
      validRequestId(row.requestId);
      validUser(row.user);
      if (row.status === "completed") {
        if (typeof row.reply !== "string" || !row.reply.trim() || row.reply.length > MAX_MESSAGE_CHARS ||
            typeof row.model !== "string" || !row.model.trim() || row.model.length > 256 || typeof row.usage !== "string") {
          throw new Error("Invalid completed subject attempt");
        }
        const wire = JSON.stringify({ version: 1, requestId: row.requestId, type: "reply", text: row.reply });
        if (Buffer.byteLength(wire, "utf8") > MAX_WIRE_BYTES) throw new Error("Stored reply exceeds protocol size limit");
        const usage = decodeJson(row.usage, "model usage");
        validUsage(usage);
        if (usage.modelId !== row.model) throw new Error("Completed attempt model metadata mismatch");
      } else if (row.reply !== null || row.model !== null || row.usage !== null) {
        throw new Error("Invalid incomplete subject attempt");
      }
    }
    if (expectedSequence - 1 > limit) throw new Error("Subject attempt budget exceeds its recorded limit");
  }

  #readValidated(): SubjectState {
    const subject = this.#db.prepare("SELECT revision, snapshot FROM subject WHERE singleton = 1").get();
    const bootstrap = this.#db.prepare("SELECT snapshot FROM bootstrap WHERE singleton = 1").get();
    const limit = this.#metaLimit();
    if (!subject || !bootstrap || !Number.isSafeInteger(subject.revision) || (subject.revision as number) < 0) {
      throw new Error("Missing or invalid subject bootstrap/snapshot; refusing to reset database");
    }
    const state = decodeSnapshot(subject.snapshot);
    const initial = decodeSnapshot(bootstrap.snapshot);
    if (initial.revision !== 0 || state.revision !== subject.revision ||
        state.self.identity.id !== initial.self.identity.id || state.scopeId !== initial.scopeId ||
        state.updatedAt < initial.updatedAt) throw new Error("Stored subject identity or revision mismatch");

    const eventRows = this.#db.prepare('SELECT revision, "eventJSON" FROM events ORDER BY revision').all() as { revision: number; eventJSON: string }[];
    for (let index = 0; index < eventRows.length; index++) {
      const row = eventRows[index]!;
      if (!Number.isSafeInteger(row.revision) || (this.#dbVersion === DB_VERSION ? row.revision !== index + 1 :
          row.revision <= (index ? eventRows[index - 1]!.revision : 0)) || row.revision > state.revision ||
          typeof row.eventJSON !== "string" || Buffer.byteLength(row.eventJSON, "utf8") > MAX_JSON_BYTES) {
        throw new Error("Invalid subject event revision chain or payload size");
      }
    }

    const checkpoint = this.#dbVersion === DB_VERSION ? this.#checkpoint : undefined;
    const reusableCheckpoint = checkpoint !== undefined && bootstrap.snapshot === checkpoint.bootstrapJson &&
      eventRows.length >= checkpoint.eventJsons.length &&
      checkpoint.eventJsons.every((eventJson, index) => eventRows[index]!.eventJSON === eventJson)
      ? checkpoint : undefined;
    let replay = reusableCheckpoint ? structuredClone(reusableCheckpoint.state) : initial;
    const cycleInputs = reusableCheckpoint
      ? new Map([...reusableCheckpoint.cycleInputs].map(([revision, input]) => [revision, structuredClone(input)] as const))
      : new Map<number, CycleInput>();
    const replayFrom = reusableCheckpoint ? reusableCheckpoint.eventJsons.length : 0;
    const completedLearningEvents = new Set<string>();
    for (let index = replayFrom; index < eventRows.length; index++) {
      const row = eventRows[index]!;
      const event = decodeJson(row.eventJSON, "subject event");
      if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid subject event");
      const type = (event as Record<string, unknown>).type;
      if (type === "lifecycle_changed") {
        const change = exactRecord(event, ["type", "expectedRevision", "lifecycle", "at"], "lifecycle event");
        safeRevision(change.expectedRevision);
        if (change.expectedRevision !== replay.revision || (change.lifecycle !== "awake" && change.lifecycle !== "sleeping") || typeof change.at !== "string") {
          throw new Error("Invalid lifecycle event");
        }
        const next = changeCoreLifecycle(replay, change.expectedRevision, change.lifecycle, change.at);
        if (next.revision !== row.revision) throw new Error("Invalid lifecycle event transition");
        replay = next;
      } else if (type === "cycle_completed") {
        const cycle = exactRecord(event, ["type", "input", "authority"], "cycle event");
        const input = cycle.input as CycleInput;
        validateModelCycleAuthority(cycle.authority);
        const authority = cycle.authority;
        const result = runSubjectCycle(replay, input, authority);
        cycleInputs.set(result.state.revision, input);
        replay = result.state;
      } else if (type === "learning_completed") {
        const learningEvent = exactRecord(event, ["type", "attemptId", "result", "at", "cycles"], "learning completion event");
        const attempt = this.#storedLearningAttempts().find(item => item.id === learningEvent.attemptId);
        if (!attempt || attempt.status !== "completed" || completedLearningEvents.has(attempt.id) ||
            typeof learningEvent.at !== "string" || attempt.at !== learningEvent.at) {
          throw new Error("Learning completion event does not match its private attempt record");
        }
        const privateResult = decodeJson(attempt.resultJSON, "learning result") as LearningResult;
        if (!isDeepStrictEqual(this.#learningEventResult(attempt, privateResult), learningEvent.result)) throw new Error("Learning completion result mismatch");
        const cycles = this.#makeLearningCycles(replay, attempt, privateResult, learningEvent.at);
        if (!Array.isArray(learningEvent.cycles) || learningEvent.cycles.length !== cycles.length || learningEvent.cycles.some((mark, cycleIndex) => {
          const value = exactRecord(mark, ["cycleId", "at"], "learning cycle mark");
          return value.cycleId !== cycles[cycleIndex]!.cycleId || value.at !== cycles[cycleIndex]!.at;
        })) throw new Error("Learning cycle identifiers or times mismatch");
        for (const input of cycles) replay = runSubjectCycle(replay, input, this.#learningAuthority()).state;
        completedLearningEvents.add(attempt.id);
      } else throw new Error("Unknown subject event type");
      if (replay.revision !== row.revision) throw new Error("Subject event revision transition mismatch");
    }
    if ((eventRows.at(-1)?.revision ?? 0) !== state.revision || !isDeepStrictEqual(replay, state)) {
      throw new Error("Subject snapshot and replayed event history mismatch");
    }
    this.#validateAttempts(limit, state.revision);
    const learningAttempts = this.#validateLearningAttempts(limit, state.revision);
    const completedLearning = learningAttempts.filter(attempt => attempt.status === "completed");
    if (completedLearning.length !== completedLearningEvents.size || completedLearning.some(attempt => !completedLearningEvents.has(attempt.id))) {
      throw new Error("Learning attempt ledger has a missing or orphan completion event");
    }
    if (this.#dbVersion === LEARNING_DB_VERSION) {
      const chatPending = this.#db.prepare("SELECT COUNT(*) AS amount FROM attempts WHERE status = 'pending'").get()?.amount;
      if (chatPending && learningAttempts.some(attempt => attempt.status === "pending")) throw new Error("Chat and learning reservations cannot be pending together");
      const chatCount = this.#db.prepare("SELECT COUNT(*) AS amount FROM attempts").get()?.amount;
      if (!Number.isSafeInteger(chatCount) || (chatCount as number) + learningAttempts.length > limit) throw new Error("Shared subject budget exceeded");
    }
    this.#validateCompletedCycles(cycleInputs);
    this.#checkpoint = {
      bootstrapJson: bootstrap.snapshot as string,
      eventJsons: eventRows.map(row => row.eventJSON),
      state: structuredClone(state),
      cycleInputs: new Map([...cycleInputs].map(([revision, input]) => [revision, structuredClone(input)] as const)),
    };
    return state;
  }

  #validateCompletedCycles(cycleInputs: ReadonlyMap<number, CycleInput>): void {
    const rows = this.#db.prepare("SELECT expectedRevision, user, reply FROM attempts WHERE status = 'completed' ORDER BY sequence").all();
    const consumedRevisions = new Set<number>();
    for (const row of rows) {
      if (!Number.isSafeInteger(row.expectedRevision) || typeof row.user !== "string" || typeof row.reply !== "string") {
        throw new Error("Invalid completed turn provenance");
      }
      const userCycle = cycleInputs.get((row.expectedRevision as number) + 1);
      const replyCycle = cycleInputs.get((row.expectedRevision as number) + 2);
      const userRevision = (row.expectedRevision as number) + 1;
      const replyRevision = (row.expectedRevision as number) + 2;
      if (!userCycle || !replyCycle || userCycle.expectedRevision !== row.expectedRevision ||
          replyCycle.expectedRevision !== userRevision ||
          userCycle.experience.kind !== "conversation" || userCycle.experience.origin !== "user_statement" ||
          userCycle.experience.content !== row.user || replyCycle.experience.kind !== "conversation" ||
          replyCycle.experience.origin !== "inference" || replyCycle.experience.content !== row.reply ||
          replyCycle.experience.sourceIds.length !== 1 || replyCycle.experience.sourceIds[0] !== userCycle.experience.id ||
          consumedRevisions.has(userRevision) || consumedRevisions.has(replyRevision)) {
        throw new Error("Completed turn does not match its core cycle events");
      }
      consumedRevisions.add(userRevision);
      consumedRevisions.add(replyRevision);
    }
    if (consumedRevisions.size !== cycleInputs.size) throw new Error("Unmatched subject cycle events");
  }

  async read(signal: AbortSignal): Promise<SubjectState> {
    return this.#transaction("BEGIN", () => this.#readValidated(), signal);
  }

  async changeLifecycle(expectedRevision: number, lifecycle: "awake" | "sleeping", at: string, signal: AbortSignal): Promise<SubjectState> {
    safeRevision(expectedRevision);
    return this.#transaction("BEGIN IMMEDIATE", () => {
      const current = this.#readValidated();
      if (current.revision !== expectedRevision) throw new CoreRevisionConflictError();
      const next = changeCoreLifecycle(current, expectedRevision, lifecycle, at);
      if (next.revision === current.revision) return current;
      const event = encodeEvent({ type: "lifecycle_changed", expectedRevision, lifecycle, at });
      const updated = this.#db.prepare("UPDATE subject SET revision = ?, snapshot = ? WHERE singleton = 1 AND revision = ?")
        .run(next.revision, encodeSnapshot(next), current.revision);
      if (updated.changes !== 1) throw new CoreRevisionConflictError();
      this.#db.prepare('INSERT INTO events (revision, "eventJSON") VALUES (?, ?)').run(next.revision, event);
      return next;
    }, signal);
  }

  async reserve(requestId: string, user: string, expectedRevision: number, signal: AbortSignal): Promise<SubjectAttempt> {
    validRequestId(requestId);
    validUser(user);
    safeRevision(expectedRevision);
    return this.#transaction("BEGIN IMMEDIATE", () => {
      const current = this.#readValidated();
      if (current.revision !== expectedRevision) throw new CoreRevisionConflictError();
      if (current.lifecycle !== "awake") throw new Error("Subject must be awake to reserve a model turn");
      if (this.#db.prepare("SELECT 1 AS found FROM attempts WHERE requestId = ?").get(requestId)) {
        throw new Error("Subject request id has already been used");
      }
      const limit = this.#metaLimit();
      if (this.#dbVersion === LEARNING_DB_VERSION &&
          this.#db.prepare("SELECT 1 AS found FROM learning_attempts WHERE status = 'pending' LIMIT 1").get()) {
        throw new Error("A learning attempt is pending; resolve it before reserving chat");
      }
      const count = this.#dbVersion === LEARNING_DB_VERSION
        ? this.#db.prepare("SELECT (SELECT COUNT(*) FROM attempts) + (SELECT COUNT(*) FROM learning_attempts) AS amount").get()?.amount
        : this.#db.prepare("SELECT COUNT(*) AS amount FROM attempts").get()?.amount;
      if (!Number.isSafeInteger(count) || (count as number) >= limit) throw new Error("Subject call budget exhausted");
      const result = this.#db.prepare(`INSERT INTO attempts (requestId, expectedRevision, user, status)
        VALUES (?, ?, ?, 'pending')`).run(requestId, expectedRevision, user);
      const sequence = Number(result.lastInsertRowid);
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid subject attempt sequence");
      return { requestId, sequence, expectedRevision, user };
    }, signal);
  }

  #matchAttempt(attempt: SubjectAttempt): StoredAttempt {
    const value = exactRecord(attempt, ["requestId", "sequence", "expectedRevision", "user"], "subject attempt");
    validRequestId(value.requestId);
    safeRevision(value.sequence);
    safeRevision(value.expectedRevision);
    validUser(value.user);
    const row = this.#db.prepare(`SELECT sequence, requestId, expectedRevision, user, status, reply, model, usage
      FROM attempts WHERE requestId = ?`).get(value.requestId) as StoredAttempt | undefined;
    if (!row || row.sequence !== value.sequence || row.requestId !== value.requestId ||
        row.expectedRevision !== value.expectedRevision || row.user !== value.user) {
      throw new Error("Subject attempt does not match stored request");
    }
    return row;
  }

  #history(): readonly DialoguePair[] {
    const rows = this.#db.prepare(`SELECT user, reply FROM attempts WHERE status = 'completed'
      ORDER BY sequence DESC LIMIT ?`).all(MAX_HISTORY_PAIRS);
    const newestFirst: DialoguePair[] = [];
    let chars = 0;
    for (const row of rows) {
      if (typeof row.user !== "string" || typeof row.reply !== "string") throw new Error("Invalid completed dialogue history");
      const size = row.user.length + row.reply.length;
      if (chars + size > MAX_HISTORY_CHARS) break;
      newestFirst.push({ user: row.user, assistant: row.reply });
      chars += size;
    }
    return newestFirst.reverse();
  }

  async history(signal: AbortSignal): Promise<readonly DialoguePair[]> {
    return this.#transaction("BEGIN", () => { this.#readValidated(); return this.#history(); }, signal);
  }

  async complete(attempt: SubjectAttempt, commit: TurnCommit, signal: AbortSignal): Promise<SubjectState> {
    assertData(commit);
    const payload = exactRecord(commit, ["reply", "cycles", "usage"], "turn commit");
    const reply = payload.reply;
    const usage = payload.usage;
    if (typeof reply !== "string" || !reply.trim() || reply.length > MAX_MESSAGE_CHARS) throw new Error("Invalid model reply");
    validUsage(usage);
    if (!Array.isArray(payload.cycles) || Object.getPrototypeOf(payload.cycles) !== Array.prototype || payload.cycles.length !== 2 ||
        Reflect.ownKeys(payload.cycles).length !== 3 || !Object.getOwnPropertyDescriptor(payload.cycles, "0") ||
        !Object.getOwnPropertyDescriptor(payload.cycles, "1")) throw new Error("A subject turn requires exactly two core cycles");
    const cycles: { input: CycleInput; authority: CycleAuthority; eventJson: string }[] = [];
    for (const candidate of payload.cycles) {
      const cycle = exactRecord(candidate, ["input", "authority"], "turn cycle");
      const input = cycle.input as CycleInput;
      const authority = cycle.authority as CycleAuthority;
      // runSubjectCycle performs full data/field validation; event encoding adds the durable byte bound.
      cycles.push({ input, authority, eventJson: encodeEvent({ type: "cycle_completed", input, authority }) });
    }

    return this.#transaction("BEGIN IMMEDIATE", () => {
      const storedAttempt = this.#matchAttempt(attempt);
      if (storedAttempt.status !== "pending") throw new Error("Subject attempt is not pending");
      const latest = this.#db.prepare("SELECT MAX(sequence) AS sequence FROM attempts").get()?.sequence;
      if (latest !== attempt.sequence) throw new Error("Stale subject attempt cannot complete");
      const current = this.#readValidated();
      if (current.revision !== storedAttempt.expectedRevision) throw new CoreRevisionConflictError();
      if (current.lifecycle !== "awake") throw new Error("Subject is no longer awake");
      const wire = JSON.stringify({ version: 1, requestId: storedAttempt.requestId, type: "reply", text: reply });
      if (Buffer.byteLength(wire, "utf8") > MAX_WIRE_BYTES) throw new Error("Model reply exceeds protocol wire limit");

      const first = cycles[0]!;
      const last = cycles[1]!;
      if (first.input.experience.kind !== "conversation" || first.input.experience.origin !== "user_statement" ||
          first.input.experience.content !== storedAttempt.user || last.input.experience.kind !== "conversation" ||
          last.input.experience.origin !== "inference" || last.input.experience.content !== reply ||
          last.input.experience.sourceIds.length !== 1 || last.input.experience.sourceIds[0] !== first.input.experience.id) {
        throw new Error("Turn cycles do not preserve user/reply provenance");
      }
      let next = current;
      for (const cycle of cycles) {
        validateModelCycleAuthority(cycle.authority);
        next = runSubjectCycle(next, cycle.input, cycle.authority).state;
      }
      const snapshot = encodeSnapshot(next);
      const changed = this.#db.prepare("UPDATE subject SET revision = ?, snapshot = ? WHERE singleton = 1 AND revision = ?")
        .run(next.revision, snapshot, current.revision);
      if (changed.changes !== 1) throw new CoreRevisionConflictError();
      for (let index = 0; index < cycles.length; index++) {
        this.#db.prepare('INSERT INTO events (revision, "eventJSON") VALUES (?, ?)')
          .run(current.revision + index + 1, cycles[index]!.eventJson);
      }
      const usageJson = encodeJson(payload.usage, "Model usage");
      const completed = this.#db.prepare(`UPDATE attempts SET status = 'completed', reply = ?, model = ?, usage = ?
        WHERE sequence = ? AND status = 'pending'`).run(reply, usage.modelId, usageJson, attempt.sequence);
      if (completed.changes !== 1) throw new Error("Subject attempt completion failed");
      return next;
    }, signal);
  }

  async fail(attempt: SubjectAttempt, signal: AbortSignal): Promise<void> {
    this.#transaction("BEGIN IMMEDIATE", () => {
      this.#readValidated();
      const row = this.#matchAttempt(attempt);
      if (row.status !== "pending") throw new Error("Subject attempt is not pending");
      const result = this.#db.prepare("UPDATE attempts SET status = 'failed' WHERE sequence = ? AND status = 'pending'").run(attempt.sequence);
      if (result.changes !== 1) throw new Error("Subject attempt failure update failed");
    }, signal);
  }

  async learningStatus(signal: AbortSignal): Promise<LearningStatus | undefined> {
    return this.#transaction("BEGIN", () => {
      const current = this.#readValidated();
      return this.#learningStatusValue(current);
    }, signal);
  }

  async reserveLearning(goalId: string, phase: "study" | "assessment", expectedRevision: number, signal: AbortSignal): Promise<LearningAttempt> {
    safeRevision(expectedRevision);
    if (typeof goalId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(goalId) || (phase !== "study" && phase !== "assessment")) {
      throw new Error("Invalid learning attempt request");
    }
    return this.#transaction("BEGIN IMMEDIATE", () => {
      const current = this.#readValidated();
      const config = this.#learningConfiguration();
      if (!config) throw new Error("No explicitly authorized learning pack");
      if (config.status !== "active") throw new Error("Learning authorization is stopped");
      if (current.revision !== expectedRevision) throw new CoreRevisionConflictError();
      if (current.lifecycle !== "awake") throw new Error("Subject must be awake to learn");
      if (this.#db.prepare("SELECT 1 AS found FROM learning_attempts WHERE status = 'pending' LIMIT 1").get()) {
        throw new Error("A learning attempt is already pending; explicitly recover after confirming old runners stopped");
      }
      if (this.#db.prepare("SELECT 1 AS found FROM attempts WHERE status = 'pending' LIMIT 1").get()) {
        throw new Error("A chat attempt is pending; resolve it before reserving learning");
      }
      const goal = config.pack.goals.find(item => item.id === goalId);
      if (!goal) throw new Error("Unknown learning goal");
      const history = this.#storedLearningAttempts().filter(item => item.goalId === goalId);
      if (phase === "study" ? history.length !== 0 : history.length !== 1 || history[0]!.phase !== "study" || history[0]!.status !== "completed") {
        throw new Error("Learning goal phase is invalid or already reserved");
      }
      const learningCount = this.#storedLearningAttempts().length;
      const sharedCount = this.#db.prepare("SELECT (SELECT COUNT(*) FROM attempts) + (SELECT COUNT(*) FROM learning_attempts) AS amount").get()?.amount;
      const minimumCost = phase === "study" ? 2 : 1;
      if (learningCount + minimumCost > config.limit) throw new Error("Learning budget exhausted");
      if (!Number.isSafeInteger(sharedCount) || (sharedCount as number) + minimumCost > this.#metaLimit()) throw new Error("Subject call budget exhausted");
      // Preflight a full episode, not just study: no irreversible orphan notes at 996+ items.
      if (!this.#hasLearningCapacity(current, phase === "study" ? 5 : 2)) throw new Error("Learning subject capacity exhausted");
      const sequence = learningCount + 1;
      const id = `learning_${sequence}`;
      this.#db.prepare(`INSERT INTO learning_attempts (sequence, id, goalId, phase, expectedRevision, status)
        VALUES (?, ?, ?, ?, ?, 'pending')`).run(sequence, id, goalId, phase, expectedRevision);
      return { id, goalId, phase, expectedRevision };
    }, signal);
  }

  #matchLearningAttempt(attempt: LearningAttempt): StoredLearningAttempt {
    const value = exactRecord(attempt, ["id", "goalId", "phase", "expectedRevision"], "learning attempt");
    if (typeof value.id !== "string" || typeof value.goalId !== "string" || (value.phase !== "study" && value.phase !== "assessment")) {
      throw new Error("Invalid learning attempt");
    }
    safeRevision(value.expectedRevision);
    const row = this.#db.prepare(`SELECT sequence, id, goalId, phase, expectedRevision, status, resultJSON, at
      FROM learning_attempts WHERE id = ?`).get(value.id) as unknown as StoredLearningAttempt | undefined;
    if (!row || row.goalId !== value.goalId || row.phase !== value.phase || row.expectedRevision !== value.expectedRevision) {
      throw new Error("Learning attempt does not match stored reservation");
    }
    return row;
  }

  async completeLearning(attempt: LearningAttempt, result: LearningResult, at: string, signal: AbortSignal): Promise<SubjectState> {
    assertData(result);
    timestamp(at);
    return this.#transaction("BEGIN IMMEDIATE", () => {
      const stored = this.#matchLearningAttempt(attempt);
      if (stored.status !== "pending") throw new Error("Learning attempt is not pending");
      const config = this.#learningConfiguration();
      if (!config || config.status !== "active") throw new Error("Learning authorization is stopped");
      const current = this.#readValidated();
      if (current.revision !== stored.expectedRevision || attempt.expectedRevision !== current.revision) throw new CoreRevisionConflictError();
      if (current.lifecycle !== "awake") throw new Error("Subject is no longer awake");
      const goal = config.pack.goals.find(item => item.id === stored.goalId)!;
      this.#validateLearningResult(result, goal, stored.phase);
      const cycles = this.#makeLearningCycles(current, stored, result, at);
      let next = current;
      for (const input of cycles) next = runSubjectCycle(next, input, this.#learningAuthority()).state;
      const snapshot = encodeSnapshot(next);
      const updated = this.#db.prepare("UPDATE subject SET revision = ?, snapshot = ? WHERE singleton = 1 AND revision = ?")
        .run(next.revision, snapshot, current.revision);
      if (updated.changes !== 1) throw new CoreRevisionConflictError();
      const eventResult = this.#learningEventResult(stored, result);
      const eventJSON = encodeEvent({ type: "learning_completed", attemptId: stored.id, result: eventResult, at,
        cycles: cycles.map(cycle => ({ cycleId: cycle.cycleId, at: cycle.at })) });
      this.#db.prepare('INSERT INTO events (revision, "eventJSON") VALUES (?, ?)').run(next.revision, eventJSON);
      const resultJSON = encodeJson(result, "Learning result");
      const completed = this.#db.prepare(`UPDATE learning_attempts SET status = 'completed', resultJSON = ?, at = ?
        WHERE id = ? AND status = 'pending'`).run(resultJSON, at, stored.id);
      if (completed.changes !== 1) throw new Error("Learning attempt completion failed");
      return next;
    }, signal);
  }

  async failLearning(attempt: LearningAttempt, signal: AbortSignal): Promise<void> {
    this.#transaction("BEGIN IMMEDIATE", () => {
      this.#readValidated();
      const stored = this.#matchLearningAttempt(attempt);
      if (stored.status !== "pending") throw new Error("Learning attempt is not pending");
      const result = this.#db.prepare("UPDATE learning_attempts SET status = 'failed' WHERE id = ? AND status = 'pending'").run(stored.id);
      if (result.changes !== 1) throw new Error("Learning failure update failed");
    }, signal);
  }

  async stopLearning(signal: AbortSignal): Promise<void> {
    this.#transaction("BEGIN IMMEDIATE", () => {
      this.#readValidated();
      const config = this.#learningConfiguration();
      if (!config) throw new Error("No explicitly authorized learning pack");
      // Persisted grant status is the commit fence, including terminal goals.
      this.#db.prepare("UPDATE learning_grant SET status = 'stopped' WHERE singleton = 1").run();
    }, signal);
  }

  async recoverLearning(signal: AbortSignal): Promise<void> {
    this.#transaction("BEGIN IMMEDIATE", () => {
      this.#readValidated();
      if (!this.#learningConfiguration()) throw new Error("No explicitly authorized learning pack");
      this.#db.prepare("UPDATE learning_attempts SET status = 'failed' WHERE status = 'pending'").run();
      // Explicit v3 recovery requires all old readers/runners/services to be stopped.
      // A crashed dialogue call must not permanently prevent this same subject from learning.
      this.#db.prepare("UPDATE attempts SET status = 'failed' WHERE status = 'pending'").run();
    }, signal);
  }

  async budget(signal: AbortSignal): Promise<SubjectBudget> {
    return this.#transaction("BEGIN", () => {
      const current = this.#readValidated();
      const limit = this.#metaLimit();
      const rows = this.#db.prepare("SELECT status, COUNT(*) AS amount FROM attempts GROUP BY status").all();
      const counts = { completed: 0, failed: 0, pending: 0 };
      for (const row of rows) {
        if (typeof row.status !== "string" || !Object.hasOwn(counts, row.status) || !Number.isSafeInteger(row.amount)) {
          throw new Error("Invalid subject budget records");
        }
        counts[row.status as keyof typeof counts] = row.amount as number;
      }
      if (this.#dbVersion === LEARNING_DB_VERSION) {
        const learningRows = this.#db.prepare("SELECT status, COUNT(*) AS amount FROM learning_attempts GROUP BY status").all();
        for (const row of learningRows) {
          if (typeof row.status !== "string" || !Object.hasOwn(counts, row.status) || !Number.isSafeInteger(row.amount)) {
            throw new Error("Invalid learning budget records");
          }
          counts[row.status as keyof typeof counts] += row.amount as number;
        }
      }
      const reserved = counts.completed + counts.failed + counts.pending;
      if (!Number.isSafeInteger(reserved) || reserved > limit) throw new Error("Invalid subject budget totals");
      // Keep `current` read in this transaction so a corrupt snapshot never yields plausible budget data.
      void current;
      return { limit, reserved, ...counts };
    }, signal);
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }
}
