import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteChatStore } from "../src/adapters/storage/sqlite-chat.ts";

const signal = () => new AbortController().signal;
function fixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "dawn-chat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "chat.sqlite");
}
function opened(t: TestContext, limit = 20) {
  const path = fixture(t);
  const store = SqliteChatStore.create(path, "subject-test", limit, signal());
  t.after(() => store.close());
  return { path, store };
}
function reserve(store: SqliteChatStore, requestId: string, user = `user ${requestId}`, revision = 0) {
  return store.reserve(requestId, user, revision, signal());
}
function usage() { return { modelId: "test-model", inputTokens: 10, outputTokens: 5 }; }

// All databases are synthetic fixtures in per-test temporary directories.
test("budget, completed history and subject binding persist across restart", async t => {
  const path = fixture(t);
  let store = SqliteChatStore.create(path, "subject-test", 3, signal());
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const first = await reserve(store, "r1", "hello", 2);
  await store.complete(first, "world", usage(), signal());
  const second = await reserve(store, "r2", "again", 3);
  assert.deepEqual(second.history, [{ user: "hello", assistant: "world" }]);
  await store.fail(second, signal());
  store.close();

  store = SqliteChatStore.open(path, "subject-test", signal());
  t.after(() => store.close());
  assert.deepEqual(await store.budget(signal()), { limit: 3, reserved: 2, completed: 1, failed: 1, pending: 0 });
  const third = await reserve(store, "r3", "last");
  assert.deepEqual(third.history, [{ user: "hello", assistant: "world" }]);
  await store.complete(third, "done", usage(), signal());
  assert.deepEqual(await store.budget(signal()), { limit: 3, reserved: 3, completed: 2, failed: 1, pending: 0 });
  await assert.rejects(store.reserve("r4", "over budget", 0, signal()), /budget exhausted/);
  assert.throws(() => SqliteChatStore.open(path, "different-subject", signal()), /subject binding mismatch/);
});

test("create is exclusive and open rejects missing, symlink, foreign schema and wrong subject", t => {
  const path = fixture(t);
  assert.throws(() => SqliteChatStore.open(path, "subject-test", signal()));
  assert.equal(existsSync(path), false);
  const store = SqliteChatStore.create(path, "subject-test", 2, signal());
  store.close();
  assert.throws(() => SqliteChatStore.create(path, "subject-test", 9, signal()));
  assert.throws(() => SqliteChatStore.open(path, "wrong", signal()), /subject binding mismatch/);
  const link = `${path}.link`;
  symlinkSync(path, link);
  assert.throws(() => SqliteChatStore.open(link, "subject-test", signal()), /regular non-symlink/);
  const original = readFileSync(path);
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA user_version = 99");
  raw.close();
  assert.throws(() => SqliteChatStore.open(path, "subject-test", signal()), /no migration performed/);
  assert.notDeepEqual(readFileSync(path), original);

  const foreign = `${path}.foreign`;
  writeFileSync(foreign, "not sqlite");
  assert.throws(() => SqliteChatStore.open(foreign, "subject-test", signal()));
});

test("a duplicate request ID never reuses a reservation, regardless of state", async t => {
  const { store } = opened(t, 4);
  const pending = await reserve(store, "same");
  await assert.rejects(reserve(store, "same"), /already been used/);
  await store.fail(pending, signal());
  await assert.rejects(reserve(store, "same"), /already been used/);
  const completed = await reserve(store, "done");
  await store.complete(completed, "response", usage(), signal());
  await assert.rejects(reserve(store, "done"), /already been used/);
  assert.deepEqual(await store.budget(signal()), { limit: 4, reserved: 2, completed: 1, failed: 1, pending: 0 });
});

test("BEGIN IMMEDIATE serializes competing reservations across two connections", async t => {
  const path = fixture(t);
  const first = SqliteChatStore.create(path, "subject-test", 1, signal());
  const second = SqliteChatStore.open(path, "subject-test", signal());
  t.after(() => { first.close(); second.close(); });
  const outcomes = await Promise.allSettled([
    first.reserve("a", "first", 0, signal()),
    second.reserve("b", "second", 0, signal()),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === "rejected").length, 1);
  assert.deepEqual(await first.budget(signal()), { limit: 1, reserved: 1, completed: 0, failed: 0, pending: 1 });
});

test("triggered completion failure rolls assistant, usage and state back atomically", async t => {
  const { path, store } = opened(t);
  const reservation = await reserve(store, "atomic", "private user text");
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TRIGGER reject_completion BEFORE UPDATE ON chat_requests BEGIN SELECT RAISE(ABORT, 'injected'); END;");
  raw.close();
  await assert.rejects(store.complete(reservation, "private assistant text", usage(), signal()));
  assert.deepEqual(await store.budget(signal()), { limit: 20, reserved: 1, completed: 0, failed: 0, pending: 1 });
  const reopened = SqliteChatStore.open(path, "subject-test", signal());
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.reserve("next", "next", 0, signal()).then(r => r.history), []);
});

test("pending and failed reservations stay charged but never enter history", async t => {
  const { path, store } = opened(t);
  const completed = await reserve(store, "completed", "remember me");
  await store.complete(completed, "saved", usage(), signal());
  const failed = await reserve(store, "failed", "must not appear");
  await store.fail(failed, signal());
  const pending = await reserve(store, "pending", "also private");
  assert.deepEqual(pending.history, [{ user: "remember me", assistant: "saved" }]);
  assert.deepEqual(await store.budget(signal()), { limit: 20, reserved: 3, completed: 1, failed: 1, pending: 1 });
  store.close();
  const reopened = SqliteChatStore.open(path, "subject-test", signal());
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.budget(signal()), { limit: 20, reserved: 3, completed: 1, failed: 1, pending: 1 });
  const afterRestart = await reserve(reopened, "after-restart", "context");
  assert.deepEqual(afterRestart.history, [{ user: "remember me", assistant: "saved" }]);
});

test("older completion is fenced after a newer reservation; older failure remains allowed", async t => {
  const { store } = opened(t);
  const old = await reserve(store, "old", "old message");
  const newer = await reserve(store, "new", "new message");
  await assert.rejects(store.complete(old, "late response", usage(), signal()), /Stale/);
  await store.fail(old, signal());
  await store.complete(newer, "current response", usage(), signal());
  const next = await reserve(store, "next", "third");
  assert.deepEqual(next.history, [{ user: "new message", assistant: "current response" }]);
  assert.deepEqual(await store.budget(signal()), { limit: 20, reserved: 3, completed: 1, failed: 1, pending: 1 });
});

test("tampered reservations, invalid inputs and cancellation cannot mutate records", async t => {
  const { store } = opened(t);
  const reservation = await reserve(store, "trusted", "stored user", 1);
  const altered = { ...reservation, user: "forged user", history: [{ user: "fake", assistant: "fake" }] };
  await assert.rejects(store.complete(altered, "answer", usage(), signal()), /does not match/);
  await assert.rejects(store.fail(altered, signal()), /does not match/);
  await assert.rejects(store.reserve("bad-revision", "text", -1, signal()));
  await assert.rejects(store.reserve("", "text", 0, signal()));
  await assert.rejects(store.reserve("too-long", "x".repeat(16_001), 0, signal()));
  await assert.rejects(store.reserve("blank-user", " \t\n", 0, signal()));
  await assert.rejects(store.reserve("cancelled", "text", 0, AbortSignal.abort()));
  await assert.rejects(store.complete(reservation, "answer", { ...usage(), inputTokens: -1 }, signal()));
  await assert.rejects(store.complete(reservation, " \t\n", usage(), signal()));
  await assert.rejects(store.fail(reservation, AbortSignal.abort()));
  assert.deepEqual(await store.budget(signal()), { limit: 20, reserved: 1, completed: 0, failed: 0, pending: 1 });
  const historyOnlyAltered = { ...reservation, history: [{ user: "fake", assistant: "fake" }] };
  await store.complete(historyOnlyAltered, "answer", usage(), signal());
  const next = await reserve(store, "history-check", "next");
  assert.deepEqual(next.history, [{ user: "stored user", assistant: "answer" }]);
  await assert.rejects(store.complete(reservation, "twice", usage(), signal()), /not pending/);
});

test("history is capped at the most recent eight complete pairs", async t => {
  const { store } = opened(t);
  for (let i = 1; i <= 10; i += 1) {
    const pair = await reserve(store, `short-${i}`, `u${i}`);
    await store.complete(pair, `a${i}`, usage(), signal());
  }
  const context = await reserve(store, "check-eight", "current");
  assert.deepEqual(context.history.map(pair => pair.user), ["u3", "u4", "u5", "u6", "u7", "u8", "u9", "u10"]);
});

test("history keeps only a continuous suffix of whole pairs within character cap", async t => {
  const { store } = opened(t);
  for (let i = 1; i <= 4; i += 1) {
    const pair = await reserve(store, `pair-${i}`, `${i}`.repeat(5_000));
    await store.complete(pair, `${i}`.repeat(5_000), usage(), signal());
  }
  const context = await reserve(store, "context", "current");
  assert.deepEqual(context.history.map(pair => pair.user[0]), ["3", "4"]);
  assert.equal(context.history.reduce((sum, pair) => sum + pair.user.length + pair.assistant.length, 0), 20_000);
  await store.fail(context, signal());

  for (let i = 5; i <= 6; i += 1) {
    const pair = await reserve(store, `large-${i}`, "u".repeat(14_000));
    await store.complete(pair, "a".repeat(14_000), usage(), signal());
  }
  const oversizedLatest = await reserve(store, "after-large", "small");
  assert.deepEqual(oversizedLatest.history, []);
});

test("maximum-sized Chinese user and assistant messages fit the bounded JSON encoding", async t => {
  const { path, store } = opened(t);
  const chinese = "界".repeat(16_000);
  const reservation = await reserve(store, "large-chinese", chinese);
  await store.complete(reservation, chinese, usage(), signal());
  store.close();
  const reopened = SqliteChatStore.open(path, "subject-test", signal());
  t.after(() => reopened.close());
  const next = await reserve(reopened, "after-chinese", "continue");
  assert.equal(next.history.length, 0); // 32,000 UTF-16 chars exceeds the 24,000 context cap as a whole pair.
});

test("open rejects whitespace-only stored user or assistant messages", async t => {
  for (const column of ["user_text", "assistant_text"] as const) {
    const path = fixture(t);
    const store = SqliteChatStore.create(path, "subject-test", 2, signal());
    const reservation = await reserve(store, "stored", "valid user");
    await store.complete(reservation, "valid assistant", usage(), signal());
    store.close();
    const raw = new DatabaseSync(path);
    raw.prepare(`UPDATE chat_requests SET ${column} = '   '`).run();
    raw.close();
    assert.throws(() => SqliteChatStore.open(path, "subject-test", signal()), /Invalid stored/);
  }
});

test("limit, subject ID, close semantics and malformed calls are validated", async t => {
  const path = fixture(t);
  for (const limit of [0, 10_001, 1.5, Number.NaN]) {
    assert.throws(() => SqliteChatStore.create(`${path}.${String(limit)}`, "subject-test", limit, signal()));
  }
  assert.throws(() => SqliteChatStore.create(`${path}.empty`, "  ", 2, signal()));
  assert.throws(() => SqliteChatStore.create(`${path}.cancel`, "subject-test", 2, AbortSignal.abort()));
  assert.equal(existsSync(`${path}.cancel`), false);
  const store = SqliteChatStore.create(path, "subject-test", 2, signal());
  const pending = await reserve(store, "once");
  store.close();
  store.close();
  await assert.rejects(store.fail(pending, signal()), /closed/);
});
