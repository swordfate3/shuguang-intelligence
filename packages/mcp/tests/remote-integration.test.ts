import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState } from "../../dawn/src/core/state.ts";
import { SqliteSubjectStore } from "../../dawn/src/adapters/storage/sqlite-subject.ts";
import { startHttpServer } from "../../dawn/src/adapters/transport/http-server.ts";
import { HttpDawnTransport } from "../../dawn/src/adapters/transport/http-client.ts";
import { SubjectService } from "../../dawn/src/runtime/subject-service.ts";
import { startHttpMcpServer } from "../src/http-server.ts";

const signal = () => AbortSignal.timeout(5000);
const publicUrl = "https://dawn-fixture.example/mcp";
const serviceToken = "s".repeat(43), authToken = "r".repeat(43);

// HTTP is solely the private proxy->gateway leg. No external host, TLS bypass or real key is used.
export function postFixture(port: number, body: unknown, session?: string, method = "POST"): Promise<{ status: number; session: string | undefined; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/mcp", method, headers: {
      Host: "dawn-fixture.example", Authorization: `Bearer ${authToken}`,
      Accept: "application/json, text/event-stream", "Content-Type": "application/json",
      ...(session ? { "Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-11-25" } : {}),
    } }, res => {
      let text = "";
      res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, session: res.headers["mcp-session-id"] as string | undefined, body: text ? JSON.parse(text) : undefined }); }
        catch { reject(new Error("Invalid synthetic MCP reply")); }
      });
      res.on("error", reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error("Synthetic MCP deadline")));
    req.on("error", reject); req.end(method === "POST" ? JSON.stringify(body) : undefined);
  });
}

test("remote MCP gateway -> actual Dawn HTTP -> same six-core SQLite: explicit wake, say, disconnect and cold reopen", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "shuguang-remote-e2e-"));
  const db = join(dir, "subject.sqlite");
  const store = SqliteSubjectStore.create(db, createInitialState("remote-same-subject", "曙光", new Date().toISOString()), 2, signal());
  let calls = 0;
  const service = new SubjectService(store, { async generate() { calls++; return {
    text: JSON.stringify({ reply: "来自独立曙光的合成回复", appraisal: null, candidates: [] }), modelId: "fixture",
    usage: { inputTokens: 1, outputTokens: 1 },
  }; } });
  const dawn = await startHttpServer({ token: serviceToken, port: 0, handler: (r, s) => service.handle(r, s) });
  const gateway = await startHttpMcpServer({ serviceToken, authToken, publicUrl, port: 0, allowWrite: true,
    transport: new HttpDawnTransport(`http://127.0.0.1:${dawn.port}`, serviceToken) });
  let id = 0;
  async function initialize() {
    const init = await postFixture(gateway.port, { jsonrpc: "2.0", id: ++id, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "remote-fixture", version: "1" },
    } });
    assert.equal(init.status, 200); assert.equal(init.body.result.protocolVersion, "2025-11-25"); assert.ok(init.session);
    const ready = await postFixture(gateway.port, { jsonrpc: "2.0", method: "notifications/initialized" }, init.session);
    assert.equal(ready.status, 202);
    return init.session!;
  }
  async function rpc(session: string, method: string, params: unknown = {}) {
    const result = await postFixture(gateway.port, { jsonrpc: "2.0", id: ++id, method, params }, session);
    assert.equal(result.status, 200); assert.equal(result.body.error, undefined); return result.body.result;
  }
  async function tool(session: string, name: string, args: unknown = {}) {
    const result = await rpc(session, "tools/call", { name, arguments: args });
    assert.equal(result.isError ?? false, false); return JSON.parse(result.content[0].text);
  }
  try {
    let session = await initialize();
    const listed = await rpc(session, "tools/list"); assert.equal(listed.tools.length, 8);
    const initial = await tool(session, "shuguang_status"); assert.equal(initial.lifecycle, "sleeping"); assert.equal(calls, 0);
    await tool(session, "shuguang_wake", { expectedRevision: initial.revision });
    const reply = await tool(session, "shuguang_say", { message: "用户准确选择发送的合成问候" });
    assert.match(JSON.stringify(reply), /来自独立曙光的合成回复/); assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(reply), new RegExp(`${serviceToken}|${authToken}`));
    const saved = await store.read(signal()); assert.equal(saved.revision, 3); assert.ok(saved.memory.records.length > 0);
    assert.equal((await postFixture(gateway.port, undefined, session, "DELETE")).status, 200);
    session = await initialize();
    const afterDisconnect = await tool(session, "shuguang_status");
    assert.equal(afterDisconnect.lifecycle, "awake"); assert.equal(afterDisconnect.revision, 3); assert.equal(calls, 1);
    await gateway.close();
    const alive = await service.handle({ version: 1, requestId: "after-gateway-close", type: "status" }, signal());
    assert.equal(alive.type, "status");
    assert.deepEqual(await store.budget(signal()), { limit: 2, reserved: 1, completed: 1, failed: 0, pending: 0 });
    const reopened = SqliteSubjectStore.open(db, signal());
    try { assert.deepEqual(await reopened.read(signal()), saved); } finally { reopened.close(); }
  } finally {
    await gateway.close(); await dawn.close(); await service.close(); store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
