import type { SubjectState } from "./state.ts";
import { assertData, choice, id, ids, integer, list, object, timestamp } from "./guards.ts";
import { assertExperience, resolveEvidence } from "./experience.ts";
import { evidenceRoots } from "./evidence.ts";
import { assertSelf } from "./self/logic.ts";
import { assertCognition } from "./cognition/logic.ts";
import { assertAffect } from "./affect/logic.ts";
import { assertMemory } from "./memory/logic.ts";
import { assertAgency } from "./agency/logic.ts";
import { assertGrowth } from "./growth/logic.ts";

/** Complete domain validation, including evidence ownership. No automatic v1 conversion. */
export function assertSubjectState(value: unknown): asserts value is SubjectState {
  assertData(value);
  const raw = object(value, ["schemaVersion", "revision", "scopeId", "lifecycle", "updatedAt", "self", "cognition", "affect", "memory", "agency", "growth", "experiences", "processedCycleIds"]);
  if (raw.schemaVersion !== 2) throw new Error("Unsupported core schema");
  integer(raw.revision); id(raw.scopeId); choice(raw.lifecycle, ["sleeping", "awake"]); timestamp(raw.updatedAt);
  assertSelf(raw.self); assertCognition(raw.cognition); assertAffect(raw.affect); assertMemory(raw.memory); assertAgency(raw.agency); assertGrowth(raw.growth);
  list(raw.experiences, 1000); raw.experiences.forEach(assertExperience); ids(raw.processedCycleIds, 1000);
  const state = value as SubjectState;
  const subjectId = state.self.identity.id;
  const evidenceIds = new Map<string, SubjectState["experiences"][number]>();
  for (const e of state.experiences) {
    if (evidenceIds.has(e.id) || e.subjectId !== subjectId || e.scopeId !== state.scopeId || e.recordedAt > state.updatedAt) {
      throw new Error("Invalid subject experience ownership or time");
    }
    for (const source of e.sourceIds) {
      const original = evidenceIds.get(source);
      if (!original || original.recordedAt > e.recordedAt) throw new Error("Experience source must precede its derivative");
    }
    evidenceIds.set(e.id, e);
  }
  const resolve = (refs: readonly string[]) => resolveEvidence(refs, state.experiences, subjectId, state.scopeId, state.updatedAt);
  for (const belief of state.self.selfBeliefs) resolve(belief.evidenceIds);
  for (const interest of state.self.interests) resolve(interest.evidenceIds);
  for (const relationship of state.self.relationships) resolve(relationship.evidenceIds);
  for (const commitment of state.self.commitments) resolve(commitment.evidenceIds);
  for (const belief of state.cognition.beliefs) {
    const sources = resolve(belief.evidenceIds);
    if (belief.updatedAt > state.updatedAt || sources.some(e => e.recordedAt > belief.updatedAt)) throw new Error("Future world belief");
    if (!sources.some(e => e.origin === belief.origin) || (belief.status === "supported" &&
        !sources.some(e => e.origin === "observation" || e.origin === "document"))) throw new Error("Invalid belief origin evidence");
    for (const oldId of belief.supersedesIds) {
      const old = state.cognition.beliefs.find(b => b.id === oldId);
      if (!old || old.id === belief.id || old.status !== "retracted" || old.updatedAt > belief.updatedAt) throw new Error("Invalid belief supersession");
    }
  }
  if (state.affect.updatedAt > state.updatedAt) throw new Error("Future affect state");
  const appraisedSources = new Set<string>();
  for (const episode of state.affect.episodes) {
    const sources = resolve(episode.sourceEventIds);
    for (const eid of evidenceRoots(episode.sourceEventIds, state.experiences, subjectId, state.scopeId, state.updatedAt)) {
      const key = `${episode.concernId}:${eid}`;
      if (appraisedSources.has(key)) throw new Error("Repeated affect evidence");
      appraisedSources.add(key);
    }
    if (!state.self.concerns.some(c => c.id === episode.concernId) || episode.startedAt > state.affect.updatedAt ||
        sources.some(e => e.recordedAt > episode.startedAt)) throw new Error("Invalid affect provenance");
  }
  for (const record of state.memory.records) {
    const sources = resolve(record.sourceIds);
    if (record.subjectId !== subjectId || record.scopeId !== state.scopeId || record.createdAt > state.updatedAt ||
        sources.some(e => e.recordedAt > record.createdAt)) throw new Error("Invalid memory ownership or time");
    if (!sources.some(e => e.origin === record.origin) || (record.kind === "knowledge" && record.status === "usable" &&
        !sources.some(e => e.origin === "observation" || e.origin === "document"))) throw new Error("Invalid memory origin evidence");
    for (const oldId of record.supersedesIds) {
      const old = state.memory.records.find(r => r.id === oldId);
      if (!old || old.id === record.id || (record.status !== "candidate" && old.status !== "retracted") || old.createdAt > record.createdAt) throw new Error("Invalid memory supersession");
    }
  }
  for (const intention of state.agency.intentions) resolve(intention.reasonIds);
  for (const proposal of state.growth.proposals) {
    const sources = resolve(proposal.evidenceIds);
    if (sources.length < 2 || new Set(sources.map(e => e.occurredAt)).size < 2 ||
        sources.some(e => e.origin === "imagination") ||
        (proposal.kind === "personality" && !sources.some(e => e.origin === "observation"))) throw new Error("Insufficient growth evidence");
    const independent = sources.filter(e => e.origin !== "inference" && e.origin !== "imagination").map(e => ({
      at: e.occurredAt,
      roots: evidenceRoots([e.id], state.experiences, subjectId, state.scopeId, state.updatedAt),
    }));
    if (!independent.some((a, index) => independent.slice(index + 1).some(b => a.at !== b.at &&
        !a.roots.some(root => b.roots.includes(root))))) throw new Error("Non-independent growth evidence");
    for (const eid of proposal.evaluationIds) {
      if (!state.growth.evaluations.some(e => e.id === eid && e.proposalId === proposal.id)) throw new Error("Unresolved growth evaluation");
    }
    if (proposal.status === "candidate" && proposal.evaluationIds.length) throw new Error("Candidate already evaluated");
    if (proposal.status !== "candidate" && !proposal.evaluationIds.length) throw new Error("Missing growth evaluation");
  }
  for (const evaluation of state.growth.evaluations) {
    const sources = resolve(evaluation.evidenceIds);
    const proposal = state.growth.proposals.find(p => p.id === evaluation.proposalId);
    if (!proposal || !proposal.evaluationIds.includes(evaluation.id) || evaluation.at > state.updatedAt ||
        sources.some(e => e.recordedAt > evaluation.at) ||
        proposal.status !== (evaluation.outcome === "pass" ? "accepted" : "rejected")) throw new Error("Invalid growth evaluation link");
    const proposalSources = resolve(proposal.evidenceIds);
    if (!sources.some(e => e.kind === "activity_result" && e.origin === "observation" &&
        !proposal.evidenceIds.includes(e.id) && proposalSources.every(old => old.occurredAt < e.occurredAt))) {
      throw new Error("Growth evaluation lacks new observed result");
    }
  }
}
