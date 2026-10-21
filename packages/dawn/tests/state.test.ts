import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState } from "../src/legacy/state.ts";
import { InMemoryStateStore } from "../src/adapters/storage/in-memory.ts";
import { LifecycleController } from "../src/runtime/lifecycle.ts";
import { RevisionConflictError } from "../src/runtime/state-store.ts";
import { UnconfiguredModel } from "../src/adapters/models/port.ts";
import { UnavailableCapabilities } from "../src/adapters/capabilities/port.ts";

const at = "2026-01-01T00:00:00.000Z";
const signal = () => new AbortController().signal;
const initial = () => createInitialState("dawn-test", "曙光", at);

test("initial state is sleeping with no invented experience or intent", () => {
  const state = initial();
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.revision, 0);
  assert.equal(state.lifecycle, "sleeping");
  assert.deepEqual(state.memoryIds, []);
  assert.deepEqual(state.agency.intentions, []);
  assert.deepEqual(state.self.beliefs, []);
  assert.throws(() => createInitialState("", "曙光", at));
  assert.throws(() => createInitialState("id", " ", at));
  assert.throws(() => createInitialState("id", "曙光", "invalid"));
});

test("wake/sleep update revision and event together without resetting personality", async () => {
  const store = new InMemoryStateStore(initial());
  const controller = new LifecycleController(store, () => at);
  const awake = await controller.wake(0, signal());
  assert.equal(awake.lifecycle, "awake");
  assert.equal(awake.revision, 1);
  assert.deepEqual(awake.self, initial().self);
  const sleeping = await controller.sleep(1, signal());
  assert.equal(sleeping.lifecycle, "sleeping");
  assert.equal(sleeping.revision, 2);
  assert.deepEqual(store.events().map(e => [e.revision, e.from, e.to]), [
    [1, "sleeping", "awake"], [2, "awake", "sleeping"],
  ]);
});

test("no-op is idempotent but stale revisions fail without adding events", async () => {
  const store = new InMemoryStateStore(initial());
  const controller = new LifecycleController(store, () => at);
  await controller.sleep(0, signal());
  assert.equal(store.events().length, 0);
  await controller.wake(0, signal());
  await assert.rejects(controller.wake(0, signal()), RevisionConflictError);
  assert.equal(store.events().length, 1);
});

test("concurrent changes have one CAS winner", async () => {
  const store = new InMemoryStateStore(initial());
  const controller = new LifecycleController(store, () => at);
  const results = await Promise.allSettled([controller.wake(0, signal()), controller.wake(0, signal())]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  assert.equal((await store.read(signal())).revision, 1);
  assert.equal(store.events().length, 1);
});

test("invalid time or lifecycle does not mutate state", async () => {
  const store = new InMemoryStateStore(initial());
  for (const timestamp of ["invalid", "2025-12-31T23:59:59.000Z"]) {
    await assert.rejects(store.changeLifecycle({ expectedRevision: 0, lifecycle: "awake", at: timestamp }, signal()));
  }
  await assert.rejects(store.changeLifecycle({ expectedRevision: 0, lifecycle: "bad" as "awake", at }, signal()));
  assert.equal((await store.read(signal())).revision, 0);
  assert.equal(store.events().length, 0);
});

test("cancelled operations cannot read or commit", async () => {
  const store = new InMemoryStateStore(initial());
  const aborted = AbortSignal.abort();
  await assert.rejects(store.read(aborted));
  await assert.rejects(store.changeLifecycle({ expectedRevision: 0, lifecycle: "awake", at }, aborted));
  assert.equal(store.events().length, 0);
});

test("input, output and event snapshots cannot mutate stored state", async () => {
  const input = initial();
  const store = new InMemoryStateStore(input);
  (input.self.identity as { name: string }).name = "changed";
  const snapshot = await store.read(signal());
  (snapshot.self.identity as { name: string }).name = "also changed";
  assert.equal((await store.read(signal())).self.identity.name, "曙光");
  await store.changeLifecycle({ expectedRevision: 0, lifecycle: "awake", at }, signal());
  const events = store.events();
  (events[0] as { to: string }).to = "corrupted";
  assert.equal(store.events()[0]?.to, "awake");
});

test("unconfigured model and capability fail explicitly, cancellation wins", async () => {
  const model = new UnconfiguredModel();
  const capabilities = new UnavailableCapabilities();
  const request = { messages: [], maxOutputTokens: 10 };
  await assert.rejects(model.generate(request, signal()), /MODEL_NOT_CONFIGURED/);
  assert.deepEqual(capabilities.list(), []);
  await assert.rejects(capabilities.execute({ capabilityId: "search", actionId: "1", input: {} }, signal()), /CAPABILITY_UNAVAILABLE/);
  await assert.rejects(model.generate(request, AbortSignal.abort()), { name: "AbortError" });
});
