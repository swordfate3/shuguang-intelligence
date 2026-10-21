import assert from "node:assert/strict";
import test from "node:test";
import { appraiseAffect, assertAffect } from "../src/core/affect/logic.ts";
import type { AffectState, Appraisal } from "../src/core/affect/types.ts";
import { assertAgency, chooseIntention } from "../src/core/agency/logic.ts";
import type { ActivityOption, AgencyState } from "../src/core/agency/types.ts";
import type { Experience } from "../src/core/experience.ts";
import { createInitialState } from "../src/core/state.ts";
import type { SelfState } from "../src/core/self/types.ts";

const subjectId = "dawn-test";
const scopeId = "owner";
const start = "2026-01-01T00:00:00.000Z";
const later = "2026-01-01T06:00:00.000Z";
const at = "2026-01-02T00:00:00.000Z";

function selfState(): SelfState {
  const initial = createInitialState(subjectId, "Dawn", start).self;
  return {
    ...initial,
    concerns: [
      { id: "concern-sky", description: "Astronomy matters", topics: ["astronomy"], weight: 0.8 },
      { id: "concern-learning", description: "Learning matters", topics: ["learning"], weight: 0.6 },
    ],
  };
}

function experience(id: string, topics = ["astronomy", "learning"]): Experience {
  return {
    id, subjectId, scopeId, kind: "conversation", origin: "observation", content: "Synthetic evidence",
    topics, occurredAt: start, recordedAt: start, sourceIds: [],
  };
}

function appraisal(patch: Partial<Appraisal> = {}): Appraisal {
  return { evidenceIds: ["event-a"], concernId: "concern-sky", desirability: -0.8, expectedness: 0.5,
    controllability: 0.1, intensity: 1, ...patch };
}

function initialAffect(): AffectState {
  return { valence: 0, arousal: 0, tension: 0, updatedAt: start, episodes: [] };
}

function option(id: string, kind: ActivityOption["kind"], patch: Partial<ActivityOption> = {}): ActivityOption {
  return { id, kind, description: `${kind} activity`, topics: [], evidenceIds: [], cost: 1, available: true, ...patch };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test("affect appraisal is bounded, concern-specific, append-only, deterministic, and leaves self untouched", () => {
  const self = freeze(selfState());
  const base = freeze(initialAffect());
  const experiences = freeze([experience("event-a")]);
  const result = appraiseAffect(base, self, appraisal(), experiences, subjectId, scopeId, at);
  assert.ok(result.valence >= -0.2 && result.valence <= 0.2);
  assert.ok(result.arousal >= 0 && result.arousal <= 0.2);
  assert.ok(result.tension >= 0 && result.tension <= 0.2);
  assert.equal(result.episodes[0]?.label, "frustration");
  assert.deepEqual(result.episodes[0]?.sourceEventIds, ["event-a"]);
  assert.match(result.episodes[0]!.id, /^affect_[A-Za-z0-9_-]{1,128}$/);
  assert.deepEqual(appraiseAffect(base, self, appraisal(), experiences, subjectId, scopeId, at), result);
  assert.deepEqual(base, initialAffect());
  assert.deepEqual(self, selfState());

  const otherConcern = appraiseAffect(result, self, appraisal({ concernId: "concern-learning" }), experiences, subjectId, scopeId, at);
  assert.equal(otherConcern.episodes.length, 2, "the same event can support another matching concern");
  assert.throws(() => appraiseAffect(result, self, appraisal(), experiences, subjectId, scopeId, at), /already impacted/);
  assert.throws(() => appraiseAffect(base, self, appraisal({ concernId: "missing" }), experiences, subjectId, scopeId, at));
  assert.throws(() => appraiseAffect(base, self, appraisal({ evidenceIds: ["unrelated"] }), [experience("unrelated", ["music"])], subjectId, scopeId, at));
  const labels: Array<[Appraisal, string]> = [
    [appraisal({ evidenceIds: ["label-surprise"], expectedness: 0, intensity: 1 }), "surprise"],
    [appraisal({ evidenceIds: ["label-satisfaction"], desirability: 0.8 }), "satisfaction"],
    [appraisal({ evidenceIds: ["label-concern"], desirability: -0.1, expectedness: 1, controllability: 1 }), "concern"],
  ];
  for (const [candidate, label] of labels) {
    assert.equal(appraiseAffect(base, self, candidate, [experience(candidate.evidenceIds[0]!)], subjectId, scopeId, at).episodes[0]?.label, label);
  }
  assert.throws(() => appraiseAffect(base, self, appraisal({ intensity: 1.01 }), experiences, subjectId, scopeId, at));
  assert.throws(() => appraiseAffect({ ...base, extra: true } as AffectState, self, null, experiences, subjectId, scopeId, at));
  assert.throws(() => appraiseAffect(base, self, null, experiences, subjectId, scopeId, "2025-12-31T23:59:59.999Z"));
});

test("affect rejects derived evidence that reuses a previously impacted source root", () => {
  const root = experience("event-a");
  const first = appraiseAffect(initialAffect(), selfState(), appraisal(), [root], subjectId, scopeId, at);
  const derived: Experience = { ...experience("reflection-r", ["astronomy"]), kind: "reflection", origin: "inference", sourceIds: [root.id] };
  assert.throws(() => appraiseAffect(first, selfState(), appraisal({ evidenceIds: [derived.id] }), [root, derived], subjectId, scopeId, at),
    /already impacted/);
});

test("affect regression uses a documented six-hour half-life, null only decays, and never deletes episodes", () => {
  const affect: AffectState = {
    valence: 0.8, arousal: 0.4, tension: 0.6, updatedAt: start,
    episodes: [{ id: "old-episode", label: "satisfaction", intensity: 0.4, sourceEventIds: ["event-a"], concernId: "concern-sky", startedAt: start }],
  };
  const result = appraiseAffect(affect, selfState(), null, [experience("event-a")], subjectId, scopeId, later);
  assert.equal(result.valence, 0.4);
  assert.equal(result.arousal, 0.2);
  assert.equal(result.tension, 0.3);
  assert.deepEqual(result.episodes, affect.episodes);
  assert.notEqual(result.episodes, affect.episodes);
  assert.throws(() => appraiseAffect(affect, selfState(), null, [], subjectId, scopeId, "2025-12-31T23:59:59.999Z"));
});

test("agency schemas are strict and proposed intentions contain only resolved evidence IDs as reasons", () => {
  const self = selfState();
  const chosen = chooseIntention(self, initialAffect(), [option("reply-a", "reply", { evidenceIds: ["event-a"] })],
    { experienceId: "event-now", availableBudget: 1, stopRequested: false });
  assertAgency(chosen);
  assert.equal(chosen.intentions[0]?.status, "proposed");
  assert.deepEqual(chosen.intentions[0]?.reasonIds, ["event-now", "event-a"]);
  assert.equal(chosen.intentions[0]?.activityId, "reply-a");
  assert.match(chosen.intentions[0]!.id, /^intent_[A-Za-z0-9_-]{1,128}$/);
  assert.deepEqual(chooseIntention(self, initialAffect(), [option("reply-a", "reply", { evidenceIds: ["event-a"] })],
    { experienceId: "event-now", availableBudget: 1, stopRequested: false }), chosen);
  assert.throws(() => assertAgency({ ...chosen, unknown: true }));
  assert.throws(() => chooseIntention(self, initialAffect(), [{ ...option("no-perm", "reply"), permission: "admin" } as ActivityOption],
    { experienceId: "event-now", availableBudget: 1, stopRequested: false }));
  assert.throws(() => chooseIntention(self, initialAffect(), [option("bad-cost", "reply", { cost: Infinity })],
    { experienceId: "event-now", availableBudget: 1, stopRequested: false }));
});

test("interests influence activity choice, recreation has intrinsic value, and uncertainty boosts reflection", () => {
  const curious = { ...selfState(), concerns: [], interests: [{ topic: "astronomy", strength: 1, evidenceIds: ["past"] }] };
  const uninterestedBase = selfState();
  const uninterested = { ...uninterestedBase, concerns: [], personality: { ...uninterestedBase.personality, curiosity: 0 } };
  const learningOptions = [option("learn", "learn", { topics: ["astronomy"] }), option("reply", "reply")];
  const context = { experienceId: "event-now", availableBudget: 2, stopRequested: false };
  assert.equal(chooseIntention(curious, initialAffect(), learningOptions, context).intentions[0]?.kind, "learn");
  assert.equal(chooseIntention(uninterested, initialAffect(), learningOptions, context).intentions[0]?.kind, "reply");
  assert.equal(chooseIntention(selfState(), initialAffect(), [option("fun", "recreate")], context).intentions[0]?.kind, "recreate");
  assert.equal(chooseIntention(selfState(), { ...initialAffect(), tension: 1, arousal: 1 },
    [option("rest", "rest"), option("fun", "recreate")], context).intentions[0]?.kind, "rest");

  const reflectOptions = [option("reflect", "reflect"), option("reply", "reply")];
  const certain = chooseIntention(selfState(), initialAffect(), reflectOptions, context);
  const uncertain = chooseIntention(selfState(), initialAffect(), reflectOptions, { ...context, uncertainty: 1 });
  assert.equal(certain.intentions[0]?.kind, "reply");
  assert.equal(uncertain.intentions[0]?.kind, "reflect");
  assert.throws(() => chooseIntention(selfState(), initialAffect(), reflectOptions, { ...context, uncertainty: 1.1 }));
});

test("agency honors stop, availability, and budget without inventing candidates", () => {
  const self = selfState();
  const context = { experienceId: "event-now", availableBudget: 0, stopRequested: false };
  const choices = [option("costly", "recreate", { cost: 1 }), option("offline", "reply", { available: false, cost: 0 })];
  assert.deepEqual(chooseIntention(self, initialAffect(), choices, context).intentions, []);
  assert.deepEqual(chooseIntention(self, initialAffect(), [option("free", "recreate", { cost: 0 })], context).intentions[0]?.kind, "recreate");
  assert.deepEqual(chooseIntention(self, initialAffect(), [option("free", "recreate", { cost: 0 })],
    { ...context, stopRequested: true }).intentions, []);
  assert.deepEqual(chooseIntention(self, initialAffect(), [], { ...context, availableBudget: Number.MAX_SAFE_INTEGER }).intentions, []);
  assert.throws(() => chooseIntention(self, initialAffect(), [], { ...context, availableBudget: Number.MAX_SAFE_INTEGER + 1 }));
});

test("pure boundaries reject getters without invoking them and outputs are detached", () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, "identity", { enumerable: true, get() { calls++; throw new Error("sentinel"); } });
  assert.throws(() => appraiseAffect(initialAffect(), accessor as SelfState, null, [], subjectId, scopeId, start));
  assert.throws(() => chooseIntention(selfState(), initialAffect(), [accessor as ActivityOption],
    { experienceId: "event-now", availableBudget: 0, stopRequested: false }));
  assert.equal(calls, 0);
  const input = freeze(initialAffect());
  const result = appraiseAffect(input, selfState(), null, [], subjectId, scopeId, later);
  assert.notEqual(result, input);
  const agency = chooseIntention(selfState(), initialAffect(), [option("fun", "recreate")],
    { experienceId: "event-now", availableBudget: 1, stopRequested: false }) as AgencyState;
  assert.notEqual(agency.intentions, []);
});
