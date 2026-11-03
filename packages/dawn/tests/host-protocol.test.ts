import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import { assertHostRequest, assertHostResponse, type HostRequest, type HostResponse } from "../src/protocol/host.ts";
import { serveHostBridge } from "../src/runtime/host-bridge.ts";
import type { HostHttpClient } from "../src/adapters/transport/host-http-client.ts";

const batch = { version: 1, batchId: "batch", sessionId: "session", leafEntryId: "entry", fragments: [{
  entryId: "entry", parentEntryId: null, textBlockIndex: 0, role: "assistant", text: "Synthetic only", sourceTimestamp: "2026-01-01T00:00:00.000Z",
}] };
const base = { version: 1, requestId: "request" };

test("host protocol rejects role elevation, unknown fields, malformed sources and unbounded batches", () => {
  for (const value of [
    { ...base, type: "pair", role: "owner" }, { ...base, type: "status", executorToken: "x".repeat(43) },
    { ...base, type: "authorize", batch, expiresAt: "tomorrow" },
    { ...base, type: "accept", grantId: "grant", batch: { ...batch, fragments: [{ ...batch.fragments[0], role: "system" }] } },
    { ...base, type: "accept", grantId: "grant", batch: { ...batch, fragments: [{ ...batch.fragments[0], sourceIds: ["trusted"] }] } },
    { ...base, type: "accept", grantId: "grant", batch: { ...batch, fragments: Array.from({ length: 17 }, (_, i) => ({ ...batch.fragments[0], entryId: `entry${i}` })) } },
    { ...base, type: "accept", grantId: "grant", batch: { ...batch, fragments: [{ ...batch.fragments[0], text: "x".repeat(4001) }] } },
    { ...base, type: "accept", grantId: "grant", batch: { ...batch, fragments: [batch.fragments[0], batch.fragments[0]] } },
    { ...base, type: "execute", toolName: "web_search", args: {} },
  ]) assert.throws(() => assertHostRequest(value));
  assertHostRequest({ ...base, type: "accept", batch, grantId: "grant" });
  assertHostResponse({ ...base, type: "import", result: { batchId: "batch", status: "consumed", newSources: 1, revision: 2 } });
  for (const value of [
    { ...base, type: "status", role: "owner" }, { ...base, type: "error", code: "provider-secret" },
    { ...base, type: "paired", bindingId: "binding", executorToken: "bad", expiresAt: "2026-01-01T00:00:00.000Z" },
    { ...base, type: "import", result: { batchId: "batch", status: "mastered", newSources: 1, revision: 2 } },
  ]) assert.throws(() => assertHostResponse(value));
});

function clientStub(work?: (request: HostRequest, signal: AbortSignal) => Promise<HostResponse>) {
  const calls: HostRequest[] = []; let closed = 0;
  const client = { close() { closed++; }, async request(request: HostRequest, signal: AbortSignal): Promise<HostResponse> {
    calls.push(request);
    if (request.type === "pair") return { version: 1, requestId: request.requestId, type: "paired", bindingId: "binding", executorToken: "secret".repeat(8), expiresAt: "2099-01-01T00:00:00.000Z" };
    if (work) return work(request, signal);
    return { version: 1, requestId: request.requestId, type: "revoked" };
  } };
  return { client: client as unknown as HostHttpClient, calls, closed: () => closed };
}

test("private JSONL rejects pair injection, invalid UTF8 and oversized frames without application dispatch", async () => {
  for (const frame of [Buffer.from(JSON.stringify({ ...base, type: "pair" }) + "\n"), Buffer.from([0xff, 10]), Buffer.from("x".repeat(65537) + "\n")]) {
    const input = new PassThrough(), output = new PassThrough();
    const stub = clientStub(); let text = ""; output.on("data", chunk => { text += chunk; });
    const serving = serveHostBridge(input, output, stub.client, new AbortController().signal);
    input.write(frame);
    try { await assert.rejects(serving); assert.equal(stub.calls.length, 1); assert.equal(text, ""); assert.ok(stub.closed() > 0); }
    finally { input.destroy(); output.destroy(); }
  }
});

test("incomplete EOF is discarded and stream failures or root cancellation abort pending private work", { timeout: 5000 }, async () => {
  const incompleteIn = new PassThrough(), incompleteOut = new PassThrough();
  const incomplete = clientStub();
  const serving = serveHostBridge(incompleteIn, incompleteOut, incomplete.client, new AbortController().signal);
  incompleteIn.end(JSON.stringify({ ...base, type: "status" }));
  await serving;
  assert.equal(incomplete.calls.length, 1);
  incompleteOut.destroy();
  for (const mode of ["input-error", "output-error", "abort", "eof-buffered-tail"] as const) {
    const input = new PassThrough(), output = new PassThrough(), controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const stub = clientStub(async (_request, signal) => {
      entered();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("synthetic private error")), { once: true }));
      throw new Error("unreachable");
    });
    let text = ""; output.on("data", chunk => { text += chunk; });
    const pending = serveHostBridge(input, output, stub.client, controller.signal);
    const rejected = assert.rejects(pending);
    input.write(JSON.stringify({ ...base, type: "status" }) + "\n");
    await started;
    if (mode === "input-error") input.destroy(new Error("synthetic input secret"));
    else if (mode === "output-error") output.destroy(new Error("synthetic output secret"));
    else if (mode === "eof-buffered-tail") input.end('{"partial":');
    else controller.abort();
    await rejected;
    assert.equal(text, ""); assert.equal(stub.calls.length, 2); assert.ok(stub.closed() > 0);
    input.destroy(); output.destroy();
  }
});

test("EOF with buffered tail cancels a backpressured output without waiting for drain", { timeout: 2000 }, async () => {
  const input = new PassThrough();
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) { entered(); /* deliberately no drain */ } });
  const stub = clientStub();
  const serving = serveHostBridge(input, output, stub.client, new AbortController().signal);
  const rejected = assert.rejects(serving);
  input.write(JSON.stringify({ ...base, type: "status" }) + "\n");
  await blocked;
  input.end('{"partial":');
  await rejected;
  assert.ok(stub.closed() > 0);
  output.destroy();
});
