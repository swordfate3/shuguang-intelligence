import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { SqliteStateStore } from "../src/adapters/storage/sqlite.ts";
import { createInitialState } from "../src/legacy/state.ts";

const at = "2026-01-01T00:00:00.000Z";
const signal = () => new AbortController().signal;
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));

test("two independent CLI writers have exactly one CAS winner", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  SqliteStateStore.create(path, createInitialState("race", "曙光", at), signal()).close();
  const launch = async () => {
    const child = spawn(process.execPath, [entry, "wake", "--db", path, "--revision", "0"], { stdio: "ignore" });
    const [code] = await once(child, "exit");
    return code;
  };
  assert.deepEqual((await Promise.all([launch(), launch()])).sort(), [0, 1]);
  const store = SqliteStateStore.open(path, signal());
  t.after(() => store.close());
  assert.equal((await store.read(signal())).revision, 1);
  assert.equal((await store.events(0, 10, signal())).length, 1);
});

test("process termination inside a transaction rolls back partial state and events", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-crash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  SqliteStateStore.create(path, createInitialState("crash", "曙光", at), signal()).close();
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    db.exec("UPDATE subject_state SET revision=1, snapshot='{}'");
    db.exec("INSERT INTO lifecycle_events VALUES (1, 'crash:1', 'sleeping', 'awake', '2026-01-01T00:00:00.000Z')");
    process.exit(17);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, path], { encoding: "utf8" });
  assert.equal(child.status, 17, child.stderr);
  const store = SqliteStateStore.open(path, signal());
  t.after(() => store.close());
  assert.equal((await store.read(signal())).revision, 0);
  assert.deepEqual(await store.events(0, 10, signal()), []);
  await store.changeLifecycle({ expectedRevision: 0, lifecycle: "awake", at }, signal());
  assert.equal((await store.read(signal())).revision, 1);
});
