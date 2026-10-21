import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import dawnExtension from "../src/index.ts";
import { startHttpServer } from "../../dawn/src/adapters/transport/http-server.ts";
import { createTokenFile, readTokenFile } from "../../dawn/src/adapters/transport/token-file.ts";
import { createInitialState } from "../../dawn/src/legacy/state.ts";
import { InMemoryStateStore } from "../../dawn/src/adapters/storage/in-memory.ts";
import { DawnService } from "../../dawn/src/runtime/service.ts";

function environment(t: TestContext) {
  const endpoint = process.env.DAWN_ENDPOINT;
  const token = process.env.DAWN_TOKEN_FILE;
  delete process.env.DAWN_ENDPOINT;
  delete process.env.DAWN_TOKEN_FILE;
  t.after(() => {
    if (endpoint === undefined) delete process.env.DAWN_ENDPOINT; else process.env.DAWN_ENDPOINT = endpoint;
    if (token === undefined) delete process.env.DAWN_TOKEN_FILE; else process.env.DAWN_TOKEN_FILE = token;
  });
}
function fixture() {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const events = new Map<string, () => Promise<void>>();
  const notices: { text: string; level: string }[] = [];
  const pi = {
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, command); },
    on(name: string, handler: () => Promise<void>) { events.set(name, handler); },
  };
  dawnExtension(pi as unknown as ExtensionAPI);
  const command = commands.get("dawn");
  assert.ok(command);
  const ctx = { hasUI: true, ui: { notify: (text: string, level: string) => notices.push({ text, level }) } };
  return { commands, events, notices, command, ctx };
}

test("factory registers command and cleanup only; unavailable service never reports success", async t => {
  environment(t);
  const f = fixture();
  assert.deepEqual([...f.commands.keys()], ["dawn"]);
  assert.deepEqual([...f.events.keys()], ["session_shutdown"]);
  assert.equal(f.notices.length, 0);
  await f.command.handler("wake 0", f.ctx);
  assert.equal(f.notices[0]?.level, "error");
  assert.match(f.notices[0]?.text ?? "", /未报告成功/);
  await assert.rejects(f.command.handler("wake 0", { hasUI: false }), /未执行任何操作/);
  await f.events.get("session_shutdown")?.();
  await f.events.get("session_shutdown")?.();
});

test("registered say permits responses beyond old 15s cap; shutdown still cancels pending commands", { timeout: 22_000 }, async t => {
  environment(t);
  const dir = mkdtempSync(join(tmpdir(), "dawn-plugin-slow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenPath = join(dir, "service.token"); createTokenFile(tokenPath);
  let calls = 0;
  let entered!: () => void, aborted!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const server = await startHttpServer({ token: readTokenFile(tokenPath), port: 0, handler: async (request, signal) => {
    assert.equal(request.type, "say"); calls++;
    if (calls === 1) {
      await new Promise(resolve => setTimeout(resolve, 15_200));
      signal.throwIfAborted();
      return { version: 1, requestId: request.requestId, type: "reply", text: "慢请求正常完成" };
    }
    entered();
    await new Promise<void>(resolve => {
      if (signal.aborted) { aborted(); resolve(); return; }
      signal.addEventListener("abort", () => { aborted(); resolve(); }, { once: true });
    });
    signal.throwIfAborted();
    throw new Error("must not succeed");
  } });
  t.after(() => server.close());
  process.env.DAWN_ENDPOINT = `http://127.0.0.1:${server.port}`;
  process.env.DAWN_TOKEN_FILE = tokenPath;
  const f = fixture();
  await f.command.handler("say 合成长请求", f.ctx);
  assert.equal(f.notices.at(-1)?.text, "慢请求正常完成");
  assert.equal(f.notices.at(-1)?.level, "info");
  const pending = f.command.handler("say 合成取消", f.ctx);
  await started;
  await f.events.get("session_shutdown")?.();
  await pending;
  await cancelled;
  assert.equal(f.notices.at(-1)?.level, "error");
  assert.match(f.notices.at(-1)?.text ?? "", /未报告成功/);
});

test("configured Pi commands directly control service; plugin shutdown does not sleep it", async t => {
  environment(t);
  const dir = mkdtempSync(join(tmpdir(), "dawn-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenPath = join(dir, "service.token");
  createTokenFile(tokenPath);
  const store = new InMemoryStateStore(createInitialState("test", "曙光", "2026-01-01T00:00:00.000Z"));
  const service = new DawnService(store);
  const server = await startHttpServer({ token: readTokenFile(tokenPath), port: 0, handler: (request, signal) => service.handle(request, signal) });
  t.after(async () => { await server.close(); await service.close(); });
  process.env.DAWN_ENDPOINT = `http://127.0.0.1:${server.port}`;
  process.env.DAWN_TOKEN_FILE = tokenPath;
  const f = fixture();
  await f.command.handler("status", f.ctx);
  assert.equal(f.notices.at(-1)?.level, "info");
  await f.command.handler("wake 0", f.ctx);
  assert.match(f.notices.at(-1)?.text ?? "", /awake/);
  await f.command.handler("say 你好", f.ctx);
  assert.equal(f.notices.at(-1)?.level, "error");
  assert.match(f.notices.at(-1)?.text ?? "", /NOT_IMPLEMENTED/);
  await f.events.get("session_shutdown")?.();
  assert.equal((await store.read(new AbortController().signal)).lifecycle, "awake");
  assert.equal(store.events().length, 1);
});
