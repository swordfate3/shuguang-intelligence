import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteSubjectStore } from "../src/adapters/storage/sqlite-subject.ts";
import { createInitialState } from "../src/core/state.ts";
import type { LearningPack } from "../src/core/learning.ts";
import { SubjectService } from "../src/runtime/subject-service.ts";
import { runAutonomousLearning } from "../src/runtime/learning-runner.ts";

const signal = () => new AbortController().signal;
const at = "2026-01-01T00:00:00.000Z";
const pack: LearningPack = { version: 1, id: "test-pack", title: "Test", goals: ["one", "two"].map(id => ({
  id, title: `Topic ${id}`, topics: ["learning"], material: "The sample code is ALPHA.",
  practice: [{ id: `practice-${id}`, prompt: "Practice?", answer: "PRIVATE_PRACTICE_KEY" }],
  assessment: [{ id: `assessment-${id}`, prompt: "Assessment?", answer: "PRIVATE_ASSESSMENT_KEY" }],
})) };
const study = { notes: "The source says sample code is ALPHA.", answers: [{ id: "practice-one", answer: "PRIVATE_PRACTICE_KEY" }] };
const assessment = { notes: "", answers: [{ id: "assessment-one", answer: "PRIVATE_ASSESSMENT_KEY" }] };
function fixture(t: { after(fn: () => void): void }, limit = 6, learningLimit = 4) {
  const dir = mkdtempSync(join(tmpdir(), "dawn-learning-storage-"));
  const path = join(dir, "subject.sqlite");
  const store = SqliteSubjectStore.createLearning(path, createInitialState("dawn", "Dawn", at), limit, pack, learningLimit, signal());
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { path, store };
}

test("learning completion is atomic, contains no private keys in public events, and coexists with real conversation cycles", async t => {
  const { path, store } = fixture(t);
  await store.changeLifecycle(0, "awake", at, signal());
  const first = await store.reserveLearning("one", "study", 1, signal());
  const afterStudy = await store.completeLearning(first, study, at, signal());
  const second = await store.reserveLearning("one", "assessment", afterStudy.revision, signal());
  const learned = await store.completeLearning(second, assessment, at, signal());
  assert.equal(learned.experiences.length, 5);
  assert.doesNotMatch(JSON.stringify(learned), /PRIVATE_PRACTICE_KEY|PRIVATE_ASSESSMENT_KEY/);
  const raw = new DatabaseSync(path);
  try {
    const events = raw.prepare('SELECT "eventJSON" FROM events').all();
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_PRACTICE_KEY|PRIVATE_ASSESSMENT_KEY/);
    assert.equal(raw.prepare("PRAGMA user_version").get()?.user_version, 3);
  } finally { raw.close(); }
  const service = new SubjectService(store, { async generate() {
    return { text: JSON.stringify({ reply: "I remember the source.", appraisal: null, candidates: [] }),
      modelId: "synthetic", usage: { inputTokens: 1, outputTokens: 1 } };
  } }, () => at);
  assert.equal((await service.handle({ version: 1, requestId: "chat", type: "say", text: "learning source" }, signal())).type, "reply");
  await service.close();
  const before = await store.read(signal());
  store.close();
  const reopened = SqliteSubjectStore.open(path, signal());
  try {
    assert.deepEqual(await reopened.read(signal()), before);
    assert.deepEqual(await reopened.history(signal()), [{ user: "learning source", assistant: "I remember the source." }]);
    assert.deepEqual(await reopened.budget(signal()), { limit: 6, reserved: 3, completed: 3, pending: 0, failed: 0 });
  } finally { reopened.close(); }
});

test("v3 explicit recovery also clears abandoned charged dialogue calls, never automatically", async t => {
  const { store } = fixture(t);
  await store.changeLifecycle(0, "awake", at, signal());
  await store.reserve("crashed-chat", "old request", 1, signal());
  await assert.rejects(store.reserveLearning("one", "study", 1, signal()), /chat attempt is pending/);
  await store.recoverLearning(signal());
  assert.deepEqual(await store.budget(signal()), { limit: 6, reserved: 1, completed: 0, pending: 0, failed: 1 });
  const attempt = await store.reserveLearning("one", "study", 1, signal());
  await store.failLearning(attempt, signal());
});

test("full episode capacity is checked before any learning model call or charge", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-learning-capacity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const count of [995, 996, 997]) {
    // A valid bootstrap can contain processed cycle IDs independently of experiences.
    // This exercises a real bounded domain collection without 500 slow simulated turns.
    const base = createInitialState("dawn", "Dawn", at);
    const initial = { ...base, processedCycleIds: Array.from({ length: count }, (_, i) => `old_${i}`) };
    const store = SqliteSubjectStore.createLearning(join(dir, `state-${count}.sqlite`), initial, 4, pack, 4, signal());
    try {
      await store.changeLifecycle(0, "awake", at, signal());
      assert.equal((await store.learningStatus(signal()))?.status, count === 995 ? "active" : "exhausted");
      if (count === 995) {
        const attempt = await store.reserveLearning("one", "study", 1, signal());
        await store.failLearning(attempt, signal());
      } else {
        let dispatched = 0;
        const result = await runAutonomousLearning(store, { async generate() { dispatched++; throw new Error("must not run"); } }, signal());
        assert.match(JSON.stringify(result), /exhausted/);
        await assert.rejects(store.reserveLearning("one", "study", 1, signal()), /capacity exhausted/);
        assert.equal(dispatched, 0);
        assert.equal((await store.budget(signal())).reserved, 0);
      }
    } finally { store.close(); }
  }
});

test("conversation between study and assessment can exhaust capacity without charging an impossible test", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-learning-capacity-interleave-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = createInitialState("dawn", "Dawn", at);
  const store = SqliteSubjectStore.createLearning(join(dir, "state.sqlite"), { ...base,
    processedCycleIds: Array.from({ length: 995 }, (_, i) => `old_${i}`) }, 6, pack, 4, signal());
  try {
    await store.changeLifecycle(0, "awake", at, signal());
    const attempt = await store.reserveLearning("one", "study", 1, signal());
    await store.completeLearning(attempt, study, at, signal());
    const service = new SubjectService(store, { async generate() {
      return { text: JSON.stringify({ reply: "hello", appraisal: null, candidates: [] }), modelId: "synthetic",
        usage: { inputTokens: 1, outputTokens: 1 } };
    } }, () => at);
    assert.equal((await service.handle({ version: 1, requestId: "interleave", type: "say", text: "hello" }, signal())).type, "reply");
    await service.close();
    assert.equal((await store.learningStatus(signal()))?.status, "exhausted");
    let calls = 0;
    await runAutonomousLearning(store, { async generate() { calls++; throw new Error("must not run"); } }, signal());
    assert.equal(calls, 0);
    assert.deepEqual(await store.budget(signal()), { limit: 6, reserved: 2, completed: 2, pending: 0, failed: 0 });
  } finally { store.close(); }
});

test("trigger failure rolls back learning snapshot, event and completed result but keeps precharge", async t => {
  const { path, store } = fixture(t);
  await store.changeLifecycle(0, "awake", at, signal());
  const before = await store.read(signal());
  const attempt = await store.reserveLearning("one", "study", before.revision, signal());
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TRIGGER reject_learning BEFORE UPDATE ON learning_attempts WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'synthetic'); END;");
  await assert.rejects(store.completeLearning(attempt, study, at, signal()));
  assert.deepEqual(await store.read(signal()), before);
  assert.deepEqual(await store.budget(signal()), { limit: 6, reserved: 1, completed: 0, pending: 1, failed: 0 });
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM events").get()?.n, 1);
  raw.exec("DROP TRIGGER reject_learning"); raw.close();
  await store.failLearning(attempt, signal());
});

test("learning and conversation reservations exclude each other; final budget cannot start a half episode", async t => {
  const { store } = fixture(t, 3, 3);
  await store.changeLifecycle(0, "awake", at, signal());
  const first = await store.reserveLearning("one", "study", 1, signal());
  await assert.rejects(store.reserve("chat", "message", 1, signal()), /learning attempt is pending/);
  await assert.rejects(store.reserveLearning("two", "study", 1, signal()), /already pending/);
  const state = await store.completeLearning(first, study, at, signal());
  const last = await store.reserveLearning("one", "assessment", state.revision, signal());
  await store.completeLearning(last, assessment, at, signal());
  const revision = (await store.read(signal())).revision;
  await assert.rejects(store.reserveLearning("two", "study", revision, signal()), /budget exhausted/);
  assert.equal((await store.learningStatus(signal()))?.status, "exhausted");
  const chat = await store.reserve("chat2", "message", revision, signal());
  await assert.rejects(store.reserveLearning("two", "study", revision, signal()), /chat attempt is pending/);
  await store.fail(chat, signal());
  assert.equal((await store.budget(signal())).reserved, 3);
});

test("sleep fences a charged learning result without partial commit", async t => {
  const { store } = fixture(t);
  await store.changeLifecycle(0, "awake", at, signal());
  const attempt = await store.reserveLearning("one", "study", 1, signal());
  await store.changeLifecycle(1, "sleeping", at, signal());
  await assert.rejects(store.completeLearning(attempt, study, at, signal()));
  assert.equal((await store.read(signal())).experiences.length, 0);
  await store.failLearning(attempt, signal());
  assert.deepEqual(await store.budget(signal()), { limit: 6, reserved: 1, completed: 0, pending: 0, failed: 1 });
});

test("cross-connection stop fences completion and survives reopening", async t => {
  const { path, store } = fixture(t);
  await store.changeLifecycle(0, "awake", at, signal());
  const attempt = await store.reserveLearning("one", "study", 1, signal());
  const other = SqliteSubjectStore.open(path, signal());
  try { await other.stopLearning(signal()); } finally { other.close(); }
  await assert.rejects(store.completeLearning(attempt, study, at, signal()), /stopped/);
  assert.equal((await store.read(signal())).revision, 1);
  await store.recoverLearning(signal());
  assert.equal((await store.learningStatus(signal()))?.status, "stopped");
  await assert.rejects(store.reserveLearning("two", "study", 1, signal()), /stopped/);
  assert.equal((await store.budget(signal())).failed, 1);
});

test("warm reads and cold opens reject event, private result, snapshot and pack tampering", async t => {
  for (const mutation of ["event", "result", "snapshot", "pack"]) {
    const { path, store } = fixture(t);
    await store.changeLifecycle(0, "awake", at, signal());
    const attempt = await store.reserveLearning("one", "study", 1, signal());
    await store.completeLearning(attempt, study, at, signal());
    const raw = new DatabaseSync(path);
    if (mutation === "event") raw.exec("DELETE FROM events WHERE revision > 1");
    if (mutation === "result") {
      const bad = { ...study, notes: "tampered notes" };
      raw.prepare("UPDATE learning_attempts SET resultJSON = ? WHERE id = ?").run(JSON.stringify(bad), attempt.id);
    }
    if (mutation === "snapshot") {
      const changed = await store.read(signal());
      raw.prepare("UPDATE subject SET snapshot = ?").run(JSON.stringify({ ...changed, lifecycle: "sleeping" }));
    }
    if (mutation === "pack") raw.prepare("UPDATE learning_pack SET packJSON = ?").run(JSON.stringify({ ...pack,
      goals: pack.goals.map(goal => ({ ...goal, material: "Changed source" })) }));
    raw.close();
    await assert.rejects(store.read(signal()));
    store.close();
    assert.throws(() => SqliteSubjectStore.open(path, signal()));
  }
});
