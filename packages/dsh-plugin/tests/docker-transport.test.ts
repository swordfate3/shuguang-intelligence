import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { DockerDawnTransport, DockerTransportError } from "../src/docker-transport.ts";
import type { DockerChildProcess, DockerSpawnOptions, DockerSpawnRunner, DockerTransportErrorCode } from "../src/docker-transport.ts";
import { CONTROL_TIMEOUT_MS, MAX_WIRE_BYTES, SAY_CLIENT_TIMEOUT_MS } from "../../dawn/src/protocol/index.ts";
import type { DawnRequest, DawnResponse } from "../../dawn/src/protocol/index.ts";

const project = resolve("synthetic docker project & echo NEVER_RUN ; $(not-a-shell) ' quoted");
const request: DawnRequest = { version: 1, requestId: "synthetic-request", type: "status" };
const status: DawnResponse = {
  version: 1, requestId: request.requestId, type: "status", lifecycle: "sleeping", revision: 0,
  runtime: { instanceId: "synthetic-instance", startedAt: "2026-01-01T00:00:00.000Z", autonomy: false },
};
const secret = "SYNTHETIC_RAW_STDERR_CREDENTIAL_PATH";
const redacted = (code: DockerTransportErrorCode) => (error: unknown) => {
  assert.ok(error instanceof DockerTransportError);
  assert.equal(error.code, code);
  assert.equal(Object.hasOwn(error, "cause"), false);
  assert.doesNotMatch(String(error) + JSON.stringify(error), new RegExp(secret));
  return true;
};
class FakeChild extends EventEmitter implements DockerChildProcess {
  readonly writes: Buffer[] = [];
  readonly stdin = new Writable({ write: (chunk: Buffer, _encoding, done) => { this.writes.push(Buffer.from(chunk)); done(); } });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kills = 0;
  kill() { this.kills++; return true; }
  async complete(output: Buffer | string, code: number | null = 0, signal: string | null = null) {
    this.stdout.end(output);
    this.stderr.end();
    await setImmediate();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
  assertCleaned() {
    assert.equal(this.kills, 1);
    assert.equal(this.stdin.destroyed, true);
    assert.equal(this.stdout.destroyed, true);
    assert.equal(this.stderr.destroyed, true);
  }
}
function fixture(context?: string) {
  const children: FakeChild[] = [];
  const calls: { command: string; args: readonly string[]; options: DockerSpawnOptions }[] = [];
  const spawnRunner: DockerSpawnRunner = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new FakeChild(); children.push(child); return child;
  };
  const transport = new DockerDawnTransport({ dockerProjectDir: project, ...(context === undefined ? {} : { dockerContext: context }) }, { spawnRunner });
  return { transport, calls, children, start(input: DawnRequest = request, signal: AbortSignal = new AbortController().signal) {
    const pending = transport.request(input, signal);
    assert.equal(children.length, calls.length);
    return { pending, child: children.at(-1)! };
  } };
}
const line = (value: unknown) => JSON.stringify(value) + "\n";

test("constructor validates explicit absolute directory and context without filesystem I/O or spawning", () => {
  let calls = 0;
  const spawnRunner: DockerSpawnRunner = () => { calls++; throw new Error(secret); };
  const dependencies = { spawnRunner };
  for (const dir of ["", "relative", ".", "--project-directory", project + "\u0000", project + "\n", project + "\r", project + "\u007f", resolve("a".repeat(32_768))]) {
    assert.throws(() => new DockerDawnTransport({ dockerProjectDir: dir }, dependencies), redacted("INVALID_CONFIG"));
  }
  for (const context of ["", " ", "--host", "desktop linux", "tcp://remote:2375", "a\nb", "a".repeat(129)]) {
    assert.throws(() => new DockerDawnTransport({ dockerProjectDir: project, dockerContext: context }, dependencies), redacted("INVALID_CONFIG"));
  }
  for (const dockerProjectName of ["", "UpperCase", "--project", "a.b", "a/b", "a b", "a\nb", "a".repeat(129)]) {
    assert.throws(() => new DockerDawnTransport({ dockerProjectDir: project, dockerProjectName }, dependencies), redacted("INVALID_CONFIG"));
  }
  new DockerDawnTransport({ dockerProjectDir: resolve("does-not-exist", "compose-is-not-read"), dockerContext: "desktop-linux", dockerProjectName: "existing_dawn-1" }, dependencies);
  assert.equal(calls, 0);
});

test("invalid request and pre-abort do not spawn or expose abort reason", async () => {
  const f = fixture();
  await assert.rejects(f.transport.request({ ...request, extra: secret } as DawnRequest, new AbortController().signal), redacted("INVALID_REQUEST"));
  await assert.rejects(f.transport.request({ version: 1, requestId: "x", type: "say", text: "x".repeat(16_001) }, new AbortController().signal), redacted("INVALID_REQUEST"));
  await assert.rejects(f.transport.request({ ...request, requestId: secret.repeat(1000) }, new AbortController().signal), redacted("INVALID_REQUEST"));
  await assert.rejects(f.transport.request(request, AbortSignal.abort(new Error(secret))), redacted("CANCELLED"));
  assert.equal(f.calls.length, 0);
});

test("fixed command and argv keep malicious directory a single argument, with no shell/startup or environment options", async () => {
  const f = fixture(); const { pending, child } = f.start();
  assert.deepEqual(f.calls, [{ command: "docker", args: ["--context", "default", "compose", "--project-directory", project,
    "-f", join(project, "compose.yaml"), "exec", "-T", "dawn", "dawn-container", "bridge-request"],
  options: { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] } }]);
  assert.deepEqual(child.writes, [Buffer.from(line(request))]);
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(child.stdin.destroyed, false);
  child.stdout.write(line(status));
  await setImmediate();
  assert.equal(child.stdin.writableEnded, false); // response bytes alone do not terminate stdin
  assert.equal(child.kills, 0);
  await child.complete("");
  assert.deepEqual(await pending, status);
  child.assertCleaned();
});

test("explicit desktop-linux context is fixed before compose and never inferred from host environment", async () => {
  const f = fixture("desktop-linux"); const { pending, child } = f.start();
  assert.deepEqual(f.calls[0]!.args.slice(0, 3), ["--context", "desktop-linux", "compose"]);
  assert.equal(Object.hasOwn(f.calls[0]!.options, "env"), false);
  await child.complete(line(status)); await pending; child.assertCleaned();
});

test("an explicit existing Compose project name is one safe argv and never starts a new project", async () => {
  const child = new FakeChild(); let args: readonly string[] = [];
  const transport = new DockerDawnTransport({ dockerProjectDir: project, dockerContext: "desktop-linux", dockerProjectName: "existing_dawn-1" }, {
    spawnRunner: (_command, value) => { args = value; return child; },
  });
  const pending = transport.request(request, new AbortController().signal);
  assert.deepEqual(args, ["--context", "desktop-linux", "compose", "--project-directory", project, "--project-name", "existing_dawn-1",
    "-f", join(project, "compose.yaml"), "exec", "-T", "dawn", "dawn-container", "bridge-request"]);
  await child.complete(line(status)); await pending; child.assertCleaned();
});

test("UTF8 split across chunks decodes correctly, and escaped message newlines stay on the one stdin line", async () => {
  const input: DawnRequest = { version: 1, requestId: "say", type: "say", text: "你好\n独立输入" };
  const response: DawnResponse = { version: 1, requestId: "say", type: "reply", text: "中文回复" };
  const f = fixture(); const { pending, child } = f.start(input);
  assert.equal(child.writes[0]!.toString().split("\n").length, 2);
  assert.deepEqual(JSON.parse(child.writes[0]!.toString()), input);
  const wire = Buffer.from(line(response)); const split = wire.indexOf(Buffer.from("中")) + 1;
  child.stdout.write(wire.subarray(0, split));
  await child.complete(wire.subarray(split));
  assert.deepEqual(await pending, response); child.assertCleaned();
});

test("single-line framing, fatal UTF8, schema and correlation errors are rejected without raw output", async () => {
  const cases: (Buffer | string)[] = [
    "", JSON.stringify(status), "\n", JSON.stringify(status) + "\r\n", "\r" + line(status), line(status) + line(status), line(status) + "\n", "log\n" + line(status),
    "  log " + line(status), "{not-json}\n", "null\n", "[]\n", "{}\n", "\ufeff" + line(status),
    Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]),
    line({ ...status, requestId: "wrong" }), line({ ...status, version: 2 }), line({ ...status, extra: secret }),
    line({ version: 1, requestId: request.requestId, type: "reply", text: secret }),
    line({ ...status, runtime: { ...status.runtime, autonomy: true } }),
  ];
  for (const output of cases) {
    const f = fixture(); const { pending, child } = f.start();
    const rejected = assert.rejects(pending, redacted("INVALID_RESPONSE"));
    await child.complete(output); await rejected; child.assertCleaned();
  }
});

test("model/control/say response classes exactly match HTTP transport, but valid application errors remain typed", async () => {
  const state = { selectionRevision: 1, model: "synthetic", thinking: "off", levels: ["off"], models: ["synthetic"], calls: 0, maxCalls: 4 };
  for (const type of ["model-status", "model-list", "model-select", "thinking-select", "wake", "sleep", "say"] as const) {
    const input: DawnRequest = type === "model-select" ? { ...request, type, expectedRevision: 0, model: "synthetic" } :
      type === "thinking-select" ? { ...request, type, expectedRevision: 0, thinking: "off" } :
      type === "wake" || type === "sleep" ? { ...request, type, expectedRevision: 0 } :
      type === "say" ? { ...request, type, text: "合成输入" } : { ...request, type };
    const good = type.startsWith("model") || type === "thinking-select" ? { version: 1, requestId: request.requestId, type: "model", state } :
      type === "say" ? { version: 1, requestId: request.requestId, type: "reply", text: "合成回复" } : status;
    const f = fixture(); const first = f.start(input);
    await first.child.complete(line(good)); assert.deepEqual(await first.pending, good); first.child.assertCleaned();
    const second = f.start(input); const rejected = assert.rejects(second.pending, redacted("INVALID_RESPONSE"));
    await second.child.complete(line(good.type === "status" ? { version: 1, requestId: request.requestId, type: "reply", text: "wrong" } : status));
    await rejected; second.child.assertCleaned();
    const third = f.start(input);
    const error = { version: 1, requestId: request.requestId, type: "error", code: "CONFLICT", message: "synthetic application failure" };
    await third.child.complete(line(error)); assert.deepEqual(await third.pending, error); third.child.assertCleaned();
  }
});

test("stdout 64KiB ceiling includes LF, accepts exact boundary and rejects overflow immediately", async () => {
  const input: DawnRequest = { version: 1, requestId: "say", type: "say", text: "fixture" };
  const base = { version: 1, requestId: "say", type: "reply", text: "界".repeat(16_000) };
  const encoded = line(base);
  const padding = MAX_WIRE_BYTES - Buffer.byteLength(encoded);
  assert.ok(padding > 0);
  const f = fixture(); const first = f.start(input);
  await first.child.complete(" ".repeat(padding) + encoded);
  assert.deepEqual(await first.pending, base); first.child.assertCleaned();
  const second = f.start(input); const rejected = assert.rejects(second.pending, redacted("INVALID_RESPONSE"));
  second.child.stdout.write(Buffer.alloc(MAX_WIRE_BYTES, 32));
  assert.equal(second.child.kills, 0);
  second.child.stdout.write(Buffer.from("x"));
  await rejected; second.child.assertCleaned();
});

test("stderr is discarded under a bounded budget and never substituted for protocol JSON", async () => {
  const f = fixture(); const first = f.start();
  first.child.stderr.write(secret); await first.child.complete(line(status));
  assert.deepEqual(await first.pending, status); first.child.assertCleaned();
  const second = f.start(); const rejected = assert.rejects(second.pending, redacted("UNAVAILABLE"));
  second.child.stderr.write(Buffer.alloc(MAX_WIRE_BYTES + 1, 65));
  await rejected; second.child.assertCleaned();
});

test("spawn throw, process/stream errors, premature closure and nonzero exits use fixed errors and never retry", async () => {
  const bad = new DockerDawnTransport({ dockerProjectDir: project }, { spawnRunner: () => { throw new Error(secret); } });
  await assert.rejects(bad.request(request, new AbortController().signal), redacted("UNAVAILABLE"));
  for (const failure of ["process", "stdin", "stdout", "stderr", "stdout-close", "exit", "signal", "close"] as const) {
    const f = fixture(); const { pending, child } = f.start(); const rejected = assert.rejects(pending, redacted("UNAVAILABLE"));
    if (failure === "process") child.emit("error", new Error(secret));
    else if (failure === "stdin" || failure === "stdout" || failure === "stderr") child[failure].emit("error", new Error(secret));
    else if (failure === "stdout-close") child.stdout.emit("close");
    else if (failure === "exit") child.emit("exit", 1, null);
    else if (failure === "signal") child.emit("exit", null, "SIGTERM");
    else child.emit("close", 0, null); // missing stdout end
    await rejected; child.assertCleaned();
    child.emit("error", new Error(secret)); child.stdin.emit("error", new Error(secret)); // cleanup races are handled
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(); const { pending, child } = f.start(); const rejected = assert.rejects(pending, redacted("UNAVAILABLE"));
  await child.complete(line(status), 1); await rejected; child.assertCleaned();
});

test("caller cancellation rejects late success, destroys pipes and kills only its CLI without extra commands", async () => {
  const f = fixture(); const controller = new AbortController(); const { pending, child } = f.start(request, controller.signal);
  const rejected = assert.rejects(pending, redacted("CANCELLED"));
  controller.abort(new Error(secret)); await rejected; child.assertCleaned();
  child.stdout.emit("data", Buffer.from(line(status))); child.stdout.emit("end"); child.emit("close", 0, null);
  assert.equal(f.calls.length, 1); assert.equal(child.kills, 1);
});

test("abort during synchronous spawn is still cleaned up before stdin dispatch", async () => {
  const controller = new AbortController(); const child = new FakeChild();
  const transport = new DockerDawnTransport({ dockerProjectDir: project }, { spawnRunner: () => { controller.abort(secret); return child; } });
  await assert.rejects(transport.request(request, controller.signal), redacted("CANCELLED"));
  assert.equal(child.writes.length, 0); child.assertCleaned();
});

test("abort after close but before async delivery rejects instead of accepting the late success", async () => {
  const f = fixture(); const controller = new AbortController(); const { pending, child } = f.start(request, controller.signal);
  const rejected = assert.rejects(pending, redacted("CANCELLED"));
  child.stdout.end(line(status)); child.stderr.end(); await setImmediate();
  child.emit("close", 0, null); controller.abort(secret);
  await rejected; child.assertCleaned();
});

test("control 10s and say 40s timeout budgets reject late frames, clean every pipe and never retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); const first = f.start(); const rejectedControl = assert.rejects(first.pending, redacted("TIMEOUT"));
  t.mock.timers.tick(CONTROL_TIMEOUT_MS - 1); assert.equal(first.child.kills, 0);
  t.mock.timers.tick(1); await rejectedControl; first.child.assertCleaned();
  first.child.stdout.emit("data", Buffer.from(line(status))); first.child.emit("close", 0, null);
  const second = f.start({ ...request, type: "say", text: "synthetic" }); const rejectedSay = assert.rejects(second.pending, redacted("TIMEOUT"));
  t.mock.timers.tick(CONTROL_TIMEOUT_MS); assert.equal(second.child.kills, 0);
  t.mock.timers.tick(SAY_CLIENT_TIMEOUT_MS - CONTROL_TIMEOUT_MS - 1); assert.equal(second.child.kills, 0);
  t.mock.timers.tick(1); await rejectedSay; second.child.assertCleaned();
  assert.equal(f.calls.length, 2);
});
