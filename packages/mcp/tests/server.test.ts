import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { spawnSync } from "node:child_process";
import { setImmediate as tick } from "node:timers/promises";
import { createStdioServer, serveStdio, MAX_INPUT_FRAME_BYTES, MAX_OUTPUT_QUEUE_FRAMES, MAX_OUTPUT_QUEUE_BYTES } from "../src/server.ts";
import type { DawnRequest, DawnResponse, DawnTransport } from "../../dawn/src/protocol/index.ts";

const init = (version = "2025-11-25") => ({ protocolVersion: version, capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
function reply(request: DawnRequest): DawnResponse {
  return { version: 1, requestId: request.requestId, type: "status", lifecycle: "sleeping", revision: 0,
    runtime: { instanceId: "fixture", startedAt: "2026-01-01T00:00:00.000Z", autonomy: false } };
}
function harness(options: { transport?: DawnTransport; allowWrite?: boolean; signal?: AbortSignal; output?: Writable } = {}) {
  const input = new PassThrough();
  const lines: any[] = [];
  let text = "";
  const output = options.output ?? new Writable({ write(chunk, _encoding, callback) {
    text += chunk.toString();
    for (;;) {
      const i = text.indexOf("\n"); if (i < 0) break;
      lines.push(JSON.parse(text.slice(0, i))); text = text.slice(i + 1);
    }
    callback();
  } });
  const calls: DawnRequest[] = [];
  const transport = options.transport ?? { async request(request: DawnRequest) { calls.push(request); return reply(request); } };
  const server = createStdioServer({ input, output, transport, allowWrite: options.allowWrite === true, ...(options.signal ? { signal: options.signal } : {}) });
  function send(method: string, id?: string | number, params?: unknown) {
    input.write(JSON.stringify({ jsonrpc: "2.0", method, ...(id === undefined ? {} : { id }), ...(params === undefined ? {} : { params }) }) + "\n");
  }
  async function ready(version?: string) {
    send("initialize", "init", init(version)); await tick();
    send("notifications/initialized"); await tick();
  }
  return { input, output, lines, calls, server, send, ready };
}
function deferredTransport() {
  const pending: { request: DawnRequest; signal: AbortSignal; resolve: (r: DawnResponse) => void }[] = [];
  const transport: DawnTransport = { request(request, signal) { return new Promise(resolve => pending.push({ request, signal, resolve })); } };
  return { transport, pending, finish() { for (const p of pending) p.resolve(reply(p.request)); } };
}

test("version negotiation, only tools capability, initialized gate, ping never calls Dawn", async () => {
  for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "unsupported"]) {
    const h = harness();
    try {
      h.send("notifications/initialized");
      h.send("tools/list", 1); h.send("ping", 2); await tick();
      assert.equal(h.lines.find(l => l.id === 1).error.code, -32002);
      assert.deepEqual(h.lines.find(l => l.id === 2).result, {});
      h.send("initialize", 3, init(version)); await tick();
      const initialization = h.lines.find(l => l.id === 3).result;
      assert.equal(initialization.protocolVersion, version === "unsupported" ? "2025-11-25" : version);
      assert.deepEqual(initialization.capabilities, { tools: {} });
      h.send("tools/list", 4); await tick();
      assert.equal(h.lines.find(l => l.id === 4).error.code, -32002);
      h.send("notifications/initialized"); h.send("tools/list", 5); await tick();
      assert.deepEqual(h.lines.find(l => l.id === 5).result.tools.map((t: any) => t.name), ["shuguang_status", "shuguang_model_status"]);
      h.send("initialize", 6, init()); await tick();
      assert.equal(h.lines.find(l => l.id === 6).error.code, -32600);
      assert.equal(h.calls.length, 0);
    } finally { h.server.close(); }
  }
});

test("read-only denial and unknown tools sanitized; malformed args are invalid params; write config lists eight", async () => {
  const h = harness();
  try {
    h.send("tools/call", 0, { name: "shuguang_status" }); await tick();
    assert.equal(h.lines[0].error.code, -32002);
    await h.ready();
    h.send("tools/call", 1, { name: "shuguang_say", arguments: { message: "SYNTHETIC_SECRET" } });
    h.send("tools/call", 2, { name: "SYNTHETIC_SECRET", arguments: {} });
    h.send("tools/call", 3, { name: "shuguang_status", arguments: { extra: "SYNTHETIC_SECRET" } });
    h.send("tools/call", 4, { name: "shuguang_status", arguments: {} });
    h.send("tools/call", undefined, { name: "shuguang_status" });
    await tick();
    assert.equal(h.lines.find(l => l.id === 1).error.code, -32602);
    assert.deepEqual(h.lines.find(l => l.id === 1).error, h.lines.find(l => l.id === 2).error);
    assert.equal(h.lines.find(l => l.id === 3).error.code, -32602);
    assert.ok(h.lines.find(l => l.id === 4).result.content);
    assert.equal(h.calls.length, 1);
    assert.ok(!JSON.stringify(h.lines).includes("SYNTHETIC_SECRET"));
  } finally { h.server.close(); }
  const writable = harness({ allowWrite: true });
  try { await writable.ready(); writable.send("tools/list", 1); await tick(); assert.equal(writable.lines.at(-1).result.tools.length, 8); }
  finally { writable.server.close(); }
});

test("parse/invalid request/method/params errors are fixed and unsupported requests rejected", async () => {
  const h = harness();
  try {
    for (const [raw, code] of [
      ["{SYNTHETIC_SECRET\n", -32700], ["[]\n", -32600], ["null\n", -32600],
      ['{"jsonrpc":"2.0","id":null,"method":"ping"}\n', -32600],
      ['{"jsonrpc":"2.0","id":1,"result":{}}\n', -32600],
      ['{"jsonrpc":"2.0","id":1,"method":"ping","extra":1}\n', -32600],
    ] as const) {
      h.input.write(raw); await tick(); assert.equal(h.lines.at(-1).error.code, code);
      assert.equal(Object.hasOwn(h.lines.at(-1), "id"), false);
    }
    h.send("initialize", 10, { protocolVersion: "2025-11-25" }); await tick();
    assert.equal(h.lines.at(-1).error.code, -32602);
    await h.ready();
    for (const method of ["resources/list", "prompts/list", "sampling/createMessage", "SYNTHETIC_SECRET"]) {
      h.send(method, method); await tick(); assert.equal(h.lines.at(-1).error.code, -32601);
    }
    for (const [method, params] of [["ping", { bad: true }], ["tools/list", { cursor: "bad" }],
      ["tools/call", { name: "shuguang_status", arguments: [] }], ["tools/call", { name: "shuguang_status", extra: 1 }]]) {
      h.send(method as string, 20, params); await tick(); assert.equal(h.lines.at(-1).error.code, -32602);
    }
    // IDs are correlation data and deliberately echoed, but raw input/errors/method names aren't.
    assert.ok(!JSON.stringify(h.lines.map(({ id: _id, ...rest }) => rest)).includes("SYNTHETIC_SECRET"));
    assert.equal(h.calls.length, 0);
  } finally { h.server.close(); }
});

test("cancel associates exact ID, ignores pre-init and late results, duplicate active ID never redispatched", async () => {
  const d = deferredTransport(); const h = harness({ transport: d.transport });
  try {
    h.send("notifications/cancelled", undefined, { requestId: 1 }); await h.ready();
    h.send("tools/call", 1, { name: "shuguang_status" });
    h.send("tools/call", 1, { name: "shuguang_status" }); await tick();
    assert.equal(d.pending.length, 1);
    assert.equal(h.lines.at(-1).error.code, -32600); assert.equal(Object.hasOwn(h.lines.at(-1), "id"), false);
    h.send("notifications/cancelled", undefined, { requestId: "1" });
    assert.equal(d.pending[0]!.signal.aborted, false);
    h.send("notifications/cancelled", undefined, { requestId: 1, reason: "SYNTHETIC_SECRET" });
    assert.equal(d.pending[0]!.signal.aborted, true);
    h.send("tools/call", 1, { name: "shuguang_status" }); await tick();
    assert.equal(d.pending.length, 1);
    d.finish(); await tick();
    assert.equal(h.lines.filter(l => l.id === 1).length, 0);
    h.send("ping", 2); await tick(); assert.deepEqual(h.lines.at(-1).result, {});
    assert.ok(!JSON.stringify(h.lines).includes("SYNTHETIC_SECRET"));
  } finally { h.server.close(); d.finish(); }
});

test("recognizable malformed notifications are silent and cannot initialize, cancel or execute tools", async () => {
  const d = deferredTransport(); const h = harness({ transport: d.transport, allowWrite: true });
  const raw = (value: unknown) => h.input.write(JSON.stringify(value) + "\n");
  try {
    for (const phase of ["new", "initializing", "ready"]) {
      if (phase === "initializing") { h.send("initialize", "init", init()); await tick(); }
      if (phase === "ready") { h.send("notifications/initialized"); h.send("tools/call", "active", { name: "shuguang_status" }); await tick(); }
      const before = h.lines.length;
      for (const method of ["notifications/initialized", "notifications/cancelled", "tools/call", "ping"]) {
        raw({ jsonrpc: "2.0", method, params: { requestId: "active", name: "shuguang_say", arguments: { message: "SECRET" } }, extra: "SECRET" });
        raw({ jsonrpc: "2.0", method, params: ["SECRET"] });
        raw({ jsonrpc: "wrong", method });
      }
      await tick();
      assert.equal(h.lines.length, before);
      if (phase !== "ready") {
        h.send("tools/list", phase); await tick();
        assert.equal(h.lines.at(-1).error.code, -32002);
        assert.equal(d.pending.length, 0);
      } else {
        assert.equal(d.pending.length, 1);
        assert.equal(d.pending[0]!.signal.aborted, false);
      }
    }
  } finally { h.server.close(); d.finish(); }
});

test("known tool value errors are isError results, structural errors stay RPC -32602 with zero IO", async () => {
  const h = harness({ allowWrite: true });
  try {
    await h.ready();
    for (const [name, args] of [
      ["shuguang_wake", { expectedRevision: -1 }],
      ["shuguang_say", { message: " " }],
      ["shuguang_say", { message: "😀".repeat(8001) }],
      ["shuguang_model_select", { expectedRevision: 0, model: "😀".repeat(129) }],
      ["shuguang_thinking_select", { expectedRevision: 0, thinking: "SECRET" }],
    ] as const) {
      h.send("tools/call", 1, { name, arguments: args }); await tick();
      assert.equal(h.lines.at(-1).result.isError, true);
      assert.equal(h.lines.at(-1).error, undefined);
    }
    for (const args of [{}, { text: "SECRET" }, { message: "ok", extra: "SECRET" }]) {
      h.send("tools/call", 2, { name: "shuguang_say", arguments: args }); await tick();
      assert.equal(h.lines.at(-1).error.code, -32602);
    }
    assert.equal(h.calls.length, 0);
    assert.ok(!JSON.stringify(h.lines).includes("SECRET"));
  } finally { h.server.close(); }
});

test("legacy sessions close rather than invent IDs for uncorrelatable errors; correlated errors work", async () => {
  for (const version of ["2025-06-18", "2025-03-26"]) {
    for (const invalid of ["parse", "batch", "oversize", "duplicate"]) {
      const d = deferredTransport(); const h = harness({ transport: d.transport });
      await h.ready(version);
      h.send("unsupported", "known"); await tick();
      assert.deepEqual(h.lines.at(-1), { jsonrpc: "2.0", id: "known", error: { code: -32601, message: "Method not found" } });
      h.send("tools/call", "active", { name: "shuguang_status" }); await tick();
      const before = h.lines.length;
      if (invalid === "parse") h.input.write("{\n");
      else if (invalid === "batch") h.input.write("[]\n");
      else if (invalid === "oversize") h.input.write(Buffer.alloc(MAX_INPUT_FRAME_BYTES + 1, 32));
      else h.send("tools/call", "active", { name: "shuguang_status" });
      await h.server.done;
      assert.equal(h.lines.length, before);
      assert.equal(d.pending[0]!.signal.aborted, true);
      d.finish(); await tick();
    }
  }
});

test("eight in-flight includes synchronous dispatch and retains ignored cancelled jobs", async () => {
  const sync = harness();
  try {
    for (let i = 0; i < 9; i++) sync.send("ping", i);
    await tick(); assert.equal(sync.lines.find(l => l.id === 8).error.code, -32000);
    assert.equal(sync.lines.filter(l => l.result).length, 8);
  } finally { sync.server.close(); }
  const d = deferredTransport(); const h = harness({ transport: d.transport });
  try {
    await h.ready();
    for (let i = 0; i < 8; i++) h.send("tools/call", i, { name: "shuguang_status" });
    for (let i = 0; i < 8; i++) h.send("notifications/cancelled", undefined, { requestId: i });
    h.send("tools/call", 8, { name: "shuguang_status" }); await tick();
    assert.equal(d.pending.length, 8);
    assert.ok(d.pending.every(p => p.signal.aborted));
    assert.equal(h.lines.find(l => l.id === 8).error.code, -32000);
    d.finish(); await tick();
    h.send("ping", 9); await tick(); assert.deepEqual(h.lines.at(-1).result, {});
  } finally { h.server.close(); d.finish(); }
});

test("EOF, input close/error, output close/error, and root abort cancel all and ignore late completions", async () => {
  for (const stop of ["eof", "close", "input-error", "output-close", "output-error", "abort"]) {
    const root = new AbortController(); const d = deferredTransport(); const h = harness({ transport: d.transport, signal: root.signal });
    await h.ready(); h.send("tools/call", 1, { name: "shuguang_status" }); await tick();
    const before = h.lines.length;
    if (stop === "eof") h.input.end('{"partial":');
    else if (stop === "close") h.input.destroy();
    else if (stop === "input-error") h.input.destroy(new Error("SYNTHETIC_SECRET"));
    else if (stop === "output-close") h.output.destroy();
    else if (stop === "output-error") h.output.destroy(new Error("SYNTHETIC_SECRET"));
    else root.abort(new Error("SYNTHETIC_SECRET"));
    await h.server.done;
    assert.equal(d.pending[0]!.signal.aborted, true);
    d.finish(); await tick(); assert.equal(h.lines.length, before);
  }
});

test("fatal UTF8, split multibyte sequences, 64KiB exact boundary and oversize recovery", async () => {
  const h = harness();
  try {
    h.input.write(Buffer.from([0xc3, 0x28, 10])); await tick();
    assert.equal(h.lines.at(-1).error.code, -32700);
    const raw = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "中文", method: "ping" }) + "\n");
    for (const byte of raw) h.input.write(Buffer.from([byte]));
    await tick(); assert.equal(h.lines.at(-1).id, "中文");
    const simple = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
    h.input.write(simple + " ".repeat(MAX_INPUT_FRAME_BYTES - Buffer.byteLength(simple)) + "\n");
    await tick(); assert.deepEqual(h.lines.at(-1).result, {});
    h.input.write(Buffer.alloc(MAX_INPUT_FRAME_BYTES + 1, 32)); await tick();
    assert.equal(h.lines.at(-1).error.code, -32600);
    const before = h.lines.length;
    h.input.write(Buffer.alloc(MAX_INPUT_FRAME_BYTES * 2, 32)); h.input.write("\n");
    await tick(); assert.equal(h.lines.length, before);
    h.send("ping", 2); await tick(); assert.equal(h.lines.at(-1).id, 2);
    h.input.write(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from(simple + "\n")]));
    await tick(); assert.equal(h.lines.at(-1).error.code, -32700);
  } finally { h.server.close(); }
});

test("output backpressure bounds queued writes and closes session on overflow", async () => {
  const writes: Buffer[] = [];
  let release: (() => void) | undefined;
  const blocked = new Writable({ highWaterMark: 1, write(chunk, _encoding, cb) { writes.push(Buffer.from(chunk)); release = cb; } });
  const h = harness({ output: blocked });
  for (let i = 0; i <= MAX_OUTPUT_QUEUE_FRAMES; i++) { h.send("ping", i); await tick(); }
  await h.server.done;
  assert.equal(writes.length, 1);
  assert.ok(blocked.writableLength < 128);
  release?.(); await tick();
  assert.equal(writes.length, 1);
});

test("output drain resumes bounded writes, callback errors do not leak or become unhandled", async () => {
  const writes: string[] = []; const releases: ((error?: Error | null) => void)[] = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, cb) { writes.push(chunk.toString()); releases.push(cb); } });
  const h = harness({ output });
  h.send("ping", 1); h.send("ping", 2); await tick();
  assert.equal(writes.length, 1);
  releases.shift()!(); await tick(); assert.equal(writes.length, 2);
  releases.shift()!(new Error("SYNTHETIC_SECRET"));
  await h.server.done; await tick();
  assert.ok(!writes.join("").includes("SYNTHETIC_SECRET"));
});

test("byte queue cap closes before frame count cap and aborts pending work", async () => {
  let release: (() => void) | undefined;
  let writes = 0;
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, cb) { writes++; release = cb; } });
  const d = deferredTransport();
  const transport: DawnTransport = { async request(r, signal) {
    if (r.type !== "say") return d.transport.request(r, signal);
    return { version: 1, requestId: r.requestId, type: "reply", text: "\u0001".repeat(16_000) };
  } };
  const h = harness({ output, transport, allowWrite: true });
  await h.ready(); h.send("tools/call", "pending", { name: "shuguang_status" }); await tick();
  // A valid 16000-character reply expands when JSON is embedded in MCP text content.
  let count = 0;
  while (count < MAX_OUTPUT_QUEUE_FRAMES + 1 && h.input.listenerCount("data") > 0) {
    h.send("tools/call", count, { name: "shuguang_say", arguments: { message: "chosen" } });
    await tick(); count++;
  }
  await h.server.done;
  assert.ok(count < MAX_OUTPUT_QUEUE_FRAMES, "byte cap must trigger before frame cap");
  assert.equal(d.pending[0]!.signal.aborted, true);
  assert.equal(writes, 1);
  assert.ok(output.writableLength < MAX_OUTPUT_QUEUE_BYTES);
  d.finish(); release?.(); await tick();
  assert.equal(writes, 1);
});

test("root abort while output blocked cancels work, pending callback error remains handled", async () => {
  const root = new AbortController();
  let release: ((error?: Error | null) => void) | undefined;
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, cb) { release = cb; } });
  const d = deferredTransport(); const h = harness({ output, transport: d.transport, signal: root.signal });
  await h.ready(); h.send("tools/call", 1, { name: "shuguang_status" }); await tick();
  root.abort(); await h.server.done;
  assert.equal(d.pending[0]!.signal.aborted, true);
  release?.(new Error("SYNTHETIC_SECRET")); d.finish(); await tick();
  assert.equal(output.listenerCount("error"), 0);
});

test("transport failures are CallToolResult, never RPC stack/error text", async () => {
  let count = 0;
  const h = harness({ transport: { async request() { count++; throw new Error("SYNTHETIC_SECRET"); } } });
  try {
    await h.ready(); h.send("tools/call", 1, { name: "shuguang_status" }); await tick();
    const result = h.lines.at(-1);
    assert.equal(result.result.isError, true); assert.equal(result.error, undefined);
    assert.ok(!JSON.stringify(h.lines).includes("SYNTHETIC_SECRET")); assert.equal(count, 1);
  } finally { h.server.close(); }
});

test("stream error sinks are bounded across sessions, preserve caller listeners, and release at close", async () => {
  const input = new PassThrough(); const output = new PassThrough();
  let observed = 0;
  const callerError = () => { observed++; };
  input.on("error", callerError);
  const transport: DawnTransport = { async request() { throw new Error("must not run"); } };
  for (let i = 0; i < 30; i++) {
    const server = createStdioServer({ input, output, transport });
    server.close(); await server.done;
    assert.equal(input.listenerCount("error"), 2); // caller + one shared sink
    assert.equal(output.listenerCount("error"), 1);
    assert.equal(input.listenerCount("close"), 1);
    assert.equal(output.listenerCount("close"), 1);
  }
  input.destroy(new Error("synthetic caller event")); output.destroy(); await tick();
  assert.equal(observed, 1);
  assert.equal(input.listenerCount("error"), 1);
  assert.equal(input.listeners("error")[0], callerError);
  assert.equal(output.listenerCount("error"), 0);
  assert.equal(input.listenerCount("close"), 0);
  assert.equal(output.listenerCount("close"), 0);
  // Streams already closed before creation must not retain a sink indefinitely either.
  const server = createStdioServer({ input, output, transport }); await server.done; await tick();
  assert.equal(input.listenerCount("error"), 1);
  assert.equal(output.listenerCount("error"), 0);
});

test("isolated processes absorb queued stream errors on close/abort/pre-destroy without secrets or late replies", async t => {
  for (const scenario of ["input-close", "idle-output-abort", "predestroy-input", "predestroy-output"]) {
    await t.test(scenario, () => {
      const source = `
        import assert from "node:assert/strict";
        import { PassThrough, Writable } from "node:stream";
        import { setImmediate as tick } from "node:timers/promises";
        import { createStdioServer } from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
        const scenario = ${JSON.stringify(scenario)};
        const input = new PassThrough();
        const chunks = [];
        const output = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk.toString()); callback(); } });
        const root = new AbortController();
        let pending; let calls = 0;
        const transport = { request(request, signal) {
          calls++;
          return new Promise(resolve => { pending = { request, signal, resolve }; });
        } };
        if (scenario === "predestroy-input") input.destroy(new Error("SYNTHETIC_SECRET"));
        if (scenario === "predestroy-output") output.destroy(new Error("SYNTHETIC_SECRET"));
        const server = createStdioServer({ input, output, transport, signal: root.signal });
        const send = value => input.write(JSON.stringify(value) + "\\n");
        if (!scenario.startsWith("predestroy")) {
          send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
            protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" }
          } });
          await tick();
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "shuguang_status" } });
          await tick();
          assert.equal(calls, 1);
          assert.equal(output.writableLength, 0);
          if (scenario === "input-close") {
            input.destroy(new Error("SYNTHETIC_SECRET")); server.close();
          } else {
            output.destroy(new Error("SYNTHETIC_SECRET")); root.abort();
          }
        }
        await server.done;
        const before = chunks.length;
        if (pending) {
          assert.equal(pending.signal.aborted, true);
          pending.resolve({ version: 1, requestId: pending.request.requestId, type: "status",
            revision: 0, lifecycle: "sleeping", runtime: {
              instanceId: "fixture", startedAt: "2026-01-01T00:00:00.000Z", autonomy: false
            } });
        } else assert.equal(calls, 0);
        await tick(); await tick();
        assert.equal(chunks.length, before);
        assert.ok(!chunks.join("").includes("SYNTHETIC_SECRET"));
        input.destroy(); output.destroy(); await tick();
        assert.equal(input.listenerCount("error"), 0);
        assert.equal(output.listenerCount("error"), 0);
        assert.equal(input.listenerCount("close"), 0);
        assert.equal(output.listenerCount("close"), 0);
      `;
      const child = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { encoding: "utf8", timeout: 5000 });
      assert.equal(child.error, undefined);
      assert.equal(child.signal, null);
      assert.equal(child.status, 0);
      assert.equal(child.stdout, "");
      assert.equal(child.stderr, "");
    });
  }
});

test("serve API resolves pre-abort without IO; raw byte stream required", async () => {
  const root = new AbortController(); root.abort();
  const input = new PassThrough(); const output = new PassThrough();
  await serveStdio({ input, output, signal: root.signal, transport: { async request() { throw new Error("must not run"); } } });
  assert.equal(input.listenerCount("data"), 0);
  const encoded = new PassThrough(); encoded.setEncoding("utf8");
  assert.throws(() => createStdioServer({ input: encoded, output, transport: { async request() { throw new Error(); } } }), /raw byte/u);
});
