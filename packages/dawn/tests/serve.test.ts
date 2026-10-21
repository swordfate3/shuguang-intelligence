import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runServer } from "../src/runtime/serve.ts";
import { createInitialState } from "../src/legacy/state.ts";
import { SqliteStateStore } from "../src/adapters/storage/sqlite.ts";
import { createTokenFile } from "../src/adapters/transport/token-file.ts";

const signal = () => new AbortController().signal;
test("invalid serve arguments or credentials never initialize missing database", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-serve-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "state.sqlite");
  const token = join(dir, "service.token");
  for (const args of [[], ["--db", db], ["--db", "relative", "--token-file", token, "--port", "0"],
    ["--db", db, "--token-file", token, "--port", "65536"],
    ["--db", db, "--token-file", token, "--port", "1.5"],
    ["--db", db, "--token-file", token, "--port", "0", "--port", "1"],
    ["--db", db, "--token-file", token, "--port", "0"],
  ]) await assert.rejects(runServer(args, signal(), () => assert.fail("must not be ready")));
  assert.deepEqual(readdirSync(dir), []);
});

test("port collision fails startup without affecting the running service or database", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-serve-collision-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "state.sqlite");
  const token = join(dir, "service.token");
  SqliteStateStore.create(db, createInitialState("test", "曙光", "2026-01-01T00:00:00.000Z"), signal()).close();
  createTokenFile(token);
  const controller = new AbortController();
  let ready!: (value: string) => void;
  const endpoint = new Promise<string>(resolve => { ready = resolve; });
  const serving = runServer(["--db", db, "--token-file", token, "--port", "0"], controller.signal, status => ready(status.endpoint));
  try {
    const url = new URL(await endpoint);
    await assert.rejects(runServer(["--db", db, "--token-file", token, "--port", url.port], signal(), () => assert.fail("must not be ready")));
  } finally { controller.abort(); await serving; }
  const store = SqliteStateStore.open(db, signal());
  try { assert.equal((await store.read(signal())).revision, 0); }
  finally { store.close(); }
});

test("serve abort closes listener and store without changing lifecycle", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-serve-close-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "state.sqlite");
  const token = join(dir, "service.token");
  SqliteStateStore.create(db, createInitialState("test", "曙光", "2026-01-01T00:00:00.000Z"), signal()).close();
  createTokenFile(token);
  const controller = new AbortController();
  let endpoint = "";
  await runServer(["--db", db, "--token-file", token, "--port", "0"], controller.signal, ready => {
    endpoint = ready.endpoint;
    controller.abort();
  });
  assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  await assert.rejects(fetch(`${endpoint}/v1/request`, { signal: AbortSignal.timeout(1000) }));
  const store = SqliteStateStore.open(db, signal());
  try {
    assert.equal((await store.read(signal())).lifecycle, "sleeping");
    assert.equal((await store.events(0, 10, signal())).length, 0);
  } finally { store.close(); }
});
