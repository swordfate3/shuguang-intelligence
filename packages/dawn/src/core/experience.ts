import { assertData, choice, id, ids, list, object, text, timestamp } from "./guards.ts";

/** An observation is a source record, never automatic proof that its text is true. */
export interface Experience {
  readonly id: string;
  readonly subjectId: string;
  readonly scopeId: string;
  readonly kind: "conversation" | "reading" | "activity_result" | "reflection";
  readonly origin: "user_statement" | "observation" | "document" | "inference" | "imagination";
  readonly content: string;
  readonly topics: readonly string[];
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly sourceIds: readonly string[];
}

export function assertExperience(value: unknown): asserts value is Experience {
  assertData(value);
  const e = object(value, ["id", "subjectId", "scopeId", "kind", "origin", "content", "topics", "occurredAt", "recordedAt", "sourceIds"]);
  id(e.id); id(e.subjectId); id(e.scopeId);
  choice(e.kind, ["conversation", "reading", "activity_result", "reflection"]);
  choice(e.origin, ["user_statement", "observation", "document", "inference", "imagination"]);
  text(e.content); list(e.topics, 12); e.topics.forEach(topic => text(topic, 128));
  if (new Set(e.topics).size !== e.topics.length) throw new Error("Duplicate experience topic");
  timestamp(e.occurredAt); timestamp(e.recordedAt);
  if (e.occurredAt > e.recordedAt) throw new Error("Future experience not observed yet");
  ids(e.sourceIds, 32);
  if (e.sourceIds.includes(e.id)) throw new Error("Self-referencing experience");
}

/** Evidence must resolve to existing records in exactly this subject/scope and not the future. */
export function resolveEvidence(evidenceIds: readonly string[], experiences: readonly Experience[],
  subjectId: string, scopeId: string, at: string): readonly Experience[] {
  assertData(evidenceIds); assertData(experiences);
  ids(evidenceIds, 1000); id(subjectId); id(scopeId); timestamp(at);
  list(experiences, 1000);
  if (evidenceIds.length === 0) throw new Error("Evidence required");
  const index = new Map<string, Experience>();
  for (const e of experiences) {
    assertExperience(e);
    if (index.has(e.id)) throw new Error("Ambiguous experience identifier");
    index.set(e.id, e);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (e: Experience): void => {
    if (visiting.has(e.id)) throw new Error("Cyclic experience evidence");
    if (visited.has(e.id)) return;
    visiting.add(e.id);
    for (const sid of e.sourceIds) {
      const source = index.get(sid);
      if (!source || source.subjectId !== e.subjectId || source.scopeId !== e.scopeId || source.recordedAt > e.recordedAt) {
        throw new Error("Invalid experience source chain");
      }
      visit(source);
    }
    visiting.delete(e.id); visited.add(e.id);
  };
  experiences.forEach(visit);
  return evidenceIds.map(eid => {
    const e = index.get(eid);
    if (!e || e.subjectId !== subjectId || e.scopeId !== scopeId || e.recordedAt > at) throw new Error("Unavailable or out-of-scope evidence");
    return e;
  });
}
