import type { Experience } from "../experience.ts";
export interface MemoryRecord {
  readonly id: string;
  readonly subjectId: string;
  readonly scopeId: string;
  readonly kind: "episode" | "knowledge" | "method" | "relationship" | "preference";
  readonly content: string;
  readonly origin: Experience["origin"];
  readonly status: "candidate" | "usable" | "disputed" | "retracted";
  readonly topics: readonly string[];
  readonly sourceIds: readonly string[];
  readonly supersedesIds: readonly string[];
  readonly importance: number;
  readonly createdAt: string;
}
export interface MemoryState { readonly records: readonly MemoryRecord[] }
