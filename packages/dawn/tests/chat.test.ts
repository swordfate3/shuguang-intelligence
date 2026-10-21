import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState } from "../src/legacy/state.ts";
import { InMemoryStateStore } from "../src/adapters/storage/in-memory.ts";
import { DawnService } from "../src/runtime/service.ts";
import type { ModelPort } from "../src/adapters/models/port.ts";

const signal = () => new AbortController().signal;
const say = { version: 1 as const, requestId: "chat", type: "say" as const, text: "你好" };
const response = { text: "你好，我是曙光。", modelId: "fake", usage: { inputTokens: 10, outputTokens: 8 } };

test("sleep blocks model calls; awake chat sends only minimum context and never writes memories", async () => {
  let calls = 0;
  const store = new InMemoryStateStore(createInitialState("test", "曙光", "2026-01-01T00:00:00.000Z"));
  const model: ModelPort = { async generate(request, received) {
    received.throwIfAborted(); calls++;
    assert.equal(request.messages.length, 2);
    assert.equal(request.messages[1]?.text, "你好");
    assert.equal(request.maxOutputTokens, 256);
    return response;
  } };
  const service = new DawnService(store, undefined, model);
  assert.equal((await service.handle(say, signal())).type, "error");
  assert.equal(calls, 0);
  await service.handle({ version: 1, requestId: "wake", type: "wake", expectedRevision: 0 }, signal());
  const before = await store.read(signal());
  const reply = await service.handle(say, signal());
  assert.deepEqual(reply, { version: 1, requestId: "chat", type: "reply", text: response.text });
  assert.deepEqual(await store.read(signal()), before);
  assert.equal(calls, 1);
  await service.close();
});

test("model failure is redacted and cancellation never returns successful reply", async () => {
  const store = new InMemoryStateStore(createInitialState("test", "曙光", "2026-01-01T00:00:00.000Z"));
  await store.changeLifecycle({ expectedRevision: 0, lifecycle: "awake", at: "2026-01-01T00:00:00.000Z" }, signal());
  const failure = new DawnService(store, undefined, { async generate() { throw new Error("private upstream token"); } });
  const failed = await failure.handle(say, signal());
  assert.equal(failed.type, "error");
  assert.doesNotMatch(JSON.stringify(failed), /private upstream token/);
  const controller = new AbortController();
  const cancelled = new DawnService(store, undefined, { async generate() { controller.abort(); return response; } });
  await assert.rejects(cancelled.handle(say, controller.signal));
  const big = new DawnService(store, undefined, { async generate() { return { ...response, text: "x".repeat(16001) }; } });
  assert.equal((await big.handle(say, signal())).type, "error");
  await failure.close(); await cancelled.close(); await big.close();
});
