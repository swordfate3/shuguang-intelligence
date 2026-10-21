import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { request as httpRequest } from "node:http";
import { startHttpServer } from "../src/adapters/transport/http-server.ts";
import type { DawnHandler, DawnRequest, DawnResponse } from "../src/protocol/index.ts";

const token = "t".repeat(43);
const requestBody: DawnRequest = { version: 1, requestId: "request-1", type: "status" };
const responseBody: DawnResponse = {
  version: 1,
  requestId: requestBody.requestId,
  type: "status",
  lifecycle: "sleeping",
  revision: 0,
  runtime: { instanceId: "test-instance", startedAt: "2026-01-01T00:00:00.000Z", autonomy: false },
};

async function serve(t: TestContext, handler: DawnHandler = async () => responseBody) {
  const server = await startHttpServer({ token, port: 0, handler });
  t.after(() => server.close());
  return {
    ...server,
    url: `http://127.0.0.1:${server.port}/v1/request`,
  };
}

function post(url: string, options: {
  token?: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
} = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest({
      host: target.hostname,
      port: Number(target.port),
      path: target.pathname,
      method: "POST",
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        "Content-Type": "application/json; charset=utf-8",
        ...(options.body === undefined ? { "Content-Length": Buffer.byteLength(JSON.stringify(requestBody)) } : {}),
        ...options.headers,
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end(options.body ?? JSON.stringify(requestBody));
  });
}

test("token format is validated and the server binds an ephemeral loopback port", async t => {
  await assert.rejects(startHttpServer({ token: "short", port: 0, handler: async () => responseBody }), /token/);
  const server = await serve(t);
  assert.ok(server.port > 0);
  const result = await post(server.url, { token });
  assert.equal(result.status, 200);
});

test("missing and incorrect bearer tokens are rejected", async t => {
  const server = await serve(t);
  assert.equal((await post(server.url)).status, 401);
  assert.equal((await post(server.url, { token: "x".repeat(43) })).status, 401);
});

test("a valid request reaches the handler and returns its protocol response", async t => {
  let received: DawnRequest | undefined;
  const server = await serve(t, async request => {
    received = request;
    return responseBody;
  });
  const result = await post(server.url, { token });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), responseBody);
  assert.deepEqual(received, requestBody);
});

test("Origin and noncanonical Host are forbidden", async t => {
  const server = await serve(t);
  assert.equal((await post(server.url, { token, headers: { Origin: "http://127.0.0.1" } })).status, 403);
  assert.equal((await post(server.url, { token, headers: { Host: `localhost:${server.port}` } })).status, 403);
});

test("oversized, malformed, invalid, and wrong-content-type requests are rejected", async t => {
  const server = await serve(t);
  assert.equal((await post(server.url, { token, body: Buffer.alloc(65 * 1024) })).status, 413);
  assert.equal((await post(server.url, { token, body: "{" })).status, 400);
  assert.equal((await post(server.url, { token, body: Buffer.from([0x7b, 0xff, 0x7d]) })).status, 400);
  assert.equal((await post(server.url, { token, body: JSON.stringify({ ...requestBody, extra: true }) })).status, 400);
  assert.equal((await post(server.url, { token, headers: { "Content-Type": "text/plain" } })).status, 400);
});

test("handler failures and invalid response envelopes are redacted as fixed 503 JSON", async t => {
  for (const handler of [
    async () => { throw new Error("private handler detail"); },
    async () => ({ ...responseBody, requestId: "wrong" }),
    async request => ({ ...responseBody, requestId: request.requestId, type: "reply", text: "🙂".repeat(16_000) }),
  ] satisfies DawnHandler[]) {
    const server = await serve(t, handler);
    const result = await post(server.url, { token });
    assert.equal(result.status, 503);
    assert.deepEqual(JSON.parse(result.body), { error: "unavailable" });
    assert.doesNotMatch(result.body, /private handler detail|wrong/);
  }
});

test("close is idempotent and aborts pending handler work", { timeout: 5_000 }, async t => {
  let handlerAborted!: () => void;
  let handlerEntered!: () => void;
  const aborted = new Promise<void>(resolve => { handlerAborted = resolve; });
  const entered = new Promise<void>(resolve => { handlerEntered = resolve; });
  const controller = new AbortController();
  const server = await startHttpServer({
    token,
    port: 0,
    signal: controller.signal,
    handler: async (_request, signal) => new Promise<DawnResponse>((_resolve, reject) => {
      handlerEntered();
      signal.addEventListener("abort", () => { handlerAborted(); reject(new Error("cancelled")); }, { once: true });
    }),
  });
  const url = `http://127.0.0.1:${server.port}/v1/request`;
  const response = post(url, { token }).catch(() => undefined);
  await entered;
  controller.abort();
  const firstClose = server.close();
  const secondClose = server.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
  await aborted;
  await response;
});

test("request timeout does not free slots for handlers that ignore abort", { timeout: 15_000 }, async t => {
  let enteredCount = 0;
  let allEntered!: () => void;
  const entered = new Promise<void>(resolve => { allEntered = resolve; });
  const server = await serve(t, async () => {
    enteredCount += 1;
    if (enteredCount === 16) allEntered();
    return new Promise<DawnResponse>(() => {});
  });
  const firstRequests = Array.from({ length: 16 }, () => post(server.url, { token }));
  await entered;
  const timedOut = await Promise.all(firstRequests);
  assert.ok(timedOut.every(result => result.status === 400));
  assert.equal((await post(server.url, { token })).status, 503);
});

test("client disconnect aborts its handler signal", { timeout: 5_000 }, async t => {
  let handlerAborted!: () => void;
  let handlerEntered!: () => void;
  const aborted = new Promise<void>(resolve => { handlerAborted = resolve; });
  const entered = new Promise<void>(resolve => { handlerEntered = resolve; });
  const server = await serve(t, async (_request, signal) => new Promise<DawnResponse>((_resolve, reject) => {
    handlerEntered();
    signal.addEventListener("abort", () => { handlerAborted(); reject(new Error("cancelled")); }, { once: true });
  }));
  const target = new URL(server.url);
  const req = httpRequest({
    host: target.hostname,
    port: Number(target.port),
    path: target.pathname,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(JSON.stringify(requestBody)),
    },
  });
  req.once("error", () => {});
  req.end(JSON.stringify(requestBody));
  await entered;
  req.destroy();
  await aborted;
});

test("disconnect during request-body iteration is contained and does not poison the server", async t => {
  let handlerCalls = 0;
  const server = await serve(t, async () => {
    handlerCalls += 1;
    return responseBody;
  });
  const target = new URL(server.url);
  const req = httpRequest({
    host: target.hostname,
    port: Number(target.port),
    path: target.pathname,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Length": 100,
    },
  });
  req.once("error", () => {});
  req.write("{\"version\":");
  await new Promise(resolve => setTimeout(resolve, 20));
  req.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(handlerCalls, 0);
  assert.equal((await post(server.url, { token })).status, 200);
});

test("invalid request target and method use fixed 404 and 405 responses", async t => {
  const server = await serve(t);
  const target = new URL(server.url);
  const request = (path: string, method: string) => new Promise<number>((resolve, reject) => {
    const req = httpRequest({ host: target.hostname, port: Number(target.port), path, method }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
  assert.equal(await request("/not-found", "POST"), 404);
  assert.equal(await request("/v1/request", "GET"), 405);
  assert.equal(await request("/v1/request?x=1", "POST"), 404);
});
