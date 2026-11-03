import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createInitialState } from "../../dawn/src/core/state.ts";
import { SqliteSubjectStore } from "../../dawn/src/adapters/storage/sqlite-subject.ts";
import { createTokenFile, readTokenFile } from "../../dawn/src/adapters/transport/token-file.ts";
import { startHttpServer } from "../../dawn/src/adapters/transport/http-server.ts";
import { SubjectService } from "../../dawn/src/runtime/subject-service.ts";

const signal = () => new AbortController().signal;
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
function connect(args: string[]) {
  const child = spawn(process.execPath, [main, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const replies = new Map<number, (value: any) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let id = 0, stderr = "";
  child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
  lines.on("line", line => {
    const value = JSON.parse(line);
    const pending = replies.get(value.id);
    if (pending) { replies.delete(value.id); pending(value); }
  });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  async function rpc(method: string, params: unknown = {}) {
    const requestId = ++id;
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { timers.delete(timer); replies.delete(requestId); reject(new Error("MCP fixture deadline")); }, 4000);
      timers.add(timer);
      replies.set(requestId, value => { clearTimeout(timer); timers.delete(timer); resolve(value); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
    });
  }
  return { child, rpc, async initialize() {
    const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } });
    assert.equal(init.result.protocolVersion, "2025-11-25");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }, async close(mode: "eof" | "signal" = "eof") {
    if (mode === "signal") child.kill("SIGTERM"); else child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
    try { assert.equal(await closed, 0); assert.equal(stderr, ""); }
    finally { clearTimeout(timer); for (const t of timers) clearTimeout(t); lines.close(); }
  } };
}

test("real MCP subprocess -> authenticated HTTP -> six-core SQLite commits, cold reopen and readonly gating", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "shuguang-mcp-integration-"));
  const db = join(dir, "subject.sqlite"), token = join(dir, "service.token");
  const store = SqliteSubjectStore.create(db, createInitialState("dawn", "曙光", new Date().toISOString()), 2, signal());
  createTokenFile(token);
  let calls = 0;
  const service = new SubjectService(store, { async generate() { calls++; return {
    text: JSON.stringify({ reply: "合成MCP回答", appraisal: null, candidates: [] }), modelId: "fixture",
    usage: { inputTokens: 1, outputTokens: 1 },
  }; } });
  const http = await startHttpServer({ token: readTokenFile(token), port: 0, handler: (r, s) => service.handle(r, s) });
  const args = ["--endpoint", `http://127.0.0.1:${http.port}`, "--token-file", token];
  let connection: ReturnType<typeof connect> | undefined;
  try {
    connection = connect(args); await connection.initialize();
    const listed = await connection.rpc("tools/list");
    assert.deepEqual(listed.result.tools.map((x: any) => x.name).sort(), ["shuguang_model_status", "shuguang_status"]);
    const denied = await connection.rpc("tools/call", { name: "shuguang_say", arguments: { message: "not authorized" } });
    assert.ok(denied.error || denied.result.isError); assert.equal(calls, 0);
    await connection.close(); connection = undefined;
    connection = connect([...args, "--allow-write"]); await connection.initialize();
    const wake = await connection.rpc("tools/call", { name: "shuguang_wake", arguments: { expectedRevision: 0 } });
    assert.equal(wake.result.isError ?? false, false);
    const say = await connection.rpc("tools/call", { name: "shuguang_say", arguments: { message: "用户显式授权的合成问候" } });
    assert.equal(say.result.isError ?? false, false); assert.match(JSON.stringify(say.result), /合成MCP回答/);
    assert.doesNotMatch(JSON.stringify(say.result), new RegExp(readTokenFile(token)));
    assert.equal(calls, 1);
    assert.equal((await store.read(signal())).revision, 3);
    assert.deepEqual(await store.budget(signal()), { limit: 2, reserved: 1, completed: 1, failed: 0, pending: 0 });
    const saved = await store.read(signal());
    const reopened = SqliteSubjectStore.open(db, signal());
    try { assert.deepEqual(await reopened.read(signal()), saved); } finally { reopened.close(); }
  } finally {
    try { if (connection) await connection.close(); }
    finally { await http.close(); await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test("MCP subprocess EOF and SIGTERM cancel active HTTP generation without stopping Dawn or refunding reservation", { timeout: 15000 }, async () => {
  for (const mode of ["eof", "signal"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "shuguang-mcp-cancel-"));
    const db = join(dir, "subject.sqlite"), token = join(dir, "service.token");
    const store = SqliteSubjectStore.create(db, createInitialState("dawn", "曙光", new Date().toISOString()), 1, signal());
    await store.changeLifecycle(0, "awake", new Date().toISOString(), signal());
    createTokenFile(token);
    let started!: () => void;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    const service = new SubjectService(store, { async generate(_request, abort) {
      started();
      await new Promise<void>((_resolve, reject) => {
        if (abort.aborted) reject(new Error("cancelled"));
        else abort.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
      throw new Error("unreachable");
    } });
    const http = await startHttpServer({ token: readTokenFile(token), port: 0, handler: (r, s) => service.handle(r, s) });
    const c = connect(["--endpoint", `http://127.0.0.1:${http.port}`, "--token-file", token, "--allow-write"]);
    try {
      await c.initialize();
      c.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "active", method: "tools/call", params: {
        name: "shuguang_say", arguments: { message: "explicit synthetic cancellation fixture" },
      } }) + "\n");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([dispatched, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("dispatch deadline")), 3000);
        })]);
      } finally { clearTimeout(timer); }
      await c.close(mode);
      // FIFO status acts as a barrier for the cancelled say's failed-attempt accounting.
      const status = await service.handle({ version: 1, requestId: "barrier", type: "status" }, signal());
      assert.equal(status.type, "status");
      assert.equal((await store.read(signal())).revision, 1);
      assert.equal((await store.read(signal())).experiences.length, 0);
      assert.deepEqual(await store.budget(signal()), { limit: 1, reserved: 1, completed: 0, failed: 1, pending: 0 });
    } finally {
      c.child.kill("SIGTERM");
      await http.close(); await service.close(); store.close(); rmSync(dir, { recursive: true, force: true });
    }
  }
});
