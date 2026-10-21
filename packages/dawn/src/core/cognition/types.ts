export interface WorldBelief {
  readonly id: string;
  readonly statement: string;
  readonly origin: "user_statement" | "observation" | "document" | "inference" | "imagination";
  readonly evidenceIds: readonly string[];
  readonly confidence: number;
  readonly status: "tentative" | "supported" | "disputed" | "retracted";
  readonly supersedesIds: readonly string[];
  readonly updatedAt: string;
}
export interface CognitionState { readonly beliefs: readonly WorldBelief[] }
/** Ephemeral input to deliberation, not a saved chain of thought or extra personality. */
export interface Workspace {
  readonly experienceId: string;
  readonly topics: readonly string[];
  readonly relevantMemoryIds: readonly string[];
  readonly relevantBeliefIds: readonly string[];
  readonly uncertainties: readonly string[];
}
