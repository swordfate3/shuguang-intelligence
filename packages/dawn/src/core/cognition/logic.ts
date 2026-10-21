import { assertExperience, resolveEvidence, type Experience } from "../experience.ts";
import { assertData, choice, id, ids, list, object, text, timestamp, unit } from "../guards.ts";
import { assertMemoryRecord } from "../memory/logic.ts";
import type { MemoryRecord } from "../memory/types.ts";
import type { CognitionState, Workspace, WorldBelief } from "./types.ts";

function assertBelief(value: unknown): asserts value is WorldBelief {
  assertData(value);
  const b = object(value, ["id", "statement", "origin", "evidenceIds", "confidence", "status", "supersedesIds", "updatedAt"]);
  id(b.id); text(b.statement);
  choice(b.origin, ["user_statement", "observation", "document", "inference", "imagination"]);
  ids(b.evidenceIds, 32); ids(b.supersedesIds, 32);
  if (b.evidenceIds.length === 0) throw new Error("Belief evidence required");
  unit(b.confidence); // A bounded annotation, NOT a calibrated probability of truth.
  choice(b.status, ["tentative", "supported", "disputed", "retracted"]);
  timestamp(b.updatedAt);
  if (b.supersedesIds.includes(b.id)) throw new Error("Self-replacing belief");
  if (b.origin === "inference" && b.status !== "tentative" && b.status !== "retracted") throw new Error("Inference must remain tentative");
  if (b.status === "supported" && (b.origin === "inference" || b.origin === "imagination")) {
    throw new Error("Unsupported belief provenance");
  }
}

/** CognitionState is owned by one subject/scope; its schema contains no per-belief scope. */
export function assertCognition(state: unknown): asserts state is CognitionState {
  assertData(state);
  const s = object(state, ["beliefs"]);
  list(s.beliefs); s.beliefs.forEach(assertBelief);
  const beliefs = s.beliefs as WorldBelief[];
  ids(beliefs.map(b => b.id));
  const index = new Map(beliefs.map(b => [b.id, b]));
  for (const belief of beliefs) {
    for (const previousId of belief.supersedesIds) {
      const previous = index.get(previousId);
      if (!previous || previous.status !== "retracted" || Date.parse(previous.updatedAt) > Date.parse(belief.updatedAt)) {
        throw new Error("Invalid belief replacement history");
      }
    }
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  function visit(belief: WorldBelief): void {
    if (visiting.has(belief.id)) throw new Error("Cyclic belief replacement");
    if (visited.has(belief.id)) return;
    visiting.add(belief.id);
    for (const previousId of belief.supersedesIds) visit(index.get(previousId)!);
    visiting.delete(belief.id); visited.add(belief.id);
  }
  beliefs.forEach(visit);
}

/** Ephemeral IDs/topics only; no generated candidates, explanations or saved reasoning. */
export function buildWorkspace(state: CognitionState, experience: Experience, memories: readonly MemoryRecord[]): Workspace {
  assertData({ state, experience, memories });
  assertCognition(state); assertExperience(experience);
  list(memories); memories.forEach(assertMemoryRecord); ids(memories.map(m => m.id));
  const topics = new Set(experience.topics.map(topic => topic.toLowerCase().trim()));
  const terms = [...new Set(experience.content.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(term => term.length >= 2))];
  const matchesText = (content: string): boolean => {
    const normalized = content.toLowerCase();
    return [...topics].some(topic => normalized.includes(topic)) || terms.some(term => normalized.includes(term));
  };
  const now = Date.parse(experience.recordedAt);
  const beliefs = state.beliefs.filter(b => b.status !== "retracted" && Date.parse(b.updatedAt) <= now && matchesText(b.statement));
  const relevantMemories = memories.filter(m => m.status !== "retracted" && m.subjectId === experience.subjectId && m.scopeId === experience.scopeId
    && Date.parse(m.createdAt) <= now && (m.topics.some(topic => topics.has(topic.toLowerCase().trim())) || matchesText(m.content)));
  // Stable lexical ordering makes assembly independent of storage ordering.
  return {
    experienceId: experience.id, topics: [...experience.topics],
    relevantMemoryIds: relevantMemories.map(m => m.id).sort(), relevantBeliefIds: beliefs.map(b => b.id).sort(),
    uncertainties: [...beliefs.filter(b => b.status === "tentative" || b.status === "disputed").map(b => b.id),
      ...relevantMemories.filter(m => m.status === "candidate" || m.status === "disputed").map(m => m.id)]
      .filter((value, index, all) => all.indexOf(value) === index).sort(),
  };
}

export function reviseBelief(state: CognitionState, belief: WorldBelief, experiences: readonly Experience[],
  subjectId: string, scopeId: string, at: string): CognitionState {
  assertData({ state, belief, experiences, subjectId, scopeId, at });
  assertCognition(state); assertBelief(belief);
  id(subjectId); id(scopeId); timestamp(at);
  list(experiences); experiences.forEach(assertExperience); ids(experiences.map(e => e.id));
  if (belief.updatedAt !== at) throw new Error("Belief revision time mismatch");
  if (state.beliefs.some(b => b.id === belief.id)) throw new Error("Duplicate belief identifier");
  const evidence = resolveEvidence(belief.evidenceIds, experiences, subjectId, scopeId, at);
  if (evidence.some(e => Date.parse(e.recordedAt) > Date.parse(at))) throw new Error("Future belief evidence");
  if (!evidence.some(e => e.origin === belief.origin)) throw new Error("Belief origin does not match evidence");
  if (belief.status === "supported" && !evidence.some(e => e.origin === "document" || e.origin === "observation")) {
    throw new Error("Supported belief requires non-speculative evidence");
  }
  // Source resolution is a provenance check, NOT a verification that the statement is true.
  for (const previousId of belief.supersedesIds) {
    const previous = state.beliefs.find(b => b.id === previousId);
    if (!previous || Date.parse(previous.updatedAt) > Date.parse(at)) throw new Error("Unavailable belief replacement target");
  }
  const next: CognitionState = structuredClone({ beliefs: [
    ...state.beliefs.map(previous => belief.supersedesIds.includes(previous.id) ? { ...previous, status: "retracted" as const } : previous), belief,
  ] });
  assertCognition(next);
  return next;
}
