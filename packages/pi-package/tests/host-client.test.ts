import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHostClient, type HostClient } from "../src/host-client.ts";

const FIXED_ERROR = "曙光私有桥不可用；未能完成会话共享。";
const STATUS = { version: 1, type: "status", subjectId: "subject_1", scopeId: "scope_1", revision: 4, lifecycle: "awake", supported: true };
function tempScript(content: string, run: (script: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "shuguang-host-client-"));
  const script = join(dir, "synthetic-host.mjs");
  writeFileSync(script, content, { mode: 0o700 });
  chmodSync(script, 0o700);
  return run(script).finally(() => rmSync(dir, { recursive: true, force: true }));
}
function nodeClient(script: string, options: Parameters<typeof createHostClient>[2] = {}): HostClient {
  return createHostClient(process.execPath, [script], options);
}
function statusScript(body: string): string {
  return `import readline from 'node:readline';\nconst rl=readline.createInterface({input:process.stdin});\n` +
    `rl.on('line',line=>{const request=JSON.parse(line);${body}});\n`;
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  constructor() { super(); }
  kill(signal = "SIGTERM"): boolean { this.signals.push(signal); return true; }
  finish(): void { this.emit("close", 0, null); }
}
function fakeClient(child: FakeChild, options: Parameters<typeof createHostClient>[2] = {}): HostClient {
  return createHostClient("synthetic-child", [], { ...options, spawnProcess: (() => child) as never });
}

test("returns real status response with a request ID and never echoes helper stderr", async () => {
  await tempScript(statusScript(`process.stderr.write('synthetic secret stderr\\n');process.stdout.write(JSON.stringify({...${JSON.stringify(STATUS)},requestId:request.requestId})+'\\n');`), async script => {
    const client = nodeClient(script);
    try {
      const response = await client.request({ type: "status" });
      assert.deepEqual({ ...response, requestId: "generated" }, { ...STATUS, requestId: "generated" });
      assert.doesNotMatch(JSON.stringify(response), /synthetic secret stderr/);
    } finally { client.close(); }
  });
});

test("strictly rejects invalid UTF-8, mismatched IDs, and wrong response types", async t => {
  const cases: Array<[string, string]> = [
    ["invalid UTF-8", `process.stdout.write(Buffer.from([0xff,0x0a]));`],
    ["mismatched ID", `process.stdout.write(JSON.stringify({...${JSON.stringify(STATUS)},requestId:'wrong_id'})+'\\n');`],
    ["wrong response type", `process.stdout.write(JSON.stringify({version:1,requestId:request.requestId,type:'revoked'})+'\\n');`],
  ];
  for (const [name, code] of cases) await t.test(name, async () => {
    await tempScript(statusScript(code), async script => {
      const client = nodeClient(script);
      try { await assert.rejects(client.request({ type: "status" }), (error: Error) => error.message === FIXED_ERROR); }
      finally { client.close(); }
    });
  });
});

test("EOF before a response fails with a fixed error without retry", async () => {
  await tempScript(`process.stdin.resume();process.stdin.on('data',()=>process.exit(0));\n`, async script => {
    const client = nodeClient(script);
    try { await assert.rejects(client.request({ type: "status" }), (error: Error) => error.message === FIXED_ERROR); }
    finally { client.close(); }
  });
});

test("abort settles the pending request, terminates once, and exposes no raw error", async () => {
  const child = new FakeChild();
  const controller = new AbortController();
  const client = fakeClient(child, { signal: controller.signal, killGraceMs: 5 });
  const request = client.request({ type: "status" });
  controller.abort(new Error("synthetic private abort detail"));
  await assert.rejects(request, (error: Error) => error.message === FIXED_ERROR && !error.message.includes("private"));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  child.finish();
});

test("request timeout uses bounded SIGTERM then SIGKILL fallback for a hung child", async () => {
  const child = new FakeChild();
  const client = fakeClient(child, { requestTimeoutMs: 15, killGraceMs: 5 });
  await assert.rejects(client.request({ type: "status" }), (error: Error) => error.message === FIXED_ERROR);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  child.finish();
});

test("stdin, stdout, stderr, and child process error events are handled without uncaught exceptions", async t => {
  for (const stream of ["stdin", "stdout", "stderr", "process"] as const) await t.test(stream, async () => {
    const child = new FakeChild();
    const client = fakeClient(child, { killGraceMs: 0 });
    const pending = client.request({ type: "status" });
    const privateError = new Error("synthetic private /home/user/model.env secret");
    if (stream === "process") child.emit("error", privateError);
    else child[stream].emit("error", privateError);
    await assert.rejects(pending, (error: Error) => error.message === FIXED_ERROR && !error.message.includes("secret"));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(child.signals.includes("SIGTERM"));
    child.finish();
  });
});

test("runtime input is exact, never permits paired secrets or protocol-field overrides, and never spawns a request", async () => {
  const child = new FakeChild();
  const chunks: Buffer[] = [];
  child.stdin.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const client = fakeClient(child);
  const request = client.request;
  for (const invalid of [
    { type: "pair" },
    { type: "status", requestId: "caller_id" },
    { type: "status", version: 1 },
    { type: "status", model: "override" },
    { type: "authorize", batch: {}, expiresAt: "2026-01-01T00:00:00Z" },
  ]) {
    await assert.rejects(request(invalid as never), (error: Error) => error.message === FIXED_ERROR);
  }
  assert.equal(chunks.length, 0);
  client.close();
  child.finish();
});

test("close and external abort are idempotent and refuse later requests", async () => {
  const child = new FakeChild();
  const controller = new AbortController();
  const client = fakeClient(child, { signal: controller.signal, killGraceMs: 0 });
  const pending = client.request({ type: "status" });
  client.close();
  await assert.rejects(pending, (error: Error) => error.message === FIXED_ERROR);
  controller.abort();
  await assert.rejects(client.request({ type: "status" }), (error: Error) => error.message === FIXED_ERROR);
  child.finish();
});

test("private child output frame, partial UTF8 bytes, stderr and session byte quotas fail closed", async t => {
  for (const mode of ["frame", "partial", "stderr", "session"]) await t.test(mode, async () => {
    const child = new FakeChild();
    const client = fakeClient(child, { killGraceMs: 0 });
    if (mode === "session") {
      let bytes = 0;
      child.stdin.on("data", (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString("utf8")) as { requestId: string };
        const response = JSON.stringify({ version: 1, requestId: request.requestId, type: "import", result: null }) + " ".repeat(60000) + "\n";
        bytes += Buffer.byteLength(response);
        child.stdout.write(response);
      });
      try {
        for (let i = 0; i < 17; i++) assert.equal((await client.request({ type: "import-status", batchId: "batch" })).type, "import");
        await assert.rejects(client.request({ type: "import-status", batchId: "batch" }), (error: Error) => error.message === FIXED_ERROR);
        assert.ok(bytes > 1024 * 1024);
      } finally { client.close(); child.finish(); }
    } else {
      const pending = client.request({ type: "status" });
      if (mode === "frame") child.stdout.write("x".repeat(65537) + "\n");
      if (mode === "partial") child.stdout.write(Buffer.alloc(65537, 0xff));
      if (mode === "stderr") child.stderr.write("s".repeat(16385));
      await assert.rejects(pending, (error: Error) => error.message === FIXED_ERROR);
      client.close(); child.finish();
    }
  });
});

test("bridge exit while idle invalidates its execution signal with no pending request", async () => {
  const child = new FakeChild(), client = fakeClient(child);
  try {
    assert.equal(client.signal.aborted, false);
    child.emit("exit", 1, null);
    assert.equal(client.signal.aborted, true);
    await assert.rejects(client.request({ type: "status" }));
  } finally { client.close(); child.finish(); }
});

test("stdout EOF or explicit close invalidates execution immediately without declaring a still-live child exited", async () => {
  for (const mode of ["eof", "stream-close", "explicit"]) {
    const child = new FakeChild(), client = fakeClient(child, { killGraceMs: 5 });
    try {
      if (mode === "eof") child.stdout.emit("end");
      else if (mode === "stream-close") child.stdout.emit("close");
      else client.close();
      assert.equal(client.signal.aborted, true);
      assert.deepEqual(child.signals, ["SIGTERM"]);
      await new Promise(resolve => setTimeout(resolve, 15));
      assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"], "EOF is not proof the process exited");
      child.finish(); assert.equal(client.signal.aborted, true);
    } finally { client.close(); child.finish(); }
  }
});
