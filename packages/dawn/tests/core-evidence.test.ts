import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState } from "../src/core/state.ts";
import { assertSubjectState } from "../src/core/validation.ts";
import { changeCoreLifecycle, runSubjectCycle } from "../src/core/cycle.ts";
import type { CycleAuthority } from "../src/core/cycle.ts";
import type { Experience } from "../src/core/experience.ts";
import { evidenceRoots } from "../src/core/evidence.ts";
import { resolveEvidence } from "../src/core/experience.ts";
import { proposeGrowth } from "../src/core/growth/logic.ts";
import { rememberExperience } from "../src/core/memory/logic.ts";

const authority: CycleAuthority = { allow: ["growth_candidate"], availableBudget: 1, stopRequested: false, evaluations: [] };
function at(n: number) { return new Date(Date.UTC(2026, 0, 1, n)).toISOString(); }
function exp(n: number): Experience {
  return { id: `e${n}`, subjectId: "dawn", scopeId: "owner", kind: "activity_result", origin: "observation", content: "synthetic event", topics: ["astronomy"], occurredAt: at(n), recordedAt: at(n), sourceIds: [] };
}
function seeded() {
  const original = createInitialState("dawn", "曙光", at(0));
  return { ...changeCoreLifecycle(original, 0, "awake", at(0)), updatedAt: at(35), experiences: Array.from({ length: 32 }, (_, n) => exp(n + 1)) };
}

test("32 proposal sources plus fresh evaluation can accumulate 33 interest references and remain valid", () => {
  const before = seeded();
  const proposal = { id: "g1", kind: "interest" as const, target: "Astronomy", delta: 0.05,
    evidenceIds: before.experiences.map(e => e.id), status: "candidate" as const, evaluationIds: [] };
  const growth = proposeGrowth(before.growth, proposal, before.experiences, "dawn", "owner", at(35));
  const state = { ...before, growth };
  assertSubjectState(state);
  const result = runSubjectCycle(state, { cycleId: "c1", expectedRevision: state.revision, at: at(36), experience: exp(36), appraisal: null, candidates: [], activities: [] },
    { ...authority, evaluations: [{ id: "eval1", proposalId: "g1", evidenceIds: ["e36"], outcome: "pass", at: at(36) }] });
  assert.equal(result.state.self.interests[0]?.evidenceIds.length, 33);
  assertSubjectState(result.state);
});

test("case variants of the same growth target cannot bypass the per-cycle step limit", () => {
  const before = seeded();
  let growth = before.growth;
  for (const [id, target] of [["g1", "Astronomy"], ["g2", "astronomy"]]) {
    growth = proposeGrowth(growth, { id: id!, kind: "interest", target: target!, delta: 0.05,
      evidenceIds: ["e1", "e2"], status: "candidate", evaluationIds: [] }, before.experiences, "dawn", "owner", at(35));
  }
  const state = { ...before, growth };
  assert.throws(() => runSubjectCycle(state, { cycleId: "c1", expectedRevision: state.revision, at: at(36), experience: exp(36), appraisal: null, candidates: [], activities: [] },
    { ...authority, evaluations: [
      { id: "v1", proposalId: "g1", evidenceIds: ["e36"], outcome: "pass", at: at(36) },
      { id: "v2", proposalId: "g2", evidenceIds: ["e36"], outcome: "pass", at: at(36) },
    ] }), /one growth evaluation/);
  assert.equal(state.self.interests.length, 0);
});

test("maximum-length experience IDs produce bounded deterministic memory IDs", () => {
  const e = { ...exp(1), id: "x".repeat(128) };
  const result = rememberExperience({ records: [] }, e, 0.5);
  assert.ok(result.records[0]!.id.length <= 128);
  assert.deepEqual(rememberExperience({ records: [] }, e, 0.5), result);
});

test("source roots resolve derivative evidence without permitting missing, cyclic, future or cross-scope chains", () => {
  const root = exp(1), derivative = { ...exp(2), sourceIds: [root.id] };
  assert.deepEqual(evidenceRoots([derivative.id], [root, derivative], "dawn", "owner", at(3)), [root.id]);
  assert.throws(() => resolveEvidence([derivative.id], [derivative], "dawn", "owner", at(3)));
  assert.throws(() => resolveEvidence([derivative.id], [{ ...root, scopeId: "private" }, derivative], "dawn", "owner", at(3)));
  assert.throws(() => resolveEvidence([root.id], [{ ...root, sourceIds: [derivative.id] }, derivative], "dawn", "owner", at(3)));
  assert.throws(() => resolveEvidence([root.id], [root], "dawn", "owner", at(0)));
  const invalid = { ...createInitialState("dawn", "曙光", at(0)), updatedAt: at(4), experiences: [
    { ...root, recordedAt: at(3) }, derivative,
  ] };
  assert.throws(() => assertSubjectState(invalid));
});
