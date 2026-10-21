import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState } from "../src/core/state.ts";
import type { CycleAuthority, CycleInput } from "../src/core/cycle.ts";
import { changeCoreLifecycle, CoreRevisionConflictError } from "../src/core/cycle.ts";
import type { SubjectAttempt, TurnCommit } from "../src/runtime/subject-store.ts";
import { SqliteSubjectStore } from "../src/adapters/storage/sqlite-subject.ts";

const t0 = "2026-01-01T00:00:00.000Z";
const t1 = "2026-01-01T00:01:00.000Z";
const t2 = "2026-01-01T00:02:00.000Z";
const t3 = "2026-01-01T00:03:00.000Z";
const signal = () => new AbortController().signal;
const authority: CycleAuthority = { allow: [], availableBudget: 0, stopRequested: false, evaluations: [] };

function temp(t: { after(callback: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "dawn-subject-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "subject.sqlite");
}
function awakeInitial() {
  const initial = createInitialState("subject", "Synthetic subject", t0);
  return changeCoreLifecycle(initial, 0, "awake", t0);
}
function cycle(cycleId: string, revision: number, at: string, experienceId: string,
  origin: "user_statement" | "inference", content: string, sourceIds: string[] = []): { input: CycleInput; authority: CycleAuthority } {
  return { input: { cycleId, expectedRevision: revision, at, experience: {
    id: experienceId, subjectId: "subject", scopeId: "owner", kind: "conversation", origin,
    content, topics: [], occurredAt: at, recordedAt: at, sourceIds,
  }, appraisal: null, candidates: [], activities: [] }, authority: structuredClone(authority) };
}
function commit(user: string, reply = "合成回复", expectedRevision = 1, turnIndex = 0): TurnCommit {
  const firstAt = new Date(Date.parse(t0) + expectedRevision * 60_000).toISOString();
  const secondAt = new Date(Date.parse(firstAt) + 60_000).toISOString();
  const userExperienceId = `user-experience-${turnIndex}`;
  return { reply, cycles: [cycle(`user-cycle-${turnIndex}`, expectedRevision, firstAt, userExperienceId, "user_statement", user),
    cycle(`reply-cycle-${turnIndex}`, expectedRevision + 1, secondAt, `reply-experience-${turnIndex}`, "inference", reply, [userExperienceId])],
    usage: { modelId: "synthetic-model", inputTokens: 1, outputTokens: 2 } };
}
async function awakeStore(path: string, limit = 10): Promise<SqliteSubjectStore> {
  const store = SqliteSubjectStore.create(path, createInitialState("subject", "Synthetic subject", t0), limit, signal());
  await store.changeLifecycle(0, "awake", t0, signal());
  return store;
}
async function reserve(store: SqliteSubjectStore, id: string, user = "synthetic user"): Promise<SubjectAttempt> {
  return store.reserve(id, user, 1, signal());
}

test("lifecycle and two complete model cycles survive reopen with exact event replay", async t => {
  const path = temp(t);
  let store = await awakeStore(path);
  const attempt = await reserve(store, "turn_1", "你好");
  const final = await store.complete(attempt, commit("你好"), signal());
  assert.equal(final.revision, 3);
  assert.equal(final.experiences.length, 2);
  assert.deepEqual(await store.history(signal()), [{ user: "你好", assistant: "合成回复" }]);
  store.close();

  store = SqliteSubjectStore.open(path, signal());
  assert.deepEqual(await store.read(signal()), final);
  const sleeping = await store.changeLifecycle(3, "sleeping", t3, signal());
  assert.equal(sleeping.revision, 4);
  store.close();
  store = SqliteSubjectStore.open(path, signal());
  try { assert.deepEqual(await store.read(signal()), sleeping); }
  finally { store.close(); }
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("revision CAS spans connections and request ids are unique; reservations charge budget permanently", async t => {
  const path = temp(t);
  const a = SqliteSubjectStore.create(path, createInitialState("subject", "Synthetic subject", t0), 2, signal());
  const b = SqliteSubjectStore.open(path, signal());
  try {
    const first = await a.changeLifecycle(0, "awake", t0, signal());
    assert.equal(first.revision, 1);
    await assert.rejects(b.changeLifecycle(0, "sleeping", t1, signal()), CoreRevisionConflictError);
    const reservations = await Promise.allSettled([
      a.reserve("same-id", "first", 1, signal()), b.reserve("same-id", "first", 1, signal()),
    ]);
    assert.equal(reservations.filter(item => item.status === "fulfilled").length, 1);
    const attempt = reservations.find(item => item.status === "fulfilled") as PromiseFulfilledResult<SubjectAttempt>;
    await a.fail(attempt.value, signal());
    assert.deepEqual(await b.budget(signal()), { limit: 2, reserved: 1, completed: 0, failed: 1, pending: 0 });
    const second = await b.reserve("second", "second", 1, signal());
    await b.fail(second, signal());
    assert.deepEqual(await a.budget(signal()), { limit: 2, reserved: 2, completed: 0, failed: 2, pending: 0 });
    await assert.rejects(a.reserve("third", "third", 1, signal()), /budget exhausted/);
  } finally { b.close(); a.close(); }
});

test("newer reservations fence late completion, while pending attempt identity cannot be forged", async t => {
  const path = temp(t);
  const store = await awakeStore(path, 5);
  try {
    const older = await reserve(store, "older", "first turn");
    const newer = await reserve(store, "newer", "next turn");
    await store.fail(newer, signal());
    await assert.rejects(store.complete(older, commit("first turn"), signal()), /Stale subject attempt/);
    await assert.rejects(store.fail({ ...older, user: "forged" }, signal()));
    await store.fail(older, signal());
    assert.deepEqual(await store.budget(signal()), { limit: 5, reserved: 2, completed: 0, failed: 2, pending: 0 });
  } finally { store.close(); }
});

test("cycle provenance, trusted-evaluation boundary, reply protocol cap and cancellation reject atomically", async t => {
  const path = temp(t);
  const store = await awakeStore(path, 5);
  try {
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(store.reserve("cancelled", "no charge", 1, aborted.signal), { name: "AbortError" });
    assert.deepEqual(await store.budget(signal()), { limit: 5, reserved: 0, completed: 0, failed: 0, pending: 0 });

    const wrongUser = await reserve(store, "bad-user", "original");
    await assert.rejects(store.complete(wrongUser, commit("other"), signal()));
    await store.fail(wrongUser, signal());

    const untrustedEvaluation = await reserve(store, "bad-authority", "user");
    const evaluated = commit("user");
    const badCycles = [...evaluated.cycles];
    badCycles[0] = { ...badCycles[0]!, authority: { ...authority, evaluations: [{} as never] } };
    await assert.rejects(store.complete(untrustedEvaluation, { ...evaluated, cycles: badCycles }, signal()));
    await store.fail(untrustedEvaluation, signal());

    const tooLargeReply = await reserve(store, "wire-cap", "user");
    const huge = "\u0001".repeat(16_000);
    await assert.rejects(store.complete(tooLargeReply, commit("user", huge), signal()), /wire limit/);
    await store.fail(tooLargeReply, signal());

    const pending = await reserve(store, "cancel-complete", "user");
    await assert.rejects(store.complete(pending, commit("user"), aborted.signal), { name: "AbortError" });
    await store.fail(pending, signal());
    assert.deepEqual(await store.budget(signal()), { limit: 5, reserved: 4, completed: 0, failed: 4, pending: 0 });
  } finally { store.close(); }
});

test("SQLite trigger failure rolls back snapshot, events and attempt completion as one transaction", async t => {
  const path = temp(t);
  const store = await awakeStore(path);
  const raw = new DatabaseSync(path);
  try {
    const attempt = await reserve(store, "rollback", "hello");
    raw.exec("CREATE TRIGGER abort_subject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    await assert.rejects(store.complete(attempt, commit("hello"), signal()), /injected failure/);
    assert.equal((await store.read(signal())).revision, 1);
    assert.deepEqual(await store.budget(signal()), { limit: 10, reserved: 1, completed: 0, failed: 0, pending: 1 });
    raw.exec("DROP TRIGGER abort_subject_event;");
    assert.equal((await store.complete(attempt, commit("hello"), signal())).revision, 3);
  } finally { raw.close(); store.close(); }
});

test("open refuses bootstrap tampering, foreign future revisions and corrupt event JSON", async t => {
  const bootstrapPath = temp(t);
  const bootstrapStore = SqliteSubjectStore.create(bootstrapPath, createInitialState("subject", "Synthetic subject", t0), 5, signal());
  bootstrapStore.close();
  const bootstrapDb = new DatabaseSync(bootstrapPath);
  const bootstrap = JSON.parse(bootstrapDb.prepare("SELECT snapshot FROM bootstrap").get()!.snapshot as string);
  bootstrap.self.identity.name = "tampered bootstrap";
  bootstrapDb.prepare("UPDATE bootstrap SET snapshot = ?").run(JSON.stringify(bootstrap));
  bootstrapDb.close();
  assert.throws(() => SqliteSubjectStore.open(bootstrapPath, signal()));

  const futurePath = temp(t);
  const futureStore = await awakeStore(futurePath);
  futureStore.close();
  const futureDb = new DatabaseSync(futurePath);
  futureDb.prepare("INSERT INTO events (revision, eventJSON) VALUES (99, '{}')").run();
  futureDb.close();
  assert.throws(() => SqliteSubjectStore.open(futurePath, signal()));

  const corruptPath = temp(t);
  const corruptStore = await awakeStore(corruptPath);
  await corruptStore.changeLifecycle(1, "sleeping", t1, signal());
  corruptStore.close();
  const corruptDb = new DatabaseSync(corruptPath);
  corruptDb.prepare("UPDATE events SET eventJSON = ? WHERE revision = 1").run("not-json");
  corruptDb.close();
  assert.throws(() => SqliteSubjectStore.open(corruptPath, signal()));
});

test("history is a bounded suffix of complete successful pairs only", async t => {
  const path = temp(t);
  const store = await awakeStore(path, 12);
  try {
    for (let index = 0; index < 10; index++) {
      const currentRevision = 1 + 2 * index;
      const user = `u${index}:` + "u".repeat(1_997);
      const reply = `a${index}:` + "a".repeat(1_997);
      const attempt = await store.reserve(`history-${index}`, user, currentRevision, signal());
      await store.complete(attempt, commit(user, reply, currentRevision, index), signal());
    }
    const pairs = await store.history(signal());
    assert.equal(pairs.length, 6);
    assert.equal(pairs[0]!.user.startsWith("u4:"), true);
    assert.equal(pairs.at(-1)!.user.startsWith("u9:"), true);
    assert.equal(pairs.reduce((chars, pair) => chars + pair.user.length + pair.assistant.length, 0), 24_000);
    const pending = await store.reserve("not-in-history", "pending", 21, signal());
    await store.fail(pending, signal());
    assert.deepEqual(await store.history(signal()), pairs);
  } finally { store.close(); }
});

test("exact-prefix checkpoint isolates returned state and replays only a valid external suffix", async t => {
  const path = temp(t);
  const a = SqliteSubjectStore.create(path, createInitialState("subject", "Synthetic subject", t0), 5, signal());
  const b = SqliteSubjectStore.open(path, signal());
  try {
    const firstRead = await a.read(signal());
    (firstRead.self.identity as { name: string }).name = "caller mutation";
    assert.equal((await a.read(signal())).self.identity.name, "Synthetic subject");
    await b.changeLifecycle(0, "awake", t0, signal());
    assert.equal((await a.read(signal())).lifecycle, "awake");
  } finally { b.close(); a.close(); }
});

test("same-revision event edits, bootstrap edits, and event deletion invalidate the exact-prefix checkpoint", async t => {
  const eventPath = temp(t);
  const eventStore = await awakeStore(eventPath);
  const eventDb = new DatabaseSync(eventPath);
  try {
    await eventStore.read(signal()); // establish a validated checkpoint
    eventDb.prepare("UPDATE events SET eventJSON = ? WHERE revision = 1").run(JSON.stringify({
      type: "lifecycle_changed", expectedRevision: 0, lifecycle: "awake", at: t1,
    }));
    await assert.rejects(eventStore.read(signal()), /snapshot and replayed event history mismatch/);
  } finally { eventDb.close(); eventStore.close(); }

  const bootstrapPath = temp(t);
  const bootstrapStore = SqliteSubjectStore.create(bootstrapPath, createInitialState("subject", "Synthetic subject", t0), 5, signal());
  const bootstrapDb = new DatabaseSync(bootstrapPath);
  try {
    await bootstrapStore.read(signal());
    const changed = createInitialState("subject", "Changed bootstrap", t0);
    bootstrapDb.prepare("UPDATE bootstrap SET snapshot = ?").run(JSON.stringify(changed));
    await assert.rejects(bootstrapStore.read(signal()), /snapshot and replayed event history mismatch/);
  } finally { bootstrapDb.close(); bootstrapStore.close(); }

  const deletedPath = temp(t);
  const deletedStore = await awakeStore(deletedPath);
  const deletedDb = new DatabaseSync(deletedPath);
  try {
    await deletedStore.read(signal());
    deletedDb.prepare("DELETE FROM events WHERE revision = 1").run();
    await assert.rejects(deletedStore.read(signal()), /snapshot and replayed event history mismatch/);
  } finally { deletedDb.close(); deletedStore.close(); }
});

test("serialization ignores inherited toJSON hooks without invoking them", async t => {
  const path = temp(t);
  let invoked = false;
  const previousToJSON = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  Object.defineProperty(Object.prototype, "toJSON", { configurable: true, get() {
    invoked = true;
    return () => "tampered";
  } });
  try {
    const store = SqliteSubjectStore.create(path, createInitialState("subject", "Synthetic subject", t0), 1, signal());
    store.close();
  } finally {
    if (previousToJSON) Object.defineProperty(Object.prototype, "toJSON", previousToJSON);
    else delete (Object.prototype as { toJSON?: unknown }).toJSON;
  }
  assert.equal(invoked, false);
  const reopened = SqliteSubjectStore.open(path, signal());
  try { assert.equal((await reopened.read(signal())).self.identity.name, "Synthetic subject"); }
  finally { reopened.close(); }
});

test("creation is exclusive and open rejects symlinks and unrelated SQLite files", async t => {
  const path = temp(t);
  const store = SqliteSubjectStore.create(path, createInitialState("subject", "Synthetic subject", t0), 1, signal());
  store.close();
  assert.throws(() => SqliteSubjectStore.create(path, createInitialState("subject", "Synthetic subject", t0), 1, signal()));
  const foreignPath = join(path, "..", "foreign.sqlite");
  const other = new DatabaseSync(foreignPath);
  other.close();
  assert.throws(() => SqliteSubjectStore.open(foreignPath, signal()));
  const linkPath = join(path, "..", "subject-link.sqlite");
  symlinkSync(path, linkPath);
  assert.throws(() => SqliteSubjectStore.open(linkPath, signal()));
});
