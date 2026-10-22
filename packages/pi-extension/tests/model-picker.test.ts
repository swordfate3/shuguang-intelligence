import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DawnResponse } from "../../dawn/src/protocol/index.ts";
import { createTokenFile, readTokenFile } from "../../dawn/src/adapters/transport/token-file.ts";
import { parseCommand } from "../src/client.ts";
import dawnExtension from "../src/index.ts";

type ModelState = Extract<DawnResponse, { type: "model" }>["state"];
type Reply = Omit<Extract<DawnResponse, { type: "model" }>, "version" | "requestId"> |
  Omit<Extract<DawnResponse, { type: "error" }>, "version" | "requestId"> |
  Omit<Extract<DawnResponse, { type: "reply" }>, "version" | "requestId"> |
  Omit<Extract<DawnResponse, { type: "status" }>, "version" | "requestId">;
const state: ModelState = {
  selectionRevision: 7, model: "cached/model", thinking: "low",
  levels: ["off", "low", "medium", "high", "xhigh", "max"],
  models: ["cached/model", "vendor/model with spaces - 2. label"], calls: 2, maxCalls: 4,
};
const model = (patch: Partial<ModelState> = {}): Reply => ({ type: "model", state: { ...state, ...patch } });
type Step = { command: string; reply: Reply };
type DialogOptions = { signal: AbortSignal };

/** Real DawnClient/HTTP transport, synthetic responses only; never uses a real endpoint/token. */
async function fixture(t: TestContext, steps: Step[]) {
  const oldEndpoint = process.env.DAWN_ENDPOINT;
  const oldToken = process.env.DAWN_TOKEN_FILE;
  const dir = mkdtempSync(join(tmpdir(), "dawn-picker-"));
  const tokenPath = join(dir, "service.token");
  createTokenFile(tokenPath);
  const token = readTokenFile(tokenPath);
  const requests: Record<string, unknown>[] = [];
  const failures: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/request");
      // Avoid including either synthetic or real credential values in assertion diagnostics.
      assert.ok(req.headers.authorization === `Bearer ${token}`);
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body) as Record<string, unknown>;
      const step = steps[requests.length];
      requests.push(request);
      assert.ok(step, "unexpected extra request (retry/refresh/write)");
      const { requestId: _expectedId, ...expected } = parseCommand(step.command);
      const { requestId, ...actual } = request;
      assert.deepEqual(actual, expected);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: 1, requestId, ...step.reply }));
    } catch (error) {
      failures.push(error);
      res.writeHead(500).end();
    }
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    rmSync(dir, { recursive: true, force: true });
    if (oldEndpoint === undefined) delete process.env.DAWN_ENDPOINT; else process.env.DAWN_ENDPOINT = oldEndpoint;
    if (oldToken === undefined) delete process.env.DAWN_TOKEN_FILE; else process.env.DAWN_TOKEN_FILE = oldToken;
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.DAWN_ENDPOINT = `http://127.0.0.1:${address.port}`;
  process.env.DAWN_TOKEN_FILE = tokenPath;

  const notices: { text: string; level: string }[] = [];
  const confirmations: { title: string; message: string; signal: AbortSignal }[] = [];
  const selections: { title: string; items: string[]; signal: AbortSignal }[] = [];
  let confirm: (opts: DialogOptions) => Promise<boolean> = async () => false;
  let select: (items: string[], opts: DialogOptions) => Promise<string | undefined> = async () => undefined;
  let handler!: (args: string, ctx: unknown) => Promise<void>;
  let shutdown!: () => Promise<void>;
  // The mock intentionally offers no model/history/session mutation APIs.
  dawnExtension({
    registerCommand(name: string, command: { handler: typeof handler }) {
      assert.equal(name, "dawn"); handler = command.handler;
    },
    on(event: string, callback: typeof shutdown) {
      assert.equal(event, "session_shutdown"); shutdown = callback;
    },
  } as unknown as ExtensionAPI);
  const ctx = {
    hasUI: true,
    ui: {
      notify(text: string, level: string) { notices.push({ text, level }); },
      async confirm(title: string, message: string, options: DialogOptions) {
        confirmations.push({ title, message, signal: options.signal });
        return confirm(options);
      },
      async select(title: string, items: string[], options: DialogOptions) {
        selections.push({ title, items, signal: options.signal });
        return select(items, options);
      },
    },
  };
  return {
    ctx, notices, confirmations, selections, requests, shutdown,
    run: (input: string, context: unknown = ctx) => handler(input, context),
    confirmWith: (fn: typeof confirm) => { confirm = fn; },
    selectWith: (fn: typeof select) => { select = fn; },
    verify() { assert.deepEqual(failures, []); assert.equal(requests.length, steps.length); },
  };
}

test("model picker explicitly confirms remote discovery and commits exact mapped ID with refreshed revision", async t => {
  const id = "vendor/model with spaces - 2. label";
  const f = await fixture(t, [
    { command: "model-status", reply: model() },
    { command: "models", reply: model({ selectionRevision: 8, models: ["remote/one", id] }) },
    { command: `model 8 ${id}`, reply: model({ selectionRevision: 9, model: id }) },
  ]);
  f.confirmWith(async () => true);
  f.selectWith(async items => items[1]);
  await f.run("model");
  f.verify();
  assert.equal(f.confirmations.length, 1);
  assert.match(f.confirmations[0]!.message, /当前曙光 endpoint.*GET/);
  assert.match(f.confirmations[0]!.message, /不生成.*不.*历史/);
  assert.deepEqual(f.selections[0]!.items, ["1. remote/one", `2. ${id}`]);
  assert.match(f.notices.at(-1)!.text, /selectionRevision=9/);
});

test("declining refresh uses cached directory without remote list", async t => {
  const f = await fixture(t, [
    { command: "model-status", reply: model() },
    { command: "model 7 cached/model", reply: model({ selectionRevision: 8 }) },
  ]);
  f.selectWith(async items => items[0]);
  await f.run("model");
  f.verify();
  assert.equal(f.confirmations.length, 1);
});

test("cancelling model select does not dispatch a selection", async t => {
  const f = await fixture(t, [{ command: "model-status", reply: model() }]);
  await f.run("model");
  f.verify();
  assert.equal(f.selections.length, 1);
  assert.equal(f.notices.length, 0);
});

test("explicit model ID reads status then CAS, with no implicit remote discovery", async t => {
  const id = state.models[1]!;
  const f = await fixture(t, [
    { command: "model-status", reply: model() },
    { command: `model 7 ${id}`, reply: model({ selectionRevision: 8, model: id }) },
  ]);
  await f.run(`model ${id}`);
  f.verify();
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.selections.length, 0);
});

test("unknown explicit ID fails closed without list or mutation", async t => {
  const f = await fixture(t, [{ command: "model-status", reply: model() }]);
  await f.run("model unknown/id");
  f.verify();
  assert.match(f.notices.at(-1)!.text, /不在已发现缓存/);
});

test("thinking picker exposes service levels including off with omission/capability caveats", async t => {
  const f = await fixture(t, [
    { command: "model-status", reply: model() },
    { command: "thinking 7 off", reply: model({ selectionRevision: 8, thinking: "off" }) },
  ]);
  f.selectWith(async items => items[0]);
  await f.run("thinking");
  f.verify();
  assert.deepEqual(f.selections[0]!.items, state.levels.map((level, i) => `${i + 1}. ${level}`));
  assert.match(f.notices[0]!.text, /off = 省略 reasoning_effort 参数，不保证关闭思考/);
  assert.match(f.notices[0]!.text, /不是模型能力认证/);
  assert.equal(f.confirmations.length, 0);
});

test("explicit thinking reads status and performs one CAS", async t => {
  const f = await fixture(t, [
    { command: "model-status", reply: model() },
    { command: "thinking 7 max", reply: model({ selectionRevision: 8, thinking: "max" }) },
  ]);
  await f.run("thinking max");
  f.verify();
  assert.equal(f.selections.length, 0);
});

test("thinking cancellation and unsupported levels never submit", async t => {
  const f = await fixture(t, [
    { command: "model-status", reply: model() },
    { command: "model-status", reply: model() },
  ]);
  await f.run("thinking");
  await f.run("thinking minimal");
  f.verify();
  assert.equal(f.selections.length, 1);
  assert.match(f.notices.at(-1)!.text, /不在服务 levels/);
});

test("CONFLICT is surfaced without retry, status refresh or second submission", async t => {
  const f = await fixture(t, [
    { command: "model-status", reply: model() },
    { command: "model 7 cached/model", reply: { type: "error", code: "CONFLICT", message: "synthetic conflict" } },
  ]);
  f.selectWith(async items => items[0]);
  await f.run("model");
  f.verify();
  assert.deepEqual(f.notices.at(-1), { text: "曙光：CONFLICT", level: "error" });
});

test("shutdown aborts pending select and rejects a late selected value without writing", { timeout: 3_000 }, async t => {
  const f = await fixture(t, [{ command: "model-status", reply: model() }]);
  let entered!: () => void;
  let finish!: (value: string) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.selectWith(async () => { entered(); return new Promise<string>(resolve => { finish = resolve; }); });
  const pending = f.run("model");
  await Promise.race([started, pending.then(() => { throw new Error("Command ended before opening select"); })]);
  await f.shutdown();
  await f.shutdown();
  assert.equal(f.selections[0]!.signal.aborted, true);
  finish(f.selections[0]!.items[0]!);
  await pending;
  f.verify();
  assert.equal(f.notices.at(-1)!.level, "error");
  assert.match(f.notices.at(-1)!.text, /未报告成功/);
});

test("shutdown during confirm rejects late approval before remote discovery", { timeout: 3_000 }, async t => {
  const f = await fixture(t, [{ command: "model-status", reply: model() }]);
  let entered!: () => void;
  let finish!: (value: boolean) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.confirmWith(async () => { entered(); return new Promise<boolean>(resolve => { finish = resolve; }); });
  const pending = f.run("model");
  await Promise.race([started, pending.then(() => { throw new Error("Command ended before opening confirm"); })]);
  await f.shutdown();
  assert.equal(f.confirmations[0]!.signal.aborted, true);
  finish(true);
  await pending;
  f.verify();
  assert.equal(f.selections.length, 0);
});

test("no UI fails closed before any service request", async t => {
  const f = await fixture(t, []);
  await assert.rejects(f.run("model", { hasUI: false }), /未执行任何操作/);
  await assert.rejects(f.run("thinking off", { hasUI: false }), /未执行任何操作/);
  f.verify();
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.selections.length, 0);
});

test("explicit models lists IDs; model-status displays model, thinking, revision and instance counters", async t => {
  const f = await fixture(t, [
    { command: "models", reply: model() },
    { command: "model-status", reply: model() },
  ]);
  await f.run("models");
  assert.match(f.notices.at(-1)!.text, /已发现模型目录/);
  for (const id of state.models) assert.ok(f.notices.at(-1)!.text.includes(id));
  await f.run("model-status");
  f.verify();
  const summary = f.notices.at(-1)!.text;
  for (const field of ["model=cached/model", "thinking=low", "selectionRevision=7", "calls=2", "maxCalls=4", "进程内", "不持久化"]) {
    assert.ok(summary.includes(field), field);
  }
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.selections.length, 0);
});

test("status and generated reply remain notification-only", async t => {
  const f = await fixture(t, [
    { command: "status", reply: { type: "status", lifecycle: "awake", revision: 3,
      runtime: { instanceId: "synthetic", startedAt: "2026-01-01T00:00:00.000Z", autonomy: false } } },
    { command: "say synthetic message", reply: { type: "reply", text: "synthetic reply" } },
  ]);
  await f.run("status");
  assert.match(f.notices.at(-1)!.text, /awake.*状态版本 3.*synthetic/);
  await f.run("say synthetic message");
  f.verify();
  assert.deepEqual(f.notices.at(-1), { text: "synthetic reply", level: "info" });
});

test("failed directory refresh stops without selecting stale cache", async t => {
  const f = await fixture(t, [
    { command: "model-status", reply: model() },
    { command: "models", reply: { type: "error", code: "UNAVAILABLE", message: "synthetic failure" } },
  ]);
  f.confirmWith(async () => true);
  await f.run("model");
  f.verify();
  assert.equal(f.selections.length, 0);
  assert.deepEqual(f.notices.at(-1), { text: "曙光：UNAVAILABLE", level: "error" });
});
