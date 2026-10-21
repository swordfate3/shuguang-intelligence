import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState } from "../src/core/state.ts";
import type { Experience } from "../src/core/experience.ts";
import { assertGrowth, evaluateGrowth, proposeGrowth } from "../src/core/growth/logic.ts";
import type { GrowthEvaluation, GrowthProposal, GrowthState } from "../src/core/growth/types.ts";
import { assertSelf, projectSelf, selfRelevance } from "../src/core/self/logic.ts";
import type { SelfState } from "../src/core/self/types.ts";

const subjectId = "dawn-test";
const scopeId = "owner";
const at = "2026-01-05T00:00:00.000Z";

function initialSelf(): SelfState {
  return createInitialState(subjectId, "曙光", "2026-01-01T00:00:00.000Z").self;
}

function experience(id: string, occurredAt: string, options: Partial<Experience> = {}): Experience {
  return {
    id, subjectId, scopeId, kind: "conversation", origin: "observation", content: "Synthetic test record",
    topics: ["astronomy"], occurredAt, recordedAt: occurredAt, sourceIds: [], ...options,
  };
}

function records(): Experience[] {
  return [
    experience("evidence-one", "2026-01-02T00:00:00.000Z"),
    experience("evidence-two", "2026-01-03T00:00:00.000Z"),
    experience("activity-test", "2026-01-04T00:00:00.000Z", { kind: "activity_result", origin: "observation" }),
  ];
}

function proposal(overrides: Partial<GrowthProposal> = {}): GrowthProposal {
  return {
    id: "proposal-one", kind: "interest", target: "astronomy", delta: 0.05,
    evidenceIds: ["evidence-one", "evidence-two"], status: "candidate", evaluationIds: [], ...overrides,
  };
}

function evaluation(overrides: Partial<GrowthEvaluation> = {}): GrowthEvaluation {
  return { id: "evaluation-one", proposalId: "proposal-one", evidenceIds: ["activity-test"], outcome: "pass", at, ...overrides };
}

function growth(): GrowthState { return { proposals: [], evaluations: [] }; }

test("self schema rejects unexpected fields, accessors, duplicate IDs, and oversized lists", () => {
  const extra = { ...initialSelf(), privateFuture: true };
  assert.throws(() => assertSelf(extra));

  const accessor = structuredClone(initialSelf()) as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, "identity", { enumerable: true, get: () => initialSelf().identity });
  assert.throws(() => assertSelf(accessor));

  const duplicate = structuredClone(initialSelf()) as unknown as { values: Array<{ id: string; description: string; weight: number }> };
  duplicate.values = [
    { id: "duplicate", description: "first", weight: 1 },
    { id: "duplicate", description: "second", weight: 1 },
  ];
  assert.throws(() => assertSelf(duplicate));

  const oversized = structuredClone(initialSelf()) as unknown as { interests: unknown[] };
  oversized.interests = Array.from({ length: 1001 }, () => ({ topic: "x", strength: 0.5, evidenceIds: [] }));
  assert.throws(() => assertSelf(oversized));
});

test("self relevance uses exact case-folded topic matches and projection is minimal/deep-cloned", () => {
  const self = structuredClone(initialSelf()) as {
    identity: SelfState["identity"];
    personality: SelfState["personality"];
    values: SelfState["values"];
    concerns: SelfState["concerns"];
    selfBeliefs: SelfState["selfBeliefs"];
    interests: SelfState["interests"];
    relationships: SelfState["relationships"];
    commitments: SelfState["commitments"];
  };
  self.interests = [{ topic: "Astronomy", strength: 0.7, evidenceIds: ["memory-a"] }];
  self.concerns = [{ id: "concern-a", description: "Private concern", topics: ["safety"], weight: 0.4 }];
  self.relationships = [{ personId: "person-a", boundaries: ["private"], evidenceIds: [] }];
  self.commitments = [{ id: "commit-a", description: "Private", status: "open", evidenceIds: [] }];

  assert.equal(selfRelevance(self, ["ASTRONOMY"]), 0.7);
  assert.equal(selfRelevance(self, ["astronomy news"]), 0);
  assert.equal(selfRelevance(self, ["safety"]), 0.4);
  let invoked = false;
  const topics = ["safe"];
  Object.defineProperty(topics, "0", { enumerable: true, get() { invoked = true; return "ASTRONOMY"; } });
  assert.throws(() => selfRelevance(self, topics));
  assert.equal(invoked, false);
  const projected = projectSelf(self);
  assert.deepEqual(Object.keys(projected), ["identity", "personality", "values", "interests"]);
  assert.equal("relationships" in projected, false);
  assert.equal("commitments" in projected, false);
  (projected.interests as unknown as Array<{ topic: string }>)[0]!.topic = "changed";
  assert.equal(self.interests[0]?.topic, "Astronomy");
});

test("growth proposals require multiple non-imagined occasions and never update self", () => {
  const experiences = records();
  const original = growth();
  const next = proposeGrowth(original, proposal(), experiences, subjectId, scopeId, at);
  assert.equal(next.proposals[0]?.status, "candidate");
  assert.deepEqual(original, growth());
  assert.throws(() => proposeGrowth(original, proposal({ evidenceIds: [] }), experiences, subjectId, scopeId, at));
  assert.throws(() => proposeGrowth(original, proposal({ evidenceIds: ["evidence-one"] }), experiences, subjectId, scopeId, at));
  assert.throws(() => proposeGrowth(original, proposal({ evidenceIds: ["evidence-one", "evidence-one"] }), experiences, subjectId, scopeId, at));
  assert.throws(() => proposeGrowth(original, proposal({ evidenceIds: ["future-one", "evidence-two"] }), experiences, subjectId, scopeId, at));
  assert.throws(() => proposeGrowth(original, proposal({ evidenceIds: ["other-scope", "evidence-two"] }), [
    ...experiences, experience("other-scope", "2026-01-03T00:00:00.000Z", { scopeId: "other" }),
  ], subjectId, scopeId, at));
  assert.throws(() => proposeGrowth(original, proposal({ evidenceIds: ["imagination", "evidence-two"] }), [
    ...experiences, experience("imagination", "2026-01-02T12:00:00.000Z", { origin: "imagination" }),
  ], subjectId, scopeId, at));
  assert.throws(() => proposeGrowth(original, proposal({ evidenceIds: ["derived-one", "derived-two"] }), [
    ...experiences,
    experience("shared-root", "2026-01-01T00:00:00.000Z"),
    experience("derived-one", "2026-01-02T12:00:00.000Z", { sourceIds: ["shared-root"] }),
    experience("derived-two", "2026-01-03T00:00:00.000Z", { sourceIds: ["shared-root"] }),
  ], subjectId, scopeId, at));
  assert.throws(() => proposeGrowth(original, proposal({ evidenceIds: ["inference-one", "inference-two"] }), [
    ...experiences,
    experience("inference-root", "2026-01-01T00:00:00.000Z"),
    experience("inference-one", "2026-01-02T00:00:00.000Z", { origin: "inference", sourceIds: ["inference-root"] }),
    experience("inference-two", "2026-01-03T00:00:00.000Z", { origin: "inference", sourceIds: ["inference-root"] }),
  ], subjectId, scopeId, at));
  assert.throws(() => proposeGrowth(original, proposal({ evidenceIds: ["inference-one", "inference-two"] }), [
    ...experiences,
    experience("inference-one", "2026-01-02T12:00:00.000Z", { origin: "inference" }),
    experience("inference-two", "2026-01-03T00:00:00.000Z", { origin: "inference" }),
  ], subjectId, scopeId, at));
  assert.throws(() => proposeGrowth(original, proposal(), [
    ...experiences.slice(0, 2).map(item => ({ ...item, occurredAt: "2026-01-02T00:00:00.000Z" })), experiences[2]!,
  ], subjectId, scopeId, at));
  assert.throws(() => proposeGrowth(original, proposal({ delta: 0 }), experiences, subjectId, scopeId, at));
  assert.throws(() => proposeGrowth(original, proposal({ delta: 0.051 }), experiences, subjectId, scopeId, at));
  assert.throws(() => proposeGrowth(original, proposal({ status: "accepted" }), experiences, subjectId, scopeId, at));
});

test("growth requires observed evidence for personality and valid schema without accessors", () => {
  const valid = { proposals: [proposal()], evaluations: [] };
  assertGrowth(valid);
  const accessor = structuredClone(valid) as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, "proposals", { enumerable: true, get: () => [] });
  assert.throws(() => assertGrowth(accessor));

  assert.throws(() => proposeGrowth(growth(), proposal({ kind: "personality", target: "curiosity" }), [
    ...records().map(item => ({ ...item, origin: "inference" as const })),
  ], subjectId, scopeId, at));
  assert.throws(() => proposeGrowth(growth(), proposal({ kind: "personality", target: "identity" }), records(), subjectId, scopeId, at));
});

test("successful objective evaluation applies a clamped small delta without changing identity or values", () => {
  const mutable = structuredClone(initialSelf()) as {
    identity: SelfState["identity"];
    personality: SelfState["personality"];
    values: SelfState["values"];
    concerns: SelfState["concerns"];
    selfBeliefs: SelfState["selfBeliefs"];
    interests: SelfState["interests"];
    relationships: SelfState["relationships"];
    commitments: SelfState["commitments"];
  };
  mutable.interests = [{ topic: "astronomy", strength: 0.98, evidenceIds: ["prior"] }];
  const self = mutable as SelfState;
  const candidate = proposeGrowth(growth(), proposal(), records(), subjectId, scopeId, at);
  const result = evaluateGrowth(candidate, self, evaluation(), records(), subjectId, scopeId, at);

  assert.equal(result.self.interests[0]?.strength, 1);
  assert.deepEqual(result.self.identity, self.identity);
  assert.deepEqual(result.self.values, self.values);
  assert.equal(result.growth.proposals[0]?.status, "accepted");
  assert.deepEqual(candidate.proposals[0]?.evaluationIds, []);
  assert.equal(self.interests[0]?.strength, 0.98);
  assert.throws(() => evaluateGrowth(result.growth, result.self, evaluation({ id: "evaluation-again" }), records(), subjectId, scopeId, at));
});

test("evaluation rejects missing/future/cross-scope evidence and only accepts a fresh observed activity result", () => {
  const candidate = proposeGrowth(growth(), proposal(), records(), subjectId, scopeId, at);
  const self = initialSelf();
  const wrongSubject = { ...self, identity: { ...self.identity, id: "other-subject" } };
  assert.throws(() => evaluateGrowth(candidate, wrongSubject, evaluation(), records(), subjectId, scopeId, at));
  assert.throws(() => evaluateGrowth(candidate, self, evaluation({ evidenceIds: [] }), records(), subjectId, scopeId, at));
  assert.throws(() => evaluateGrowth(candidate, self, evaluation({ at: "2026-01-04T00:00:00.000Z" }), records(), subjectId, scopeId, at));
  assert.throws(() => evaluateGrowth(candidate, self, evaluation({ evidenceIds: ["not-found"] }), records(), subjectId, scopeId, at));
  assert.throws(() => evaluateGrowth(candidate, self, evaluation({ evidenceIds: ["other-scope"] }), [
    ...records(), experience("other-scope", "2026-01-04T00:00:00.000Z", { kind: "activity_result", scopeId: "other" }),
  ], subjectId, scopeId, at));
  assert.throws(() => evaluateGrowth(candidate, self, evaluation({ evidenceIds: ["evidence-one"] }), records(), subjectId, scopeId, at));
  assert.throws(() => evaluateGrowth(candidate, self, evaluation({ evidenceIds: ["activity-imagined"] }), [
    ...records(), experience("activity-imagined", "2026-01-04T00:00:00.000Z", { kind: "activity_result", origin: "imagination" }),
  ], subjectId, scopeId, at));
  assert.throws(() => evaluateGrowth(candidate, self, evaluation({ evidenceIds: ["activity-stale"] }), [
    ...records(), experience("activity-stale", "2026-01-02T12:00:00.000Z", { kind: "activity_result" }),
  ], subjectId, scopeId, at));
});

test("failed test records rejection but leaves all self fields unchanged", () => {
  const self = initialSelf();
  const candidate = proposeGrowth(growth(), proposal(), records(), subjectId, scopeId, at);
  const result = evaluateGrowth(candidate, self, evaluation({ outcome: "fail" }), records(), subjectId, scopeId, at);
  assert.deepEqual(result.self, self);
  assert.equal(result.growth.proposals[0]?.status, "rejected");
  assert.deepEqual(result.growth.proposals[0]?.evaluationIds, ["evaluation-one"]);
});

test("personality pass is clamped and evaluation IDs are unique", () => {
  const mutable = structuredClone(initialSelf()) as {
    identity: SelfState["identity"];
    personality: { curiosity: number; caution: number; expressiveness: number; sociability: number };
    values: SelfState["values"];
    concerns: SelfState["concerns"];
    selfBeliefs: SelfState["selfBeliefs"];
    interests: SelfState["interests"];
    relationships: SelfState["relationships"];
    commitments: SelfState["commitments"];
  };
  mutable.personality.curiosity = 0.99;
  const source = records();
  const candidate = proposeGrowth(growth(), proposal({ kind: "personality", target: "curiosity" }), source, subjectId, scopeId, at);
  const result = evaluateGrowth(candidate, mutable as SelfState, evaluation(), source, subjectId, scopeId, at);
  assert.equal(result.self.personality.curiosity, 1);

  const prior: GrowthState = {
    proposals: [{ ...proposal({ id: "older-proposal", status: "rejected", evaluationIds: ["evaluation-one"] }) }],
    evaluations: [{ id: "evaluation-one", proposalId: "older-proposal", evidenceIds: ["activity-test"], outcome: "fail", at }],
  };
  const current = proposeGrowth(prior, proposal(), source, subjectId, scopeId, at);
  assert.throws(() => evaluateGrowth(current, mutable as SelfState, evaluation({ id: "evaluation-one" }), source, subjectId, scopeId, at));
});
