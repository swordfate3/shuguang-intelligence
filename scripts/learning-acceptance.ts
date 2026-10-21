import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAICompatibleModel } from "../packages/dawn/src/adapters/models/openai-compatible.ts";
import { SqliteSubjectStore } from "../packages/dawn/src/adapters/storage/sqlite-subject.ts";
import { createInitialState } from "../packages/dawn/src/core/state.ts";
import { gradeAnswers, parseLearningPack, type LearningGoal } from "../packages/dawn/src/core/learning.ts";
import { runAutonomousLearning } from "../packages/dawn/src/runtime/learning-runner.ts";
import type { LearningAttemptDetail } from "../packages/dawn/src/runtime/learning-store.ts";
import { APP_VERSION } from "../packages/dawn/src/runtime/version.ts";

const DEADLINE_MS = 30_000;
const SYNTHETIC_API_KEY = "synthetic-offline-token-not-a-credential";
const FAILED = "Offline learning acceptance failed.";
const AT = "2026-10-21T00:00:00.000Z";

/** Fault injection for regression tests only. No endpoint, credential or model injection. */
export interface LearningAcceptanceTestOptions {
  readonly temporaryRoot?: string;
  readonly failFakeCall?: number;
  readonly abortFakeCall?: number;
  readonly signal?: AbortSignal;
}

interface CallRecord {
  readonly goalId: string;
  readonly phase: "study" | "assessment";
  readonly projection: Record<string, unknown>;
}
interface CheckRecord { readonly name: string; readonly stage: string; readonly status: "passed"; readonly count: number }
interface StageRecord { readonly stage: string; readonly status: "passed" }

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 64 * 1024) throw new Error(FAILED);
    chunks.push(bytes);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
  response.end(JSON.stringify(value));
}

/** Check parsed data fields, not the legitimate output-schema word 'answer' in SYSTEM. */
function hasPrivateField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPrivateField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    ["answer", "answers", "answerKey", "answer_key", "privateScore"].includes(key) || hasPrivateField(child));
}

function answersFromNotes(goal: LearningGoal, notes: string): string {
  const matched = goal.id === "signal" ? /橙灯对应动作\s*(MOVE)/u.exec(notes) : /VELA\s*代表编号\s*(29)/u.exec(notes);
  assert.ok(matched, "synthetic assessment derives its answer from the submitted notes");
  return matched[1]!;
}

async function listen(server: Server, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  await new Promise<void>((done, reject) => {
    const stop = () => { reject(new Error(FAILED)); };
    const failed = () => { signal.removeEventListener("abort", stop); reject(new Error(FAILED)); };
    signal.addEventListener("abort", stop, { once: true });
    server.once("error", failed);
    server.listen({ port: 0, host: "127.0.0.1", signal }, () => {
      signal.removeEventListener("abort", stop);
      server.off("error", failed);
      done();
    });
  });
  signal.throwIfAborted();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((done, reject) => {
        server.close(error => error ? reject(new Error(FAILED)) : done());
        server.closeAllConnections();
      }),
      new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error(FAILED)), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Only temporary v3 data and an in-process loopback fake model, even when environment credentials exist. */
export async function runLearningAcceptance(options: LearningAcceptanceTestOptions = {}): Promise<object> {
  for (const value of [options.failFakeCall, options.abortFakeCall]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 4)) throw new Error(FAILED);
  }
  if (options.failFakeCall !== undefined && options.abortFakeCall !== undefined) throw new Error(FAILED);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const checks: CheckRecord[] = [];
  const stages: StageRecord[] = [];
  const calls: CallRecord[] = [];
  const notes = new Map<string, string>();
  const check = (name: string, stage: string, count: number) => checks.push({ name, stage, status: "passed", count });
  const stage = (name: string) => stages.push({ stage: name, status: "passed" });
  let store: SqliteSubjectStore | undefined;
  let server: Server | undefined;
  let dir: string | undefined;
  let summary: object | undefined;
  let failed = false;
  let cleanupFailed = false;
  try {
    signal.throwIfAborted();
    const pack = parseLearningPack(readFileSync(new URL("../config/learning-pack.example.json", import.meta.url), "utf8"));
    assert.equal(pack.goals.length, 2);
    dir = mkdtempSync(join(options.temporaryRoot ?? tmpdir(), "shuguang-learning-offline-"));
    const db = join(dir, "subject.sqlite");
    store = SqliteSubjectStore.createLearning(db, createInitialState("offline_fixture", "Synthetic subject", AT), 4, pack, 4, signal);
    const awake = await store.changeLifecycle(0, "awake", AT, signal);
    assert.equal(awake.revision, 1);
    assert.equal((await store.learningStatus(signal))?.status, "active");
    check("v3-authorization-and-explicit-wake", "setup", 2);
    stage("setup");

    server = createServer((request, response) => {
      void (async () => {
        try {
          assert.equal(request.method, "POST");
          assert.equal(request.url, "/v1/chat/completions");
          assert.equal(request.headers.authorization, `Bearer ${SYNTHETIC_API_KEY}`);
          const body = await readBody(request) as {
            model: string; stream: boolean; max_tokens: number; messages: { role: string; content: string }[];
          };
          assert.equal(body.model, "synthetic-offline-model");
          assert.equal(body.stream, false);
          assert.equal(body.max_tokens, 1024);
          assert.deepEqual(body.messages.map(message => message.role), ["system", "user"]);
          const input = JSON.parse(body.messages[1]!.content) as {
            phase: "study" | "assessment"; goal: Record<string, unknown>; untrustedLearningData: boolean;
          };
          assert.equal(input.untrustedLearningData, true);
          assert.ok(input.phase === "study" || input.phase === "assessment");
          const goal = pack.goals.find(goal => goal.title === input.goal.title);
          assert.ok(goal);
          assert.equal(hasPrivateField(input), false);
          calls.push({ goalId: goal.id, phase: input.phase, projection: structuredClone(input.goal) });
          assert.ok(calls.length <= 4);
          if (input.phase === "study") {
            assert.deepEqual(Object.keys(input.goal).sort(), ["title", "topics", "material", "practice"].sort());
            assert.equal(input.goal.material, goal.material);
            assert.deepEqual(input.goal.practice, goal.practice.map(({ id, prompt }) => ({ id, prompt })));
            for (const hidden of pack.goals.flatMap(goal => goal.assessment)) {
              assert.equal(JSON.stringify(body.messages).includes(hidden.prompt), false);
            }
            // Deterministic fake model: notes copy synthetic material, not a claim about real learning.
            notes.set(goal.id, String(input.goal.material));
          } else {
            assert.deepEqual(Object.keys(input.goal).sort(), ["title", "topics", "questions", "learnedNotes"].sort());
            assert.deepEqual(input.goal.questions, goal.assessment.map(({ id, prompt }) => ({ id, prompt })));
            assert.equal(input.goal.learnedNotes, notes.get(goal.id));
            assert.equal("material" in input.goal, false);
          }
          if (options.abortFakeCall === calls.length) { controller.abort(); return; }
          if (options.failFakeCall === calls.length) { sendJson(response, 503, { error: "synthetic failure" }); return; }
          const questions = input.phase === "study" ? goal.practice : goal.assessment;
          const answers = questions.map(question => ({ id: question.id,
            answer: input.phase === "study" ? (goal.id === "signal" ? "WAIT" : "17")
              : answersFromNotes(goal, String(input.goal.learnedNotes)),
          }));
          sendJson(response, 200, {
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
              notes: input.phase === "study" ? notes.get(goal.id) : "", answers,
            }) } }],
            usage: { prompt_tokens: 41, completion_tokens: 23 },
          });
        } catch { sendJson(response, 500, { error: "synthetic fixture failure" }); }
      })();
    });
    const port = await listen(server, signal);
    // Test-only IPC barrier: install cancellation/release listeners before readiness.
    // A slow parent cannot lose the cancellation race to normal completion. The run
    // deadline also bounds a parent that never responds; no fixture data is sent.
    if (process.send) await new Promise<void>((done, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", aborted);
        process.removeListener("message", released);
      };
      const aborted = () => { cleanup(); reject(new Error(FAILED)); };
      const released = (message: unknown) => {
        if (message && typeof message === "object" && "type" in message && message.type === "continue") {
          cleanup(); done();
        }
      };
      signal.addEventListener("abort", aborted, { once: true });
      process.on("message", released);
      if (signal.aborted) { aborted(); return; }
      process.send!({ type: "fixture-ready" }, error => { if (error) aborted(); });
    });
    const model = new OpenAICompatibleModel({ baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "synthetic-offline-model", apiKey: SYNTHETIC_API_KEY, timeoutMs: 4000, maxCalls: 4, reasoningEffort: "low" });
    let tick = 0;
    const report = await runAutonomousLearning(store, model, signal,
      () => new Date(Date.parse(AT) + (++tick) * 1000).toISOString());
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.map(call => call.phase), ["study", "assessment", "study", "assessment"]);
    assert.deepEqual(new Set(calls.map(call => call.goalId)), new Set(["signal", "label"]));
    assert.equal((report as { allGoalsPassed: boolean }).allGoalsPassed, true);
    check("four-openai-compatible-fake-calls", "model-boundary", 4);
    check("study-hides-private-and-heldout-data", "model-boundary", 2);
    check("assessment-uses-notes-without-material-field", "model-boundary", 2);
    stage("model-boundary");

    const state = await store.read(signal);
    const status = await store.learningStatus(signal);
    assert.ok(status);
    assert.equal(status.status, "completed");
    assert.equal(status.attempts.length, 4);
    assert.ok(status.attempts.every(attempt => attempt.status === "completed" && attempt.result));
    for (const goal of pack.goals) {
      const study: LearningAttemptDetail = status.attempts.find(attempt => attempt.goalId === goal.id && attempt.phase === "study")!;
      const assessment: LearningAttemptDetail = status.attempts.find(attempt => attempt.goalId === goal.id && attempt.phase === "assessment")!;
      assert.equal(study.result!.notes, notes.get(goal.id));
      assert.deepEqual(gradeAnswers(goal.assessment, assessment.result!.answers), { correct: 1, total: 1, passed: true });
      assert.ok(state.memory.records.some(memory => memory.content === study.result!.notes && memory.origin === "inference"));
      assert.equal(calls.find(call => call.goalId === goal.id && call.phase === "assessment")!.projection.learnedNotes, study.result!.notes);
    }
    assert.equal(state.revision, 11);
    assert.equal(state.experiences.length, 10);
    assert.equal(state.memory.records.length, 10);
    const budget = await store.budget(signal);
    assert.deepEqual(budget, { limit: 4, reserved: 4, completed: 4, failed: 0, pending: 0 });
    const raw = new DatabaseSync(db, { readOnly: true });
    try {
      const events = raw.prepare("SELECT eventJSON FROM events ORDER BY revision").all() as { eventJSON: string }[];
      assert.equal(events.length, 5);
      assert.equal(hasPrivateField(events.map(row => JSON.parse(row.eventJSON))), false);
    } finally { raw.close(); }
    // Fact-aligned answers may appear inside material/notes; only private fields/submission arrays are excluded.
    assert.equal(hasPrivateField(state), false);
    assert.deepEqual(await store.history(signal), []);
    check("both-goals-independently-graded", "learning-persistence", 2);
    check("ten-learning-revisions-plus-explicit-wake", "learning-persistence", 11);
    check("saved-study-notes-are-real-memory-records", "learning-persistence", 2);
    check("events-and-memory-exclude-private-answer-fields", "learning-persistence", 2);
    check("learning-does-not-enter-dialogue-history", "learning-persistence", 1);
    stage("learning-persistence");

    store.close(); store = undefined;
    store = SqliteSubjectStore.open(db, signal);
    assert.deepEqual(await store.read(signal), state);
    assert.deepEqual(await store.learningStatus(signal), status);
    assert.deepEqual(await store.budget(signal), budget);
    check("cold-reopen-exact-state-status-budget", "restart-and-stop", 3);
    stage("restart-and-stop");
    await runAutonomousLearning(store, model, signal);
    assert.equal(calls.length, 4, "completed run must not dispatch another model call");
    check("completed-rerun-zero-upstream-calls", "rerun-and-stop", 1);
    await store.stopLearning(signal);
    store.close(); store = undefined;
    store = SqliteSubjectStore.open(db, signal);
    assert.equal((await store.learningStatus(signal))?.status, "stopped");
    assert.deepEqual(await store.budget(signal), budget);
    assert.deepEqual(await store.read(signal), state);
    assert.deepEqual(await store.history(signal), []);
    check("stop-persists-and-history-remains-separate", "rerun-and-stop", 2);
    stage("rerun-and-stop");
    summary = { version: APP_VERSION, mode: "offline", upstream: "fake", dryrun: true, status: "passed", calls: 4, goals: 2,
      checks, stages, budget, goalGrades: (report as { goals: unknown }).goals,
      restart: { stateExact: true, statusExact: true, budgetExact: true },
      cleanup: { temporaryFilesRemoved: true, environmentChanged: false, completedBeforeReport: true },
      claim: "synthetic fixture only; not evidence of real learning effectiveness" };
  } catch { failed = true; }
  finally {
    controller.abort();
    if (store) { try { store.close(); } catch { cleanupFailed = true; } }
    if (server) { try { await closeServer(server); } catch { cleanupFailed = true; } }
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { cleanupFailed = true; } }
    clearTimeout(timer);
  }
  if (failed || cleanupFailed || !summary) throw new Error(FAILED);
  return summary; // Success is observable only after all owned resources are cleaned.
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) { console.error("Offline learning acceptance accepts no arguments."); process.exitCode = 1; return; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const report = await runLearningAcceptance({ signal: controller.signal });
    controller.signal.throwIfAborted();
    console.log(JSON.stringify(report));
  } catch { console.error(FAILED); process.exitCode = 1; }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
