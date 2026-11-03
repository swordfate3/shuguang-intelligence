import { randomUUID } from "node:crypto";

export const MAX_SHARED_FRAGMENTS = 16;
export const MAX_FRAGMENT_CODE_UNITS = 4000;
export const MAX_BATCH_BYTES = 24 * 1024;

export interface SharedFragment {
  readonly entryId: string;
  readonly parentEntryId: string | null;
  readonly textBlockIndex: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly sourceTimestamp: string;
}

export interface SharedBatch {
  readonly version: 1;
  readonly batchId: string;
  readonly sessionId: string;
  readonly leafEntryId: string;
  readonly fragments: readonly SharedFragment[];
}

const SHAREABLE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textBlocks(message: Record<string, unknown>): Array<{ index: number; text: string }> {
  const role = message.role;
  const content = message.content;
  if (role === "user" && typeof content === "string") return content.trim() ? [{ index: 0, text: content }] : [];

  // Current Pi assistant messages use content[]. Some compatible hosts expose blocks[].
  const blocks = role === "assistant" && Array.isArray(message.blocks)
    ? message.blocks
    : Array.isArray(content) ? content : [];
  const result: Array<{ index: number; text: string }> = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block: unknown = blocks[index];
    if (record(block) && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      result.push({ index, text: block.text });
    }
  }
  return result;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid share timestamp");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("invalid share timestamp");
  return new Date(milliseconds).toISOString();
}

function collectTextFragments(branch: readonly unknown[]): Array<Omit<SharedFragment, "sourceTimestamp"> & { readonly rawTimestamp: unknown }> {
  const fragments: Array<Omit<SharedFragment, "sourceTimestamp"> & { readonly rawTimestamp: unknown }> = [];
  for (const candidate of branch) {
    if (!record(candidate) || candidate.type !== "message" || !record(candidate.message)) continue;
    const role = candidate.message.role;
    if (role !== "user" && role !== "assistant") continue;
    for (const block of textBlocks(candidate.message)) {
      fragments.push({
        entryId: candidate.id as string,
        parentEntryId: candidate.parentId as string | null,
        textBlockIndex: block.index,
        role,
        text: block.text,
        rawTimestamp: candidate.timestamp,
      });
    }
  }
  return fragments;
}

/** Build an immutable snapshot from the active Pi branch; selects newest N text blocks in branch order. */
export function buildSharedBatch(
  sessionId: string,
  leafEntryId: string,
  branch: readonly unknown[],
  count: number,
  batchId: string = randomUUID(),
): SharedBatch {
  if (!SHAREABLE_ID.test(sessionId) || !SHAREABLE_ID.test(leafEntryId) || !SHAREABLE_ID.test(batchId) ||
      !Number.isSafeInteger(count) || count < 1 || count > MAX_SHARED_FRAGMENTS) {
    throw new Error("invalid share selection");
  }
  const latestRaw = collectTextFragments(branch).slice(-count);
  if (!latestRaw.length) throw new Error("empty share selection");
  const latest = latestRaw.map(fragment => {
    if (typeof fragment.entryId !== "string" || !SHAREABLE_ID.test(fragment.entryId) ||
        !(fragment.parentEntryId === null || (typeof fragment.parentEntryId === "string" && SHAREABLE_ID.test(fragment.parentEntryId))) ||
        !Number.isSafeInteger(fragment.textBlockIndex) || fragment.textBlockIndex < 0 || fragment.textBlockIndex > 1023) {
      throw new Error("invalid share metadata");
    }
    if (fragment.text.length > MAX_FRAGMENT_CODE_UNITS) throw new Error("share fragment too large");
    return {
      entryId: fragment.entryId,
      parentEntryId: fragment.parentEntryId,
      textBlockIndex: fragment.textBlockIndex,
      role: fragment.role,
      text: fragment.text,
      sourceTimestamp: canonicalTimestamp(fragment.rawTimestamp),
    } satisfies SharedFragment;
  });
  if (new Set(latest.map(({ entryId, textBlockIndex }) => `${entryId}:${textBlockIndex}`)).size !== latest.length) {
    throw new Error("duplicate share fragment");
  }
  const fragments = latest.map(fragment => Object.freeze(fragment));
  const batch: SharedBatch = Object.freeze({ version: 1, batchId, sessionId, leafEntryId, fragments: Object.freeze(fragments) });
  if (Buffer.byteLength(JSON.stringify(batch), "utf8") > MAX_BATCH_BYTES) throw new Error("share batch too large");
  return batch;
}
