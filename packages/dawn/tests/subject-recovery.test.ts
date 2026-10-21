import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInitialState } from "../src/core/state.ts";
import { SqliteSubjectStore } from "../src/adapters/storage/sqlite-subject.ts";
const signal = () => new AbortController().signal;
const at = "2026-01-01T00:00:00.000Z";

test("independent subject processes contend under a live write lock: final quota is reserved exactly once, pending survives crash", { timeout: 10_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-subject-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "subject.sqlite");
  const initial = SqliteSubjectStore.create(path, createInitialState("subject", "合成", at), 1, signal());
  await initial.changeLifecycle(0, "awake", at, signal()); initial.close();
  const module = new URL("../src/adapters/storage/sqlite-subject.ts", import.meta.url).href;
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    import { SqliteSubjectStore } from ${JSON.stringify(module)};
    const signal = () => new AbortController().signal;
    const store = SqliteSubjectStore.open(process.argv[1], signal());
    const raw = new DatabaseSync(process.argv[1]);
    process.send('ready');
    process.on('message', async command => {
      if (command === 'lock') { raw.exec('BEGIN IMMEDIATE'); process.send('locked'); }
      if (command === 'release') { raw.exec('COMMIT'); process.send('released'); }
      if (command === 'reserve') {
        process.send('attempting');
        let code = 0;
        try { await store.reserve('worker_' + process.pid, '合成', 1, signal()); }
        catch (error) { code = error instanceof Error && error.message === 'Subject call budget exhausted' ? 1 : 2; }
        // Exit without failing pending: simulate crash after durable T1.
        process.exit(code);
      }
    });
  `;
  function launch() {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, path], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    return { child, exited: once(child, "exit") };
  }
  const a = launch(), b = launch();
  await Promise.all([once(a.child, "message"), once(b.child, "message")]);
  const lock = once(a.child, "message"); a.child.send("lock"); assert.equal((await lock)[0], "locked");
  const attempt = once(b.child, "message"); b.child.send("reserve"); assert.equal((await attempt)[0], "attempting");
  await new Promise(r => setTimeout(r, 40));
  const release = once(a.child, "message"); a.child.send("release"); assert.equal((await release)[0], "released");
  a.child.send("reserve");
  const exits = await Promise.all([a.exited, b.exited]);
  assert.deepEqual(exits.map(e => e[0]).sort(), [0, 1], "unexpected SQLite/worker errors must not be mistaken for quota refusal");
  const store = SqliteSubjectStore.open(path, signal());
  try {
    assert.deepEqual(await store.budget(signal()), { limit: 1, reserved: 1, completed: 0, failed: 0, pending: 1 });
    assert.equal((await store.read(signal())).revision, 1);
    assert.deepEqual(await store.history(signal()), []);
    await assert.rejects(store.reserve("after_restart", "不得自动退还", 1, signal()), /budget exhausted/);
  } finally { store.close(); }
});
