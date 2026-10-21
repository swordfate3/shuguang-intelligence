import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertCognition, buildWorkspace, reviseBelief } from "../src/core/cognition/logic.ts";
import { assertMemory, correctMemory, recallMemories, rememberExperience } from "../src/core/memory/logic.ts";
import type { CognitionState, WorldBelief } from "../src/core/cognition/types.ts";
import type { MemoryRecord, MemoryState } from "../src/core/memory/types.ts";
import type { Experience } from "../src/core/experience.ts";

const EARLY = "2026-01-01T00:00:00.000Z";
const NOW = "2026-01-02T00:00:00.000Z";
const FUTURE = "2026-01-03T00:00:00.000Z";
const exp = (patch: Partial<Experience> = {}): Experience => ({ id: "e1", subjectId: "subject", scopeId: "owner", kind: "reading", origin: "document", content: "Orchid watering instructions", topics: ["orchid"], occurredAt: EARLY, recordedAt: EARLY, sourceIds: [], ...patch });
const belief = (patch: Partial<WorldBelief> = {}): WorldBelief => ({ id: "b1", statement: "Orchid needs water", origin: "document", evidenceIds: ["e1"], confidence: 0.6, status: "supported", supersedesIds: [], updatedAt: NOW, ...patch });
const memory = (patch: Partial<MemoryRecord> = {}): MemoryRecord => ({ id: "m1", subjectId: "subject", scopeId: "owner", kind: "knowledge", content: "Orchid watering instructions", origin: "document", status: "usable", topics: ["orchid"], sourceIds: ["e1"], supersedesIds: [], importance: 0.5, createdAt: EARLY, ...patch });
const query = (patch = {}) => ({ text: "orchid", topics: ["orchid"], subjectId: "subject", scopeId: "owner", at: NOW, limit: 10, ...patch });
const revise = (b = belief(), es: readonly Experience[] = [exp()], state: CognitionState = { beliefs: [] }) => reviseBelief(state, b, es, "subject", "owner", NOW);
const correct = (r = memory({ createdAt: NOW }), es: readonly Experience[] = [exp()], state: MemoryState = { records: [] }) => correctMemory(state, r, es, "subject", "owner", NOW);
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test("belief revisions resolve provenance, not truth or calibrated confidence", () => {
  assert.equal(revise().beliefs[0]!.status, "supported");
  assert.equal(revise(belief({ origin: "observation" }), [exp({ origin: "observation" })]).beliefs[0]!.origin, "observation");
  for (const origin of ["inference", "imagination", "user_statement"] as const) {
    assert.throws(() => revise(belief({ origin }), [exp({ origin })]));
    assert.equal(revise(belief({ origin, status: "tentative" }), [exp({ origin })]).beliefs[0]!.status, "tentative");
  }
  assert.equal(revise(belief({ origin: "user_statement", evidenceIds: ["e1", "e2"] }),
    [exp({ origin: "user_statement" }), exp({ id: "e2", origin: "document" })]).beliefs[0]!.status, "supported");
  assert.throws(() => revise(belief({ origin: "inference", status: "disputed" }), [exp({ origin: "inference" })]));
  assert.throws(() => revise(belief(), [exp({ origin: "imagination" })]));
  assert.throws(() => revise(belief({ evidenceIds: [] })));
  assert.throws(() => revise(belief({ evidenceIds: ["missing"] })));
  assert.throws(() => revise(belief(), [exp(), exp()]));
  for (const patch of [{ scopeId: "other" }, { subjectId: "other" }, { recordedAt: FUTURE }]) assert.throws(() => revise(belief(), [exp(patch)]));
  assert.throws(() => revise(belief({ updatedAt: EARLY })));
});

test("belief replacement appends, retracts, rejects duplicate/missing/self/future, and deep clones", () => {
  const state = freeze({ beliefs: [belief({ updatedAt: EARLY })] });
  const candidate = freeze(belief({ id: "b2", supersedesIds: ["b1"] }));
  const next = revise(candidate, freeze([exp()]), state);
  assert.equal(state.beliefs[0]!.status, "supported");
  assert.equal(next.beliefs[0]!.status, "retracted");
  assert.notEqual(next.beliefs[0]!, state.beliefs[0]!);
  assert.notEqual(next.beliefs[1]!.evidenceIds, candidate.evidenceIds);
  assert.throws(() => revise(belief(), [exp()], state));
  for (const supersedesIds of [["b2"], ["missing"], ["b1", "b1"]]) assert.throws(() => revise(belief({ id: "b2", supersedesIds }), [exp()], state));
  assert.throws(() => revise(candidate, [exp()], { beliefs: [belief({ updatedAt: FUTURE })] }));
  const inference = belief({ origin: "inference", status: "tentative", updatedAt: EARLY });
  assert.equal(revise(candidate, [exp()], { beliefs: [inference] }).beliefs[0]!.status, "retracted");
});

test("assertions reject invalid fields, enums, sizes, ranges, UTC and replacement graphs", () => {
  assertCognition({ beliefs: [] }); assertMemory({ records: [] });
  for (const patch of [{ confidence: NaN }, { confidence: 1.1 }, { confidence: -1 }, { statement: "  " }, { id: "bad id" }, { status: "fact" }, { origin: "model" }, { extra: true }, { updatedAt: "2026-01-02" }, { updatedAt: "2026-01-02T01:00:00.000+01:00" }, { evidenceIds: ["e1", "e1"] }]) {
    assert.throws(() => assertCognition({ beliefs: [{ ...belief(), ...patch }] }));
  }
  for (const patch of [{ importance: Infinity }, { importance: -1 }, { content: " " }, { topics: [" "] }, { topics: ["x", "x"] }, { topics: Array.from({ length: 13 }, (_, i) => `t${i}`) }, { sourceIds: [] }, { sourceIds: ["e1", "e1"] }, { kind: "secret" }, { status: "fact" }, { createdAt: "not UTC" }, { extra: true }]) {
    assert.throws(() => assertMemory({ records: [{ ...memory(), ...patch }] }));
  }
  assert.throws(() => assertCognition({ beliefs: [belief(), belief()] }));
  assert.throws(() => assertMemory({ records: [memory(), memory()] }));
  assert.throws(() => assertCognition({ beliefs: Array.from({ length: 1001 }, (_, i) => belief({ id: `b${i}` })) }));
  assert.throws(() => assertMemory({ records: Array.from({ length: 1001 }, (_, i) => memory({ id: `m${i}` })) }));
  assert.throws(() => assertCognition({ beliefs: [belief({ status: "retracted", supersedesIds: ["b2"] }), belief({ id: "b2", status: "retracted", supersedesIds: ["b1"] })] }));
  assert.throws(() => assertMemory({ records: [memory({ status: "retracted", supersedesIds: ["m2"] }), memory({ id: "m2", status: "retracted", supersedesIds: ["m1"] })] }));
  assert.throws(() => assertCognition({ beliefs: [belief({ supersedesIds: ["missing"] })] }));
  assert.throws(() => assertMemory({ records: [memory({ supersedesIds: ["missing"] })] }));
});

test("remembering is an episode preserving origin, never knowledge, with no mutation or overwrite", () => {
  for (const origin of ["imagination", "inference", "user_statement", "document", "observation"] as const) {
    const event = freeze(exp({ origin }));
    const state = freeze({ records: [] });
    const next = rememberExperience(state, event, 0.4);
    assert.deepEqual(next.records[0]!, memory({ id: `memory_${createHash("sha256").update("e1").digest("hex")}`, kind: "episode", origin, importance: 0.4 }));
    assert.notEqual(next.records[0]!.topics, event.topics);
    assert.deepEqual(state, { records: [] });
    assert.throws(() => rememberExperience(next, event, 0.4));
  }
  for (const importance of [-1, 1.1, NaN, Infinity]) assert.throws(() => rememberExperience({ records: [] }, exp(), importance));
});

test("memory correction validates evidence/origin and retracts only same subject/scope history", () => {
  const state = freeze({ records: [memory()] });
  const record = freeze(memory({ id: "m2", createdAt: NOW, supersedesIds: ["m1"], content: "Updated orchid instructions" }));
  const next = correct(record, freeze([exp()]), state);
  assert.equal(state.records[0]!.status, "usable");
  assert.equal(next.records[0]!.status, "retracted");
  assert.equal(next.records[1]!.content, record.content);
  assert.notEqual(next.records[0]!.topics, state.records[0]!.topics);
  assert.notEqual(next.records[1]!.sourceIds, record.sourceIds);
  assert.throws(() => correct(memory({ createdAt: NOW }), [exp()], state));
  for (const patch of [{ scopeId: "other" }, { subjectId: "other" }, { createdAt: FUTURE }]) assert.throws(() => correct(record, [exp()], { records: [memory(patch)] }));
  for (const supersedesIds of [["m2"], ["missing"], ["m1", "m1"]]) assert.throws(() => correct({ ...record, supersedesIds }, [exp()], state));
  for (const patch of [{ scopeId: "other" }, { subjectId: "other" }, { recordedAt: FUTURE }, { origin: "imagination" as const }]) assert.throws(() => correct(record, [exp(patch)], state));
  assert.throws(() => correct(record, [exp(), exp()], state));
  assert.throws(() => correct({ ...record, sourceIds: [] }, [exp()], state));
  assert.throws(() => correct({ ...record, sourceIds: ["missing"] }, [exp()], state));
  assert.throws(() => correct({ ...record, scopeId: "other" }, [exp()], state));
  assert.throws(() => correct({ ...record, createdAt: EARLY }, [exp()], state));
  for (const origin of ["inference", "imagination"] as const) {
    assert.throws(() => correct({ ...record, origin }, [exp({ origin })], state));
    assert.equal(correct({ ...record, origin, status: "candidate" }, [exp({ origin })], state).records[1]!.status, "candidate");
  }
  assert.throws(() => correct({ ...record, origin: "user_statement" }, [exp({ origin: "user_statement" })], state));
});

test("candidate memory corrections retain usable source until trusted acceptance", () => {
  const state = freeze({ records: [memory()] });
  const proposed = memory({ id: "proposal", createdAt: NOW, supersedesIds: ["m1"], status: "candidate" });
  const next = correct(proposed, [exp()], state);
  assert.equal(next.records[0]!.status, "usable");
  assert.equal(next.records[1]!.status, "candidate");
  assert.deepEqual(recallMemories(next, query()).map(m => m.id), ["m1"]);
  assert.deepEqual(state.records, [memory()]);
});

test("recall is relevant, private, usable, nonfuture, deterministic and cloned", () => {
  const records = freeze([
    memory({ id: "z", importance: 0.5 }), memory({ id: "a", importance: 0.5 }),
    memory({ id: "recent", createdAt: NOW }), memory({ id: "important", importance: 1 }),
    memory({ id: "private", scopeId: "private" }), memory({ id: "other", subjectId: "other" }),
    memory({ id: "future", createdAt: FUTURE }), memory({ id: "disputed", status: "disputed" }),
    memory({ id: "candidate", status: "candidate" }), memory({ id: "retracted", status: "retracted" }),
    memory({ id: "unrelated", content: "Private financial account", topics: ["finance"] }),
  ]);
  const recalled = recallMemories({ records }, query());
  assert.deepEqual(recalled.map(r => r.id), ["important", "recent", "a", "z"]);
  assert.deepEqual(recallMemories({ records: [...records].reverse() }, query()), recalled);
  assert.notEqual(recalled[0]!, records[3]!); assert.notEqual(recalled[0]!.topics, records[3]!.topics);
  assert.deepEqual(recallMemories({ records }, query({ text: "astronomy", topics: [] })), []);
  assert.deepEqual(recallMemories({ records }, query({ limit: 0 })), []);
  assert.equal(recallMemories({ records }, query({ limit: 1 })).length, 1);
  for (const patch of [{ text: " " }, { topics: [" "] }, { topics: ["x", "x"] }, { at: "bad" }, { limit: -1 }, { limit: 1.5 }, { limit: 1001 }, { extra: true }]) assert.throws(() => recallMemories({ records }, query(patch)));
});

test("workspace exposes only relevant IDs/topics and marks uncertainty without retaining thought", () => {
  const state = freeze({ beliefs: [belief(), belief({ id: "tentative", status: "tentative" }), belief({ id: "disputed", status: "disputed" }), belief({ id: "old", status: "retracted" }), belief({ id: "future", updatedAt: FUTURE }), belief({ id: "irrelevant", statement: "Galaxies expand" })] });
  const event = freeze(exp({ recordedAt: NOW }));
  const memories = freeze([memory(), memory({ id: "candidate", status: "candidate" }), memory({ id: "private", scopeId: "private" }), memory({ id: "other", subjectId: "other" }), memory({ id: "old", status: "retracted" }), memory({ id: "future", createdAt: FUTURE })]);
  const workspace = buildWorkspace(state, event, memories);
  assert.deepEqual(workspace, { experienceId: "e1", topics: ["orchid"], relevantMemoryIds: ["candidate", "m1"], relevantBeliefIds: ["b1", "disputed", "tentative"], uncertainties: ["candidate", "disputed", "tentative"] });
  assert.notEqual(workspace.topics, event.topics);
  assert.deepEqual(buildWorkspace({ beliefs: [] }, exp({ content: "Galaxies", topics: [] }), [memory()]).relevantMemoryIds, []);
  assert.throws(() => buildWorkspace(state, event, [memory(), memory()]));
});

test("every public boundary rejects accessors before execution and redacts values", () => {
  let calls = 0;
  const evil = Object.defineProperty({}, "secret", { enumerable: true, get() { calls++; throw new Error("PRIVATE_SENTINEL"); } });
  const bad = evil as never;
  const operations = [
    () => assertCognition(bad), () => assertMemory(bad),
    () => buildWorkspace(bad, exp(), []), () => buildWorkspace({ beliefs: [] }, bad, []), () => buildWorkspace({ beliefs: [] }, exp(), bad),
    () => reviseBelief({ beliefs: [] }, bad, [exp()], "subject", "owner", NOW),
    () => reviseBelief({ beliefs: [] }, belief(), bad, "subject", "owner", NOW),
    () => reviseBelief({ beliefs: [] }, belief(), [exp()], bad, "owner", NOW),
    () => rememberExperience(bad, exp(), 0.5), () => rememberExperience({ records: [] }, bad, 0.5), () => rememberExperience({ records: [] }, exp(), bad),
    () => recallMemories({ records: [] }, bad), () => recallMemories(bad, query()),
    () => correctMemory({ records: [] }, bad, [exp()], "subject", "owner", NOW),
    () => correctMemory({ records: [] }, memory(), bad, "subject", "owner", NOW),
    () => correctMemory({ records: [] }, memory(), [exp()], "subject", "owner", bad),
  ];
  for (const operation of operations) assert.throws(operation, error => error instanceof Error && !error.message.includes("PRIVATE_SENTINEL"));
  assert.equal(calls, 0);
  assert.throws(() => assertMemory({ records: new Array(1) }));
  assert.throws(() => assertCognition({ beliefs: [new Date()] }));
});
