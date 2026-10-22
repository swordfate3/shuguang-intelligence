import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type RequestListener } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInitialState } from "../src/core/state.ts";
import { createInitialState as createLegacyInitialState } from "../src/legacy/state.ts";
import { OpenAICompatibleModel } from "../src/adapters/models/openai-compatible.ts";
import { SqliteSubjectStore } from "../src/adapters/storage/sqlite-subject.ts";
import { InMemoryStateStore } from "../src/adapters/storage/in-memory.ts";
import { assertDawnRequest, assertDawnResponse, MAX_WIRE_BYTES } from "../src/protocol/index.ts";
import type { DawnRequest, DawnResponse } from "../src/protocol/index.ts";
import { SubjectService } from "../src/runtime/subject-service.ts";
import { DawnService } from "../src/runtime/service.ts";
import { ModelSelectionConflictError } from "../src/runtime/model-control.ts";
import type { ModelControlPort } from "../src/runtime/model-control.ts";
import type { ModelPort } from "../src/adapters/models/port.ts";
import type { ModelSelectionState } from "../src/protocol/model-controls.ts";

const at = "2026-01-01T00:00:00.000Z";
const token = "synthetic-loopback-token-12345678901234567890";
const apiKey = "synthetic-adapter-key-NEVER-LEAK";
const originalModel = "synthetic-original-model";
const alternateModel = "synthetic-alternate-model";
const controller = () => new AbortController();
const signal = () => controller().signal;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function listen(handler: RequestListener): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

async function call(origin: string, request: DawnRequest): Promise<DawnResponse> {
  const response = await fetch(`${origin}/v1/request`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (response.status !== 200) throw new Error(`Synthetic local service returned ${response.status}`);
  const value: unknown = await response.json();
  assertDawnResponse(value);
  assert.equal(value.requestId, request.requestId);
  return value;
}

function request(type: DawnRequest["type"], requestId: string, extra: object = {}): DawnRequest {
  return { version: 1, requestId, type, ...extra } as DawnRequest;
}

function upstreamResponse() {
  return {
    model: "upstream-untrusted-model-id",
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ reply: "合成回答", appraisal: null, candidates: [] }) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

function adapter(baseUrl: string): OpenAICompatibleModel {
  return new OpenAICompatibleModel({ baseUrl, model: originalModel, apiKey, maxCalls: 5 });
}

function assertError(response: DawnResponse, code: string): void {
  assert.equal(response.type, "error");
  if (response.type === "error") assert.equal(response.code, code);
}

function assertModel(response: DawnResponse) {
  assert.equal(response.type, "model");
  if (response.type !== "model") throw new Error("Expected model response");
  assert.deepEqual(Object.keys(response.state).sort(), ["calls", "levels", "maxCalls", "model", "models", "selectionRevision", "thinking"]);
  assert.equal(JSON.stringify(response).includes(apiKey), false);
  assert.equal(JSON.stringify(response).includes("127.0.0.1"), false);
  return response.state;
}

test("protocol strictly validates model controls and safe bounded model states", () => {
  const base = { version: 1, requestId: "model-control" };
  for (const value of [
    { ...base, type: "model-status" }, { ...base, type: "model-list" },
    { ...base, type: "model-select", expectedRevision: 0, model: originalModel },
    { ...base, type: "thinking-select", expectedRevision: 0, thinking: "xhigh" },
  ]) assertDawnRequest(value);
  for (const value of [
    { ...base, type: "model-status", extra: true },
    { ...base, type: "model-select", expectedRevision: 0, model: "" },
    { ...base, type: "model-select", expectedRevision: 0, model: "x".repeat(257) },
    { ...base, type: "model-select", expectedRevision: 0, model: "bad\u0000id" },
    { ...base, type: "model-select", expectedRevision: -1, model: "valid-model" },
    { ...base, type: "thinking-select", expectedRevision: 0.5, thinking: "high" },
    { ...base, type: "thinking-select", expectedRevision: 0, thinking: "none" },
    { ...base, type: "thinking-select", expectedRevision: 0, thinking: "medium", extra: true },
  ]) assert.throws(() => assertDawnRequest(value));

  const state = { selectionRevision: 1, model: originalModel, thinking: "low", levels: ["off", "low"],
    models: [originalModel], calls: 1, maxCalls: 5 };
  assertDawnResponse({ ...base, type: "model", state });
  for (const invalid of [
    { ...state, surprise: true }, { ...state, selectionRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...state, model: "bad\u0085id" }, { ...state, thinking: "none" },
    { ...state, levels: [] }, { ...state, levels: ["low", "low"] },
    { ...state, levels: ["medium"] }, { ...state, levels: ["none"] },
    { ...state, models: Array.from({ length: 129 }, (_, i) => `model-${i}`) },
    { ...state, models: [originalModel, originalModel] }, { ...state, models: ["bad\u202eid"] },
    { ...state, calls: -1 }, { ...state, maxCalls: 0 }, { ...state, calls: 6 },
  ]) assert.throws(() => assertDawnResponse({ ...base, type: "model", state: invalid }));

  // 128 legal IDs can still exceed the transport cap; response validation enforces actual UTF-8 size.
  const oversized = { ...state, models: Array.from({ length: 128 }, (_, i) => `${i}-` + "界".repeat(250)) };
  const envelope = { ...base, type: "model", state: oversized };
  assert.ok(Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_WIRE_BYTES);
  assert.throws(() => assertDawnResponse(envelope));
});

test("subject loopback model controls discover/select without charge or subject-state mutation; old generation remains FIFO fenced", { timeout: 15_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "dawn-model-service-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = createInitialState("synthetic-subject", "合成主体", at);
  const store = SqliteSubjectStore.create(join(directory, "subject.sqlite"), initial, 5, signal());
  t.after(() => store.close());
  await store.changeLifecycle(0, "awake", at, signal());

  const generationEntered = deferred();
  const releaseGeneration = deferred();
  const postedModels: string[] = [];
  let discoveryCalls = 0;
  const upstream = await listen((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      discoveryCalls++;
      res.end(JSON.stringify({ data: [{ id: originalModel }, { id: alternateModel }] }));
      return;
    }
    assert.equal(req.method, "POST");
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
      postedModels.push(body.model);
      if (postedModels.length === 1) {
        generationEntered.resolve();
        await releaseGeneration.promise;
      }
      res.end(JSON.stringify(upstreamResponse()));
    });
  });
  t.after(() => upstream.close());
  const model = adapter(`${upstream.origin}/v1`);
  const service = new SubjectService(store, model, () => at);
  // Exercise the production authenticated HTTP transport and its loopback bounds.
  const { startHttpServer } = await import("../src/adapters/transport/http-server.ts");
  const controlServer = await startHttpServer({ token, port: 0, handler: (req, abort) => service.handle(req, abort) });
  const origin = `http://127.0.0.1:${controlServer.port}`;
  t.after(() => controlServer.close());

  const subjectBeforeControls = await store.read(signal());
  const budgetBeforeControls = await store.budget(signal());
  const initialState = assertModel(await call(origin, request("model-status", "status-1")));
  assert.equal(initialState.selectionRevision, 0);
  assert.equal(initialState.calls, 0);
  assert.deepEqual(initialState.models, [originalModel]);
  const discovered = assertModel(await call(origin, request("model-list", "list-1")));
  assert.deepEqual(discovered.models, [originalModel, alternateModel]);
  assert.equal(discovered.calls, 0);
  assert.equal(discovered.selectionRevision, 0);
  assertModel(await call(origin, request("model-select", "select-1", { expectedRevision: 0, model: alternateModel })));
  const thinking = assertModel(await call(origin, request("thinking-select", "thinking-1", { expectedRevision: 1, thinking: "off" })));
  assert.equal(thinking.selectionRevision, 2);
  assert.equal(thinking.calls, 0);

  assert.deepEqual(await store.read(signal()), subjectBeforeControls, "model controls never write subject state or revision");
  assert.deepEqual(await store.budget(signal()), budgetBeforeControls, "model controls never reserve subject calls");
  assert.deepEqual(budgetBeforeControls, { limit: 5, reserved: 0, completed: 0, failed: 0, pending: 0 });

  // Reset selection while idle, then prove a queued change cannot affect the accepted generate call.
  assertModel(await call(origin, request("model-select", "select-original", { expectedRevision: 2, model: originalModel })));
  const say = request("say", "fifo-say", { text: "合成问题" });
  const pendingSay = call(origin, say);
  await generationEntered.promise;
  // Cancel model controls while they are still queued, not merely during active discovery.
  const cancelledListSignal = controller();
  const cancelledSelectSignal = controller();
  const cancelledList = assert.rejects(service.handle(request("model-list", "queued-cancelled-list"), cancelledListSignal.signal), { name: "AbortError" });
  const cancelledSelect = assert.rejects(service.handle(request("thinking-select", "queued-cancelled-thinking", {
    expectedRevision: 3, thinking: "high",
  }), cancelledSelectSignal.signal), { name: "AbortError" });
  cancelledListSignal.abort(); cancelledSelectSignal.abort();
  const selectionRequest = request("model-select", "select-queued", { expectedRevision: 3, model: alternateModel });
  let selectionFinished = false;
  const pendingSelection = call(origin, selectionRequest).then(result => { selectionFinished = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(selectionFinished, false, "control waits behind already-running generation in the service FIFO");
  assert.deepEqual(postedModels, [originalModel]);
  releaseGeneration.resolve();
  assert.equal((await pendingSay).type, "reply");
  const selected = assertModel(await pendingSelection);
  await Promise.all([cancelledList, cancelledSelect]);
  assert.equal(discoveryCalls, 1, "queued cancelled discovery never dispatches GET");
  assert.equal(selected.selectionRevision, 4, "queued cancelled selection never changes selection state");
  assert.equal(selected.thinking, "off");
  assert.equal(selected.model, alternateModel);
  assert.equal(selected.calls, 1);
  assert.deepEqual(postedModels, [originalModel]);

  const nextSay = await call(origin, request("say", "fifo-next", { text: "下一次合成问题" }));
  assert.equal(nextSay.type, "reply");
  assert.deepEqual(postedModels, [originalModel, alternateModel]);
  const subjectAfter = await store.read(signal());
  assert.equal(subjectAfter.revision, subjectBeforeControls.revision + 4, "only successful say cycles changed subject revision");
  assert.equal((await store.budget(signal())).completed, 2);
  assert.equal(model.modelState().calls, 2);
  await service.close();
});

test("legacy loopback service uses fake controls without lifecycle writes and absent controls stay unimplemented", async t => {
  const initial = createLegacyInitialState("synthetic-legacy", "合成旧主体", at);
  const store = new InMemoryStateStore(initial);
  let calls = 0;
  let selectionRevision = 0;
  let selectedModel = originalModel;
  let thinking: ModelSelectionState["thinking"] = "low";
  let models = [originalModel];
  const fake: ModelControlPort = {
    async generate() { calls++; throw new Error("unexpected generation"); },
    modelState: () => ({ selectionRevision, model: selectedModel, thinking, levels: ["off", "low", "medium", "high", "xhigh", "max"],
      models, calls, maxCalls: 3 }),
    async discoverModels(abort) { abort.throwIfAborted(); models = [originalModel, alternateModel]; return fake.modelState(); },
    selectModel(expected, model) {
      if (expected !== selectionRevision) throw new ModelSelectionConflictError();
      if (model !== selectedModel) { selectedModel = model; selectionRevision++; }
      return fake.modelState();
    },
    selectThinking(expected, level) {
      if (expected !== selectionRevision) throw new ModelSelectionConflictError();
      if (level !== thinking) { thinking = level; selectionRevision++; }
      return fake.modelState();
    },
  };
  const service = new DawnService(store, () => at, fake);
  const { startHttpServer } = await import("../src/adapters/transport/http-server.ts");
  const server = await startHttpServer({ token, port: 0, handler: (req, abort) => service.handle(req, abort) });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.port}`;

  const before = await store.read(signal());
  assertModel(await call(origin, request("model-status", "legacy-status")));
  const discovered = assertModel(await call(origin, request("model-list", "legacy-list")));
  assert.deepEqual(discovered.models, [originalModel, alternateModel]);
  assertModel(await call(origin, request("model-select", "legacy-select", { expectedRevision: 0, model: alternateModel })));
  assert.equal(assertModel(await call(origin, request("thinking-select", "legacy-thinking", { expectedRevision: 1, thinking: "off" }))).thinking, "off");
  assertError(await call(origin, request("model-select", "legacy-stale", { expectedRevision: 0, model: originalModel })), "CONFLICT");
  assert.deepEqual(await store.read(signal()), before);
  assert.deepEqual(store.events(), []);
  assert.equal(calls, 0);
  await service.close();

  const noControlService = new DawnService(store, () => at, { async generate() { calls++; throw new Error("unexpected"); } });
  const noControlServer = await startHttpServer({ token, port: 0, handler: (req, abort) => noControlService.handle(req, abort) });
  t.after(() => noControlServer.close());
  const unsupported = await call(`http://127.0.0.1:${noControlServer.port}`, request("model-status", "no-control"));
  assertError(unsupported, "NOT_IMPLEMENTED");
  assert.equal(JSON.stringify(unsupported).includes(apiKey), false);
  assert.deepEqual(await store.read(signal()), before);
  assert.deepEqual(store.events(), []);
  assert.equal(calls, 0);
  await noControlService.close();
});

test("loopback rejects malformed controls, maps conflicts, sanitizes failures, and propagates active abort", async t => {
  const state = { selectionRevision: 0, model: originalModel, thinking: "low" as const,
    levels: ["low"] as const, models: [originalModel], calls: 0, maxCalls: 2 };
  let discoverCalls = 0;
  const discoverEntered = deferred();
  const fake = {
    modelState: () => state,
    async discoverModels(abort: AbortSignal) {
      discoverCalls++;
      discoverEntered.resolve();
      await new Promise<void>(resolve => abort.addEventListener("abort", () => resolve(), { once: true }));
      abort.throwIfAborted();
      return state;
    },
    selectModel(expected: number) { if (expected !== 0) throw new ModelSelectionConflictError(); return state; },
    selectThinking(expected: number) { if (expected !== 0) throw new ModelSelectionConflictError(); return state; },
    async generate() { throw new Error("never called"); },
  } as unknown as ModelPort;
  const service = new DawnService(new InMemoryStateStore(createLegacyInitialState("synthetic-validation", "验证", at)), () => at, fake);
  const { startHttpServer } = await import("../src/adapters/transport/http-server.ts");
  const server = await startHttpServer({ token, port: 0, handler: (req, abort) => service.handle(req, abort) });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.port}`;

  for (const malformed of [
    { version: 1, requestId: "bad-model", type: "model-select", expectedRevision: 0, model: "bad\u0000id" },
    { version: 1, requestId: "bad-level", type: "thinking-select", expectedRevision: 0, thinking: "none" },
    { version: 1, requestId: "extra", type: "model-status", hidden: true },
  ]) {
    const response = await fetch(`${origin}/v1/request`, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(malformed) });
    assert.equal(response.status, 400);
    assert.equal(discoverCalls, 0);
  }
  const conflict = await call(origin, request("model-select", "stale", { expectedRevision: 1, model: alternateModel }));
  assertError(conflict, "CONFLICT");
  assert.doesNotMatch(JSON.stringify(conflict), /NEVER-LEAK|127\.0\.0\.1|upstream/);

  const activeAbort = new AbortController();
  const pending = service.handle(request("model-list", "cancelled"), activeAbort.signal);
  await discoverEntered.promise;
  activeAbort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(discoverCalls, 1);
  await service.close();
});
