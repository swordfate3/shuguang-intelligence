import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModel, parseModelConfig, createModelConfig } from "../src/adapters/models/config.ts";

test("explicit config resolves only named credentials, rejects literals/unknown fields and excess budget", t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-model-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "model.json");
  const name = "DAWN_CONFIG_UNIT_TEST_KEY";
  const previous = process.env[name];
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  process.env[name] = "unit-test-key";
  const config = { baseUrl: "http://127.0.0.1:1234/v1", model: "test", credentialEnv: name, maxCalls: 1, reasoningEffort: "low" };
  writeFileSync(path, JSON.stringify(config));
  assert.ok(loadModel(path)); // timeoutMs remains optional for existing configurations.
  writeFileSync(path, JSON.stringify({ ...config, timeoutMs: 30_000 }));
  assert.ok(loadModel(path));
  for (const value of [{ ...config, timeoutMs: 0 }, { ...config, timeoutMs: 30_001 },
    { ...config, timeoutMs: "8000" }, { ...config, timeoutMs: 1.5 },
    { ...config, apiKey: "must-not-be-accepted" }, { ...config, maxCalls: 11 },
    { ...config, credentialEnv: "!cat a-file" }, { ...config, credentialEnv: "not-a-variable" },
    { ...config, unexpected: true }]) {
    writeFileSync(path, JSON.stringify(value));
    assert.throws(() => loadModel(path));
  }
  for (const invalidJson of [
    JSON.stringify({ ...config, timeoutMs: null }).replace('"timeoutMs":null', '"timeoutMs":NaN'),
    JSON.stringify({ ...config, timeoutMs: null }).replace('"timeoutMs":null', '"timeoutMs":undefined'),
  ]) {
    writeFileSync(path, invalidJson);
    assert.throws(() => loadModel(path));
  }
  delete process.env[name];
  writeFileSync(path, JSON.stringify(config));
  assert.throws(() => loadModel(path));
});

test("model configuration validates offline without credentials or model requests", () => {
  const config = { baseUrl: "https://example.invalid/v1", model: "synthetic-model", credentialEnv: "DAWN_WIZARD_UNSET_SYNTHETIC",
    maxCalls: 4, reasoningEffort: "low", timeoutMs: 30000 };
  assert.deepEqual(parseModelConfig(config), config);
  for (const change of [{ baseUrl: "https://user:secret@example.invalid/v1" }, { baseUrl: "https://example.invalid/v1?key=x" },
    { baseUrl: "http://example.invalid/v1" }, { baseUrl: "https://example.invalid/api/v1" }, { baseUrl: "!credential-command" },
    { model: "bad\u001b[31m" }, { model: "m".repeat(257) }, { model: " padded " }, { model: "" },
    { credentialEnv: "$SECRET" }, { apiKey: "synthetic-key-not-allowed" }, { reasoningEffort: "off" }]) {
    assert.throws(() => parseModelConfig({ ...config, ...change }));
  }
});

test("model configuration creation is explicit, private, exclusive and rejects cancellation before write", t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-model-create-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "new.json");
  const config = { baseUrl: "https://example.invalid/v1", model: "synthetic-model", credentialEnv: "DAWN_WIZARD_UNSET_SYNTHETIC",
    maxCalls: 4, reasoningEffort: "low" };
  const signal = new AbortController().signal;
  createModelConfig(path, config, signal);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), config);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => createModelConfig(path, { ...config, model: "replacement" }, signal));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), config);
  const link = join(dir, "link.json");
  symlinkSync(path, link);
  assert.throws(() => createModelConfig(link, config, signal));
  assert.throws(() => createModelConfig("relative.json", config, signal));
  const aborted = new AbortController(); aborted.abort();
  assert.throws(() => createModelConfig(join(dir, "cancelled.json"), config, aborted.signal));
  assert.throws(() => createModelConfig(join(dir, "invalid.json"), { ...config, maxCalls: 11 }, signal));
  assert.deepEqual(readdirSync(dir).sort(), ["link.json", "new.json"]);
});

test("new offline configuration roundtrips through the existing loader and adapter without real network", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-config-roundtrip-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const name = "DAWN_CONFIG_ROUNDTRIP_UNIT_KEY";
  const previous = process.env[name];
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(String(url), "https://example.invalid/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "synthetic");
    assert.equal(body.reasoning_effort, "low");
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "synthetic response" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
  const path = join(dir, "model.json");
  createModelConfig(path, { baseUrl: "https://example.invalid/v1", model: "synthetic", credentialEnv: name,
    maxCalls: 4, reasoningEffort: "low", timeoutMs: 30000 }, new AbortController().signal);
  assert.equal(calls, 0);
  process.env[name] = "synthetic-test-only";
  const model = loadModel(path);
  assert.equal(calls, 0);
  const result = await model.generate({ messages: [{ role: "user", text: "synthetic" }], maxOutputTokens: 1 }, new AbortController().signal);
  assert.equal(result.text, "synthetic response");
  assert.equal(calls, 1);
});

test("loadModel forwards an explicit timeout to the model adapter", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-model-timeout-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "model.json");
  const name = "DAWN_CONFIG_TIMEOUT_TEST_KEY";
  const previous = process.env[name];
  process.env[name] = "synthetic-config-test-key";
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    fetchCalls += 1;
    const signal = init?.signal;
    if (!signal) { reject(new Error("Missing synthetic request signal")); return; }
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const originalSetTimeout = globalThis.setTimeout;
  const scheduledTimeouts: unknown[] = [];
  globalThis.setTimeout = new Proxy(originalSetTimeout, {
    apply(target, thisArg, args: [handler: unknown, timeout?: unknown, ...rest: unknown[]]) {
      scheduledTimeouts.push(args[1]);
      args[1] = 1; // Keep these abort-path tests fast while retaining the requested delay.
      return Reflect.apply(target, thisArg, args);
    },
  });
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });

  const base = { baseUrl: "https://example.invalid/v1", model: "test", credentialEnv: name,
    maxCalls: 1, reasoningEffort: "low" };
  for (const [timeoutMs, expectedDelay] of [[undefined, 8000], [30_000, 30_000]] as const) {
    const config = timeoutMs === undefined ? base : { ...base, timeoutMs };
    writeFileSync(path, JSON.stringify(config));
    const adapter = loadModel(path);
    await assert.rejects(adapter.generate({
      messages: [{ role: "user", text: "Synthetic timeout test" }], maxOutputTokens: 1,
    }, new AbortController().signal), /MODEL_TIMEOUT/);
    assert.equal(scheduledTimeouts.at(-1), expectedDelay);
    assert.equal(fetchCalls, scheduledTimeouts.length);
  }
});
