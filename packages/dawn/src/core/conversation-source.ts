import { assertData, id, list, object, text, timestamp } from "./guards.ts";

export interface ConversationFragment {
  readonly entryId: string;
  readonly parentEntryId: string | null;
  readonly textBlockIndex: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly sourceTimestamp: string;
}
export interface ConversationBatch {
  readonly version: 1;
  readonly batchId: string;
  readonly sessionId: string;
  readonly leafEntryId: string;
  readonly fragments: readonly ConversationFragment[];
}
/** Exact immutable text blocks, no model-authored roles or arbitrary CycleInput. */
export function assertConversationBatch(value: unknown): asserts value is ConversationBatch {
  assertData(value);
  const batch = object(value, ["version", "batchId", "sessionId", "leafEntryId", "fragments"]);
  if (batch.version !== 1) throw new Error("Unsupported conversation batch");
  id(batch.batchId); id(batch.sessionId); id(batch.leafEntryId);
  list(batch.fragments, 16);
  if (!batch.fragments.length) throw new Error("Empty conversation batch");
  const seen = new Set<string>();
  for (const item of batch.fragments) {
    const f = object(item, ["entryId", "parentEntryId", "textBlockIndex", "role", "text", "sourceTimestamp"]);
    id(f.entryId); if (f.parentEntryId !== null) id(f.parentEntryId);
    if (!Number.isSafeInteger(f.textBlockIndex) || (f.textBlockIndex as number) < 0 || (f.textBlockIndex as number) > 1023 ||
        (f.role !== "user" && f.role !== "assistant")) throw new Error("Invalid conversation fragment");
    text(f.text, 4000); timestamp(f.sourceTimestamp);
    const key = `${f.entryId}:${f.textBlockIndex}`;
    if (seen.has(key)) throw new Error("Duplicate conversation fragment");
    seen.add(key);
  }
}
