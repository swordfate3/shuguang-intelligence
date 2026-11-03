import test from "node:test";
import assert from "node:assert/strict";
import { createTools, ToolParamsError, toolFailure } from "../src/tools.ts";
import type { DawnRequest, DawnResponse, DawnTransport } from "../../dawn/src/protocol/index.ts";

function response(request: DawnRequest): DawnResponse {
  const base = { version: 1 as const, requestId: request.requestId };
  if (request.type === "say") return { ...base, type: "reply", text: "synthetic reply" };
  if (request.type.startsWith("model-") || request.type === "thinking-select") {
    return { ...base, type: "model", state: { selectionRevision: 0, model: "fixture", thinking: "off", levels: ["off"], models: [], calls: 0, maxCalls: 1 } };
  }
  return { ...base, type: "status", revision: 0, lifecycle: "sleeping", runtime: { instanceId: "fixture", startedAt: "2026-01-01T00:00:00.000Z", autonomy: false } };
}
function fixture(allowWrite = false) {
  const calls: { request: DawnRequest; signal: AbortSignal }[] = [];
  const transport: DawnTransport = { async request(request, signal) { calls.push({ request, signal }); return response(request); } };
  return { calls, tools: createTools({ transport, allowWrite }), signal: new AbortController().signal };
}

test("read-only default and explicit write gating, conservative metadata and fresh schemas", async () => {
  const { calls, tools, signal } = fixture();
  assert.deepEqual(tools.list().map(t => t.name), ["shuguang_status", "shuguang_model_status"]);
  for (const name of ["say", "wake", "sleep", "model_list", "model_select", "thinking_select", "unknown"]) {
    await assert.rejects(tools.call(`shuguang_${name}`, {}, signal), ToolParamsError);
  }
  assert.equal(calls.length, 0);
  const writable = fixture(true).tools;
  assert.equal(writable.list().length, 8);
  for (const tool of writable.list()) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.required, Object.keys(tool.inputSchema.properties));
    assert.equal(tool.annotations.idempotentHint, tool.annotations.readOnlyHint);
  }
  const say = writable.list().find(t => t.name === "shuguang_say")!;
  assert.match(say.description, /永久调用额度.*失败不退/u);
  assert.match(say.description, /代理转述.*没有新增可信来源机制/u);
  assert.equal(say.annotations.readOnlyHint, false);
  assert.equal(say.annotations.idempotentHint, false);
  assert.equal(say.annotations.openWorldHint, true);
  const directory = writable.list().find(t => t.name === "shuguang_model_list")!;
  assert.match(directory.description, /联网.*写权限/u);
  assert.equal(directory.annotations.readOnlyHint, false);
  assert.equal(directory.annotations.openWorldHint, true);
  say.inputSchema.required.push("bad");
  assert.deepEqual(writable.list().find(t => t.name === "shuguang_say")!.inputSchema.required, ["message"]);
});

test("all tools map once to DawnRequest, exact selected text, UUIDs and signal", async () => {
  const { calls, tools, signal } = fixture(true);
  const entries: [string, Record<string, unknown>, string][] = [
    ["status", {}, "status"], ["model_status", {}, "model-status"],
    ["say", { message: "  selected text\n" }, "say"],
    ["wake", { expectedRevision: 2 }, "wake"], ["sleep", { expectedRevision: 3 }, "sleep"],
    ["model_list", {}, "model-list"], ["model_select", { expectedRevision: 4, model: "vendor/model" }, "model-select"],
    ["thinking_select", { expectedRevision: 5, thinking: "high" }, "thinking-select"],
  ];
  for (const [name, args, type] of entries) {
    const result = await tools.call(`shuguang_${name}`, args, signal);
    assert.notEqual(result.isError, true);
    const call = calls.at(-1)!;
    assert.equal(call.request.type, type);
    assert.equal(call.signal, signal);
    assert.match(call.request.requestId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);
  }
  assert.equal(calls.length, 8);
  assert.equal(new Set(calls.map(c => c.request.requestId)).size, 8);
  assert.equal((calls[2]!.request as Extract<DawnRequest, { type: "say" }>).text, "  selected text\n");
});

test("strict keys, safe integers, message/model/thinking limits reject before IO", async () => {
  const { calls, tools, signal } = fixture(true);
  const badStructure: [string, unknown][] = [
    ["status", { extra: true }], ["status", null], ["status", []], ["wake", {}],
    ["say", { text: "no" }], ["say", { message: "ok", history: ["private"] }],
    ["model_select", { expectedRevision: 0, model: "ok", endpoint: "secret" }],
    ["model_list", { refresh: true }], ["status", JSON.parse('{"__proto__":{}}')],
  ];
  for (const [name, args] of badStructure) await assert.rejects(tools.call(`shuguang_${name}`, args, signal), ToolParamsError);
  const badValue: [string, unknown][] = [
    ...[-1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1, Infinity, NaN].map(value => ["wake", { expectedRevision: value }] as [string, unknown]),
    ...["", " \n\t", "x".repeat(16001), 1].map(message => ["say", { message }] as [string, unknown]),
    ...["", " x", "x ", "x\n", "x\u200b", "x\u2028", "x".repeat(257), 1].map(model => ["model_select", { expectedRevision: 0, model }] as [string, unknown]),
    ["thinking_select", { expectedRevision: 0, thinking: "none" }],
    ["thinking_select", { expectedRevision: 0, thinking: "HIGH" }],
  ];
  for (const [name, args] of badValue) assert.deepEqual(await tools.call(`shuguang_${name}`, args, signal), toolFailure());
  assert.equal(calls.length, 0);
  for (const [name, args] of [
    ["say", { message: "x".repeat(16000) }],
    ["model_select", { expectedRevision: Number.MAX_SAFE_INTEGER, model: "x".repeat(256) }],
    ...["off", "low", "medium", "high", "xhigh", "max"].map(thinking => ["thinking_select", { expectedRevision: 0, thinking }]),
  ] as [string, unknown][]) assert.notEqual((await tools.call(`shuguang_${name}`, args, signal)).isError, true);
});

test("Unicode code-point schema bounds also enforce documented UTF-16 limits before IO", async () => {
  const { calls, tools, signal } = fixture(true);
  for (const [name, key, limit, extra] of [
    ["say", "message", 16000, {}],
    ["model_select", "model", 256, { expectedRevision: 0 }],
  ] as const) {
    const schema = tools.list().find(t => t.name === `shuguang_${name}`)!.inputSchema.properties[key] as { maxLength: number; description: string };
    assert.equal(schema.maxLength, limit);
    assert.match(schema.description, /Unicode 码点.*额外限制.*UTF-16/u);
    const accepted = "😀".repeat(limit / 2);
    const rejected = accepted + "😀";
    assert.equal(accepted.length, limit);
    assert.ok(Array.from(rejected).length <= schema.maxLength, "JSON Schema code-point maxLength alone would pass");
    assert.notEqual((await tools.call(`shuguang_${name}`, { ...extra, [key]: accepted }, signal)).isError, true);
    const before = calls.length;
    assert.deepEqual(await tools.call(`shuguang_${name}`, { ...extra, [key]: rejected }, signal), toolFailure());
    assert.equal(calls.length, before);
  }
});

test("fixed sanitized failures, validation and correlation; no retry/wake/fallback", async () => {
  const secret = "SYNTHETIC_SECRET_DO_NOT_EMIT";
  const failures: ((r: DawnRequest) => unknown)[] = [
    () => { throw new Error(secret); },
    r => ({ version: 1, requestId: r.requestId, type: "error", code: "UNAVAILABLE", message: secret }),
    r => ({ ...response(r), secret }),
    r => ({ ...response(r), requestId: "wrong" }),
    r => ({ version: 1, requestId: r.requestId, type: "reply", text: secret }),
  ];
  for (const fail of failures) {
    let calls = 0;
    const tools = createTools({ transport: { async request(r) { calls++; return fail(r) as DawnResponse; } } });
    const result = await tools.call("shuguang_status", {}, new AbortController().signal);
    assert.deepEqual(result, toolFailure());
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(calls, 1);
  }
});

test("abort before dispatch and after ignored cancellation suppress success", async () => {
  const controller = new AbortController(); controller.abort();
  const first = fixture(true);
  assert.deepEqual(await first.tools.call("shuguang_say", { message: "chosen" }, controller.signal), toolFailure());
  assert.equal(first.calls.length, 0);
  const late = new AbortController();
  const tools = createTools({ transport: { async request(r) { late.abort(); return response(r); } } });
  assert.deepEqual(await tools.call("shuguang_status", {}, late.signal), toolFailure());
});
