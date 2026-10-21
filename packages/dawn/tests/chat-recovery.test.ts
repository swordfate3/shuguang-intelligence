import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { SqliteChatStore } from "../src/adapters/storage/sqlite-chat.ts";
const signal = () => new AbortController().signal;
const usage = { modelId: "fake", inputTokens: 1, outputTokens: 2 };

test("independent processes contend on a live writer lock and only one reserves the final slot", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-chat-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "chat.sqlite");
  SqliteChatStore.create(path, "subject", 1, signal()).close();
  const module = new URL("../src/adapters/storage/sqlite-chat.ts", import.meta.url).href;
  // Open both before locking so their reserve calls, rather than open validation, contend.
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    import { SqliteChatStore } from ${JSON.stringify(module)};
    const s = SqliteChatStore.open(process.argv[1], 'subject', new AbortController().signal);
    const raw = new DatabaseSync(process.argv[1]);
    process.send('ready');
    process.on('message', async command => {
      if(command === 'lock') { raw.exec('BEGIN IMMEDIATE'); process.send('locked'); }
      if(command === 'release') { raw.exec('COMMIT'); process.send('released'); }
      if(command === 'reserve') {
        process.send('attempting');
        let code=0;
        try { await s.reserve(String(process.pid), 'synthetic', 0, new AbortController().signal); }
        catch(error) { code = error instanceof Error && error.message === 'Chat call budget exhausted' ? 1 : 2; }
        s.close();raw.close();process.exit(code);
      }
    });
  `;
  function launch() {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, path], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    const exited = once(child, "exit");
    return { child, exited };
  }
  const a = launch(), b = launch();
  await Promise.all([once(a.child, "message"), once(b.child, "message")]);
  const locked = once(a.child, "message"); a.child.send("lock"); assert.equal((await locked)[0], "locked");
  const attempting = once(b.child, "message"); b.child.send("reserve"); assert.equal((await attempting)[0], "attempting");
  // A demonstrably holds the live lock when B starts its reserve; let B wait briefly.
  await new Promise(resolve => setTimeout(resolve, 40));
  const released = once(a.child, "message"); a.child.send("release"); assert.equal((await released)[0], "released");
  a.child.send("reserve");
  const codes = await Promise.all([a.exited, b.exited]);
  assert.deepEqual(codes.map(result => result[0]).sort(), [0, 1]);
  const store = SqliteChatStore.open(path, "subject", signal());
  try { assert.deepEqual(await store.budget(signal()), { limit: 1, reserved: 1, completed: 0, failed: 0, pending: 1 }); }
  finally { store.close(); }
});

test("reopening preserves duplicate IDs in every state and a failed newer reservation still fences old completion", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-chat-recover-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "chat.sqlite");
  let a = SqliteChatStore.create(path, "subject", 10, signal());
  const done = await a.reserve("done", "one", 1, signal());
  await a.complete(done, "reply", usage, signal());
  const failed = await a.reserve("failed", "two", 1, signal());
  await a.fail(failed, signal());
  const pending = await a.reserve("pending", "three", 1, signal());
  a.close();
  a = SqliteChatStore.open(path, "subject", signal());
  const b = SqliteChatStore.open(path, "subject", signal());
  try {
    for (const id of ["done", "failed", "pending"]) await assert.rejects(a.reserve(id, "duplicate", 1, signal()));
    const newer = await b.reserve("new", "four", 1, signal());
    await b.fail(newer, signal());
    await assert.rejects(a.complete(pending, "late", usage, signal()));
    await a.fail(pending, signal());
    assert.deepEqual(await a.budget(signal()), { limit: 10, reserved: 4, completed: 1, failed: 3, pending: 0 });
  } finally { b.close(); a.close(); }
});
