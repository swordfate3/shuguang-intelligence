import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { createServer } from "node:http";
import type { RequestListener } from "node:http";
import { HttpDawnTransport, parseDawnEndpoint } from "../src/http-transport.ts";
import { startHttpServer } from "../../dawn/src/adapters/transport/http-server.ts";
import { MAX_WIRE_BYTES } from "../../dawn/src/protocol/index.ts";

const token = "t".repeat(43);
const request = { version: 1 as const, requestId: "test-request", type: "status" as const };
const status = { ...request, lifecycle: "sleeping" as const, revision: 0,
  runtime: { instanceId: "test-instance", startedAt: "2026-01-01T00:00:00.000Z", autonomy: false as const } };
const signal = () => AbortSignal.timeout(2000);
async function server(t: TestContext, listener: RequestListener) {
  const http = createServer(listener);
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("transport only accepts explicit canonical loopback endpoint and token", () => {
  for (const endpoint of ["http://localhost:1234", "https://127.0.0.1:1234", "http://127.0.0.1", "http://127.0.0.1:0",
    "http://127.0.0.1:65536", "http://127.0.0.1:1234/", "http://127.0.0.1:1234?q=x", "http://127.0.0.1:1234#x",
    "http://user:password@127.0.0.1:1234", "http://192.168.1.1:1234"]) {
    assert.throws(() => new HttpDawnTransport(endpoint, token));
  }
  assert.throws(() => new HttpDawnTransport("http://127.0.0.1:1234", "short"));
});

test("canonical Host preserves the explicit HTTP default port", () => {
  assert.deepEqual(parseDawnEndpoint("http://127.0.0.1:80"), { port: 80, host: "127.0.0.1:80" });
  assert.deepEqual(parseDawnEndpoint("http://127.0.0.1:7341"), { port: 7341, host: "127.0.0.1:7341" });
});

test("transport talks to actual authenticated server without a Pi model", async t => {
  const http = await startHttpServer({ token, port: 0, handler: async () => status });
  t.after(() => http.close());
  const endpoint = `http://127.0.0.1:${http.port}`;
  const transport = new HttpDawnTransport(endpoint, token);
  assert.deepEqual(await transport.request(request, signal()), status);
  await assert.rejects(new HttpDawnTransport(endpoint, "x".repeat(43)).request(request, signal()));
});

test("redirects are never followed and credentials never reach another endpoint", async t => {
  let leaked = false;
  const destination = await server(t, (_req, res) => { leaked = true; res.end(); });
  const source = await server(t, (_req, res) => { res.writeHead(307, { Location: destination }); res.end(); });
  await assert.rejects(new HttpDawnTransport(source, token).request(request, signal()));
  assert.equal(leaked, false);
});

test("schema, correlation, response type, UTF8 and size failures are rejected", async t => {
  for (const body of [
    "{", JSON.stringify({ ...status, requestId: "other" }), JSON.stringify({ ...status, revision: -1 }),
    JSON.stringify({ version: 1, requestId: request.requestId, type: "reply", text: "not status" }),
    JSON.stringify({ ...status, extra: true }), Buffer.from([0xff]), "x".repeat(MAX_WIRE_BYTES + 1),
  ]) {
    const endpoint = await server(t, (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); res.end(body);
    });
    await assert.rejects(new HttpDawnTransport(endpoint, token).request(request, signal()));
  }
});

test("invalid request is not dispatched; timeout and caller cancellation do not become success", async t => {
  let calls = 0;
  const endpoint = await server(t, (_req, res) => { calls++; res.writeHead(200, { "Content-Type": "application/json" }); });
  const transport = new HttpDawnTransport(endpoint, token);
  await assert.rejects(transport.request({ ...request, version: 2 } as unknown as typeof request, signal()));
  await assert.rejects(transport.request(request, AbortSignal.abort()));
  assert.equal(calls, 0);
  await assert.rejects(transport.request(request, AbortSignal.timeout(50)));
});
