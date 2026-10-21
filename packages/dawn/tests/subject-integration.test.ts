import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runCli } from "../src/runtime/cli.ts";
import { runServer } from "../src/runtime/serve.ts";
import { createTokenFile, readTokenFile } from "../src/adapters/transport/token-file.ts";
import { SqliteSubjectStore } from "../src/adapters/storage/sqlite-subject.ts";
import { SqliteStateStore } from "../src/adapters/storage/sqlite.ts";
import { HttpDawnTransport } from "../../pi-extension/src/http-transport.ts";
const signal = () => new AbortController().signal;

async function setup(t: TestContext, hang = false, delayMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), "dawn-six-core-integration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "subject.sqlite"), config = join(dir, "model.json"), token = join(dir, "service.token");
  const env = `DAWN_SUBJECT_FIXTURE_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  process.env[env] = "synthetic-key";
  t.after(() => { delete process.env[env]; });
  const bodies: { messages: { role: string; content: string }[]; max_tokens: number }[] = [];
  let dispatched!: () => void;
  const started = new Promise<void>(resolve => { dispatched = resolve; });
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw);
    bodies.push(body);
    dispatched();
    if (hang) { res.on("error", () => undefined); return; }
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    const context = JSON.parse(body.messages[1].content);
    const first = bodies.length === 1;
    const content = JSON.stringify({ reply: first ? "理解需要一步步来。" : "接着之前的问题。",
      appraisal: first ? { evidenceIds: [context.current.experienceId], concernId: "understanding", desirability: 0.6,
        expectedness: 0.5, controllability: 0.7, intensity: 0.8 } : null,
      candidates: first ? [{ type: "world_belief", belief: { id: "fixture_belief", statement: "用户正在探索学习问题的理解方法", origin: "user_statement",
        evidenceIds: [context.current.experienceId], confidence: 0.6, status: "tentative", supersedesIds: [], updatedAt: context.current.at } }] : [],
    });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 42, completion_tokens: 30 } }));
  });
  await new Promise<void>(r => upstream.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => { upstream.close(() => r()); upstream.closeAllConnections(); }));
  const addr = upstream.address(); assert.ok(addr && typeof addr === "object");
  writeFileSync(config, JSON.stringify({ baseUrl: `http://127.0.0.1:${addr.port}/v1`, model: "synthetic", credentialEnv: env, maxCalls: 3, reasoningEffort: "low", ...(delayMs ? { timeoutMs: 30_000 } : {}) }));
  const init = await runCli(["subject-init", "--db", db, "--id", "dawn", "--name", "曙光", "--limit", "2"], signal());
  assert.equal((init as { schemaVersion: number }).schemaVersion, 2);
  await runCli(["subject-wake", "--db", db, "--revision", "0"], signal());
  createTokenFile(token);
  const args = ["--subject-db", db, "--token-file", token, "--port", "0", "--model-config", config];
  async function start() {
    const controller = new AbortController();
    let ready!: (url: string) => void;
    const endpoint = new Promise<string>(r => { ready = r; });
    const running = runServer(args, controller.signal, info => ready(info.endpoint));
    const url = await Promise.race([endpoint, running.then(() => { throw new Error("Stopped before ready"); })]);
    return { transport: new HttpDawnTransport(url, readTokenFile(token)), stop: async () => { controller.abort(); await running; } };
  }
  return { db, token, args, start, bodies, started };
}

test("explicit new-format CLI -> authenticated HTTP -> model candidates -> atomic six-core state; restart recalls and keeps quota", async t => {
  const f = await setup(t);
  let server = await f.start();
  try {
    assert.equal((await server.transport.request({ version: 1, type: "say", requestId: "one", text: "探索如何学习和理解问题" }, signal())).type, "reply");
    const status = await server.transport.request({ version: 1, type: "status", requestId: "status1" }, signal());
    assert.equal(status.type, "status"); if (status.type === "status") assert.equal(status.revision, 3);
  } finally { await server.stop(); }
  server = await f.start();
  try {
    assert.equal((await server.transport.request({ version: 1, type: "say", requestId: "two", text: "接着理解之前的问题" }, signal())).type, "reply");
    const messages = f.bodies[1]!.messages;
    assert.ok(messages.some(m => m.role === "assistant" && m.content === "理解需要一步步来。"));
    const projection = JSON.parse(messages[1]!.content).projection;
    assert.equal(projection.beliefs[0].id, "fixture_belief");
    assert.ok(projection.affect.valence > 0);
    assert.ok(projection.memories.length > 0);
    assert.equal(f.bodies[0]!.max_tokens, 1024);
    assert.equal((await server.transport.request({ version: 1, type: "say", requestId: "over", text: "额度已满" }, signal())).type, "error");
    assert.equal(f.bodies.length, 2);
  } finally { await server.stop(); }
  const store = SqliteSubjectStore.open(f.db, signal());
  try {
    const state = await store.read(signal());
    assert.equal(state.revision, 5); assert.equal(state.experiences.length, 4); assert.equal(state.memory.records.length, 4);
    assert.equal(state.cognition.beliefs[0]?.status, "tentative");
    assert.equal(state.self.interests.length, 0);
    assert.deepEqual(await store.budget(signal()), { limit: 2, reserved: 2, completed: 2, failed: 0, pending: 0 });
  } finally { store.close(); }
  assert.throws(() => SqliteStateStore.open(f.db, signal()), "old format must not silently adopt new subject");
  await assert.rejects(runCli(["subject-init", "--db", f.db, "--id", "overwrite", "--name", "错误", "--limit", "100"], signal()));
});

test("six-core serve rejects mixed flags, missing db, legacy format; status/budget are diagnostics not private body dumps", async t => {
  const f = await setup(t);
  for (const args of [ [...f.args, "--db", f.db], [...f.args, "--chat-db", f.db],
    f.args.map(s => s === f.db ? f.db + ".missing" : s),
    f.args.map(s => s === "--subject-db" ? "--db" : s),
  ]) await assert.rejects(runServer(args, signal(), () => assert.fail("must not start")));
  const status = await runCli(["subject-status", "--db", f.db], signal());
  assert.doesNotMatch(JSON.stringify(status), /personality|relationships|content|snapshot/);
  const budget = await runCli(["subject-budget", "--db", f.db], signal());
  assert.deepEqual(budget, { budget: { limit: 2, reserved: 0, completed: 0, failed: 0, pending: 0 }, autonomy: false });
  await assert.rejects(runCli(["subject-sleep", "--db", f.db, "--revision", "0"], signal()));
  const state = await runCli(["subject-sleep", "--db", f.db, "--revision", "1"], signal());
  assert.equal((state as { lifecycle: string }).lifecycle, "sleeping");
});

test("six-core foreground shutdown cancels hanging upstream and preserves charged failed attempt without core mutation", { timeout: 5000 }, async t => {
  const f = await setup(t, true);
  const server = await f.start();
  const pending = server.transport.request({ version: 1, type: "say", requestId: "cancelled", text: "合成停止测试" }, signal());
  const observed = pending.then(() => undefined, () => undefined);
  try { await f.started; }
  finally { await server.stop(); }
  await observed;
  const store = SqliteSubjectStore.open(f.db, signal());
  try {
    assert.equal((await store.read(signal())).revision, 1);
    assert.equal((await store.read(signal())).experiences.length, 0);
    assert.deepEqual(await store.budget(signal()), { limit: 2, reserved: 1, completed: 0, failed: 1, pending: 0 });
    assert.deepEqual(await store.history(signal()), []);
  } finally { store.close(); }
});

test("explicit model budget above 8s completes through actual client/server beyond old 10s transport deadline", { timeout: 20_000 }, async t => {
  const f = await setup(t, false, 10_200);
  const server = await f.start();
  try {
    const result = await server.transport.request({ version: 1, type: "say", requestId: "slow", text: "探索学习与理解问题" }, signal());
    assert.equal(result.type, "reply");
    const store = SqliteSubjectStore.open(f.db, signal());
    try {
      assert.equal((await store.read(signal())).revision, 3);
      assert.equal((await store.budget(signal())).completed, 1);
    } finally { store.close(); }
  } finally { await server.stop(); }
});

test("invalid new-format CLI never creates missing resources", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-subject-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "missing.sqlite");
  for (const args of [ ["subject-init", "--db", db, "--id", "dawn", "--name", "曙光"],
    ["subject-init", "--db", db, "--id", "dawn", "--name", "曙光", "--limit", "10001"],
    ["subject-status", "--db", "relative"], ["subject-unknown", "--db", db],
    ["subject-status", "--db", db], ["subject-status", "--db", db, "--limit", "3"],
    ["subject-init", "--db", db, "--id", "invalid id", "--name", "曙光", "--limit", "2"],
  ]) await assert.rejects(runCli(args, signal()));
  assert.deepEqual(readdirSync(dir), []);
});
