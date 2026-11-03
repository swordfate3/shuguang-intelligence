import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { startHttpMcpServer, HTTP_MAX_BODY_BYTES, HTTP_MAX_SESSIONS, HTTP_MAX_GLOBAL_IN_FLIGHT,
  type HttpMcpServerOptions } from "../src/http-server.ts";
import type { DawnRequest, DawnResponse, DawnTransport } from "../../dawn/src/protocol/index.ts";
import { startHttpServer } from "../../dawn/src/adapters/transport/http-server.ts";
import { HttpDawnTransport } from "../../dawn/src/adapters/transport/http-client.ts";

const authToken = "R".repeat(43), serviceToken = "S".repeat(43);
const publicUrl = "https://test.example/mcp";
const init = (version = "2025-11-25") => ({ protocolVersion: version, capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
const rpc = (method: string, id?: string | number, params?: unknown) => ({ jsonrpc: "2.0", method,
  ...(id === undefined ? {} : { id }), ...(params === undefined ? {} : { params }) });
function reply(r: DawnRequest): DawnResponse {
  if (r.type === "say") return { version: 1, requestId: r.requestId, type: "reply", text: "fixture reply" };
  return { version: 1, requestId: r.requestId, type: "status", lifecycle: "sleeping", revision: 0,
    runtime: { instanceId: "fixture", startedAt: "2026-01-01T00:00:00.000Z", autonomy: false } };
}
function deferred() {
  const pending: { request: DawnRequest; signal: AbortSignal; resolve: (value: DawnResponse) => void }[] = [];
  const transport: DawnTransport = { request(request, signal) { return new Promise(resolve => pending.push({ request, signal, resolve })); } };
  return { transport, pending, finish() { for (const p of pending) p.resolve(reply(p.request)); } };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await delay(5); }
  assert.fail("fixture deadline");
}
interface Response { status: number; headers: Record<string, string | string[] | undefined>; text: string; body: any }
async function fixture(extra: Partial<HttpMcpServerOptions> = {}) {
  const calls: DawnRequest[] = [];
  const server = await startHttpMcpServer({ publicUrl, authToken, serviceToken, port: 0,
    transport: { async request(r) { calls.push(r); return reply(r); } }, ...extra });
  function request(value: unknown, options: { method?: string; sid?: string; version?: string | null; headers?: Record<string, string | undefined>; raw?: Buffer; path?: string } = {}) {
    const bytes = options.raw ?? Buffer.from(value === undefined ? "" : JSON.stringify(value));
    const headers: Record<string, string> = { Host: "test.example", Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (options.sid) headers["Mcp-Session-Id"] = options.sid;
    if (options.version !== null) headers["Mcp-Protocol-Version"] = options.version ?? "2025-11-25";
    for (const [key, value] of Object.entries(options.headers ?? {})) { if (value === undefined) delete headers[key]; else headers[key] = value; }
    let client!: ReturnType<typeof httpRequest>;
    const result = new Promise<Response>((resolve, reject) => {
      client = httpRequest({ hostname: "127.0.0.1", port: server.port, path: options.path ?? "/mcp", method: options.method ?? "POST", headers, agent: false }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(chunk)); res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode!, headers: res.headers, text, body: text ? JSON.parse(text) : undefined });
        });
      });
      client.on("error", reject); client.end(bytes);
    });
    return { client, result };
  }
  const post = (value: unknown, options: Parameters<typeof request>[1] = {}) => request(value, options).result;
  async function initialize(version = "2025-11-25", ready = true) {
    const result = await post(rpc("initialize", "init", init(version)), { version: null });
    assert.equal(result.status, 200);
    const sid = result.headers["mcp-session-id"] as string;
    assert.match(sid, /^[A-Za-z0-9_-]{43}$/);
    const negotiated = result.body.result.protocolVersion as string;
    if (ready) assert.equal((await post(rpc("notifications/initialized"), { sid, version: negotiated })).status, 202);
    return { sid, version: negotiated, result };
  }
  return { server, calls, request, post, initialize };
}

test("shape-valid upstream text cannot reflect either access credential, including JSON-escaped input", async () => {
  for (const reflected of [authToken, serviceToken]) {
    const f = await fixture({ allowWrite: true, transport: { async request(r) {
      const escaped = [...reflected].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
      const text: string = JSON.parse(`"${escaped}"`);
      return { version: 1, requestId: r.requestId, type: "reply", text: `fixture ${text}` };
    } } });
    try {
      const s = await f.initialize();
      const result = await f.post(rpc("tools/call", 1, { name: "shuguang_say", arguments: { message: "chosen" } }), s);
      assert.equal(result.status, 500);
      assert.ok(!result.text.includes(authToken)); assert.ok(!result.text.includes(serviceToken));
      assert.match(result.text, /MCP response unavailable/);
    } finally { await f.server.close(); }
  }
});

test("real HTTP handshake negotiates all versions, enforces initialized and lists only true capabilities", async () => {
  const f = await fixture();
  try {
    for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "unknown"]) {
      const s = await f.initialize(version, false);
      assert.equal(s.version, version === "unknown" ? "2025-11-25" : version);
      assert.deepEqual(s.result.body.result.capabilities, { tools: {} });
      assert.equal((await f.post(rpc("tools/list", 1), s)).body.error.code, -32002);
      assert.equal((await f.post(rpc("notifications/initialized"), s)).status, 202);
      const list = await f.post(rpc("tools/list", 2), s);
      assert.equal(list.headers["content-type"], "application/json");
      assert.deepEqual(list.body.result.tools.map((t: any) => t.name), ["shuguang_status", "shuguang_model_status"]);
      assert.deepEqual((await f.post(rpc("ping", 3), s)).body.result, {});
      assert.equal((await f.post(rpc("initialize", 4, init()), s)).body.error.code, -32600);
      assert.equal((await f.post(rpc("tools/list", 5), { ...s, version: null })).status, version === "2025-03-26" ? 200 : 400);
    }
    assert.equal(f.calls.length, 0);
    assert.equal((await f.post(rpc("ping", 1))).status, 400);
    assert.equal((await f.post(rpc("ping", 1), { sid: "z".repeat(43) })).status, 404);
    assert.equal((await f.post(rpc("ping", 1), { version: "invalid" })).status, 400);
    for (const method of ["GET", "PUT", "OPTIONS"]) {
      const result = await f.post(undefined, { method }); assert.equal(result.status, 405); assert.equal(result.headers.allow, "POST, DELETE");
    }
  } finally { await f.server.close(); }
});

test("authority, exact Origin, independent timing-safe Bearer and forwarding headers cannot authorize", async () => {
  const f = await fixture();
  try {
    const s = await f.initialize();
    for (const headers of [
      { Authorization: undefined }, { Authorization: `Bearer ${serviceToken}` }, { Authorization: `Bearer ${"x".repeat(43)}` },
      { Authorization: `Basic ${authToken}` }, { Authorization: `Bearer ${authToken}x` },
    ]) assert.equal((await f.post(rpc("ping", 1), { ...s, headers })).status, 401);
    for (const headers of [
      { Host: "127.0.0.1", "X-Forwarded-Host": "test.example" }, { Host: "test.example:443" }, { Host: "TEST.EXAMPLE" },
      { Origin: "null" }, { Origin: "https://test.example/" }, { Origin: "https://test.example.evil" },
      { Origin: "http://test.example", "X-Forwarded-Proto": "https" },
    ]) assert.equal((await f.post(rpc("ping", 1), { ...s, headers })).status, 403);
    const okay = await f.post(rpc("ping", 1), { ...s, headers: { Origin: "https://test.example", "X-Forwarded-Host": "evil", "X-Forwarded-Proto": "http" } });
    assert.equal(okay.status, 200); assert.equal(okay.headers["access-control-allow-origin"], undefined);
    assert.equal((await f.post(rpc("ping", 1), { ...s, path: "/mcp?x=1" })).status, 404);
    assert.equal((await f.post(rpc("ping", 1), { ...s, headers: { "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await f.post(rpc("ping", 1), { ...s, headers: { "Content-Encoding": "gzip" } })).status, 415);
    for (const accept of ["application/json", "*/*", "application/json, text/event-stream;q=0"]) {
      assert.equal((await f.post(rpc("ping", 1), { ...s, headers: { Accept: accept } })).status, 406);
    }
  } finally { await f.server.close(); }
  await assert.rejects(fixture({ authToken: serviceToken }), /Independent/);
  await assert.rejects(fixture({ forbiddenTokens: [authToken] }), /Independent/);
  await assert.rejects(fixture({ publicUrl: "http://test.example/mcp" }), /public URL/);
});

test("single JSON, fatal UTF8 and 64KiB cap, malformed messages never dispatch", async () => {
  const f = await fixture();
  try {
    const s = await f.initialize();
    for (const raw of [Buffer.from([0xc3, 0x28]), Buffer.from("{"), Buffer.from("[]"), Buffer.from("null"),
      Buffer.from('{"jsonrpc":"2.0","id":null,"method":"ping"}'),
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}'),
      Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping","secret":"SECRET"}'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(rpc("ping", 1)))]),
      Buffer.from(`${JSON.stringify(rpc("ping", 1))}\n${JSON.stringify(rpc("ping", 2))}`)]) {
      const result = await f.post(undefined, { ...s, raw });
      assert.equal(result.status, 400); assert.doesNotMatch(result.text, /SECRET/);
    }
    const valid = Buffer.from(JSON.stringify(rpc("ping", "中文")));
    assert.equal((await f.post(undefined, { ...s, raw: Buffer.concat([valid, Buffer.alloc(HTTP_MAX_BODY_BYTES - valid.length, 32)]) })).status, 200);
    assert.equal((await f.post(undefined, { ...s, raw: Buffer.alloc(HTTP_MAX_BODY_BYTES + 1, 32) })).status, 413);
    assert.equal((await f.post(undefined, { ...s, headers: { "Content-Length": String(HTTP_MAX_BODY_BYTES + 1) } })).status, 413);
    assert.equal((await f.post(rpc("notifications/anything", undefined, { secret: "SECRET" }), s)).status, 202);
    assert.equal((await f.post(rpc("tools/call", undefined, { name: "shuguang_status" }), s)).status, 202);
    assert.equal(f.calls.length, 0);
  } finally { await f.server.close(); }
});

test("allowWrite is server-authoritative; maps to existing Dawn tools with fixed errors and no retry", async () => {
  for (const allowWrite of [false, true]) {
    const f = await fixture({ allowWrite });
    try {
      const s = await f.initialize();
      const list = await f.post(rpc("tools/list", 1), s);
      assert.equal(list.body.result.tools.length, allowWrite ? 8 : 2);
      const say = await f.post(rpc("tools/call", 2, { name: "shuguang_say", arguments: { message: "explicit chosen text" } }), s);
      if (allowWrite) { assert.equal(say.body.result.isError, undefined); assert.equal(f.calls[0]!.type, "say"); }
      else { assert.equal(say.body.error.code, -32602); assert.equal(f.calls.length, 0); }
      const status = await f.post(rpc("tools/call", 3, { name: "shuguang_status" }), s);
      assert.equal(status.body.id, 3); assert.equal(status.body.result.isError, undefined);
    } finally { await f.server.close(); }
  }
  let calls = 0;
  const f = await fixture({ transport: { async request() { calls++; throw new Error("PRIVATE_SECRET"); } } });
  try {
    const s = await f.initialize();
    const result = await f.post(rpc("tools/call", 1, { name: "shuguang_status" }), s);
    assert.equal(result.body.result.isError, true); assert.doesNotMatch(result.text, /PRIVATE_SECRET/); assert.equal(calls, 1);
  } finally { await f.server.close(); }
});

test("out-of-order replies correlate, duplicate IDs blocked; eight active slots include ignored cancellation", async () => {
  const d = deferred(), f = await fixture({ transport: d.transport });
  try {
    const s = await f.initialize();
    const waiting: Promise<Response>[] = [];
    for (let id = 0; id < 8; id++) {
      waiting.push(f.post(rpc("tools/call", id, { name: "shuguang_status" }), s));
      await until(() => d.pending.length === id + 1);
    }
    assert.equal((await f.post(rpc("tools/call", 0, { name: "shuguang_status" }), s)).status, 409);
    assert.equal((await f.post(rpc("tools/call", 8, { name: "shuguang_status" }), s)).status, 429);
    assert.equal((await f.post(rpc("notifications/cancelled", undefined, { requestId: "0" }), s)).status, 202);
    assert.equal(d.pending[0]!.signal.aborted, false);
    assert.equal((await f.post(rpc("notifications/cancelled", undefined, { requestId: 0 }), s)).status, 202);
    const cancelled = await waiting[0]!;
    assert.equal(cancelled.body.id, 0); assert.equal(cancelled.body.error.code, -32800);
    assert.equal(d.pending[0]!.signal.aborted, true);
    assert.equal((await f.post(rpc("ping", 9), s)).status, 429);
    for (const p of [...d.pending].reverse()) p.resolve(reply(p.request));
    const results = await Promise.all(waiting);
    assert.deepEqual(results.map(r => r.body.id), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal((await f.post(rpc("ping", 10), s)).status, 200);
  } finally { d.finish(); await f.server.close(); }
});

test("HTTP disconnect is NOT cancellation, idle expiry does not interrupt active work", async () => {
  const d = deferred(), f = await fixture({ transport: d.transport, idleTimeoutMs: 50 });
  try {
    const s = await f.initialize();
    const call = f.request(rpc("tools/call", 1, { name: "shuguang_status" }), s);
    const disconnected = call.result.catch(() => undefined);
    await until(() => d.pending.length === 1);
    call.client.destroy(); await disconnected;
    await delay(140);
    assert.equal(d.pending[0]!.signal.aborted, false);
    assert.equal((await f.post(rpc("ping", 2), s)).status, 200);
    const n = await f.post(rpc("notifications/cancelled", undefined, { requestId: 1 }), s);
    assert.equal(n.status, 202); assert.equal(d.pending[0]!.signal.aborted, true);
    // Even ignored cancellation is active; idle sweeps must not free this work's capacity.
    await delay(100); assert.equal((await f.post(rpc("ping", 3), s)).status, 200);
    d.finish(); await delay(140);
    assert.equal((await f.post(rpc("ping", 4), s)).status, 404);
  } finally { d.finish(); await f.server.close(); }
});

test("DELETE only closes one access session, global ignored-abort cap survives session deletion", async () => {
  const d = deferred(), f = await fixture({ transport: d.transport });
  try {
    const sessions = await Promise.all(Array.from({ length: 9 }, () => f.initialize()));
    const waiting: Promise<Response>[] = [];
    for (const s of sessions.slice(0, 8)) for (let id = 0; id < 8; id++) waiting.push(f.post(rpc("tools/call", id, { name: "shuguang_status" }), s));
    await until(() => d.pending.length === HTTP_MAX_GLOBAL_IN_FLIGHT);
    assert.equal((await f.post(rpc("ping", 90), sessions[8])).status, 429);
    assert.equal((await f.post(undefined, { ...sessions[0]!, method: "DELETE" })).status, 200);
    assert.equal((await f.post(rpc("ping", 91), sessions[0])).status, 404);
    assert.equal(d.pending.filter(p => p.signal.aborted).length, 8);
    assert.equal((await f.post(rpc("ping", 92), sessions[8])).status, 429);
    d.finish(); await Promise.all(waiting);
    assert.equal((await f.post(rpc("ping", 93), sessions[8])).status, 200);
    assert.equal((await f.post(rpc("ping", 94), sessions[1])).status, 200);
    assert.equal((await f.post(undefined, { ...sessions[0]!, method: "DELETE" })).status, 404);
  } finally { d.finish(); await f.server.close(); }
});

test("session cap is 32 random IDs; DELETE recovers access capacity without any Dawn call", async () => {
  const f = await fixture();
  try {
    const sessions = [];
    for (let i = 0; i < HTTP_MAX_SESSIONS; i++) sessions.push(await f.initialize());
    assert.equal(new Set(sessions.map(s => s.sid)).size, HTTP_MAX_SESSIONS);
    assert.equal((await f.post(rpc("initialize", 1, init()))).status, 503);
    assert.equal((await f.post(undefined, { ...sessions[0]!, method: "DELETE" })).status, 200);
    await f.initialize(); assert.equal(f.calls.length, 0);
  } finally { await f.server.close(); }
});

test("deadline aborts access, preserves active slots until actual transport settles; root abort closes sockets", async () => {
  const d = deferred(), controller = new AbortController();
  const f = await fixture({ transport: d.transport, requestTimeoutMs: 40, signal: controller.signal });
  try {
    const s = await f.initialize();
    const result = await f.post(rpc("tools/call", 1, { name: "shuguang_status" }), s);
    assert.equal(result.body.error.code, -32800); assert.equal(d.pending[0]!.signal.aborted, true);
    assert.equal((await f.post(rpc("tools/call", 1, { name: "shuguang_status" }), s)).status, 409);
    const pending = f.post(rpc("tools/call", 2, { name: "shuguang_status" }), s).catch(() => undefined);
    await until(() => d.pending.length === 2);
    controller.abort(); await f.server.done; await pending;
    assert.ok(d.pending.every(p => p.signal.aborted));
    await f.server.close();
  } finally { d.finish(); await f.server.close(); }
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(fixture({ signal: aborted.signal }));
});

test("slow incomplete body times out, aborted body is cleaned up without tool IO", async () => {
  const f = await fixture({ bodyTimeoutMs: 60 });
  try {
    const s = await f.initialize();
    const raw = connect(f.server.port, "127.0.0.1");
    const chunks: Buffer[] = [];
    const closed = new Promise<void>((resolve, reject) => { raw.on("data", c => { assert.ok(Buffer.isBuffer(c)); chunks.push(c); }); raw.on("error", reject); raw.once("close", () => resolve()); });
    raw.write(`POST /mcp HTTP/1.1\r\nHost: test.example\r\nAuthorization: Bearer ${authToken}\r\nMcp-Session-Id: ${s.sid}\r\nMcp-Protocol-Version: ${s.version}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 100\r\n\r\n{`);
    await closed;
    assert.match(Buffer.concat(chunks).toString(), /408 Request Timeout/);
    assert.equal((await f.post(rpc("ping", 1), s)).status, 200);
    const aborted = connect(f.server.port, "127.0.0.1");
    aborted.on("error", () => {});
    aborted.write("POST /mcp HTTP/1.1\r\nHost: test.example\r\nContent-Length: 100\r\n\r\n{");
    aborted.destroy();
    assert.equal(f.calls.length, 0);
  } finally { await f.server.close(); }
});

test("MCP -> existing HttpDawnTransport -> local authenticated Dawn; DELETE never closes Dawn", async () => {
  const calls: DawnRequest[] = [];
  const dawn = await startHttpServer({ token: serviceToken, port: 0, handler: async r => { calls.push(r); return reply(r); } });
  const transport = new HttpDawnTransport(`http://127.0.0.1:${dawn.port}`, serviceToken);
  const f = await fixture({ transport, allowWrite: true });
  try {
    const s = await f.initialize();
    const result = await f.post(rpc("tools/call", 1, { name: "shuguang_say", arguments: { message: "explicit fixture" } }), s);
    assert.equal(result.body.result.isError, undefined);
    assert.equal(calls.length, 1); assert.equal(calls[0]!.type, "say");
    assert.equal((await f.post(undefined, { ...s, method: "DELETE" })).status, 200);
    await f.server.close();
    const response = await transport.request({ version: 1, requestId: "after-close", type: "status" }, new AbortController().signal);
    assert.equal(response.type, "status"); assert.deepEqual(calls.map(c => c.type), ["say", "status"]);
  } finally { await f.server.close(); await dawn.close(); }
});

test("escaped maximum tool payload stays bounded; oversized upstream is sanitized and not retried", async () => {
  let calls = 0;
  const f = await fixture({ allowWrite: true, transport: { async request(r) {
    calls++;
    return { version: 1, requestId: r.requestId, type: "reply", text: "\u0001".repeat(calls === 1 ? 16000 : 16001) };
  } } });
  try {
    const s = await f.initialize();
    const id = "i".repeat(60_000);
    const first = await f.post(rpc("tools/call", id, { name: "shuguang_say", arguments: { message: "chosen" } }), s);
    assert.equal(first.status, 200); assert.equal(first.body.id, id); assert.equal(first.body.result.isError, undefined);
    assert.ok(Buffer.byteLength(first.text) <= 256 * 1024);
    const next = await f.post(rpc("tools/call", 2, { name: "shuguang_say", arguments: { message: "chosen" } }), s);
    assert.equal(next.body.result.isError, true); assert.ok(Buffer.byteLength(next.text) < 1024);
    assert.equal(calls, 2);
  } finally { await f.server.close(); }
});

test("headers beyond 32 are rejected rather than silently hiding late Origin or protocol fields", async () => {
  const f = await fixture();
  try {
    const s = await f.initialize();
    const body = JSON.stringify(rpc("tools/call", 1, { name: "shuguang_status" }));
    const necessary = ["Host: test.example", `Authorization: Bearer ${authToken}`, `Mcp-Session-Id: ${s.sid}`,
      `Mcp-Protocol-Version: ${s.version}`, "Content-Type: application/json", "Accept: application/json, text/event-stream",
      `Content-Length: ${Buffer.byteLength(body)}`];
    const padding = Array.from({ length: 32 - necessary.length }, (_, i) => `X-Pad-${i}: x`);
    for (const late of ["Origin: https://evil.example", "Mcp-Protocol-Version: unsupported", `Authorization: Bearer ${"X".repeat(43)}`]) {
      const raw = connect(f.server.port, "127.0.0.1"); const chunks: Buffer[] = [];
      const closed = new Promise<void>((resolve, reject) => {
        raw.on("data", c => { assert.ok(Buffer.isBuffer(c)); chunks.push(c); }); raw.on("error", reject); raw.once("close", () => resolve());
      });
      raw.write(`POST /mcp HTTP/1.1\r\n${[...necessary, ...padding, late].join("\r\n")}\r\n\r\n${body}`);
      await closed;
      assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1.1 431/);
    }
    assert.equal(f.calls.length, 0);
    assert.equal((await f.post(rpc("ping", 2), s)).status, 200);
  } finally { await f.server.close(); }
});

test("duplicate Host/Origin/auth/session/version headers are rejected before dispatch", async () => {
  const f = await fixture();
  try {
    const s = await f.initialize();
    const body = JSON.stringify(rpc("ping", 1));
    const headers = [`Host: test.example`, `Authorization: Bearer ${authToken}`, `Origin: https://test.example`,
      `Mcp-Session-Id: ${s.sid}`, `Mcp-Protocol-Version: ${s.version}`];
    for (const duplicate of headers) {
      const raw = connect(f.server.port, "127.0.0.1");
      const chunks: Buffer[] = [];
      const closed = new Promise<void>((resolve, reject) => { raw.on("data", c => { assert.ok(Buffer.isBuffer(c)); chunks.push(c); }); raw.on("error", reject); raw.once("close", () => resolve()); });
      raw.write(`POST /mcp HTTP/1.1\r\n${headers.join("\r\n")}\r\n${duplicate}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      await closed;
      assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1.1 40[013]/);
    }
    assert.equal(f.calls.length, 0);
    assert.equal((await f.post(rpc("ping", 1), s)).status, 200);
  } finally { await f.server.close(); }
});
