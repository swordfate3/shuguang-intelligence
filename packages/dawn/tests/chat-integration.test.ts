import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { RequestListener } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { runCli } from "../src/runtime/cli.ts";
import { runServer } from "../src/runtime/serve.ts";
import { createTokenFile, readTokenFile } from "../src/adapters/transport/token-file.ts";
import { HttpDawnTransport } from "../../pi-extension/src/http-transport.ts";
import { SqliteChatStore } from "../src/adapters/storage/sqlite-chat.ts";
import { SqliteStateStore } from "../src/adapters/storage/sqlite.ts";
import { randomUUID } from "node:crypto";

const signal = () => new AbortController().signal;
async function upstream(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/v1`;
}
async function fixture(t: TestContext, baseUrl: string, limit = 2) {
  const dir = mkdtempSync(join(tmpdir(), "dawn-chat-integration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "subject.sqlite"), chat = join(dir, "chat.sqlite"), token = join(dir, "service.token"), config = join(dir, "model.json");
  const env = `DAWN_SYNTH_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  process.env[env] = "synthetic-integration-key";
  t.after(() => { delete process.env[env]; });
  writeFileSync(config, JSON.stringify({ baseUrl, model: "synthetic-model", credentialEnv: env, maxCalls: 3, reasoningEffort: "low" }));
  await runCli(["init", "--db", db, "--id", "test-subject", "--name", "曙光"], signal());
  await runCli(["chat-init", "--db", db, "--chat-db", chat, "--limit", String(limit)], signal());
  await runCli(["wake", "--db", db, "--revision", "0"], signal());
  createTokenFile(token);
  const args = ["--db", db, "--chat-db", chat, "--token-file", token, "--port", "0", "--model-config", config];
  async function start() {
    const controller = new AbortController();
    let ready!: (endpoint: string) => void;
    const endpoint = new Promise<string>(resolve => { ready = resolve; });
    const running = runServer(args, controller.signal, result => ready(result.endpoint));
    const url = await Promise.race([endpoint, running.then(() => { throw new Error("Stopped before ready"); })]);
    const transport = new HttpDawnTransport(url, readTokenFile(token));
    return { stop: async () => { controller.abort(); await running; }, transport };
  }
  return { db, chat, args, start };
}

test("config -> HTTP -> model dialogue survives restart; persistent quota cannot reset with new model instance", async t => {
  const received: { role: string; content: string }[][] = [];
  const baseUrl = await upstream(t, async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-integration-key");
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw);
    received.push(body.messages);
    const text = received.length === 1 ? "合成回复一" : "合成回复二";
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
  });
  const f = await fixture(t, baseUrl);
  let service = await f.start();
  try {
    assert.equal((await service.transport.request({ version: 1, type: "say", requestId: "one", text: "合成消息一" }, signal())).type, "reply");
  } finally { await service.stop(); }
  service = await f.start();
  try {
    assert.equal((await service.transport.request({ version: 1, type: "say", requestId: "two", text: "接着之前说" }, signal())).type, "reply");
    assert.deepEqual(received[1]?.slice(1), [
      { role: "user", content: "合成消息一" }, { role: "assistant", content: "合成回复一" }, { role: "user", content: "接着之前说" },
    ]);
    const denied = await service.transport.request({ version: 1, type: "say", requestId: "three", text: "超过永久预算" }, signal());
    assert.equal(denied.type, "error");
    assert.equal(received.length, 2);
  } finally { await service.stop(); }
  const chat = SqliteChatStore.open(f.chat, "test-subject", signal());
  try { assert.deepEqual(await chat.budget(signal()), { limit: 2, reserved: 2, completed: 2, failed: 0, pending: 0 }); }
  finally { chat.close(); }
  const state = SqliteStateStore.open(f.db, signal());
  try { assert.equal((await state.read(signal())).revision, 1); }
  finally { state.close(); }
});

test("stopping a service aborts in-flight upstream; charged failure is not conversation history", async t => {
  let dispatched!: () => void;
  const started = new Promise<void>(resolve => { dispatched = resolve; });
  const baseUrl = await upstream(t, async (req, res) => {
    for await (const _chunk of req) { /* drain synthetic body */ }
    dispatched();
    res.on("error", () => undefined);
    // Intentionally never sends headers. Service abort must cancel fetch and drain.
  });
  const f = await fixture(t, baseUrl);
  const service = await f.start();
  const pending = service.transport.request({ version: 1, type: "say", requestId: "cancelled", text: "合成取消测试" }, signal());
  const observed = pending.then(() => undefined, () => undefined);
  try {
    await Promise.race([started, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("No dispatch")), 2000); timer.unref(); })]);
  } finally { await service.stop(); }
  await observed;
  const chat = SqliteChatStore.open(f.chat, "test-subject", signal());
  try { assert.deepEqual(await chat.budget(signal()), { limit: 2, reserved: 1, completed: 0, failed: 1, pending: 0 }); }
  finally { chat.close(); }
});

test("model-enabled serve requires an explicitly existing chat DB; CLI never resets budgets", async t => {
  const baseUrl = await upstream(t, (_req, res) => { res.writeHead(500); res.end(); });
  const f = await fixture(t, baseUrl);
  await assert.rejects(runCli(["chat-init", "--db", f.db, "--chat-db", f.chat, "--limit", "9"], signal()));
  const budget = await runCli(["chat-budget", "--db", f.db, "--chat-db", f.chat], signal());
  assert.deepEqual(budget, { subjectId: "test-subject", chatCreated: false, budget: { limit: 2, reserved: 0, completed: 0, failed: 0, pending: 0 } });
  const withoutChat = f.args.filter((_, i, args) => args[i] !== "--chat-db" && args[i - 1] !== "--chat-db");
  await assert.rejects(runServer(withoutChat, signal(), () => assert.fail("must not start without ledger")));
  await assert.rejects(runServer(f.args.map(value => value === f.chat ? `${f.chat}.missing` : value), signal(), () => assert.fail("must not create ledger")));
});
