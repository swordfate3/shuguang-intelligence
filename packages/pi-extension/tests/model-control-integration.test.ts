import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import dawnExtension from "../src/index.ts";
import { createInitialState } from "../../dawn/src/core/state.ts";
import { SqliteSubjectStore } from "../../dawn/src/adapters/storage/sqlite-subject.ts";
import { OpenAICompatibleModel } from "../../dawn/src/adapters/models/openai-compatible.ts";
import { startHttpServer } from "../../dawn/src/adapters/transport/http-server.ts";
import { SubjectService } from "../../dawn/src/runtime/subject-service.ts";

/** Mock only Pi UI and the upstream provider; Dawn transport, service, adapter and SQLite are real. */
test("Pi outside selection controls the same six-core subject and adapter across two real loopback generations", { timeout: 10_000 }, async t => {
  const oldEndpoint = process.env.DAWN_ENDPOINT;
  const oldToken = process.env.DAWN_TOKEN_FILE;
  t.after(() => {
    if (oldEndpoint === undefined) delete process.env.DAWN_ENDPOINT; else process.env.DAWN_ENDPOINT = oldEndpoint;
    if (oldToken === undefined) delete process.env.DAWN_TOKEN_FILE; else process.env.DAWN_TOKEN_FILE = oldToken;
  });
  const directory = mkdtempSync(join(tmpdir(), "dawn-picker-integrated-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = "s".repeat(43);
  const tokenPath = join(directory, "service.token");
  writeFileSync(tokenPath, token, { mode: 0o600 });
  const at = "2026-01-01T00:00:00.000Z";
  const abort = new AbortController();
  const store = SqliteSubjectStore.create(join(directory, "subject.sqlite"), createInitialState("synthetic-subject", "合成曙光", at), 5, abort.signal);
  t.after(() => store.close());
  await store.changeLifecycle(0, "awake", at, abort.signal);
  let gets = 0;
  const posts: Record<string, unknown>[] = [];
  const upstream = createServer((req, res) => {
    if (req.method === "GET") {
      gets++;
      assert.equal(req.url, "/v1/models");
      res.end(JSON.stringify({ data: [{ id: "synthetic-first" }, { id: "synthetic-second" }] }));
      return;
    }
    assert.equal(req.url, "/v1/chat/completions");
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      posts.push(JSON.parse(body) as Record<string, unknown>);
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: {
        content: JSON.stringify({ reply: `合成回答 ${posts.length}`, appraisal: null, candidates: [] }),
      } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }));
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); }));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const model = new OpenAICompatibleModel({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "synthetic-first",
    apiKey: "synthetic-only-never-real", maxCalls: 2 });
  const service = new SubjectService(store, model, () => at);
  t.after(() => service.close());
  const server = await startHttpServer({ token, port: 0, handler: (request, signal) => service.handle(request, signal) });
  t.after(() => server.close());
  process.env.DAWN_ENDPOINT = `http://127.0.0.1:${server.port}`;
  process.env.DAWN_TOKEN_FILE = tokenPath;

  let handler!: (args: string, ctx: unknown) => Promise<void>;
  const notices: { text: string; level: string }[] = [];
  dawnExtension({
    registerCommand(_name: string, command: { handler: typeof handler }) { handler = command.handler; },
    on() {},
  } as unknown as ExtensionAPI);
  const ctx = { hasUI: true, ui: {
    notify(text: string, level: string) { notices.push({ text, level }); },
    async confirm() { return true; },
    async select(_title: string, values: string[]) { return values[1]; },
  } };
  await handler("say synthetic-history-marker", ctx);
  assert.equal(notices.at(-1)?.text, "合成回答 1");
  const before = await store.read(abort.signal);
  const budgetBefore = await store.budget(abort.signal);
  await handler("model", ctx);
  await handler("thinking high", ctx);
  assert.deepEqual(await store.read(abort.signal), before);
  assert.deepEqual(await store.budget(abort.signal), budgetBefore);
  assert.equal(gets, 1, "only explicit picker approval discovers models");
  assert.equal(model.modelState().calls, 1, "switching preserves the existing instance call counter");
  await handler("say synthetic-second-question", ctx);
  assert.equal(notices.at(-1)?.text, "合成回答 2");
  assert.equal(posts.length, 2);
  assert.equal(posts[0]?.model, "synthetic-first");
  assert.equal(posts[0]?.reasoning_effort, "low");
  assert.equal(posts[1]?.model, "synthetic-second");
  assert.equal(posts[1]?.reasoning_effort, "high");
  assert.ok(JSON.stringify(posts[1]?.messages).includes("synthetic-history-marker"), "same subject retains conversation across model switch");
  assert.equal((await store.read(abort.signal)).revision, before.revision + 2);
  assert.equal((await store.budget(abort.signal)).completed, 2);
  assert.equal(model.modelState().calls, 2);
  await handler("thinking off", ctx);
  await handler("model-status", ctx);
  assert.match(notices.at(-1)?.text ?? "", /model=synthetic-second.*thinking=off.*calls=2.*maxCalls=2/);
  assert.equal(posts.length, 2, "status and thinking are never generation probes");
  assert.ok(notices.every(notice => notice.level !== "error"));
});
