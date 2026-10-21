import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { RequestListener } from "node:http";
import { inspect } from "node:util";
import test from "node:test";
import type { TestContext } from "node:test";
import { OpenAICompatibleModel } from "../src/adapters/models/openai-compatible.ts";
import type { ModelPort } from "../src/adapters/models/port.ts";

// Synthetic credentials only. All fetches in this file target ephemeral loopback servers.
const apiKey = "synthetic-test-key-DO-NOT-LEAK";
const model = "configured-test-model";
const request: Parameters<ModelPort["generate"]>[0] = {
  messages: [
    { role: "system", text: "Synthetic system instruction" },
    { role: "user", text: "Synthetic question" },
    { role: "assistant", text: "Synthetic history" },
  ],
  maxOutputTokens: 64,
};
const response = () => ({
  model: "untrusted-upstream-model",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Synthetic reply" } }],
  usage: { prompt_tokens: 12, completion_tokens: 3 },
});
const generate = (adapter: ModelPort) => adapter.generate(request, new AbortController().signal);

async function serve(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

function adapter(baseUrl: string, options: { timeoutMs?: number; maxCalls?: number } = {}) {
  return new OpenAICompatibleModel({ baseUrl, apiKey, model, ...options });
}

function redacted(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.doesNotMatch(inspect(error), /synthetic-test-key|upstream-private|127\.0\.0\.1|https?:\/\//);
  assert.equal(error.cause, undefined);
  return true;
}

test("POST auth, strict body, base paths, configured model ID, and private credentials", async t => {
  let calls = 0;
  const baseUrl = await serve(t, (req, res) => {
    calls += 1;
    assert.equal(req.method, "POST");
    assert.equal(req.url, calls === 1 ? "/chat/completions" : "/v1/chat/completions");
    assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
    assert.equal(req.headers["content-type"], "application/json");
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
        model, messages: request.messages.map(({ role, text }) => ({ role, content: text })),
        max_tokens: 64, stream: false, reasoning_effort: "low",
      });
      res.end(JSON.stringify(response()));
    });
  });
  for (const path of ["///", "/v1///"]) {
    const instance = adapter(baseUrl + path);
    assert.equal(JSON.stringify(instance), "{}");
    assert.doesNotMatch(inspect(instance, { showHidden: true }), /synthetic-test-key|127\.0\.0\.1/);
    assert.deepEqual(await generate(instance), {
      text: "Synthetic reply", modelId: model, usage: { inputTokens: 12, outputTokens: 3 },
    });
  }
  assert.equal(calls, 2);
});

test("explicit reasoning effort is sent unchanged and unsupported values fail before dispatch", async t => {
  const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
  const received: string[] = [];
  const baseUrl = await serve(t, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString()).reasoning_effort);
      res.end(JSON.stringify(response()));
    });
  });
  for (const reasoningEffort of efforts) {
    await generate(new OpenAICompatibleModel({ baseUrl, apiKey, model, reasoningEffort }));
  }
  assert.deepEqual(received, [...efforts]);
  for (const reasoningEffort of ["none", "", "LOW", "unsupported", null, 1]) {
    assert.throws(() => new OpenAICompatibleModel({
      baseUrl, apiKey, model,
      reasoningEffort: reasoningEffort as "low",
    }), /MODEL_INVALID_CONFIG/);
  }
  assert.equal(received.length, efforts.length);
});

test("constructor rejects unsafe URLs and config without disclosing values", () => {
  for (const baseUrl of [
    "http://example.invalid/v1", "http://localhost/v1", "http://127.1/v1", "http://2130706433/v1",
    "http://[::1]/v1", "ftp://example.invalid", "https://user:synthetic-test-key@example.invalid/v1",
    "https://example.invalid/v1?secret=synthetic-test-key", "https://example.invalid/v1#secret",
    "https://example.invalid/v1?", "https://example.invalid/v1#", "https://example.invalid/other",
    "https://example.invalid/v1/chat/completions", "https://example.invalid/other/../v1",
    "https://example.invalid/%76%31", "https://example.invalid\\v1", " https://example.invalid/v1", "",
  ]) assert.throws(() => adapter(baseUrl), redacted);
  for (const options of [
    { apiKey: "" }, { apiKey: "  " }, { apiKey: "secret\r\nheader:value" }, { model: " " },
    { timeoutMs: 0 }, { timeoutMs: 30_001 }, { timeoutMs: 1.5 }, { timeoutMs: NaN },
    { maxCalls: 0 }, { maxCalls: -1 }, { maxCalls: Infinity }, { maxCalls: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => new OpenAICompatibleModel({ baseUrl: "https://example.invalid/v1", apiKey, model, ...options }), redacted);
  // Constructor validation only: never sends an external request.
  assert.doesNotThrow(() => adapter("https://example.invalid/v1"));
  assert.doesNotThrow(() => adapter("https://example.invalid/v1", { timeoutMs: 30_000 }));
});

test("invalid message roles/text and token bounds fail before dispatch or budget consumption", async t => {
  let calls = 0;
  const baseUrl = await serve(t, (_req, res) => { calls += 1; res.end(JSON.stringify(response())); });
  const instance = adapter(baseUrl, { maxCalls: 1 });
  const invalid: unknown[] = [null, {}, { ...request, extra: true }];
  for (const messages of [[], new Array(1), null, "text", [null], [{ role: "tool", text: "text" }],
    [{ role: "USER", text: "text" }], [{ role: "user", text: " \n" }], [{ role: "user", text: 1 }],
    [{ role: "user", text: "text", content: "extra" }]]) invalid.push({ ...request, messages });
  for (const maxOutputTokens of [0, -1, 1025, 0.5, NaN, Infinity, "10", Number.MAX_SAFE_INTEGER + 1]) {
    invalid.push({ ...request, maxOutputTokens });
  }
  for (const input of invalid) {
    await assert.rejects(instance.generate(input as typeof request, new AbortController().signal), /MODEL_INVALID_REQUEST/);
  }
  assert.equal(calls, 0);
  await generate(instance);
  assert.equal(calls, 1);
});

test("token and output boundaries, zero usage, and exact 128 KiB response are accepted", async t => {
  const baseUrl = await serve(t, (_req, res) => {
    const value = response();
    value.choices[0]!.message.content = "x".repeat(16_000);
    value.usage = { prompt_tokens: 0, completion_tokens: 0 };
    const json = JSON.stringify(value);
    res.end(json + " ".repeat(128 * 1024 - Buffer.byteLength(json)));
  });
  for (const maxOutputTokens of [1, 1024]) {
    const result = await adapter(baseUrl).generate({ ...request, maxOutputTokens }, new AbortController().signal);
    assert.equal(result.text.length, 16_000);
    assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
  }
});

test("HTTP errors and transport failures are redacted, with no retry", async t => {
  for (const status of [400, 401, 429, 500]) {
    let calls = 0;
    const baseUrl = await serve(t, (_req, res) => {
      calls += 1;
      res.writeHead(status);
      res.end(`upstream-private ${apiKey}`);
    });
    await assert.rejects(generate(adapter(baseUrl)), error => {
      redacted(error);
      assert.equal((error as Error).message, "MODEL_HTTP_ERROR");
      return true;
    });
    assert.equal(calls, 1);
  }
  const baseUrl = await serve(t, (req) => req.socket.destroy(new Error(`upstream-private ${apiKey}`)));
  await assert.rejects(generate(adapter(baseUrl)), error => {
    redacted(error);
    assert.equal((error as Error).message, "MODEL_REQUEST_FAILED");
    return true;
  });
});

test("redirects are never followed or forwarded credentials", async t => {
  let targetCalls = 0;
  const target = await serve(t, (_req, res) => { targetCalls += 1; res.end(JSON.stringify(response())); });
  for (const status of [301, 302, 303, 307, 308]) {
    const baseUrl = await serve(t, (_req, res) => { res.writeHead(status, { Location: target }); res.end(); });
    await assert.rejects(generate(adapter(baseUrl)), redacted);
  }
  assert.equal(targetCalls, 0);
});

test("oversized declared and chunked responses are bounded", async t => {
  for (const declared of [true, false]) {
    const baseUrl = await serve(t, (_req, res) => {
      if (declared) {
        // No body: reject oversized headers immediately, not only on EOF.
        res.writeHead(200, { "Content-Length": 128 * 1024 + 1 });
        res.flushHeaders();
        return;
      }
      res.setHeader("Transfer-Encoding", "chunked");
      res.write(Buffer.alloc(64 * 1024, 32));
      res.write(Buffer.alloc(64 * 1024, 32));
      res.end("x");
    });
    await assert.rejects(generate(adapter(baseUrl)), /MODEL_RESPONSE_TOO_LARGE/);
  }
});

test("malformed JSON, UTF-8, schema, missing usage, whitespace and truncated outputs fail", async t => {
  const malformed: unknown[] = [null, {}, [], { error: `upstream-private ${apiKey}`, ...response() }];
  for (const choices of [[], [null], [{}], [{ finish_reason: "stop", message: null }]]) {
    malformed.push({ ...response(), choices });
  }
  for (const content of [null, 1, [], "", " \n\t", "x".repeat(16_001)]) {
    malformed.push({ ...response(), choices: [{ finish_reason: "stop", message: { content } }] });
  }
  for (const finish_reason of [undefined, null, "length", "content_filter", "tool_calls", "unknown"]) {
    malformed.push({ ...response(), choices: [{ finish_reason, message: { content: "Partial" } }] });
  }
  for (const usage of [undefined, null, {}, { prompt_tokens: 1 }, { completion_tokens: 1 },
    ...[-1, 0.5, "1", null, Number.MAX_SAFE_INTEGER + 1].flatMap(value => [
      { prompt_tokens: value, completion_tokens: 1 }, { prompt_tokens: 1, completion_tokens: value },
    ])]) malformed.push({ ...response(), usage });
  const bodies = ["{upstream-private", "", Buffer.from([0xff]), ...malformed.map(value => JSON.stringify(value))];
  for (const body of bodies) {
    const baseUrl = await serve(t, (_req, res) => res.end(body));
    await assert.rejects(generate(adapter(baseUrl)), error => {
      redacted(error);
      assert.match((error as Error).message, /^MODEL_(INVALID|INCOMPLETE)_RESPONSE$/);
      return true;
    });
  }
});

test("pre-cancellation throws a sanitized AbortError without spending budget", async t => {
  let calls = 0;
  const baseUrl = await serve(t, (_req, res) => { calls += 1; res.end(JSON.stringify(response())); });
  const instance = adapter(baseUrl, { maxCalls: 1 });
  const controller = new AbortController();
  controller.abort(new Error(`upstream-private ${apiKey}`));
  await assert.rejects(instance.generate(request, controller.signal), error => {
    redacted(error);
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
  assert.equal(calls, 0);
  await generate(instance);
  assert.equal(calls, 1);
});

test("cancellation and timeout cover both headers and a stalled body, close connections and spend budget", { timeout: 10_000 }, async t => {
  for (const bodyStarted of [false, true]) {
    for (const cancel of [false, true]) {
      let entered!: () => void;
      let closed!: () => void;
      const entry = new Promise<void>(resolve => { entered = resolve; });
      const close = new Promise<void>(resolve => { closed = resolve; });
      let calls = 0;
      const baseUrl = await serve(t, (_req, res) => {
        calls += 1;
        res.once("close", closed);
        if (bodyStarted) { res.writeHead(200); res.write('{"choices":'); }
        entered();
      });
      const instance = adapter(baseUrl, { timeoutMs: cancel ? 2_000 : 100, maxCalls: 1 });
      const controller = new AbortController();
      const pending = assert.rejects(instance.generate(request, controller.signal), error => {
        redacted(error);
        assert.equal((error as Error).message, cancel ? "MODEL_CANCELLED" : "MODEL_TIMEOUT");
        if (cancel) assert.equal((error as Error).name, "AbortError");
        return true;
      });
      await entry;
      if (cancel) controller.abort(new Error(`upstream-private ${apiKey}`));
      await pending;
      await close;
      await assert.rejects(generate(instance), /MODEL_CALL_BUDGET_EXHAUSTED/);
      assert.equal(calls, 1);
    }
  }
});

test("default lifetime budget is ten calls and does not reset after success", async t => {
  let calls = 0;
  const baseUrl = await serve(t, (_req, res) => { calls += 1; res.end(JSON.stringify(response())); });
  const instance = adapter(baseUrl);
  for (let i = 0; i < 10; i += 1) await generate(instance);
  await assert.rejects(generate(instance), /MODEL_CALL_BUDGET_EXHAUSTED/);
  assert.equal(calls, 10);
});

test("concurrent calls reserve budget synchronously and HTTP failures never refund it", async t => {
  let calls = 0;
  const baseUrl = await serve(t, (_req, res) => { calls += 1; res.writeHead(500); res.end(); });
  const instance = adapter(baseUrl, { maxCalls: 2 });
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => generate(instance)));
  assert.ok(results.every(result => result.status === "rejected"));
  assert.equal(results.filter(result => result.status === "rejected" && result.reason.message === "MODEL_HTTP_ERROR").length, 2);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason.message === "MODEL_CALL_BUDGET_EXHAUSTED").length, 4);
  assert.equal(calls, 2);
  await assert.rejects(generate(instance), /MODEL_CALL_BUDGET_EXHAUSTED/);
});
