import { createHash } from "node:crypto";
import { assertExperience, resolveEvidence, type Experience } from "../experience.ts";
import { assertData, choice, id, ids, integer, list, object, text, timestamp, unit } from "../guards.ts";
import type { MemoryRecord, MemoryState } from "./types.ts";

/** @internal Shared with workspace construction, which may receive a subset of memory records. */
export function assertMemoryRecord(value: unknown): asserts value is MemoryRecord {
  assertData(value);
  const r = object(value, ["id", "subjectId", "scopeId", "kind", "content", "origin", "status", "topics", "sourceIds", "supersedesIds", "importance", "createdAt"]);
  id(r.id); id(r.subjectId); id(r.scopeId);
  choice(r.kind, ["episode", "knowledge", "method", "relationship", "preference"]);
  text(r.content);
  choice(r.origin, ["user_statement", "observation", "document", "inference", "imagination"]);
  choice(r.status, ["candidate", "usable", "disputed", "retracted"]);
  list(r.topics, 12); r.topics.forEach(topic => text(topic, 128));
  if (new Set(r.topics).size !== r.topics.length) throw new Error("Duplicate memory topic");
  ids(r.sourceIds, 32); ids(r.supersedesIds, 32);
  if (r.sourceIds.length === 0) throw new Error("Memory evidence required");
  if (r.supersedesIds.includes(r.id)) throw new Error("Self-replacing memory");
  unit(r.importance); timestamp(r.createdAt);
  // A usable episode only says that an event occurred, not that its content is true.
  if (r.kind !== "episode" && r.status === "usable" && (r.origin === "inference" || r.origin === "imagination")) {
    throw new Error("Speculative memory cannot become usable knowledge");
  }
}

export function assertMemory(state: unknown): asserts state is MemoryState {
  assertData(state);
  const s = object(state, ["records"]);
  list(s.records); s.records.forEach(assertMemoryRecord);
  const records = s.records as MemoryRecord[];
  ids(records.map(r => r.id));
  const index = new Map(records.map(r => [r.id, r]));
  for (const record of records) {
    for (const previousId of record.supersedesIds) {
      const previous = index.get(previousId);
      if (!previous || previous.subjectId !== record.subjectId || previous.scopeId !== record.scopeId ||
          (record.status !== "candidate" && previous.status !== "retracted") || Date.parse(previous.createdAt) > Date.parse(record.createdAt)) {
        throw new Error("Invalid memory replacement history");
      }
    }
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  function visit(record: MemoryRecord): void {
    if (visiting.has(record.id)) throw new Error("Cyclic memory replacement");
    if (visited.has(record.id)) return;
    visiting.add(record.id);
    for (const previousId of record.supersedesIds) visit(index.get(previousId)!);
    visiting.delete(record.id); visited.add(record.id);
  }
  records.forEach(visit);
}

export function rememberExperience(state: MemoryState, experience: Experience, importance: number): MemoryState {
  assertData({ state, experience, importance });
  assertMemory(state); assertExperience(experience); unit(importance);
  const record: MemoryRecord = {
    id: `memory_${createHash("sha256").update(experience.id).digest("hex")}`, subjectId: experience.subjectId, scopeId: experience.scopeId,
    kind: "episode", content: experience.content, origin: experience.origin, status: "usable",
    topics: [...experience.topics], sourceIds: [experience.id], supersedesIds: [], importance,
    createdAt: experience.recordedAt,
  };
  if (state.records.some(r => r.id === record.id)) throw new Error("Duplicate memory identifier");
  const next = structuredClone({ records: [...state.records, record] });
  assertMemory(next);
  return next;
}

/**
 * Deterministic local heuristic, not a research-model reproduction or semantic search.
 * Relevance = 4 per exact (case-folded) topic + 1 per distinct matching text token.
 * Only positively relevant records qualify. Score = 10 * relevance + 2 * importance
 * + 1/(1 + age in days); ties use recency then ASCII ID. No clock or external I/O.
 * Token/substring matching deliberately prefers an empty result to unrelated private data.
 */
export function recallMemories(state: MemoryState, query: {
  text: string; topics: readonly string[]; subjectId: string; scopeId: string; at: string; limit: number;
}): readonly MemoryRecord[] {
  assertData({ state, query }); assertMemory(state);
  const q = object(query, ["text", "topics", "subjectId", "scopeId", "at", "limit"]);
  text(q.text); list(q.topics, 12); q.topics.forEach(topic => text(topic, 128));
  if (new Set(q.topics).size !== q.topics.length) throw new Error("Duplicate recall topic");
  id(q.subjectId); id(q.scopeId); timestamp(q.at); integer(q.limit, 0, 1000);
  const terms = [...new Set(query.text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(term => term.length >= 2))];
  const topics = new Set(query.topics.map(topic => topic.toLowerCase().trim()));
  const now = Date.parse(query.at);
  const matches = state.records.flatMap(record => {
    if (record.status !== "usable" || record.subjectId !== query.subjectId || record.scopeId !== query.scopeId || Date.parse(record.createdAt) > now) return [];
    const content = record.content.toLowerCase();
    const relevance = 4 * new Set(record.topics.map(topic => topic.toLowerCase().trim()).filter(topic => topics.has(topic))).size
      + terms.filter(term => content.includes(term)).length;
    if (relevance === 0) return [];
    const ageDays = (now - Date.parse(record.createdAt)) / 86_400_000;
    return [{ record, score: 10 * relevance + 2 * record.importance + 1 / (1 + ageDays) }];
  });
  matches.sort((a, b) => b.score - a.score || Date.parse(b.record.createdAt) - Date.parse(a.record.createdAt)
    || (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0));
  return structuredClone(matches.slice(0, query.limit).map(match => match.record));
}

export function correctMemory(state: MemoryState, record: MemoryRecord, experiences: readonly Experience[],
  subjectId: string, scopeId: string, at: string): MemoryState {
  assertData({ state, record, experiences, subjectId, scopeId, at });
  assertMemory(state); assertMemoryRecord(record);
  id(subjectId); id(scopeId); timestamp(at);
  list(experiences); experiences.forEach(assertExperience); ids(experiences.map(e => e.id));
  if (record.subjectId !== subjectId || record.scopeId !== scopeId || record.createdAt !== at) throw new Error("Invalid memory correction scope or time");
  if (state.records.some(r => r.id === record.id)) throw new Error("Duplicate memory identifier");
  // Resolve both source identity and provenance, never treating confidence or source existence as truth.
  const evidence = resolveEvidence(record.sourceIds, experiences, subjectId, scopeId, at);
  if (evidence.some(e => Date.parse(e.recordedAt) > Date.parse(at))) throw new Error("Future memory evidence");
  if (!evidence.some(e => e.origin === record.origin)) throw new Error("Memory origin does not match evidence");
  if (record.kind === "knowledge" && record.status === "usable" && !evidence.some(e => e.origin === "document" || e.origin === "observation")) {
    throw new Error("Knowledge requires non-speculative evidence");
  }
  for (const previousId of record.supersedesIds) {
    const previous = state.records.find(r => r.id === previousId);
    if (!previous || previous.subjectId !== subjectId || previous.scopeId !== scopeId || Date.parse(previous.createdAt) > Date.parse(at)) {
      throw new Error("Unavailable memory replacement target");
    }
  }
  const next: MemoryState = structuredClone({ records: [
    // A proposed replacement must not erase usable evidence before acceptance.
    ...state.records.map(previous => record.status !== "candidate" && record.supersedesIds.includes(previous.id)
      ? { ...previous, status: "retracted" as const } : previous), record,
  ] });
  assertMemory(next);
  return next;
}
