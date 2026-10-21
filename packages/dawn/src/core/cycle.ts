import type { SubjectState } from "./state.ts";
import type { Experience } from "./experience.ts";
import { assertExperience, resolveEvidence } from "./experience.ts";
import type { WorldBelief, Workspace } from "./cognition/types.ts";
import type { Appraisal } from "./affect/types.ts";
import type { MemoryRecord } from "./memory/types.ts";
import type { ActivityOption } from "./agency/types.ts";
import type { GrowthEvaluation, GrowthProposal } from "./growth/types.ts";
import { assertSubjectState } from "./validation.ts";
import { assertData, id, integer, list, object, timestamp, unit } from "./guards.ts";
import { buildWorkspace, reviseBelief } from "./cognition/logic.ts";
import { correctMemory, recallMemories, rememberExperience } from "./memory/logic.ts";
import { appraiseAffect } from "./affect/logic.ts";
import { chooseIntention } from "./agency/logic.ts";
import { evaluateGrowth, proposeGrowth } from "./growth/logic.ts";

/** These are candidates, not executable patches. No arbitrary field paths or permission changes. */
export type ChangeCandidate =
  | { readonly type: "world_belief"; readonly belief: WorldBelief }
  | { readonly type: "memory_correction"; readonly record: MemoryRecord }
  | { readonly type: "growth_candidate"; readonly proposal: GrowthProposal };
export interface CycleInput {
  readonly cycleId: string;
  readonly expectedRevision: number;
  readonly at: string;
  readonly experience: Experience;
  readonly appraisal: Appraisal | null;
  readonly candidates: readonly ChangeCandidate[];
  readonly activities: readonly ActivityOption[];
}
/** Supplied by trusted caller policy, NEVER parsed from a model's candidate JSON. */
export interface CycleAuthority {
  readonly allow: readonly ChangeCandidate["type"][];
  readonly availableBudget: number;
  readonly stopRequested: boolean;
  readonly evaluations: readonly GrowthEvaluation[];
}
export interface CycleResult {
  readonly state: SubjectState;
  readonly workspace: Workspace;
  readonly event: { readonly type: "cycle_completed"; readonly cycleId: string; readonly experienceId: string;
    readonly fromRevision: number; readonly toRevision: number; readonly at: string };
}
export class CoreRevisionConflictError extends Error {
  constructor() { super("Core revision conflict"); this.name = "CoreRevisionConflictError"; }
}

/** Pure, all-or-nothing domain cycle. No model, database, tool, timer or hidden autonomous loop. */
export function runSubjectCycle(state: SubjectState, input: CycleInput, authority: CycleAuthority): CycleResult {
  assertSubjectState(state); assertData(input); assertData(authority);
  object(input, ["cycleId", "expectedRevision", "at", "experience", "appraisal", "candidates", "activities"]);
  object(authority, ["allow", "availableBudget", "stopRequested", "evaluations"]);
  id(input.cycleId); integer(input.expectedRevision); timestamp(input.at);
  if (input.expectedRevision !== state.revision) throw new CoreRevisionConflictError();
  if (state.lifecycle !== "awake" || authority.stopRequested === true) throw new Error("Core cycle stopped or sleeping");
  if (typeof authority.stopRequested !== "boolean") throw new Error("Invalid stop policy");
  unit(authority.availableBudget, 0, Number.MAX_SAFE_INTEGER);
  list(authority.allow, 3);
  if (new Set(authority.allow).size !== authority.allow.length || authority.allow.some(t => !["world_belief", "memory_correction", "growth_candidate"].includes(t))) throw new Error("Invalid change policy");
  list(authority.evaluations, 16); list(input.candidates, 16); list(input.activities, 32);
  if (input.at < state.updatedAt || !Number.isSafeInteger(state.revision + 1)) throw new Error("Core time or revision overflow");
  if (state.processedCycleIds.includes(input.cycleId) || state.experiences.some(e => e.id === input.experience.id)) throw new Error("Duplicate core cycle or experience");
  assertExperience(input.experience);
  if (input.experience.subjectId !== state.self.identity.id || input.experience.scopeId !== state.scopeId || input.experience.recordedAt !== input.at) throw new Error("Invalid cycle experience scope or time");
  if (input.experience.sourceIds.length) resolveEvidence(input.experience.sourceIds, state.experiences, state.self.identity.id, state.scopeId, input.at);
  // Work only on a detached candidate. Throwing anywhere leaves the caller's state untouched.
  let next = structuredClone(state);
  const experiences = [...next.experiences, structuredClone(input.experience)];
  next = { ...next, experiences, memory: rememberExperience(next.memory, input.experience, 0.5) };
  for (const candidate of input.candidates) {
    if (!candidate || !authority.allow.includes(candidate.type)) throw new Error("Core change not permitted");
    switch (candidate.type) {
      case "world_belief":
        object(candidate, ["type", "belief"]);
        next = { ...next, cognition: reviseBelief(next.cognition, candidate.belief, experiences, next.self.identity.id, next.scopeId, input.at) };
        break;
      case "memory_correction":
        object(candidate, ["type", "record"]);
        next = { ...next, memory: correctMemory(next.memory, candidate.record, experiences, next.self.identity.id, next.scopeId, input.at) };
        break;
      case "growth_candidate":
        object(candidate, ["type", "proposal"]);
        next = { ...next, growth: proposeGrowth(next.growth, candidate.proposal, experiences, next.self.identity.id, next.scopeId, input.at) };
        break;
      default: throw new Error("Unknown core transition");
    }
  }
  // Evaluation is a separate trusted input; language reflection is not external verification.
  const evaluatedTargets = new Set<string>();
  for (const evaluation of authority.evaluations) {
    const priorProposal = state.growth.proposals.find(p => p.id === evaluation.proposalId && p.status === "candidate");
    if (!priorProposal) throw new Error("Growth requires a prior-cycle candidate");
    const targetKey = `${priorProposal.kind}:${priorProposal.target.toLowerCase()}`;
    if (evaluatedTargets.has(targetKey)) throw new Error("Only one growth evaluation per target per cycle");
    evaluatedTargets.add(targetKey);
    const result = evaluateGrowth(next.growth, next.self, evaluation, experiences, next.self.identity.id, next.scopeId, input.at);
    next = { ...next, growth: result.growth, self: result.self };
  }
  next = { ...next, affect: appraiseAffect(next.affect, next.self, input.appraisal, experiences, next.self.identity.id, next.scopeId, input.at) };
  for (const activity of input.activities) {
    // An activity's availability is only a trusted candidate input, not an authorization token.
    resolveEvidence(activity.evidenceIds, experiences, next.self.identity.id, next.scopeId, input.at);
  }
  const recalled = recallMemories(next.memory, { text: input.experience.content, topics: input.experience.topics,
    subjectId: next.self.identity.id, scopeId: next.scopeId, at: input.at, limit: 8 });
  const workspace = buildWorkspace(next.cognition, input.experience, recalled);
  next = { ...next, agency: chooseIntention(next.self, next.affect, input.activities, {
    experienceId: input.experience.id, availableBudget: authority.availableBudget, stopRequested: false,
    uncertainty: Math.min(1, workspace.uncertainties.length / 4),
  }), revision: state.revision + 1, updatedAt: input.at, processedCycleIds: [...state.processedCycleIds, input.cycleId] };
  assertSubjectState(next);
  return structuredClone({ state: next, workspace, event: {
    type: "cycle_completed", cycleId: input.cycleId, experienceId: input.experience.id,
    fromRevision: state.revision, toRevision: next.revision, at: input.at,
  } });
}

/** Trusted explicit control only; a motivation or model candidate cannot wake/sleep the subject. */
export function changeCoreLifecycle(state: SubjectState, expectedRevision: number,
  lifecycle: "awake" | "sleeping", at: string): SubjectState {
  assertSubjectState(state); integer(expectedRevision); timestamp(at);
  if (expectedRevision !== state.revision) throw new CoreRevisionConflictError();
  if (!["awake", "sleeping"].includes(lifecycle) || at < state.updatedAt) throw new Error("Invalid core lifecycle transition");
  if (state.lifecycle === lifecycle) return structuredClone(state);
  if (!Number.isSafeInteger(state.revision + 1)) throw new Error("Core revision overflow");
  const next: SubjectState = { ...structuredClone(state), revision: state.revision + 1, lifecycle, updatedAt: at };
  assertSubjectState(next);
  return next;
}
