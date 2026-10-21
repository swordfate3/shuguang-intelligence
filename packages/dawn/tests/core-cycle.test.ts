import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState } from "../src/core/state.ts";
import type { SubjectState } from "../src/core/state.ts";
import { assertSubjectState } from "../src/core/validation.ts";
import { changeCoreLifecycle, CoreRevisionConflictError, runSubjectCycle } from "../src/core/cycle.ts";
import type { CycleAuthority, CycleInput } from "../src/core/cycle.ts";
import type { Experience } from "../src/core/experience.ts";
import { assertData, timestamp } from "../src/core/guards.ts";

const at = "2026-01-01T00:00:00.000Z";
const at2 = "2026-01-01T01:00:00.000Z";
const at3 = "2026-01-01T02:00:00.000Z";
function experience(id = "exp1", time = at): Experience {
  return { id, subjectId: "dawn", scopeId: "owner", kind: "reading", origin: "document", content: "一段天文阅读的合成资料", topics: ["astronomy"], occurredAt: time, recordedAt: time, sourceIds: [] };
}
function awake(): SubjectState {
  const initial = createInitialState("dawn", "曙光", at);
  const seeded: SubjectState = { ...initial, self: { ...initial.self,
    concerns: [{ id: "understand", description: "希望理解天文", topics: ["astronomy"], weight: 0.8 }],
  } };
  return changeCoreLifecycle(seeded, 0, "awake", at);
}
function input(revision = 1): CycleInput {
  return { cycleId: "cycle1", expectedRevision: revision, at, experience: experience(),
    appraisal: { evidenceIds: ["exp1"], concernId: "understand", desirability: 0.8, expectedness: 0.6, controllability: 0.7, intensity: 0.8 },
    candidates: [{ type: "world_belief", belief: { id: "belief1", statement: "合成资料中包含天文说明", origin: "document", evidenceIds: ["exp1"], confidence: 0.7, status: "tentative", supersedesIds: [], updatedAt: at } }],
    activities: [{ id: "read_more", kind: "learn", description: "继续阅读获准资料", topics: ["astronomy"], evidenceIds: ["exp1"], cost: 1, available: true }],
  };
}
const authority: CycleAuthority = { allow: ["world_belief", "memory_correction", "growth_candidate"], availableBudget: 3, stopRequested: false, evaluations: [] };

test("six-core cycle records evidence, understands, appraises and proposes an intention without executing tools", () => {
  const initial = awake(); const before = structuredClone(initial);
  const result = runSubjectCycle(initial, input(), authority);
  assert.deepEqual(initial, before);
  assert.equal(result.state.revision, 2);
  assert.deepEqual(result.event, { type: "cycle_completed", cycleId: "cycle1", experienceId: "exp1", fromRevision: 1, toRevision: 2, at });
  assert.equal(result.state.experiences.length, 1);
  assert.equal(result.state.memory.records[0]?.origin, "document");
  assert.equal(result.state.cognition.beliefs[0]?.statement, "合成资料中包含天文说明");
  assert.ok(result.state.affect.valence > 0);
  assert.equal(result.state.agency.intentions[0]?.activityId, "read_more");
  assert.equal(result.state.agency.intentions[0]?.status, "proposed");
  assert.equal("workspace" in result.state, false);
  assert.equal(result.workspace.experienceId, "exp1");
  assert.equal(result.workspace.relevantMemoryIds.length, 1);
  assertSubjectState(JSON.parse(JSON.stringify(result.state)));
  assert.deepEqual(runSubjectCycle(initial, input(), authority), result);
});

test("growth uses earlier distinct experiences, then a separate trusted result, and influences later choices", () => {
  let state = runSubjectCycle(awake(), { ...input(), appraisal: null, candidates: [], activities: [] }, authority).state;
  state = runSubjectCycle(state, { cycleId: "cycle2", expectedRevision: state.revision, at: at2, experience: experience("exp2", at2), appraisal: null,
    candidates: [{ type: "growth_candidate", proposal: { id: "interest1", kind: "interest", target: "astronomy", delta: 0.05, evidenceIds: ["exp1", "exp2"], status: "candidate", evaluationIds: [] } }], activities: [] }, authority).state;
  assert.equal(state.self.interests.length, 0, "candidate is not automatic personal change");
  const external: Experience = { ...experience("test_result", at3), kind: "activity_result", origin: "observation", content: "合成观察：新任务中再次选择了天文活动" };
  const result = runSubjectCycle(state, { cycleId: "cycle3", expectedRevision: state.revision, at: at3, experience: external,
    appraisal: null, candidates: [], activities: [
      { id: "a_other", kind: "learn", description: "无关活动", topics: ["other"], evidenceIds: ["test_result"], cost: 0, available: true },
      { id: "z_astronomy", kind: "learn", description: "天文活动", topics: ["astronomy"], evidenceIds: ["test_result"], cost: 0, available: true },
    ] }, { ...authority, evaluations: [{ id: "eval1", proposalId: "interest1", evidenceIds: ["test_result"], outcome: "pass", at: at3 }] });
  assert.equal(result.state.growth.proposals[0]?.status, "accepted");
  assert.equal(result.state.self.interests[0]?.topic, "astronomy");
  assert.equal(result.state.self.interests[0]?.strength, 0.05);
  assert.equal(result.state.agency.intentions[0]?.activityId, "z_astronomy");
  assert.deepEqual(result.state.self.identity, state.self.identity);
  assert.deepEqual(result.state.self.values, state.self.values);
});

test("late invalid candidate rolls back every domain change; no permissions or arbitrary patches", () => {
  const state = awake(); const original = structuredClone(state);
  assert.throws(() => runSubjectCycle(state, { ...input(), candidates: [...input().candidates,
    { type: "set_anything", path: "self.identity", value: "overridden" } as never] }, authority));
  assert.deepEqual(state, original);
  assert.throws(() => runSubjectCycle(state, input(), { ...authority, allow: [] }));
  assert.deepEqual(state, original);
  assert.throws(() => runSubjectCycle(state, { ...input(), activities: [{ ...input().activities[0]!, permissions: ["network"] } as never] }, authority));
  assert.deepEqual(state, original);
});

test("scope, evidence, duplicate, revision, cancellation policy and sleeping fail closed", () => {
  const state = awake(); const result = runSubjectCycle(state, input(), authority);
  assert.throws(() => runSubjectCycle(state, { ...input(), expectedRevision: 0 }, authority), CoreRevisionConflictError);
  assert.throws(() => runSubjectCycle(state, input(), { ...authority, stopRequested: true }));
  assert.throws(() => runSubjectCycle(createInitialState("dawn", "曙光", at), { ...input(), expectedRevision: 0 }, authority));
  assert.throws(() => runSubjectCycle(result.state, { ...input(), expectedRevision: 2 }, authority));
  assert.throws(() => runSubjectCycle(state, { ...input(), experience: { ...experience(), scopeId: "someone_else" } }, authority));
  assert.throws(() => runSubjectCycle(state, { ...input(), experience: { ...experience(), sourceIds: ["missing"] } }, authority));
  assert.throws(() => runSubjectCycle(state, { ...input(), appraisal: { ...input().appraisal!, evidenceIds: ["missing"] } }, authority));
  assert.equal(state.revision, 1);
});

test("state boundary rejects accessors, unknown fields, lost references, future timestamps and hidden data", () => {
  const state = awake(); let accessed = false;
  const malicious = { ...input() };
  Object.defineProperty(malicious, "activities", { enumerable: true, get() { accessed = true; throw new Error("private"); } });
  assert.throws(() => runSubjectCycle(state, malicious, authority));
  assert.equal(accessed, false);
  assert.throws(() => assertSubjectState({ ...state, schemaVersion: 1 }));
  assert.throws(() => assertSubjectState({ ...state, cognition: { beliefs: [], arbitraryPatch: true } }));
  assert.throws(() => assertSubjectState({ ...state, self: { ...state.self, interests: [{ topic: "music", strength: 0.2, evidenceIds: ["missing"] }] } }));
  assert.throws(() => timestamp("+010000-01-01T00:00:00.000Z"));
  assert.throws(() => assertData([, "sparse"]));
  assert.throws(() => assertData(new Date()));
  let toJsonCalled = false;
  const inherited = ["value"];
  Object.setPrototypeOf(inherited, Object.create(Array.prototype, { toJSON: { get() { toJsonCalled = true; return () => []; } } }));
  assert.throws(() => assertData(inherited));
  assert.equal(toJsonCalled, false);
  const hidden = Object.defineProperty({ a: 1 }, "secret", { value: 1 });
  assert.throws(() => assertData(hidden));
});

test("explicit lifecycle, no-op isolation and output snapshots remain under caller control", () => {
  const state = awake();
  const noOp = changeCoreLifecycle(state, 1, "awake", at);
  assert.deepEqual(noOp, state); assert.notEqual(noOp, state);
  const slept = changeCoreLifecycle(state, 1, "sleeping", at2);
  assert.equal(slept.revision, 2);
  assert.deepEqual(slept.self, state.self);
  assert.throws(() => changeCoreLifecycle(state, 0, "sleeping", at2), CoreRevisionConflictError);
  assert.throws(() => changeCoreLifecycle(state, 1, "sleeping", "2025-01-01T00:00:00.000Z"));
  const result = runSubjectCycle(state, input(), authority);
  (result.state.self.identity as { name: string }).name = "Changed detached copy";
  assert.equal(state.self.identity.name, "曙光");
});
