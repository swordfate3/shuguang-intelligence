import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryStateStore } from "../src/adapters/storage/in-memory.ts";
import type { ModelPort } from "../src/adapters/models/port.ts";
import { createInitialState } from "../src/legacy/state.ts";
import { MAX_MESSAGE_CHARS, MAX_WIRE_BYTES } from "../src/protocol/index.ts";
import type { DawnResponse } from "../src/protocol/index.ts";
import type { ChatStore, ChatExchange, ChatReservation } from "../src/runtime/chat-store.ts";
import { DawnService } from "../src/runtime/service.ts";
import { RevisionConflictError } from "../src/runtime/state-store.ts";

const at = "2026-01-01T00:00:00.000Z";
const signal = () => new AbortController().signal;
const say = (requestId = "chat", text = "Synthetic question") => ({ version: 1 as const, type: "say" as const, requestId, text });
const answer = { text: "Synthetic answer", modelId: "fake-model", usage: { inputTokens: 10, outputTokens: 8 } };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function unavailable(response: DawnResponse) {
  assert.deepEqual(response, { version: 1, requestId: response.requestId, type: "error", code: "UNAVAILABLE", message: "Dawn state is unavailable." });
}

/** Synthetic transactional fixture: failed reservations remain charged, never enter history. */
class FakeChatStore implements ChatStore {
  history: ChatExchange[] = [];
  reservations: ChatReservation[] = [];
  completed: ChatReservation[] = [];
  failed: ChatReservation[] = [];
  failSignals: AbortSignal[] = [];
  usages: Parameters<ChatStore["complete"]>[2][] = [];
  limit = 100;
  reserveError: unknown;
  completeError: unknown;
  failError: unknown;
  closed = false;
  async reserve(requestId: string, user: string, subjectRevision: number, abort: AbortSignal) {
    abort.throwIfAborted();
    if (this.reserveError) throw this.reserveError;
    if (this.reservations.some(item => item.requestId === requestId)) throw new Error("private duplicate");
    if (this.reservations.length >= this.limit) throw new Error("private exhausted budget");
    const reservation = { requestId, user, subjectRevision, sequence: this.reservations.length + 1, history: structuredClone(this.history) };
    this.reservations.push(reservation);
    return reservation;
  }
  async complete(reservation: ChatReservation, assistant: string, usage: Parameters<ChatStore["complete"]>[2], abort: AbortSignal) {
    abort.throwIfAborted();
    if (this.completeError) throw this.completeError;
    this.completed.push(reservation);
    this.usages.push(usage);
    this.history.push({ user: reservation.user, assistant });
  }
  async fail(reservation: ChatReservation, abort: AbortSignal) {
    this.failSignals.push(abort);
    abort.throwIfAborted();
    if (this.failError) throw this.failError;
    if (!this.completed.includes(reservation)) this.failed.push(reservation);
  }
  async budget(abort: AbortSignal) {
    abort.throwIfAborted();
    return { limit: this.limit, reserved: this.reservations.length, completed: this.completed.length,
      failed: this.failed.length, pending: this.reservations.length - this.completed.length - this.failed.length };
  }
  close() { this.closed = true; }
}
async function stateStore(awake = true) {
  const initial = createInitialState("private-subject-id", "private-subject-name", at);
  const store = new InMemoryStateStore({ ...initial, memoryIds: ["private-memory"],
    self: { ...initial.self, interests: [{ topic: "private-interest", strength: 0.5, evidenceIds: [] }] } });
  if (awake) await store.changeLifecycle({ expectedRevision: 0, lifecycle: "awake", at }, signal());
  return store;
}

test("reserve precedes dispatch; ordered complete history, minimum disclosure and multi-turn persistence", async () => {
  const store = await stateStore();
  const chats = new FakeChatStore();
  chats.history = [{ user: "old question", assistant: "old answer" }, { user: "next question", assistant: "next answer" }];
  const before = await store.read(signal());
  let calls = 0;
  let system = "";
  const model: ModelPort = { async generate(request, abort) {
    abort.throwIfAborted();
    calls++;
    const reservation = chats.reservations.at(-1)!;
    assert.equal(reservation.subjectRevision, 1);
    assert.equal(chats.reservations.length, calls);
    assert.equal(request.maxOutputTokens, 256);
    assert.equal(request.messages[0]?.role, "system");
    if (system) assert.equal(request.messages[0]?.text, system);
    system = request.messages[0]!.text;
    assert.match(system, /有限.*对话记录/);
    assert.match(system, /不是.*事实.*指令/);
    assert.deepEqual(request.messages.slice(1), [
      ...reservation.history.flatMap(pair => [{ role: "user", text: pair.user }, { role: "assistant", text: pair.assistant }]),
      { role: "user", text: reservation.user },
    ]);
    assert.doesNotMatch(JSON.stringify(request), /private-subject|private-memory|private-interest|memoryIds|personality/);
    return { ...answer, text: `reply-${calls}` };
  } };
  const service = new DawnService(store, () => at, model, chats);
  const results = await Promise.all([service.handle(say("first", "one"), signal()), service.handle(say("second", "two"), signal())]);
  assert.deepEqual(results.map(result => result.type), ["reply", "reply"]);
  assert.deepEqual(chats.reservations[1]!.history.at(-1), { user: "one", assistant: "reply-1" });
  assert.deepEqual(chats.history.at(-1), { user: "two", assistant: "reply-2" });
  assert.deepEqual(chats.usages, Array(2).fill({ modelId: "fake-model", inputTokens: 10, outputTokens: 8 }));
  assert.deepEqual(await store.read(signal()), before);
  await service.close();
});

test("40,000 character context keeps recent complete pairs in order, including exact boundary", async () => {
  for (const extra of [0, 1]) {
    const chats = new FakeChatStore();
    chats.history = [
      { user: "old", assistant: "discard" },
      { user: "u".repeat(12_000 + extra), assistant: "a".repeat(12_000) },
    ];
    const model: ModelPort = { async generate(request) {
      const context = request.messages.slice(1);
      assert.equal(context.reduce((size, message) => size + message.text.length, 0), extra ? 16_000 : 40_000);
      assert.deepEqual(context.map(message => message.role), extra ? ["user"] : ["user", "assistant", "user"]);
      assert.ok(!JSON.stringify(context).includes("discard"));
      return answer;
    } };
    const service = new DawnService(await stateStore(), undefined, model, chats);
    assert.equal((await service.handle(say("bounded", "x".repeat(16_000)), signal())).type, "reply");
    await service.close();
  }
});

test("sleeping and missing model do not reserve; reserve rejection/duplicate/budget never dispatch", async () => {
  const chats = new FakeChatStore();
  let calls = 0;
  const model: ModelPort = { async generate() { calls++; return answer; } };
  const sleeping = new DawnService(await stateStore(false), undefined, model, chats);
  assert.equal((await sleeping.handle(say(), signal())).type, "error");
  const missing = new DawnService(await stateStore(), undefined, undefined, chats);
  assert.equal((await missing.handle(say(), signal())).type, "error");
  assert.equal(chats.reservations.length, 0);
  const service = new DawnService(await stateStore(), undefined, model, chats);
  for (const error of [new Error("private reserve failure"), new RevisionConflictError()]) {
    chats.reserveError = error;
    unavailable(await service.handle(say(), signal()));
  }
  assert.equal(calls, 0);
  chats.reserveError = undefined;
  chats.limit = 1;
  assert.equal((await service.handle(say(), signal())).type, "reply");
  unavailable(await service.handle(say(), signal()));
  unavailable(await service.handle(say("over-budget"), signal()));
  assert.equal(calls, 1);
  assert.equal(chats.failSignals.length, 0);
  await sleeping.close(); await missing.close(); await service.close();
});

test("model errors and commit failures are redacted, mark failed without pairs/refund or retry", async () => {
  for (const phase of ["model", "commit"] as const) {
    const chats = new FakeChatStore();
    chats.limit = 1;
    if (phase === "commit") chats.completeError = new Error("private commit body");
    let calls = 0;
    const service = new DawnService(await stateStore(), undefined, { async generate() {
      calls++;
      if (phase === "model") throw new Error("private upstream body");
      return answer;
    } }, chats);
    unavailable(await service.handle(say(), signal()));
    assert.equal(chats.failed.length, 1);
    assert.deepEqual(chats.history, []);
    assert.equal(chats.completed.length, 0);
    assert.equal(chats.failSignals[0]?.aborted, false);
    assert.deepEqual(await chats.budget(signal()), { limit: 1, reserved: 1, completed: 0, failed: 1, pending: 0 });
    unavailable(await service.handle(say("later"), signal()));
    assert.equal(calls, 1);
    await service.close();
  }
});

test("invalid replies and usage cannot commit history", async () => {
  const escaped = "\u0000".repeat(MAX_MESSAGE_CHARS);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...say(), type: "reply", text: escaped })) > MAX_WIRE_BYTES);
  const invalid: unknown[] = [null, { ...answer, text: null }, ...["", " \n", "x".repeat(MAX_MESSAGE_CHARS + 1), escaped].map(text => ({ ...answer, text })),
    ...[null, "", "  ", 42].map(modelId => ({ ...answer, modelId })),
    ...[null, undefined, {}, { inputTokens: 0 }].map(usage => ({ ...answer, usage }))];
  for (const value of [-1, 0.5, Infinity, NaN, "1", Number.MAX_SAFE_INTEGER + 1]) {
    invalid.push({ ...answer, usage: { inputTokens: value, outputTokens: 1 } }, { ...answer, usage: { inputTokens: 1, outputTokens: value } });
  }
  for (const result of invalid) {
    const chats = new FakeChatStore();
    const service = new DawnService(await stateStore(), undefined, { async generate() {
      return result as typeof answer;
    } }, chats);
    unavailable(await service.handle(say(), signal()));
    assert.equal(chats.failed.length, 1);
    assert.deepEqual(chats.history, []);
    await service.close();
  }
});

test("cancellation at reservation/model/commit uses fresh cleanup signal and preserves original reason", async () => {
  for (const phase of ["reserve", "model", "commit"] as const) {
    for (const cleanupFails of [false, true]) {
      const controller = new AbortController();
      const reason = new Error("Synthetic cancellation");
      const chats = new FakeChatStore();
      if (cleanupFails) chats.failError = new Error("private cleanup failure");
      const reserve = chats.reserve.bind(chats);
      chats.reserve = async (...args) => {
        const result = await reserve(...args);
        if (phase === "reserve") controller.abort(reason);
        return result;
      };
      const complete = chats.complete.bind(chats);
      chats.complete = async (...args) => {
        if (phase === "commit") controller.abort(reason);
        return complete(...args);
      };
      let calls = 0;
      const service = new DawnService(await stateStore(), undefined, { async generate(_request, abort) {
        assert.equal(abort, controller.signal);
        calls++;
        if (phase === "model") controller.abort(reason);
        return answer;
      } }, chats);
      await assert.rejects(service.handle(say(), controller.signal), error => error === reason);
      assert.equal(calls, phase === "reserve" ? 0 : 1);
      assert.equal(chats.failSignals.length, 1);
      assert.notEqual(chats.failSignals[0], controller.signal);
      assert.equal(chats.failSignals[0]!.aborted, false);
      assert.deepEqual(chats.history, []);
      assert.equal(chats.reservations.length, 1);
      await service.close();
    }
  }
});

test("cleanup error does not mask model AbortError/TimeoutError or convert regular error to cancellation", async () => {
  for (const name of ["AbortError", "TimeoutError", "Error"]) {
    const original = new Error("private original");
    original.name = name;
    const chats = new FakeChatStore();
    chats.failError = new DOMException("private cleanup", "AbortError");
    const service = new DawnService(await stateStore(), undefined, { async generate() { throw original; } }, chats);
    if (name === "Error") unavailable(await service.handle(say(), signal()));
    else await assert.rejects(service.handle(say(), signal()), error => error === original);
    assert.equal(chats.failSignals.length, 1);
    assert.deepEqual(chats.history, []);
    await service.close();
  }
});

test("external sleep and sleep/wake revision changes fence generated reply before commit", async () => {
  for (const wakeAgain of [false, true]) {
    const store = await stateStore();
    const chats = new FakeChatStore();
    const entered = deferred();
    const gate = deferred();
    const service = new DawnService(store, undefined, { async generate() {
      entered.resolve(); await gate.promise; return answer;
    } }, chats);
    const pending = service.handle(say(), signal());
    await entered.promise;
    await store.changeLifecycle({ expectedRevision: 1, lifecycle: "sleeping", at }, signal());
    if (wakeAgain) await store.changeLifecycle({ expectedRevision: 2, lifecycle: "awake", at }, signal());
    gate.resolve();
    unavailable(await pending);
    assert.equal(chats.failed.length, 1);
    assert.deepEqual(chats.history, []);
    assert.equal(chats.completed.length, 0);
    await service.close();
  }
});

test("reply waits for commit; close drains queue and never closes caller-owned stores or sleeps", async () => {
  const store = await stateStore();
  const chats = new FakeChatStore();
  const entered = deferred();
  const gate = deferred();
  const complete = chats.complete.bind(chats);
  chats.complete = async (...args) => { entered.resolve(); await gate.promise; return complete(...args); };
  const service = new DawnService(store, undefined, { async generate() { return answer; } }, chats);
  let replied = false;
  const first = service.handle(say("first"), signal()).then(result => { replied = true; return result; });
  await entered.promise;
  const next = service.handle(say("second"), signal());
  const closed = service.close();
  assert.equal(service.close(), closed);
  let drained = false;
  void closed.then(() => { drained = true; });
  await assert.rejects(service.handle(say("rejected"), signal()), /closed/);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(replied, false);
  assert.equal(drained, false);
  assert.equal(chats.reservations.length, 1);
  assert.deepEqual(chats.history, []);
  gate.resolve();
  assert.equal((await first).type, "reply");
  assert.equal((await next).type, "reply");
  await closed;
  assert.equal(chats.history.length, 2);
  assert.equal(chats.closed, false);
  assert.equal((await store.read(signal())).lifecycle, "awake");
  assert.equal(drained, true);
});

test("failed turn is absent from later history and does not poison the queue; zero usage is valid", async () => {
  const chats = new FakeChatStore();
  let calls = 0;
  const service = new DawnService(await stateStore(), undefined, { async generate(request) {
    calls++;
    if (calls === 1) throw new Error("private failed answer");
    assert.deepEqual(request.messages.slice(1), [{ role: "user", text: "successful turn" }]);
    return { ...answer, usage: { inputTokens: 0, outputTokens: 0 } };
  } }, chats);
  unavailable(await service.handle(say("failed", "failed turn"), signal()));
  assert.equal((await service.handle(say("success", "successful turn"), signal())).type, "reply");
  assert.deepEqual(chats.history, [{ user: "successful turn", assistant: answer.text }]);
  assert.deepEqual(chats.usages, [{ modelId: answer.modelId, inputTokens: 0, outputTokens: 0 }]);
  assert.equal(chats.reservations.length, 2);
  await service.close();
});

test("pre-cancelled and queued-cancelled chats never reserve or dispatch", async () => {
  const chats = new FakeChatStore();
  const entered = deferred();
  const gate = deferred();
  let calls = 0;
  const service = new DawnService(await stateStore(), undefined, { async generate() {
    calls++; entered.resolve(); await gate.promise; return answer;
  } }, chats);
  await assert.rejects(service.handle(say("pre"), AbortSignal.abort()), { name: "AbortError" });
  assert.equal(chats.reservations.length, 0);
  const first = service.handle(say("first"), signal());
  await entered.promise;
  const controller = new AbortController();
  const reason = new Error("queued cancellation");
  const cancelled = assert.rejects(service.handle(say("queued"), controller.signal), error => error === reason);
  controller.abort(reason);
  gate.resolve();
  await first; await cancelled;
  assert.equal(calls, 1);
  assert.equal(chats.reservations.length, 1);
  assert.equal(chats.failSignals.length, 0);
  await service.close();
});

test("cancellation racing completed persistence still throws, without pretending to roll back", async () => {
  const chats = new FakeChatStore();
  const controller = new AbortController();
  const reason = new Error("late cancellation");
  const complete = chats.complete.bind(chats);
  chats.complete = async (...args) => { await complete(...args); controller.abort(reason); };
  const service = new DawnService(await stateStore(), undefined, { async generate() { return answer; } }, chats);
  await assert.rejects(service.handle(say(), controller.signal), error => error === reason);
  assert.equal(chats.completed.length, 1);
  assert.equal(chats.failed.length, 0);
  assert.equal(chats.failSignals.length, 1);
  assert.equal(chats.failSignals[0]!.aborted, false);
  assert.deepEqual(chats.history, [{ user: say().text, assistant: answer.text }]);
  await service.close();
});
