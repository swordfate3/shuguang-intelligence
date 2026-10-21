import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState } from "../src/core/state.ts";
import { SqliteSubjectStore } from "../src/adapters/storage/sqlite-subject.ts";
import { SubjectService } from "../src/runtime/subject-service.ts";
import type { ModelPort } from "../src/adapters/models/port.ts";

const at = "2026-01-01T00:00:00.000Z";
const signal = () => new AbortController().signal;
function fixture(t: test.TestContext, limit = 3) {
  const dir = mkdtempSync(join(tmpdir(), "dawn-subject-service-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "subject.sqlite");
  const initial = createInitialState("dawn", "曙光", at);
  const store = SqliteSubjectStore.create(path, { ...initial, self: { ...initial.self, concerns: [
    { id: "understanding", description: "理解问题", topics: ["理解"], weight: 0.8 },
  ] } }, limit, signal());
  t.after(() => store.close());
  return { store, path };
}
function response(reply = "合成回答") { return { text: JSON.stringify({ reply, appraisal: null, candidates: [] }), modelId: "fixture", usage: { inputTokens: 1, outputTokens: 1 } }; }
const say = (id: string, text = "理解这个问题") => ({ version: 1 as const, type: "say" as const, requestId: id, text });

test("six-core chat commits user statement, tentative belief, affect, assistant inference and usage; context survives restart", async t => {
  const { store, path } = fixture(t);
  await store.changeLifecycle(0, "awake", at, signal());
  let calls = 0;
  const model: ModelPort = { async generate(input) {
    const context = JSON.parse(input.messages[1]!.text);
    calls++;
    if (calls === 2) {
      assert.ok(input.messages.some(m => m.role === "assistant" && m.text === "我们一起理解。"));
      assert.ok(context.projection.beliefs.some((b: { id: string }) => b.id === "b1"));
      assert.ok(context.projection.affect.valence > 0);
      return response();
    }
    return { ...response(), text: JSON.stringify({ reply: "我们一起理解。",
      appraisal: { evidenceIds: [context.current.experienceId], concernId: "understanding", desirability: 0.7,
        expectedness: 0.5, controllability: 0.7, intensity: 0.8 },
      candidates: [{ type: "world_belief", belief: { id: "b1", statement: "用户表示希望理解问题", origin: "user_statement",
        evidenceIds: [context.current.experienceId], confidence: 0.6, status: "tentative", supersedesIds: [], updatedAt: context.current.at } }],
    }) };
  } };
  const service = new SubjectService(store, model, () => at);
  assert.equal((await service.handle(say("first"), signal())).type, "reply");
  await service.close();
  const state = await store.read(signal());
  assert.equal(state.revision, 3);
  assert.equal(state.experiences.length, 2);
  assert.deepEqual(state.experiences.map(e => e.origin), ["user_statement", "inference"]);
  assert.deepEqual(state.experiences[1]!.sourceIds, [state.experiences[0]!.id]);
  assert.equal(state.memory.records.length, 2);
  assert.equal(state.cognition.beliefs[0]!.status, "tentative");
  assert.ok(state.affect.valence > 0);
  assert.equal(state.self.interests.length, 0, "model appraisal is not verified growth");
  const reopened = SqliteSubjectStore.open(path, signal());
  try {
    assert.deepEqual(await reopened.read(signal()), state);
    const second = new SubjectService(reopened, model, () => at);
    assert.equal((await second.handle(say("second"), signal())).type, "reply");
    await second.close();
    assert.equal((await reopened.read(signal())).revision, 5);
    assert.deepEqual(await reopened.budget(signal()), { limit: 3, reserved: 2, completed: 2, failed: 0, pending: 0 });
  } finally { reopened.close(); }
});

test("candidate correction never removes source recall after old dialogue leaves recent history", async t => {
  const { store } = fixture(t, 15);
  await store.changeLifecycle(0, "awake", at, signal());
  let calls = 0;
  let originalMemoryId = "";
  const service = new SubjectService(store, { async generate(input) {
    calls++;
    const context = JSON.parse(input.messages[1]!.text);
    if (calls === 2) {
      const original = context.projection.memories.find((m: { content: string }) => m.content === "理解 ORCHID 的历史依据");
      assert.ok(original);
      originalMemoryId = original.id;
      return { ...response(), text: JSON.stringify({ reply: "已记录待核验的修正。", appraisal: null, candidates: [{ type: "memory_correction", record: {
        id: "pending_correction", subjectId: "dawn", scopeId: "owner", kind: "knowledge", content: "理解 ORCHID 的待核验修正",
        origin: "user_statement", status: "candidate", topics: ["理解"], sourceIds: [context.current.experienceId],
        supersedesIds: [original.id], importance: 0.5, createdAt: context.current.at,
      } }] }) };
    }
    if (calls === 12) {
      assert.ok(!input.messages.slice(2, -1).some(m => m.text === "理解 ORCHID 的历史依据"), "old pair has left history");
      assert.ok(context.projection.memories.some((m: { id: string; status: string }) => m.id === originalMemoryId && m.status === "usable"));
      assert.ok(!context.projection.memories.some((m: { id: string }) => m.id === "pending_correction"), "candidate did not become usable");
    }
    return response("普通合成回答");
  } }, () => at);
  try {
    assert.equal((await service.handle(say("old", "理解 ORCHID 的历史依据"), signal())).type, "reply");
    assert.equal((await service.handle(say("correction", "理解 ORCHID 的修正提案"), signal())).type, "reply");
    for (let i = 0; i < 9; i++) assert.equal((await service.handle(say(`filler_${i}`, `普通无关消息 ${i}`), signal())).type, "reply");
    assert.equal((await service.handle(say("recall", "ORCHID"), signal())).type, "reply");
    const state = await store.read(signal());
    assert.equal(state.memory.records.find(m => m.id === originalMemoryId)!.status, "usable");
    assert.equal(state.memory.records.find(m => m.id === "pending_correction")!.status, "candidate");
  } finally { await service.close(); }
});

test("invalid model envelope or domain candidate charges attempt but never partially commits either cycle", async t => {
  const { store } = fixture(t);
  await store.changeLifecycle(0, "awake", at, signal());
  const before = await store.read(signal());
  const invalid = ["not-json", JSON.stringify({ reply: "不应显示", appraisal: null, candidates: [], evaluations: [] }),
    JSON.stringify({ reply: "不应显示", appraisal: null, candidates: [{ type: "world_belief", belief: { id: "bad", statement: "虚构", origin: "observation",
      evidenceIds: ["hidden"], confidence: 1, status: "supported", supersedesIds: [], updatedAt: at } }] })];
  let calls = 0;
  const service = new SubjectService(store, { async generate() { return { ...response(), text: invalid[calls++]! }; } }, () => at);
  for (const id of ["bad1", "bad2", "bad3"]) assert.equal((await service.handle(say(id), signal())).type, "error");
  assert.deepEqual(await store.read(signal()), before);
  assert.deepEqual(await store.history(signal()), []);
  assert.equal((await store.budget(signal())).failed, 3);
  assert.equal((await service.handle(say("exhausted"), signal())).type, "error");
  assert.equal(calls, 3);
  await service.close();
});

test("external sleep fences in-flight generation in the same subject database; duplicate request does not call again", async t => {
  const { store, path } = fixture(t);
  await store.changeLifecycle(0, "awake", at, signal());
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { entered = r; });
  let calls = 0;
  const service = new SubjectService(store, { async generate() { calls++; entered(); await wait; return response(); } }, () => at);
  const pending = service.handle(say("pending"), signal());
  await started;
  const other = SqliteSubjectStore.open(path, signal());
  try { await other.changeLifecycle(1, "sleeping", at, signal()); }
  finally { other.close(); }
  release();
  assert.equal((await pending).type, "error");
  assert.equal((await store.read(signal())).revision, 2);
  assert.equal((await store.read(signal())).experiences.length, 0);
  assert.equal((await store.budget(signal())).failed, 1);
  await store.changeLifecycle(2, "awake", at, signal());
  assert.equal((await service.handle(say("pending"), signal())).type, "error");
  assert.equal(calls, 1);
  await service.close();
});

test("cancellation after generation and malformed usage do not become successful core changes", async t => {
  const { store } = fixture(t);
  await store.changeLifecycle(0, "awake", at, signal());
  const controller = new AbortController();
  const service = new SubjectService(store, { async generate() { controller.abort(); return response(); } }, () => at);
  await assert.rejects(service.handle(say("cancel"), controller.signal));
  await service.close();
  const usage = new SubjectService(store, { async generate() { return { ...response(), usage: { inputTokens: NaN, outputTokens: 0 } }; } }, () => at);
  assert.equal((await usage.handle(say("usage"), signal())).type, "error");
  await usage.close();
  assert.equal((await store.read(signal())).revision, 1);
  assert.equal((await store.budget(signal())).failed, 2);
});

test("service FIFO and close drain accepted work; sleeping and absent model never dispatch", async t => {
  const { store } = fixture(t);
  let calls = 0;
  const model: ModelPort = { async generate() { calls++; return response(); } };
  const service = new SubjectService(store, model, () => at);
  assert.equal((await service.handle(say("sleeping"), signal())).type, "error");
  await store.changeLifecycle(0, "awake", at, signal());
  const a = service.handle(say("a"), signal()), b = service.handle(say("b"), signal());
  const drained = service.close();
  await assert.rejects(service.handle(say("late"), signal()));
  assert.equal((await a).type, "reply"); assert.equal((await b).type, "reply");
  await drained;
  assert.equal(calls, 2);
  assert.equal((await store.read(signal())).revision, 5);
  const noModel = new SubjectService(store, undefined, () => at);
  const result = await noModel.handle(say("no-model"), signal());
  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.code, "NOT_IMPLEMENTED");
  await noModel.close();
});
