import { resolveEvidence } from "./experience.ts";
import type { Experience } from "./experience.ts";

/** Resolve through derivative records so rephrasing an old event does not create new evidence. */
export function evidenceRoots(evidenceIds: readonly string[], experiences: readonly Experience[],
  subjectId: string, scopeId: string, at: string): readonly string[] {
  const selected = resolveEvidence(evidenceIds, experiences, subjectId, scopeId, at);
  const index = new Map(experiences.map(e => [e.id, e]));
  const roots = new Set<string>();
  const visited = new Set<string>();
  const visit = (e: Experience): void => {
    if (visited.has(e.id)) return;
    visited.add(e.id);
    if (!e.sourceIds.length) roots.add(e.id);
    else for (const id of e.sourceIds) visit(index.get(id)!);
  };
  selected.forEach(visit);
  return [...roots].sort();
}
