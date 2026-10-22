import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { inspect } from "node:util";
import test, { type TestContext } from "node:test";
import { OpenAICompatibleModel } from "../src/adapters/models/openai-compatible.ts";
import type { ModelSelectionState, ThinkingLevel } from "../src/protocol/model-controls.ts";
import { ModelSelectionConflictError, type ModelControlPort } from "../src/runtime/model-control.ts";
import type { ModelPort } from "../src/adapters/models/port.ts";

const apiKey = "synthetic-model-control-key-NEVER-LEAK";
const originalModel = "synthetic-configured-model";
const request: Parameters<ModelPort["generate"]>[0] = {
  messages: [{ role: "user", text: "Synthetic model control request" }], maxOutputTokens: 16,
};
const response = (modelId: string) => ({
  model: "upstream-reported-model-is-not-trusted",
  choices: [{ finish_reason: "stop", message: { content: `synthetic reply from ${modelId}` } }],
  usage: { prompt_tokens: 2, completion_tokens: 3 },
});

async function serve(t: TestContext, handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/v1`;
}

function adapter(baseUrl: string, options: { maxCalls?: number; timeoutMs?: number } = {}): OpenAICompatibleModel {
  return new OpenAICompatibleModel({ baseUrl, model: originalModel, apiKey, ...options });
}

function redacted(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.doesNotMatch(inspect(error), /synthetic-model-control-key|upstream-private|127\.0\.0\.1|https?:\/\//);
  assert.equal(error.cause, undefined);
  return true;
}

function generate(model: ModelControlPort, signal = new AbortController().signal) {
  return model.generate(request, signal);
}

function assertStateWithoutSecrets(state: ModelSelectionState): void {
  assert.deepEqual(Object.keys(state).sort(), ["calls", "levels", "maxCalls", "model", "models", "selectionRevision", "thinking"]);
  assert.doesNotMatch(JSON.stringify(state), /synthetic-model-control-key|127\.0\.0\.1|https?:\/\//);
}

test("discovery is explicit, authenticated GET, bounded de-duplicated state and no call-budget charge", async t => {
  let gets = 0;
  let posts = 0;
  const baseUrl = await serve(t, (req, res) => {
    if (req.method === "GET") {
      gets += 1;
      assert.equal(req.url, "/v1/models");
      assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
      res.end(JSON.stringify({ object: "list", data: [
        { id: "synthetic-model-b", created: 1 }, { id: "synthetic-model-a", owned_by: "synthetic" },
        { id: "synthetic-model-b", permission: [] },
      ] }));
      return;
    }
    posts += 1;
    res.writeHead(500).end("unexpected generated request");
  });
  const model = adapter(baseUrl, { maxCalls: 2 });
  const initial = model.modelState();
  assert.deepEqual(initial.models, [originalModel]);
  assert.equal(initial.calls, 0);
  assertStateWithoutSecrets(initial);

  const discovered = await model.discoverModels(new AbortController().signal);
  assert.deepEqual(discovered.models, ["synthetic-model-b", "synthetic-model-a"]);
  assert.equal(discovered.calls, 0);
  assert.equal(discovered.model, originalModel);
  assert.deepEqual(discovered.levels, ["off", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(gets, 1);
  assert.equal(posts, 0);
  assertStateWithoutSecrets(discovered);

  const selected = model.selectModel(discovered.selectionRevision, "synthetic-model-b", new AbortController().signal);
  assert.equal(selected.selectionRevision, discovered.selectionRevision + 1);
  assert.equal(model.selectModel(selected.selectionRevision, "synthetic-model-b", new AbortController().signal).selectionRevision,
    selected.selectionRevision, "same-value selection is a no-op");
  assert.throws(() => model.selectModel(discovered.selectionRevision, "synthetic-model-a", new AbortController().signal),
    ModelSelectionConflictError);
  assert.throws(() => model.selectModel(selected.selectionRevision, "unknown-synthetic-model", new AbortController().signal), /MODEL_UNKNOWN_ID/);
  assert.throws(() => model.selectModel(selected.selectionRevision, "bad\u0000id", new AbortController().signal), /MODEL_UNKNOWN_ID/);

  const thinking = model.selectThinking(selected.selectionRevision, "off", new AbortController().signal);
  assert.equal(thinking.thinking, "off");
  assert.equal(thinking.selectionRevision, selected.selectionRevision + 1);
  assert.equal(model.selectThinking(thinking.selectionRevision, "off", new AbortController().signal).selectionRevision,
    thinking.selectionRevision, "same thinking value is a no-op");
  assert.throws(() => model.selectThinking(selected.selectionRevision, "high" as ThinkingLevel, new AbortController().signal),
    ModelSelectionConflictError);
  assert.throws(() => model.selectThinking(thinking.selectionRevision, "none" as ThinkingLevel, new AbortController().signal),
    /MODEL_INVALID_THINKING_LEVEL/);
  assert.equal(model.modelState().calls, 0);
});

test("bad discovery schemas, IDs, excessive items, oversized bodies and HTTP errors preserve the previous cache", async t => {
  const invalidPayloads: unknown[] = [
    null,
    { data: "not-an-array" },
    { data: [{ id: 1 }] },
    { data: [{ id: "bad\u0000id" }] },
    { data: [{ id: "bad\u0085id" }] },
    { data: [{ id: "bad\u202eid" }] },
    { data: [{ id: "x".repeat(257) }] },
    { data: Array.from({ length: 129 }, (_, index) => ({ id: `synthetic-model-${index}` })) },
    // Valid individual IDs still must fit a safe catalog inside the 64 KiB control protocol.
    { data: Array.from({ length: 128 }, (_, index) => ({ id: `${index}-${"字".repeat(250)}` })) },
  ];
  let mode: "valid" | "invalid" | "invalid-utf8" | "http" | "oversized" | "chunked" = "valid";
  let payloadIndex = 0;
  const baseUrl = await serve(t, (_req, res) => {
    if (mode === "http") { res.writeHead(503).end("upstream-private"); return; }
    if (mode === "oversized") {
      res.writeHead(200, { "Content-Length": 1024 * 1024 + 1 }).flushHeaders();
      return;
    }
    if (mode === "chunked") {
      res.setHeader("Transfer-Encoding", "chunked");
      res.write(Buffer.alloc(512 * 1024, 32));
      res.write(Buffer.alloc(512 * 1024, 32));
      res.end("x");
      return;
    }
    if (mode === "invalid-utf8") { res.end(Buffer.from([0xff])); return; }
    const value = mode === "valid" ? { data: [{ id: "synthetic-good-model" }] } : invalidPayloads[payloadIndex++];
    res.end(JSON.stringify(value));
  });
  const model = adapter(baseUrl);
  const original = model.modelState();
  assert.deepEqual((await model.discoverModels(new AbortController().signal)).models, ["synthetic-good-model"]);
  const goodCache = model.modelState();

  for (let i = 0; i < invalidPayloads.length; i += 1) {
    mode = "invalid";
    await assert.rejects(model.discoverModels(new AbortController().signal), error => {
      redacted(error);
      assert.equal((error as Error).message, "MODEL_INVALID_MODELS_RESPONSE");
      return true;
    });
    assert.deepEqual(model.modelState(), goodCache);
  }
  mode = "invalid-utf8";
  await assert.rejects(model.discoverModels(new AbortController().signal), error => {
    redacted(error);
    assert.equal((error as Error).message, "MODEL_INVALID_RESPONSE");
    return true;
  });
  assert.deepEqual(model.modelState(), goodCache);
  for (const nextMode of ["http", "oversized", "chunked"] as const) {
    mode = nextMode;
    await assert.rejects(model.discoverModels(new AbortController().signal), error => {
      redacted(error);
      assert.match((error as Error).message, /^MODEL_DISCOVERY_(HTTP_ERROR|RESPONSE_TOO_LARGE)$/);
      return true;
    });
    assert.deepEqual(model.modelState(), goodCache);
  }
  assert.equal(original.models[0], originalModel);
});

test("model discovery rejects redirects without following them or forwarding credentials", async t => {
  let targetCalls = 0;
  const target = await serve(t, (_req, res) => { targetCalls += 1; res.end(JSON.stringify({ data: [] })); });
  const redirect = await serve(t, (_req, res) => { res.writeHead(302, { Location: `${target}/models` }).end(); });
  const model = adapter(redirect);
  await assert.rejects(model.discoverModels(new AbortController().signal), error => {
    redacted(error);
    assert.equal((error as Error).message, "MODEL_DISCOVERY_FAILED");
    return true;
  });
  assert.equal(targetCalls, 0);
  assert.deepEqual(model.modelState().models, [originalModel]);
});

test("discovery timeout is capped at eight seconds and preserves cache without charging calls", { timeout: 5_000 }, async t => {
  const originalSetTimeout = globalThis.setTimeout;
  const scheduled: number[] = [];
  globalThis.setTimeout = new Proxy(originalSetTimeout, {
    apply(target, thisArg, args: [handler: TimerHandler, timeout?: number, ...rest: unknown[]]) {
      if (args[1] === 8_000) {
        scheduled.push(8_000);
        args[1] = 5;
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });
  const baseUrl = await serve(t, (_req, _res) => { /* Synthetic server deliberately stalls. */ });
  const model = adapter(baseUrl, { timeoutMs: 30_000 });
  const original = model.modelState();
  await assert.rejects(model.discoverModels(new AbortController().signal), error => {
    redacted(error);
    assert.equal((error as Error).message, "MODEL_TIMEOUT");
    return true;
  });
  assert.deepEqual(scheduled, [8_000]);
  assert.deepEqual(model.modelState(), original);
});

test("discovery and generation are mutually exclusive with model controls", async t => {
  let enteredResolve!: () => void;
  const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
  const baseUrl = await serve(t, (req, res) => {
    if (req.method === "GET") { enteredResolve(); return; }
    res.end(JSON.stringify(response(originalModel)));
  });
  const model = adapter(baseUrl);
  const controller = new AbortController();
  const pendingDiscovery = model.discoverModels(controller.signal);
  await entered;
  assert.throws(() => model.selectThinking(0, "high", new AbortController().signal), /MODEL_CONTROL_BUSY/);
  await assert.rejects(generate(model), /MODEL_CONTROL_BUSY/);
  await assert.rejects(model.discoverModels(new AbortController().signal), /MODEL_CONTROL_BUSY/);
  controller.abort();
  await assert.rejects(pendingDiscovery, error => {
    redacted(error);
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
  assert.deepEqual(model.modelState().models, [originalModel]);
  assert.equal(model.modelState().selectionRevision, 0);
  assert.equal(model.modelState().calls, 0);

  let postEnteredResolve!: () => void;
  const postEntered = new Promise<void>(resolve => { postEnteredResolve = resolve; });
  const pendingBase = await serve(t, (req, res) => {
    if (req.method === "POST") { postEnteredResolve(); return; }
    res.end(JSON.stringify({ data: [originalModel] }));
  });
  const pendingModel = adapter(pendingBase);
  const callAbort = new AbortController();
  const pendingCall = generate(pendingModel, callAbort.signal);
  await postEntered;
  assert.throws(() => pendingModel.selectModel(0, originalModel, new AbortController().signal), /MODEL_CONTROL_BUSY/);
  await assert.rejects(pendingModel.discoverModels(new AbortController().signal), /MODEL_CONTROL_BUSY/);
  callAbort.abort();
  await assert.rejects(pendingCall, error => {
    redacted(error);
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
  assert.equal(pendingModel.modelState().calls, 1, "dispatched cancellation spends the shared budget");
});

test("model and thinking snapshots reach requests, off omits reasoning_effort, failures spend shared budget", async t => {
  let posts = 0;
  const received: Record<string, unknown>[] = [];
  const baseUrl = await serve(t, (req, res) => {
    if (req.method === "GET") { res.end(JSON.stringify({ data: [{ id: "synthetic-second-model" }] })); return; }
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      posts += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      received.push(body);
      if (posts === 1) { res.end(JSON.stringify(response(String(body.model)))); return; }
      res.writeHead(500).end("upstream-private response must not leak");
    });
  });
  const model = adapter(baseUrl, { maxCalls: 2 });
  const first = await generate(model);
  assert.equal(first.modelId, originalModel, "return configured model ID, not upstream's untrusted model field");
  assert.equal(received[0]!.model, originalModel);
  assert.equal(received[0]!.reasoning_effort, "low");
  assert.equal(model.modelState().calls, 1);

  const discovered = await model.discoverModels(new AbortController().signal);
  const selectedModel = model.selectModel(discovered.selectionRevision, "synthetic-second-model", new AbortController().signal);
  const selectedThinking = model.selectThinking(selectedModel.selectionRevision, "off", new AbortController().signal);
  assert.equal(selectedThinking.calls, 1, "selection and discovery do not reconstruct/reset the adapter");
  await assert.rejects(generate(model), error => {
    redacted(error);
    assert.equal((error as Error).message, "MODEL_HTTP_ERROR");
    return true;
  });
  assert.equal(received[1]!.model, "synthetic-second-model");
  assert.equal(Object.hasOwn(received[1]!, "reasoning_effort"), false, "off means omission, not none");
  assert.equal(model.modelState().calls, 2);
  await assert.rejects(generate(model), /MODEL_CALL_BUDGET_EXHAUSTED/);
  assert.equal(posts, 2, "failed generation is not retried and budget is not refunded");
  assert.equal(model.modelState().calls, 2);
});

test("constructor enforces the same ID display and wire policy as remote discovery", () => {
  for (const model of ["x".repeat(257), "bad\u202eid", "bad\u2028id", "bad\u0000id", " "]) {
    assert.throws(() => new OpenAICompatibleModel({ baseUrl: "http://127.0.0.1:1234/v1", model, apiKey }), /MODEL_INVALID_CONFIG/);
  }
});

test("initial models are locally selectable before discovery and stale/invalid CAS never changes state", () => {
  const model = new OpenAICompatibleModel({ baseUrl: "http://127.0.0.1:1234/v1", model: originalModel,
    apiKey, reasoningEffort: "off", maxCalls: 1 });
  assert.equal(model.selectModel(0, originalModel, new AbortController().signal).selectionRevision, 0);
  assert.equal(model.modelState().thinking, "off");
  for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0"]) {
    assert.throws(() => model.selectThinking(expectedRevision as number, "high", new AbortController().signal), ModelSelectionConflictError);
    assert.equal(model.modelState().selectionRevision, 0);
    assert.equal(model.modelState().thinking, "off");
  }
});
