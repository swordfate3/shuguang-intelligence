import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInitialState } from "../src/legacy/state.ts";
import { SqliteStateStore } from "../src/adapters/storage/sqlite.ts";
import { RevisionConflictError } from "../src/runtime/state-store.ts";
import { InMemoryStateStore } from "../src/adapters/storage/in-memory.ts";

const at = "2026-01-01T00:00:00.000Z";
const later = "2026-01-02T00:00:00.000Z";
const signal = () => new AbortController().signal;
const initial = () => createInitialState("dawn-test", "曙光", at);
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "dawn-sqlite-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "state.sqlite");
}

// Fixtures live only in temporary directories. No user/home database is opened.
test("SQLite preserves full bootstrap state, identity, revision and events after reopening", async t => {
  const path = fixture(t);
  const source = {
    ...initial(),
    self: { ...initial().self, interests: [{ topic: "天文", strength: 0.7, evidenceIds: ["e1"] }] },
    memoryIds: ["memory-1"],
    affect: { ...initial().affect, valence: 0.4, episodes: [
      { id: "feeling-1", label: "好奇", intensity: 0.5, sourceEventIds: ["e1"], startedAt: at },
    ] },
    agency: { ...initial().agency, intentions: [
      { id: "i1", origin: "self" as const, description: "了解星空", reasonIds: ["e1"], status: "proposed" as const, priority: 0.4 },
    ] },
    growthProposals: [
      { id: "g1", kind: "method" as const, description: "核对资料来源", evidenceIds: ["e1"], status: "candidate" as const, evaluationIds: [] },
    ],
  };
  let store = SqliteStateStore.create(path, source, signal());
  const awake = await store.changeLifecycle({ expectedRevision: 0, lifecycle: "awake", at: later }, signal());
  store.close();
  store = SqliteStateStore.open(path, signal());
  t.after(() => store.close());
  assert.deepEqual(await store.read(signal()), awake);
  assert.deepEqual((await store.read(signal())).self, source.self);
  assert.equal((await store.events(0, 10, signal())).length, 1);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("two connections reject stale revisions, no-op writes add no events", async t => {
  const path = fixture(t);
  const first = SqliteStateStore.create(path, initial(), signal());
  const second = SqliteStateStore.open(path, signal());
  t.after(() => { first.close(); second.close(); });
  await first.changeLifecycle({ expectedRevision: 0, lifecycle: "sleeping", at }, signal());
  assert.deepEqual(await first.events(0, 10, signal()), []);
  await first.changeLifecycle({ expectedRevision: 0, lifecycle: "awake", at }, signal());
  await assert.rejects(second.changeLifecycle({ expectedRevision: 0, lifecycle: "sleeping", at }, signal()), RevisionConflictError);
  assert.equal((await second.read(signal())).revision, 1);
  await second.changeLifecycle({ expectedRevision: 1, lifecycle: "sleeping", at: later }, signal());
  assert.equal((await first.read(signal())).revision, 2);
  assert.deepEqual((await first.events(1, 10, signal())).map(e => e.revision), [2]);
});

test("event insertion failure rolls snapshot and revision back atomically", async t => {
  const path = fixture(t);
  const store = SqliteStateStore.create(path, initial(), signal());
  t.after(() => store.close());
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TRIGGER reject_event BEFORE INSERT ON lifecycle_events BEGIN SELECT RAISE(ABORT, 'injected'); END;");
  raw.close();
  await assert.rejects(store.changeLifecycle({ expectedRevision: 0, lifecycle: "awake", at }, signal()));
  assert.deepEqual(await store.read(signal()), initial());
  assert.deepEqual(await store.events(0, 10, signal()), []);
});

test("cancel, invalid input and backwards clocks cannot commit", async t => {
  const path = fixture(t);
  const store = SqliteStateStore.create(path, initial(), signal());
  t.after(() => store.close());
  await assert.rejects(store.changeLifecycle({ expectedRevision: 0, lifecycle: "awake", at }, AbortSignal.abort()));
  for (const time of ["invalid", "2025-01-01T00:00:00.000Z", "2026-01-01"]) {
    await assert.rejects(store.changeLifecycle({ expectedRevision: 0, lifecycle: "awake", at: time }, signal()));
  }
  await assert.rejects(store.events(-1, 10, signal()));
  await assert.rejects(store.events(0, 1001, signal()));
  assert.deepEqual(await store.read(signal()), initial());
  assert.deepEqual(await store.events(0, 10, signal()), []);
});

test("creation never replaces files; open never creates missing database or follows symlink", t => {
  const path = fixture(t);
  assert.throws(() => SqliteStateStore.open(path, signal()));
  assert.equal(existsSync(path), false);
  writeFileSync(path, "not a database");
  assert.throws(() => SqliteStateStore.create(path, initial(), signal()));
  assert.throws(() => SqliteStateStore.open(path, signal()));
  assert.equal(readFileSync(path, "utf8"), "not a database");
  const link = `${path}.link`;
  symlinkSync(path, link);
  assert.throws(() => SqliteStateStore.open(link, signal()), /non-symlink/);
});

test("invalid bootstrap and cancelled create do not create a file", t => {
  const path = fixture(t);
  assert.throws(() => SqliteStateStore.create(path, { ...initial(), revision: 3 }, signal()));
  assert.throws(() => SqliteStateStore.create(path, initial(), AbortSignal.abort()));
  assert.equal(existsSync(path), false);
});

test("future schema, foreign database and corrupted snapshot are rejected without reset", async t => {
  for (const kind of ["future", "foreign", "snapshot", "missing", "events", "event_chain", "personality", "bootstrap"] as const) {
    const path = `${fixture(t)}-${kind}`;
    const store = SqliteStateStore.create(path, initial(), signal());
    await store.changeLifecycle({ expectedRevision: 0, lifecycle: "awake", at }, signal());
    store.close();
    const raw = new DatabaseSync(path);
    if (kind === "future") raw.exec("PRAGMA user_version = 99");
    if (kind === "foreign") raw.exec("PRAGMA application_id = 42");
    if (kind === "snapshot") raw.prepare("UPDATE subject_state SET snapshot = ?").run(JSON.stringify({ ...initial(), revision: 1, affect: {} }));
    if (kind === "missing") raw.exec("DELETE FROM subject_state");
    if (kind === "events") raw.exec("DELETE FROM lifecycle_events");
    if (kind === "event_chain") raw.exec("UPDATE lifecycle_events SET from_state = 'awake', to_state = 'sleeping'");
    if (kind === "personality") {
      const snapshot = JSON.parse(raw.prepare("SELECT snapshot FROM subject_state").get()?.snapshot as string);
      snapshot.self.personality.curiosity = 0.9;
      raw.prepare("UPDATE subject_state SET snapshot = ?").run(JSON.stringify(snapshot));
    }
    if (kind === "bootstrap") raw.exec("DELETE FROM bootstrap");
    raw.close();
    const before = readFileSync(path);
    assert.throws(() => SqliteStateStore.open(path, signal()));
    assert.deepEqual(readFileSync(path), before);
  }
});

test("non-serializable and hidden bootstrap fields fail before file creation", t => {
  for (const kind of ["hidden", "negative-zero", "oversize"] as const) {
    const path = `${fixture(t)}-${kind}`;
    const state = initial();
    if (kind === "hidden") Object.defineProperty(state.self.identity, "name", { enumerable: false });
    if (kind === "negative-zero") (state.affect as { valence: number }).valence = -0;
    if (kind === "oversize") (state.self.identity as { name: string }).name = "a".repeat(2 * 1024 * 1024);
    assert.throws(() => SqliteStateStore.create(path, state, signal()));
    assert.equal(existsSync(path), false);
  }
});

test("a later snapshot exceeding the size bound rolls back and can be reopened", async t => {
  const path = fixture(t);
  const state = initial();
  const emptySize = Buffer.byteLength(JSON.stringify(state));
  const limit = 2 * 1024 * 1024;
  (state.self.identity as { name: string }).name += "a".repeat(limit - emptySize);
  assert.equal(Buffer.byteLength(JSON.stringify(state)), limit);
  let store = SqliteStateStore.create(path, state, signal());
  t.after(() => store.close());
  for (let revision = 0; revision < 9; revision++) {
    await store.changeLifecycle({ expectedRevision: revision, lifecycle: revision % 2 === 0 ? "awake" : "sleeping", at }, signal());
  }
  await assert.rejects(store.changeLifecycle({ expectedRevision: 9, lifecycle: "sleeping", at }, signal()), /snapshot/);
  assert.equal((await store.read(signal())).revision, 9);
  assert.equal((await store.events(0, 20, signal())).length, 9);
  store.close();
  store = SqliteStateStore.open(path, signal());
  assert.equal((await store.read(signal())).revision, 9);
});

test("in-memory and SQLite lifecycle semantics match", async t => {
  const durable = SqliteStateStore.create(fixture(t), initial(), signal());
  t.after(() => durable.close());
  const memory = new InMemoryStateStore(initial());
  for (const lifecycle of ["sleeping", "awake", "awake", "sleeping"] as const) {
    const revision = (await memory.read(signal())).revision;
    const change = { expectedRevision: revision, lifecycle, at: later };
    assert.deepEqual(await durable.changeLifecycle(change, signal()), await memory.changeLifecycle(change, signal()));
  }
  assert.deepEqual(await durable.events(0, 10, signal()), memory.events());
  durable.close(); durable.close();
  await assert.rejects(durable.read(signal()), /closed/);
});

test("separate CLI processes restore subject and refuse stale changes", t => {
  const path = fixture(t);
  const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" });
  const created = run("init", "--db", path, "--id", "one", "--name", "曙光");
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).revision, 0);
  assert.equal(run("wake", "--db", path, "--revision", "0").status, 0);
  const restored = run("status", "--db", path);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).subjectId, "one");
  assert.equal(JSON.parse(restored.stdout).lifecycle, "awake");
  assert.equal(JSON.parse(restored.stdout).revision, 1);
  assert.equal(run("sleep", "--db", path, "--revision", "0").status, 1);
  assert.equal(run("init", "--db", path, "--id", "two", "--name", "另一个").status, 1);
  assert.equal(run("sleep", "--db", path, "--revision", "1").status, 0);
  const events = run("events", "--db", path);
  assert.equal(events.status, 0, events.stderr);
  assert.equal(JSON.parse(events.stdout).events.length, 2);
});
