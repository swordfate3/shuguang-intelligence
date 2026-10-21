export type MemoryOrigin =
  | "observation" | "user_statement" | "document" | "inference" | "imagination";

export interface MemoryRecord {
  readonly id: string;
  readonly kind: "episode" | "knowledge" | "method" | "relationship" | "preference";
  readonly content: string;
  readonly origin: MemoryOrigin;
  readonly status: "candidate" | "usable" | "disputed" | "retracted";
  readonly scopeId: string;
  readonly sourceIds: readonly string[];
  readonly supersedesIds: readonly string[];
  readonly createdAt: string;
}

/** Ports must enforce scope and exclude retracted entries by default. */
export interface MemoryRepository {
  recall(query: { readonly text: string; readonly scopeId: string; readonly limit: number },
    signal: AbortSignal): Promise<readonly MemoryRecord[]>;
}
