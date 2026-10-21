import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState } from "../src/legacy/state.ts";
import { assertSubjectState } from "../src/legacy/validation.ts";

const at = "2026-01-01T00:00:00.000Z";
type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;

function richState(): Mutable<ReturnType<typeof createInitialState>> {
  const state = structuredClone(createInitialState("dawn-test", "曙光", at)) as Mutable<ReturnType<typeof createInitialState>>;
  state.self.beliefs.push({ statement: "A tentative belief", evidenceIds: ["memory-1"], status: "tentative" });
  state.self.interests.push({ topic: "astronomy", strength: 0.8, evidenceIds: ["memory-1"] });
  state.self.relationships.push({
    personId: "person-1", statedBoundaries: ["ask first"], sharedMemoryIds: ["memory-1"],
    subjectiveView: "A valued conversation partner",
  });
  state.self.commitments.push({ id: "commitment-1", description: "Follow up", status: "open", evidenceIds: ["event-1"] });
  state.affect = {
    valence: -0.2, arousal: 0.6, tension: 0.1, updatedAt: at,
    episodes: [{ id: "episode-1", label: "Curious", intensity: 0.7, sourceEventIds: ["event-1"], startedAt: at }],
  };
  state.agency = {
    motivations: { curiosity: 0.9, competence: 0.5, connection: 0.6, recreation: 0.2, rest: 0.4 },
    intentions: [{
      id: "intention-1", origin: "commitment", description: "Review notes", reasonIds: ["commitment-1"],
      status: "ready", priority: 0.8,
    }],
    activeActivityId: "activity-1",
  };
  state.growthProposals.push({
    id: "proposal-1", kind: "method", description: "Try a clearer explanation", evidenceIds: ["memory-1"],
    status: "trial", evaluationIds: ["evaluation-1"],
  });
  state.memoryIds.push("memory-1");
  return state;
}

function expectInvalid(value: unknown, path: string): void {
  assert.throws(
    () => assertSubjectState(value),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, `Invalid subject state: ${path}`);
      return true;
    },
  );
}

test("accepts the initial state and a populated nested schema-v1 snapshot", () => {
  assertSubjectState(createInitialState("dawn-test", "曙光", at));
  assertSubjectState(richState());
});

test("rejects invalid top-level values, timestamps, and revisions", () => {
  const cases: Array<[string, (state: ReturnType<typeof richState>) => void, string]> = [
    ["schema version", state => { (state as { schemaVersion: number }).schemaVersion = 2; }, "state.schemaVersion"],
    ["negative revision", state => { (state as { revision: number }).revision = -1; }, "state.revision"],
    ["unsafe revision", state => { (state as { revision: number }).revision = Number.MAX_SAFE_INTEGER + 1; }, "state.revision"],
    ["fractional revision", state => { (state as { revision: number }).revision = 1.5; }, "state.revision"],
    ["bad lifecycle", state => { (state as { lifecycle: string }).lifecycle = "running"; }, "state.lifecycle"],
    ["empty memory reference", state => { state.memoryIds[0] = " "; }, "state.memoryIds[0]"],
    ["invalid updatedAt", state => { (state as { updatedAt: string }).updatedAt = "yesterday"; }, "state.updatedAt"],
    ["noncanonical UTC timestamp", state => { (state as { updatedAt: string }).updatedAt = "2026-01-01T00:00:00Z"; }, "state.updatedAt"],
  ];
  for (const [label, mutate, path] of cases) {
    const state = richState();
    mutate(state);
    assert.throws(() => assertSubjectState(state), { message: `Invalid subject state: ${path}` }, label);
  }
});

test("rejects missing, unknown, and non-data snapshot fields", () => {
  const missing = richState() as unknown as Record<string, unknown>;
  delete missing.revision;
  expectInvalid(missing, "state.revision");

  const extraRoot = { ...richState(), schemaVersion: 1, futureField: "private marker" };
  assert.throws(() => assertSubjectState(extraRoot), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^Invalid subject state: state\.<unknown>$/);
    assert.equal(error.message.includes("private marker"), false);
    return true;
  });

  const extraNested = richState() as unknown as { self: Record<string, unknown> };
  extraNested.self = { ...extraNested.self, futureField: true };
  expectInvalid(extraNested, "state.self.<unknown>");

  const accessor = richState() as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, "revision", { get: () => 0, enumerable: true });
  expectInvalid(accessor, "state.revision");

  const hidden = richState();
  Object.defineProperty(hidden.self.identity, "name", { enumerable: false });
  expectInvalid(hidden, "state.self.identity.name");
});

test("rejects invalid scalar and nested union, range, and reference fields", () => {
  const cases: Array<[string, (state: ReturnType<typeof richState>) => void, string]> = [
    ["blank identity", state => { (state.self.identity as { id: string }).id = "  "; }, "state.self.identity.id"],
    ["personality above range", state => { (state.self.personality as { curiosity: number }).curiosity = 1.01; }, "state.self.personality.curiosity"],
    ["NaN affect", state => { (state.affect as { arousal: number }).arousal = Number.NaN; }, "state.affect.arousal"],
    ["valence below range", state => { (state.affect as { valence: number }).valence = -1.01; }, "state.affect.valence"],
    ["bad nested timestamp", state => { (state.affect as { updatedAt: string }).updatedAt = "2026-01-01T00:00:00Z"; }, "state.affect.updatedAt"],
    ["bad belief status", state => { (state.self.beliefs[0] as { status: string }).status = "certain"; }, "state.self.beliefs[0].status"],
    ["empty belief reference", state => { (state.self.beliefs[0] as { evidenceIds: string[] }).evidenceIds[0] = ""; }, "state.self.beliefs[0].evidenceIds[0]"],
    ["interest strength above range", state => { (state.self.interests[0] as { strength: number }).strength = 2; }, "state.self.interests[0].strength"],
    ["empty relationship ID", state => { (state.self.relationships[0] as { personId: string }).personId = ""; }, "state.self.relationships[0].personId"],
    ["blank boundary", state => { (state.self.relationships[0] as { statedBoundaries: string[] }).statedBoundaries[0] = " "; }, "state.self.relationships[0].statedBoundaries[0]"],
    ["bad commitment status", state => { (state.self.commitments[0] as { status: string }).status = "pending"; }, "state.self.commitments[0].status"],
    ["bad episode intensity", state => { (state.affect.episodes[0] as { intensity: number }).intensity = Infinity; }, "state.affect.episodes[0].intensity"],
    ["bad episode source reference", state => { (state.affect.episodes[0] as { sourceEventIds: string[] }).sourceEventIds[0] = " "; }, "state.affect.episodes[0].sourceEventIds[0]"],
    ["bad intention origin", state => { (state.agency.intentions[0] as { origin: string }).origin = "model"; }, "state.agency.intentions[0].origin"],
    ["intention priority out of range", state => { (state.agency.intentions[0] as { priority: number }).priority = -0.1; }, "state.agency.intentions[0].priority"],
    ["bad growth kind", state => { (state.growthProposals[0] as { kind: string }).kind = "fact"; }, "state.growthProposals[0].kind"],
    ["bad growth status", state => { (state.growthProposals[0] as { status: string }).status = "approved"; }, "state.growthProposals[0].status"],
  ];
  for (const [label, mutate, path] of cases) {
    const state = richState();
    mutate(state);
    assert.throws(() => assertSubjectState(state), { message: `Invalid subject state: ${path}` }, label);
  }
});

test("rejects missing or malformed nested objects and sparse arrays", () => {
  const missingNested = richState() as unknown as { agency: Record<string, unknown> };
  delete missingNested.agency.motivations;
  expectInvalid(missingNested, "state.agency.motivations");

  const wrongNested = richState() as unknown as { self: Record<string, unknown> };
  wrongNested.self.relationships = [null];
  expectInvalid(wrongNested, "state.self.relationships[0]");

  const sparse = richState() as unknown as { memoryIds: string[] };
  sparse.memoryIds = Array(1);
  expectInvalid(sparse, "state.memoryIds[0]");
});
