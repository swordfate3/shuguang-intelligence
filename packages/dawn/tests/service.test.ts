import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStateStore } from "../src/adapters/storage/in-memory.ts";
import { SqliteStateStore } from "../src/adapters/storage/sqlite.ts";
import { createInitialState } from "../src/legacy/state.ts";
import { assertDawnResponse } from "../src/protocol/index.ts";
import type { DawnRequest, DawnResponse } from "../src/protocol/index.ts";
import { DawnService } from "../src/runtime/service.ts";
import { RevisionConflictError } from "../src/runtime/state-store.ts";
import type { StateStore } from "../src/runtime/state-store.ts";

const at = "2026-01-01T00:00:00.000Z";
const later = "2026-01-02T00:00:00.000Z";
const signal = () => new AbortController().signal;
const initial = () => createInitialState("service-test", "Test subject", at);
const status = (requestId = "status"): DawnRequest => ({ version: 1, requestId, type: "status" });
const wake = (expectedRevision = 0): DawnRequest => ({ version: 1, requestId: "wake", type: "wake", expectedRevision });
const sleep = (expectedRevision = 1): DawnRequest => ({ version: 1, requestId: "sleep", type: "sleep", expectedRevision });
const say = (): DawnRequest => ({ version: 1, requestId: "say", type: "say", text: "Synthetic message" });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function checkStatus(response: DawnResponse, service: DawnService, lifecycle: "awake" | "sleeping", revision: number) {
  assertDawnResponse(response);
  assert.equal(response.type, "status");
  if (response.type !== "status") throw new Error("Expected status");
  assert.equal(response.lifecycle, lifecycle);
  assert.equal(response.revision, revision);
  assert.deepEqual(response.runtime, { instanceId: service.instanceId, startedAt: service.startedAt, autonomy: false });
}
function checkError(response: DawnResponse, code: string) {
  assertDawnResponse(response);
  assert.equal(response.type, "error");
  if (response.type !== "error") throw new Error("Expected error");
  assert.equal(response.code, code);
}

/** The first read blocks; real in-memory CAS still owns every mutation. */
function blockedStore() {
  const inner = new InMemoryStateStore(initial());
  const entered = deferred();
  const gate = deferred();
  const calls: string[] = [];
  let first = true;
  const store: StateStore = {
    async read(abort) {
      calls.push("read");
      if (first) { first = false; entered.resolve(); await gate.promise; }
      return inner.read(abort);
    },
    async changeLifecycle(change, abort) {
      calls.push(change.lifecycle);
      return inner.changeLifecycle(change, abort);
    },
  };
  return { store, inner, calls, entered: entered.promise, release: () => gate.resolve() };
}

test("service uses real lifecycle CAS, no-ops and stable control-only runtime metadata", async () => {
  const store = new InMemoryStateStore(initial());
  const service = new DawnService(store, () => at);
  assert.match(service.instanceId, /^[a-f0-9-]{36}$/);
  assert.equal(service.startedAt, at);
  checkStatus(await service.handle(status(), signal()), service, "sleeping", 0);
  checkStatus(await service.handle(sleep(0), signal()), service, "sleeping", 0);
  checkStatus(await service.handle(wake(), signal()), service, "awake", 1);
  checkStatus(await service.handle(wake(1), signal()), service, "awake", 1);
  checkError(await service.handle(sleep(0), signal()), "CONFLICT");
  checkStatus(await service.handle(sleep(), signal()), service, "sleeping", 2);
  assert.deepEqual(store.events().map(event => event.to), ["awake", "sleeping"]);
  assert.deepEqual((await store.read(signal())).self, initial().self);
  await service.close();
});

test("all accepted requests including say wait in FIFO order", async () => {
  const fixture = blockedStore();
  const service = new DawnService(fixture.store, () => at);
  const first = service.handle(status("first"), signal());
  await fixture.entered;
  const waking = service.handle(wake(), signal());
  let said = false;
  const saying = service.handle(say(), signal()).then(response => { said = true; return response; });
  const sleeping = service.handle(sleep(), signal());
  const last = service.handle(status("last"), signal());
  await tick();
  assert.deepEqual(fixture.calls, ["read"]);
  assert.equal(said, false);
  fixture.release();
  checkStatus(await first, service, "sleeping", 0);
  checkStatus(await waking, service, "awake", 1);
  checkError(await saying, "NOT_IMPLEMENTED");
  checkStatus(await sleeping, service, "sleeping", 2);
  checkStatus(await last, service, "sleeping", 2);
  assert.deepEqual(fixture.calls, ["read", "awake", "sleeping", "read"]);
  await service.close();
});

test("concurrent writes preserve CAS rather than replacing expected revisions", async () => {
  const store = new InMemoryStateStore(initial());
  const service = new DawnService(store, () => at);
  const results = await Promise.all([service.handle(wake(), signal()), service.handle(wake(), signal())]);
  checkStatus(results[0]!, service, "awake", 1);
  checkError(results[1]!, "CONFLICT");
  assert.equal(store.events().length, 1);
  await service.close();
});

test("queued cancellation throws its reason, never enters store, and does not poison queue", async () => {
  const fixture = blockedStore();
  const service = new DawnService(fixture.store, () => at);
  const first = service.handle(status(), signal());
  await fixture.entered;
  const controller = new AbortController();
  const reason = new Error("Synthetic cancellation");
  const cancelled = service.handle(wake(), controller.signal);
  const rejected = assert.rejects(cancelled, error => error === reason);
  controller.abort(reason);
  const after = service.handle(status("after"), signal());
  fixture.release();
  await first;
  await rejected;
  checkStatus(await after, service, "sleeping", 0);
  assert.deepEqual(fixture.calls, ["read", "read"]);
  assert.deepEqual(fixture.inner.events(), []);
  await service.close();
});

test("pre-cancelled status, writes and say throw without touching store", async () => {
  let calls = 0;
  const store: StateStore = {
    async read() { calls++; throw new Error("Unexpected read"); },
    async changeLifecycle() { calls++; throw new Error("Unexpected write"); },
  };
  const service = new DawnService(store, () => at);
  for (const request of [status(), wake(), sleep(), say()]) {
    await assert.rejects(service.handle(request, AbortSignal.abort()), { name: "AbortError" });
  }
  assert.equal(calls, 0);
  await service.close();
});

test("in-flight cancellation is propagated even if a store resolves or throws a different error", async () => {
  for (const fails of [false, true]) {
    const controller = new AbortController();
    const reason = new Error("Synthetic cancellation");
    const store: StateStore = {
      async read(received) {
        assert.equal(received, controller.signal);
        controller.abort(reason);
        if (fails) throw new RevisionConflictError();
        return initial();
      },
      async changeLifecycle() { throw new Error("Unexpected write"); },
    };
    const service = new DawnService(store, () => at);
    await assert.rejects(service.handle(status(), controller.signal), error => error === reason);
    await service.close();
  }
});

test("close is idempotent, drains accepted work, refuses new work, and does not close store or sleep", async () => {
  const fixture = blockedStore();
  let storeClosed = false;
  const store = { ...fixture.store, close() { storeClosed = true; } };
  const service = new DawnService(store, () => at);
  const first = service.handle(status(), signal());
  await fixture.entered;
  const accepted = service.handle(wake(), signal());
  const closed = service.close();
  assert.equal(service.close(), closed);
  let drained = false;
  void closed.then(() => { drained = true; });
  await assert.rejects(service.handle(sleep(), signal()), /closed/);
  await tick();
  assert.equal(drained, false);
  fixture.release();
  await first;
  checkStatus(await accepted, service, "awake", 1);
  await closed;
  assert.equal(drained, true);
  assert.equal(storeClosed, false);
  assert.equal((await fixture.inner.read(signal())).lifecycle, "awake");
  assert.deepEqual(fixture.calls, ["read", "awake"]);
  assert.equal(fixture.inner.events().length, 1);
  await assert.rejects(service.handle(status(), signal()), /closed/);
});

test("say is explicitly unimplemented both sleeping and awake, with no store access", async () => {
  const inner = new InMemoryStateStore(initial());
  let calls = 0;
  const store: StateStore = {
    read(abort) { calls++; return inner.read(abort); },
    changeLifecycle(change, abort) { calls++; return inner.changeLifecycle(change, abort); },
  };
  const service = new DawnService(store, () => at);
  for (const awake of [false, true]) {
    if (awake) await service.handle(wake(), signal());
    const before = await inner.read(signal());
    const beforeCalls = calls;
    checkError(await service.handle(say(), signal()), "NOT_IMPLEMENTED");
    assert.equal(calls, beforeCalls);
    assert.deepEqual(await inner.read(signal()), before);
  }
  await service.close();
});

test("invalid requests cannot read, call the mutation clock, or commit", async () => {
  const fixture = blockedStore();
  let clockCalls = 0;
  const service = new DawnService(fixture.store, () => { clockCalls++; return at; });
  const invalid: unknown[] = [null, [], {}, { ...wake(), version: 2 }, { ...wake(), requestId: "bad id" },
    { ...wake(), expectedRevision: -1 }, { ...wake(), expectedRevision: 0.5 },
    { ...wake(), expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...wake(), extra: true },
    { ...status(), type: "unknown" }, { ...say(), text: " " }, { ...say(), text: "x".repeat(16_001) }];
  for (const request of invalid) {
    await assert.rejects(service.handle(request as DawnRequest, signal()), /Invalid Dawn request/);
  }
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.inner.events(), []);
  assert.equal(clockCalls, 1);
  await service.close();
});

test("accepted requests are snapshots, not caller-mutable queued commands", async () => {
  const fixture = blockedStore();
  const service = new DawnService(fixture.store, () => at);
  const first = service.handle(status(), signal());
  await fixture.entered;
  const request = { version: 1 as const, requestId: "original", type: "wake" as const, expectedRevision: 0 };
  const queued = service.handle(request, signal());
  request.expectedRevision = 100;
  request.requestId = "changed";
  fixture.release();
  await first;
  const response = await queued;
  checkStatus(response, service, "awake", 1);
  assert.equal(response.requestId, "original");
  await service.close();
});

test("storage failures are sanitized, revision errors map to conflict, abort errors still throw", async () => {
  let failure: unknown = new Error("Synthetic private backend detail");
  const store: StateStore = {
    async read() { throw failure; },
    async changeLifecycle() { throw failure; },
  };
  const service = new DawnService(store, () => at);
  for (const request of [status(), wake(), sleep()]) {
    const response = await service.handle(request, signal());
    checkError(response, "UNAVAILABLE");
    assert.equal(JSON.stringify(response).includes("private backend"), false);
  }
  failure = new RevisionConflictError();
  checkError(await service.handle(wake(), signal()), "CONFLICT");
  for (const name of ["AbortError", "TimeoutError"]) {
    failure = new DOMException("Synthetic cancellation", name);
    await assert.rejects(service.handle(status(), signal()), error => error === failure);
  }
  checkError(await service.handle(say(), signal()), "NOT_IMPLEMENTED");
  await service.close();
});

test("start time must be canonical ISO; default clock is valid", async () => {
  const store = new InMemoryStateStore(initial());
  for (const invalid of ["invalid", "2026-01-01", "2026-01-01T00:00:00Z"]) {
    assert.throws(() => new DawnService(store, () => invalid), /Invalid service start time/);
  }
  const service = new DawnService(store);
  assert.equal(new Date(service.startedAt).toISOString(), service.startedAt);
  checkStatus(await service.handle(status(), signal()), service, "sleeping", 0);
  await service.close();
});

test("new service instance on the same in-memory store retains state but has a new runtime identity", async () => {
  const store = new InMemoryStateStore(initial());
  const first = new DawnService(store, () => at);
  await first.handle(wake(), signal());
  await first.close();
  const second = new DawnService(store, () => later);
  assert.notEqual(second.instanceId, first.instanceId);
  assert.equal(second.startedAt, later);
  checkStatus(await second.handle(status(), signal()), second, "awake", 1);
  assert.equal(store.events().length, 1);
  await second.close();
});

test("SQLite restart preserves CAS/events while service identity changes and store ownership stays external", async t => {
  const directory = mkdtempSync(join(tmpdir(), "dawn-service-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite");
  let store = SqliteStateStore.create(path, initial(), signal());
  t.after(() => store.close());
  const first = new DawnService(store, () => at);
  checkStatus(await first.handle(wake(), signal()), first, "awake", 1);
  await first.close();
  assert.equal((await store.read(signal())).lifecycle, "awake");
  store.close();
  store = SqliteStateStore.open(path, signal());
  const second = new DawnService(store, () => later);
  assert.notEqual(second.instanceId, first.instanceId);
  checkStatus(await second.handle(status(), signal()), second, "awake", 1);
  checkError(await second.handle(sleep(0), signal()), "CONFLICT");
  checkStatus(await second.handle(sleep(), signal()), second, "sleeping", 2);
  checkError(await second.handle(say(), signal()), "NOT_IMPLEMENTED");
  await second.close();
  assert.deepEqual((await store.events(0, 10, signal())).map(event => event.to), ["awake", "sleeping"]);
});
