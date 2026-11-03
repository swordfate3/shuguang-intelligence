import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertData, id, integer, object, timestamp } from "../../core/guards.ts";
import { assertResearchPlan, assertResearchReceipt, type ResearchGoal, type ResearchPlan, type ResearchReceipt } from "../../core/research.ts";
import { gradeAnswers } from "../../core/learning.ts";
import type { CycleInput } from "../../core/cycle.ts";
import type { SubjectState } from "../../core/state.ts";
import type { LearningResult } from "../../runtime/learning-store.ts";
import type { ResearchAttempt, ResearchRunState, ResearchStatus, ResearchTaskSummary } from "../../runtime/research-store.ts";

// No transaction ownership here: SqliteSubjectStore commits control + core together.
const SCHEMA = `
CREATE TABLE research_runs (runId TEXT PRIMARY KEY, dataJSON TEXT NOT NULL) STRICT;
CREATE TABLE research_tasks (taskId TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES research_runs(runId), dataJSON TEXT NOT NULL) STRICT;
CREATE TABLE research_receipts (receiptId TEXT PRIMARY KEY, taskId TEXT NOT NULL UNIQUE REFERENCES research_tasks(taskId), dataJSON TEXT NOT NULL) STRICT;
CREATE TABLE research_model_attempts (id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES research_runs(runId), dataJSON TEXT NOT NULL) STRICT;
CREATE TABLE research_events (sequence INTEGER PRIMARY KEY CHECK(sequence > 0), eventJSON TEXT NOT NULL) STRICT;
`;
export function researchJSON(value: unknown): string {
  assertData(value);
  const copy = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return Object.assign(Object.setPrototypeOf([], null), v.map(copy));
    const out = Object.create(null) as Record<string, unknown>;
    for (const k of Object.keys(v).sort()) out[k] = copy(Object.getOwnPropertyDescriptor(v, k)!.value);
    return out;
  };
  return JSON.stringify(copy(value));
}
const hash = (v: unknown): string => createHash("sha256").update(researchJSON(v)).digest("hex");
export function researchId(...parts: unknown[]): string { return `research_${hash(parts)}`; }
export interface ResearchRun {
  plan: ResearchPlan; bindingId: string; status: ResearchRunState; revision: number; fence: number;
}
export type ResearchTask = { -readonly [K in keyof ResearchTaskSummary]: ResearchTaskSummary[K] } & { claimAt: string | null };
export interface ResearchModelAttempt {
  attempt: ResearchAttempt; status: "pending" | "completed" | "failed" | "unknown";
  result: LearningResult | null; at: string | null; reservedAt: string;
}
export interface ResearchLedger {
  runs: Map<string, ResearchRun>; tasks: Map<string, ResearchTask>;
  receipts: Map<string, ResearchReceipt>; attempts: Map<string, ResearchModelAttempt>;
}
type Command =
  | { type: "start"; plan: ResearchPlan; bindingId: string; at: string }
  | { type: "queue"; runId: string; goalId: string; at: string }
  | { type: "claim"; taskId: string; bindingId: string; revision: number; at: string }
  | { type: "submit"; receipt: ResearchReceipt; bindingId: string; at: string }
  | { type: "reserve"; attempt: ResearchAttempt; at: string }
  | { type: "complete"; id: string; result: LearningResult; at: string }
  | { type: "fail"; id: string; at: string }
  | { type: "fence"; runId: string; status: "paused" | "paused_restart" | "stopped" | "exhausted"; at: string }
  | { type: "resume"; runId: string; bindingId: string; at: string }
  | { type: "terminal"; runId: string; status: "completed" | "exhausted"; at: string };
function equal(a: unknown, b: unknown): void {
  if (!isDeepStrictEqual(a, b)) throw new Error("Research ledger integrity mismatch");
}
export function goalFor(l: ResearchLedger, taskId: string): ResearchGoal {
  const task = l.tasks.get(taskId); const run = task && l.runs.get(task.runId);
  const goal = run?.plan.goals.find(g => g.id === task!.goalId);
  if (!goal) throw new Error("Unknown research goal"); return goal;
}
export function runTasks(l: ResearchLedger, runId: string): ResearchTask[] { return [...l.tasks.values()].filter(t => t.runId === runId); }
export function runAttempts(l: ResearchLedger, runId: string): ResearchModelAttempt[] { return [...l.attempts.values()].filter(a => a.attempt.runId === runId); }
export function taskAttempts(l: ResearchLedger, taskId: string): ResearchModelAttempt[] { return [...l.attempts.values()].filter(a => a.attempt.taskId === taskId); }
export function receiptFor(l: ResearchLedger, taskId: string): ResearchReceipt | undefined { return [...l.receipts.values()].find(r => r.taskId === taskId); }
export function safeTask(t: ResearchTask): ResearchTaskSummary {
  return { runId: t.runId, taskId: t.taskId, goalId: t.goalId, revision: t.revision, capability: t.capability, status: t.status };
}
export function researchStatusValue(l: ResearchLedger, runId: string): ResearchStatus {
  const r = l.runs.get(runId); if (!r) throw new Error("Unknown research run");
  const tasks = runTasks(l, runId); const attempts = runAttempts(l, runId);
  const assessments = attempts.filter(a => a.status === "completed" && a.attempt.phase === "assessment");
  const passed = assessments.filter(a => gradeAnswers(goalFor(l, a.attempt.taskId).assessment, a.result!.answers).passed).length;
  const allGoalsPassed = passed === r.plan.goals.length;
  const failed = tasks.some(t => t.status === "failed" || t.status === "unknown") || assessments.some(a => !gradeAnswers(goalFor(l, a.attempt.taskId).assessment, a.result!.answers).passed);
  return { runId, status: r.status, revision: r.revision, pendingModel: attempts.some(a => a.status === "pending"), fence: r.fence,
    searchReserved: tasks.filter(t => t.claimAt !== null).length, modelReserved: attempts.length,
    goals: r.plan.goals.map(g => {
      const t = tasks.find(t => t.goalId === g.id); const aa = t ? taskAttempts(l, t.taskId) : [];
      const assessment = aa.find(a => a.attempt.phase === "assessment" && a.status === "completed");
      const grade = assessment ? gradeAnswers(g.assessment, assessment.result!.answers) : null;
      const stage = t?.status === "accepted" && aa.length ? aa.at(-1)!.attempt.phase : t?.status ?? "unstarted";
      return { goalId: g.id, stage, grade, verification: grade ? grade.passed ? "passed" : "failed" : t && ["failed", "unknown"].includes(t.status) ? "failed" : "verification_pending" };
    }), searchesReserved: tasks.filter(t => t.claimAt !== null).length,
    modelCallsReserved: attempts.length, maxSearches: r.plan.maxSearches, maxModelCalls: r.plan.maxModelCalls,
    completedGoals: tasks.filter(t => t.status === "completed").length, totalGoals: r.plan.goals.length,
    allGoalsPassed, verification: allGoalsPassed ? "passed" : failed ? "failed" : "verification_pending", tasks: tasks.map(safeTask) };
}
export function validateResearchResult(goal: ResearchGoal, phase: ResearchAttempt["phase"], value: unknown): asserts value is LearningResult {
  assertData(value); const r = object(value, ["notes", "answers"]);
  if (typeof r.notes !== "string" || (phase === "study" ? !r.notes.trim() || r.notes.length > 4000 : r.notes !== "")) throw new Error("Invalid research notes");
  gradeAnswers(phase === "study" ? goal.practice : goal.assessment, r.answers as LearningResult["answers"]);
}
function active(l: ResearchLedger, runId: string, at: string, bindingId?: string): ResearchRun {
  const r = l.runs.get(runId);
  if (!r || r.status !== "active" || at >= r.plan.expiresAt || bindingId !== undefined && r.bindingId !== bindingId) throw new Error("Research run inactive, expired or binding mismatch");
  return r;
}
function reduce(l: ResearchLedger, raw: unknown): void {
  assertData(raw); const c = raw as Command; timestamp(c.at);
  if (c.type === "start") {
    object(c, ["type", "plan", "bindingId", "at"]); assertResearchPlan(c.plan); id(c.bindingId);
    if (l.runs.has(c.plan.runId) || l.runs.size >= 64 || c.plan.expiresAt <= c.at) throw new Error("Invalid research start");
    l.runs.set(c.plan.runId, { plan: c.plan, bindingId: c.bindingId, status: "active", revision: 0, fence: 0 }); return;
  }
  if (c.type === "queue") {
    object(c, ["type", "runId", "goalId", "at"]); const r = active(l, c.runId, c.at);
    const tasks = runTasks(l, c.runId);
    if (!r.plan.goals.some(g => g.id === c.goalId) || tasks.some(t => t.goalId === c.goalId || ["queued", "claimed", "accepted"].includes(t.status)) || tasks.length >= r.plan.maxSearches) throw new Error("Invalid research queue");
    const taskId = researchId(c.runId, c.goalId);
    l.tasks.set(taskId, { runId: c.runId, taskId, goalId: c.goalId, revision: 0, capability: "web.search", status: "queued", claimAt: null }); r.revision++; return;
  }
  if (c.type === "claim") {
    object(c, ["type", "taskId", "bindingId", "revision", "at"]); integer(c.revision);
    const t = l.tasks.get(c.taskId); if (!t || t.status !== "queued" || t.revision !== c.revision || [...l.tasks.values()].some(other => other.status === "claimed")) throw new Error("Research claim conflict; never re-execute a historical claim or overlap searches");
    const r = active(l, t.runId, c.at, c.bindingId);
    t.status = "claimed"; t.claimAt = c.at; t.revision++; r.revision++; return;
  }
  if (c.type === "submit") {
    object(c, ["type", "receipt", "bindingId", "at"]); assertResearchReceipt(c.receipt);
    const t = l.tasks.get(c.receipt.taskId); if (!t || t.status !== "claimed" || l.receipts.has(c.receipt.receiptId) || receiptFor(l, t.taskId)) throw new Error("Research receipt conflict");
    const r = active(l, t.runId, c.at, c.bindingId);
    if (c.receipt.retrievedAt < t.claimAt! || c.receipt.retrievedAt > c.at) throw new Error("Invalid research receipt time");
    l.receipts.set(c.receipt.receiptId, c.receipt); t.status = c.receipt.results.length ? "accepted" : "failed"; t.revision++; r.revision++; return;
  }
  if (c.type === "reserve") {
    object(c, ["type", "attempt", "at"]);
    const a = c.attempt; object(a, ["id", "runId", "taskId", "goalId", "phase", "expectedRevision", "bindingId", "fence"]);
    integer(a.expectedRevision); integer(a.fence); id(a.id);
    const r = active(l, a.runId, c.at, a.bindingId);
    const receipt = receiptFor(l, a.taskId); if (!receipt || receipt.retrievedAt > c.at) throw new Error("Invalid research reservation time");
    const t = l.tasks.get(a.taskId); const prev = taskAttempts(l, a.taskId);
    if (!t || t.status !== "accepted" || t.goalId !== a.goalId || t.runId !== a.runId || r.fence !== a.fence ||
      l.attempts.has(a.id) || a.id !== researchId(a.taskId, a.phase) || [...l.attempts.values()].some(p => p.status === "pending") ||
      runAttempts(l, a.runId).length >= r.plan.maxModelCalls ||
      (a.phase === "study" ? prev.length !== 0 : a.phase !== "assessment" || prev.length !== 1 || prev[0]!.status !== "completed" || !goalFor(l, t.taskId).assessment.length)) throw new Error("Invalid research reservation");
    l.attempts.set(a.id, { attempt: a, status: "pending", result: null, at: null, reservedAt: c.at }); r.revision++; return;
  }
  if (c.type === "complete" || c.type === "fail") {
    object(c, c.type === "complete" ? ["type", "id", "result", "at"] : ["type", "id", "at"]);
    const a = l.attempts.get(c.id); if (!a || a.status !== "pending") throw new Error("Research attempt is not pending");
    const r = c.type === "complete" ? active(l, a.attempt.runId, c.at, a.attempt.bindingId) : l.runs.get(a.attempt.runId)!;
    if (c.at < a.reservedAt || a.attempt.fence !== r.fence) throw new Error("Research attempt fenced");
    const t = l.tasks.get(a.attempt.taskId)!;
    if (c.type === "complete") {
      const goal = goalFor(l, t.taskId); validateResearchResult(goal, a.attempt.phase, c.result);
      a.status = "completed"; a.result = c.result; a.at = c.at;
      if (a.attempt.phase === "assessment" || !goal.assessment.length) t.status = "completed";
    } else { a.status = "failed"; t.status = "failed"; }
    t.revision++; r.revision++; return;
  }
  if (c.type === "fence") {
    object(c, ["type", "runId", "status", "at"]); const r = l.runs.get(c.runId);
    if (!r || !["active", "paused", "paused_restart"].includes(r.status) || !["paused", "paused_restart", "stopped", "exhausted"].includes(c.status)) throw new Error("Invalid research fence");
    r.status = c.status; r.fence++; r.revision++;
    for (const t of runTasks(l, c.runId)) {
      if (t.status === "claimed") { t.status = "unknown"; t.revision++; }
      else if (c.status === "exhausted" && ["queued", "accepted"].includes(t.status)) { t.status = "failed"; t.revision++; }
    }
    for (const a of runAttempts(l, c.runId)) if (a.status === "pending") {
      a.status = "unknown"; const t = l.tasks.get(a.attempt.taskId)!; t.status = "unknown"; t.revision++;
    }
    return;
  }
  if (c.type === "resume") {
    object(c, ["type", "runId", "bindingId", "at"]); id(c.bindingId); const r = l.runs.get(c.runId);
    if (!r || !["paused", "paused_restart"].includes(r.status) || c.at >= r.plan.expiresAt) throw new Error("Research run cannot resume");
    r.bindingId = c.bindingId; r.status = "active"; r.revision++; r.fence++; return;
  }
  if (c.type === "terminal") {
    object(c, ["type", "runId", "status", "at"]); const r = l.runs.get(c.runId);
    if (!r || r.status !== "active" || !["completed", "exhausted"].includes(c.status) || runTasks(l, c.runId).some(t => ["queued", "claimed", "accepted"].includes(t.status))) throw new Error("Invalid research terminal state");
    if (c.status === "completed" && runTasks(l, c.runId).length !== r.plan.goals.length) throw new Error("Unfinished research goals");
    r.status = c.status; r.revision++; return;
  }
  throw new Error("Unknown research event");
}
export class SqliteResearchLedger {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) { this.#db = db; }
  static create(db: DatabaseSync): void { db.exec(SCHEMA); }
  validate(): ResearchLedger {
    const normalized = (s: string): string => s.replace(/\s+/g, " ").trim();
    for (const sql of SCHEMA.split(";").filter(s => s.trim())) {
      const name = /CREATE TABLE ([a-z_]+)/.exec(sql)![1]!;
      const row = this.#db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
      if (!row || typeof row.sql !== "string" || normalized(row.sql) !== normalized(sql)) throw new Error("Invalid research schema");
    }
    if (this.#db.prepare("PRAGMA foreign_key_check").get()) throw new Error("Invalid research foreign key");
    const l: ResearchLedger = { runs: new Map(), tasks: new Map(), receipts: new Map(), attempts: new Map() };
    const rows = this.#db.prepare("SELECT sequence,eventJSON FROM research_events ORDER BY sequence").all();
    if (rows.length > 8192) throw new Error("Research audit capacity exceeded");
    let bytes = 0;
    rows.forEach((row, i) => {
      if (row.sequence !== i + 1 || typeof row.eventJSON !== "string" || Buffer.byteLength(row.eventJSON) > 128 * 1024) throw new Error("Invalid research audit");
      bytes += Buffer.byteLength(row.eventJSON);
      const c: unknown = JSON.parse(row.eventJSON); equal(researchJSON(c), row.eventJSON); reduce(l, c);
    });
    if (bytes > 16 * 1024 * 1024) throw new Error("Research audit byte capacity exceeded");
    for (const [table, key, values] of this.#tables(l)) {
      const stored = this.#db.prepare(`SELECT * FROM ${table}`).all();
      equal(stored.length, values.length);
      const byId = new Map(values.map(v => [v[key], v]));
      for (const row of stored) equal({ ...row }, byId.get(row[key] as string));
    }
    return l;
  }
  #tables(l: ResearchLedger): [string, string, Record<string, string>[]][] {
    return [
      ["research_runs", "runId", [...l.runs].map(([runId, r]) => ({ runId, dataJSON: researchJSON(r) }))],
      ["research_tasks", "taskId", [...l.tasks].map(([taskId, t]) => ({ taskId, runId: t.runId, dataJSON: researchJSON(t) }))],
      ["research_receipts", "receiptId", [...l.receipts].map(([receiptId, r]) => ({ receiptId, taskId: r.taskId, dataJSON: researchJSON(r) }))],
      ["research_model_attempts", "id", [...l.attempts].map(([id, a]) => ({ id, runId: a.attempt.runId, dataJSON: researchJSON(a) }))],
    ];
  }
  apply(l: ResearchLedger, c: Command): void {
    const encoded = researchJSON(c);
    const count = this.#db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(eventJSON AS BLOB))),0) AS bytes FROM research_events").get()!;
    // Leave headroom for all 64 runs to pause/stop even when normal audit capacity is reached.
    const control = c.type === "fence" || c.type === "fail" || c.type === "terminal";
    if ((!control && ((count.n as number) >= 8000 || (count.bytes as number) + Buffer.byteLength(encoded) > 15 * 1024 * 1024)) || (count.n as number) >= 8192 || (count.bytes as number) + Buffer.byteLength(encoded) > 16 * 1024 * 1024 || Buffer.byteLength(encoded) > 128 * 1024) throw new Error("Research audit capacity exceeded");
    reduce(l, JSON.parse(encoded));
    for (const [table, key, values] of this.#tables(l)) for (const row of values) {
      const keys = Object.keys(row);
      this.#db.prepare(`INSERT INTO ${table}(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")}) ON CONFLICT(${key}) DO UPDATE SET dataJSON=excluded.dataJSON`).run(...keys.map(k => row[k]!));
    }
    this.#db.prepare("INSERT INTO research_events(sequence,eventJSON) VALUES (?,?)").run((count.n as number) + 1, encoded);
  }
  /** Reconstruct trusted source, notes and local-score inputs; never accept external CycleInput/sourceIds. */
  cycles(l: ResearchLedger, state: SubjectState, stored: ResearchModelAttempt): CycleInput[] {
    const a = stored.attempt; const goal = goalFor(l, a.taskId); const result = stored.result; const at = stored.at;
    if (stored.status !== "completed" || !result || !at || state.revision !== a.expectedRevision || state.lifecycle !== "awake") throw new Error("Invalid research completion replay");
    validateResearchResult(goal, a.phase, result); timestamp(at);
    const entries: { id: string; kind: "reading" | "reflection" | "activity_result"; origin: "document" | "inference" | "observation"; content: string; sourceIds: string[] }[] = [];
    if (a.phase === "study") {
      const receipt = receiptFor(l, a.taskId); if (!receipt) throw new Error("Research source receipt missing");
      const sources = new Set<string>();
      for (const r of receipt.results) {
        // The same page must not acquire a fresh independent evidence root per task/retrieval.
        // No URL is fetched here. Origins and changed excerpts retain a dependency on the first page root.
        const page = new URL(r.url); page.hash = "";
        const rootId = researchId(state.self.identity.id, state.scopeId, "page", page.href);
        const origin = r.origin === "document" ? "document" as const : "inference" as const;
        const root = state.experiences.find(e => e.id === rootId) ?? entries.find(e => e.id === rootId);
        if (!root) {
          entries.push({ id: rootId, kind: "reading", origin, content: r.text, sourceIds: [] });
          sources.add(rootId);
        } else if (root.content === r.text && root.origin === origin) sources.add(rootId);
        else {
          const excerptId = researchId(rootId, r.text, origin);
          if (!state.experiences.some(e => e.id === excerptId) && !entries.some(e => e.id === excerptId)) {
            entries.push({ id: excerptId, kind: "reading", origin, content: r.text, sourceIds: [rootId] });
          }
          sources.add(excerptId);
        }
      }
      entries.push({ id: researchId(a.id, "notes"), kind: "reflection", origin: "inference", content: result.notes, sourceIds: [...sources] });
    }
    const grade = gradeAnswers(a.phase === "study" ? goal.practice : goal.assessment, result.answers);
    const study = taskAttempts(l, a.taskId).find(p => p.attempt.phase === "study")!;
    entries.push({ id: researchId(a.id, "score"), kind: "activity_result", origin: "observation", content: `本轮本地评分：答对 ${grade.correct}/${grade.total}；${grade.passed ? "通过" : "未通过"}。`, sourceIds: [researchId(study.attempt.id, "notes")] });
    return entries.map((e, index) => ({ cycleId: researchId(a.id, "cycle", index), expectedRevision: state.revision + index, at,
      experience: { ...e, subjectId: state.self.identity.id, scopeId: state.scopeId, topics: [...goal.topics], occurredAt: at, recordedAt: at }, appraisal: null, candidates: [], activities: [] }));
  }
}
