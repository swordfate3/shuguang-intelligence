import { assertExperience, resolveEvidence, type Experience } from "../experience.ts";
import { assertData, choice, clamp, id, ids, list, object, text, timestamp, unit } from "../guards.ts";
import type { SelfState } from "../self/types.ts";
import { assertSelf } from "../self/logic.ts";
import type { GrowthEvaluation, GrowthProposal, GrowthState, PersonalityAxis } from "./types.ts";

const PERSONALITY_AXES = ["curiosity", "caution", "expressiveness", "sociability"] as const;
const MAX_ITEMS = 1000;
const MAX_EVIDENCE = 32;

function assertProposal(value: unknown): asserts value is GrowthProposal {
  const proposal = object(value, ["id", "kind", "target", "delta", "evidenceIds", "status", "evaluationIds"]);
  id(proposal.id);
  choice(proposal.kind, ["interest", "personality"]);
  if (proposal.kind === "interest") text(proposal.target, 128);
  else choice(proposal.target, PERSONALITY_AXES);
  if (typeof proposal.delta !== "number" || !Number.isFinite(proposal.delta) || proposal.delta === 0 || Math.abs(proposal.delta) > 0.05) {
    throw new Error("Invalid growth delta");
  }
  ids(proposal.evidenceIds, MAX_EVIDENCE);
  if (proposal.evidenceIds.length === 0) throw new Error("Growth proposal evidence required");
  choice(proposal.status, ["candidate", "accepted", "rejected"]);
  ids(proposal.evaluationIds, MAX_ITEMS);
}

function assertEvaluation(value: unknown): asserts value is GrowthEvaluation {
  const evaluation = object(value, ["id", "proposalId", "evidenceIds", "outcome", "at"]);
  id(evaluation.id);
  id(evaluation.proposalId);
  ids(evaluation.evidenceIds, MAX_EVIDENCE);
  if (evaluation.evidenceIds.length === 0) throw new Error("Growth evaluation evidence required");
  choice(evaluation.outcome, ["pass", "fail"]);
  timestamp(evaluation.at);
}

/** Validate growth schema and its proposal/evaluation references. */
export function assertGrowth(value: unknown): asserts value is GrowthState {
  assertData(value);
  const growth = object(value, ["proposals", "evaluations"]);
  list(growth.proposals, MAX_ITEMS);
  list(growth.evaluations, MAX_ITEMS);

  const proposals = new Map<string, GrowthProposal>();
  for (const item of growth.proposals) {
    assertProposal(item);
    const proposal = item as GrowthProposal;
    if (proposals.has(proposal.id)) throw new Error("Duplicate growth proposal ID");
    proposals.set(proposal.id, proposal);
  }

  const evaluations = new Map<string, GrowthEvaluation>();
  const evaluationsByProposal = new Map<string, GrowthEvaluation>();
  for (const item of growth.evaluations) {
    assertEvaluation(item);
    const evaluation = item as GrowthEvaluation;
    if (evaluations.has(evaluation.id)) throw new Error("Duplicate growth evaluation ID");
    if (evaluationsByProposal.has(evaluation.proposalId)) throw new Error("Duplicate growth proposal evaluation");
    if (!proposals.has(evaluation.proposalId)) throw new Error("Orphan growth evaluation");
    evaluations.set(evaluation.id, evaluation);
    evaluationsByProposal.set(evaluation.proposalId, evaluation);
  }

  for (const proposal of proposals.values()) {
    const evaluation = evaluationsByProposal.get(proposal.id);
    if (proposal.status === "candidate") {
      if (proposal.evaluationIds.length !== 0 || evaluation) throw new Error("Candidate growth proposal has evaluation");
    } else {
      if (!evaluation || proposal.evaluationIds.length !== 1 || proposal.evaluationIds[0] !== evaluation.id) {
        throw new Error("Growth proposal evaluation mismatch");
      }
      if ((proposal.status === "accepted") !== (evaluation.outcome === "pass")) {
        throw new Error("Growth proposal status mismatch");
      }
    }
  }
}

function checkedExperiences(value: readonly Experience[]): readonly Experience[] {
  assertData(value);
  list(value, MAX_ITEMS);
  const seen = new Set<string>();
  for (const item of value) {
    assertExperience(item);
    if (seen.has(item.id)) throw new Error("Duplicate experience ID");
    seen.add(item.id);
  }
  return value;
}

function requireNonImagined(evidence: readonly Experience[]): void {
  if (evidence.some(item => item.origin === "imagination")) throw new Error("Imagined experience cannot support growth");
}

function assertIndependentExternalEvidence(evidence: readonly Experience[], experiences: readonly Experience[]): void {
  const byId = new Map(experiences.map(item => [item.id, item]));
  const cache = new Map<string, Set<string>>();
  const resolving = new Set<string>();
  const rootsFor = (item: Experience): Set<string> => {
    // A model-derived inference is never itself an independent external source,
    // even when it cites external records; those records must be supplied directly.
    if (item.origin === "inference" || item.origin === "imagination") return new Set();
    const cached = cache.get(item.id);
    if (cached) return cached;
    if (resolving.has(item.id)) throw new Error("Cyclic experience source chain");
    resolving.add(item.id);
    const roots = new Set<string>();
    const sources = item.sourceIds;
    if (sources.length === 0) {
      roots.add(item.id);
    } else {
      for (const sourceId of sources) {
        const source = byId.get(sourceId);
        if (source) {
          if (source.subjectId !== item.subjectId || source.scopeId !== item.scopeId ||
            source.occurredAt > item.occurredAt || source.recordedAt > item.recordedAt) {
            throw new Error("Invalid experience source scope or chronology");
          }
          for (const root of rootsFor(source)) roots.add(root);
        } else {
          roots.add(sourceId);
        }
      }
    }
    resolving.delete(item.id);
    cache.set(item.id, roots);
    return roots;
  };

  const candidates = evidence.map(item => ({ item, roots: rootsFor(item) })).filter(candidate => candidate.roots.size > 0);
  for (let left = 0; left < candidates.length; left++) {
    for (let right = left + 1; right < candidates.length; right++) {
      const a = candidates[left]!;
      const b = candidates[right]!;
      if (a.item.occurredAt === b.item.occurredAt) continue;
      if (![...a.roots].some(root => b.roots.has(root))) return;
    }
  }
  throw new Error("Growth needs independent external source roots and occasions");
}

function assertProposalEvidence(proposal: GrowthProposal, evidence: readonly Experience[], experiences: readonly Experience[]): void {
  requireNonImagined(evidence);
  assertIndependentExternalEvidence(evidence, experiences);
  if (proposal.kind === "personality" && !evidence.some(item => item.origin === "observation")) {
    throw new Error("Personality growth needs observational evidence");
  }
}

/** Record a bounded candidate only; proposing never changes the self snapshot. */
export function proposeGrowth(state: GrowthState, proposal: GrowthProposal, experiences: readonly Experience[],
  subjectId: string, scopeId: string, at: string): GrowthState {
  assertGrowth(state);
  assertData(proposal);
  assertProposal(proposal);
  id(subjectId); id(scopeId); timestamp(at);
  const available = checkedExperiences(experiences);
  const evidence = resolveEvidence(proposal.evidenceIds, available, subjectId, scopeId, at);
  if (evidence.length < 2) throw new Error("Growth needs at least two experiences");
  assertProposalEvidence(proposal, evidence, available);
  if (proposal.status !== "candidate" || proposal.evaluationIds.length !== 0) throw new Error("New growth proposal must be unevaluated candidate");
  if (state.proposals.some(existing => existing.id === proposal.id)) throw new Error("Duplicate growth proposal ID");

  const next: GrowthState = structuredClone({
    proposals: [...state.proposals, proposal],
    evaluations: state.evaluations,
  });
  assertGrowth(next);
  return next;
}

/** Apply only a trusted, evidence-backed evaluation; failed trials change no self fields. */
export function evaluateGrowth(growth: GrowthState, self: SelfState, evaluation: GrowthEvaluation,
  experiences: readonly Experience[], subjectId: string, scopeId: string, at: string): { growth: GrowthState; self: SelfState } {
  assertGrowth(growth);
  assertSelf(self);
  if (self.identity.id !== subjectId) throw new Error("Growth self subject mismatch");
  assertData(evaluation);
  assertEvaluation(evaluation);
  id(subjectId); id(scopeId); timestamp(at);
  if (evaluation.at !== at) throw new Error("Evaluation timestamp must equal trusted current time");
  if (growth.evaluations.some(existing => existing.id === evaluation.id)) throw new Error("Duplicate growth evaluation ID");
  const proposal = growth.proposals.find(item => item.id === evaluation.proposalId);
  if (!proposal || proposal.status !== "candidate" || proposal.evaluationIds.length !== 0) {
    throw new Error("Growth proposal is not an unevaluated candidate");
  }

  const available = checkedExperiences(experiences);
  const sourceEvidence = resolveEvidence(proposal.evidenceIds, available, subjectId, scopeId, at);
  if (sourceEvidence.length < 2) throw new Error("Growth needs at least two experiences");
  assertProposalEvidence(proposal, sourceEvidence, available);
  const testEvidence = resolveEvidence(evaluation.evidenceIds, available, subjectId, scopeId, at);
  requireNonImagined(testEvidence);
  const latestSourceOccurrence = Math.max(...sourceEvidence.map(item => Date.parse(item.occurredAt)));
  if (!testEvidence.some(item => item.kind === "activity_result" && item.origin === "observation" &&
    !proposal.evidenceIds.includes(item.id) && Date.parse(item.occurredAt) > latestSourceOccurrence)) {
    throw new Error("Growth evaluation needs a newer observed activity result");
  }
  if (proposal.kind === "personality" && !testEvidence.some(item => item.origin === "observation")) {
    throw new Error("Personality evaluation needs observational evidence");
  }
  if (!evaluation.evidenceIds.some(evidenceId => !proposal.evidenceIds.includes(evidenceId))) {
    throw new Error("Growth evaluation needs new evidence");
  }

  const outcome = evaluation.outcome;
  const updatedProposal: GrowthProposal = {
    ...proposal,
    status: outcome === "pass" ? "accepted" : "rejected",
    evaluationIds: [evaluation.id],
  };
  const nextGrowth: GrowthState = structuredClone({
    proposals: growth.proposals.map(item => item.id === proposal.id ? updatedProposal : item),
    evaluations: [...growth.evaluations, evaluation],
  });
  let nextSelf: SelfState = structuredClone(self);
  if (outcome === "pass") {
    if (proposal.kind === "personality") {
      const axis = proposal.target as PersonalityAxis;
      nextSelf = {
        ...nextSelf,
        personality: { ...nextSelf.personality, [axis]: clamp(nextSelf.personality[axis] + proposal.delta) },
      };
    } else {
      const existing = nextSelf.interests.find(item => item.topic.toLowerCase() === proposal.target.toLowerCase());
      const evidenceIds = [...new Set([...(existing?.evidenceIds ?? []), ...proposal.evidenceIds, ...evaluation.evidenceIds])];
      const updatedInterest = {
        topic: existing?.topic ?? proposal.target,
        strength: clamp((existing?.strength ?? 0) + proposal.delta),
        evidenceIds,
      };
      nextSelf = {
        ...nextSelf,
        interests: existing
          ? nextSelf.interests.map(item => item === existing ? updatedInterest : item)
          : [...nextSelf.interests, updatedInterest],
      };
    }
  }
  assertGrowth(nextGrowth);
  assertSelf(nextSelf);
  return { growth: nextGrowth, self: nextSelf };
}
