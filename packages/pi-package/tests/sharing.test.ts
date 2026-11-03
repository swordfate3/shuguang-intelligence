import assert from "node:assert/strict";
import test from "node:test";
import { buildSharedBatch, MAX_BATCH_BYTES, MAX_FRAGMENT_CODE_UNITS } from "../src/sharing.ts";

const timestamp = "2026-01-02T03:04:05.000Z";
function user(id: string, text: string, parentId: string | null = null): unknown {
  return { type: "message", id, parentId, timestamp, message: { role: "user", content: text } };
}
function assistant(id: string, content: unknown, parentId: string | null = null): unknown {
  return { type: "message", id, parentId, timestamp, message: { role: "assistant", content } };
}

test("extracts user strings and assistant text blocks in original branch order", () => {
  const batch = buildSharedBatch("session_1", "entry_3", [
    user("entry_1", "  user statement  "),
    assistant("entry_2", [{ type: "thinking", thinking: "private" }, { type: "text", text: "assistant text" },
      { type: "toolCall", name: "synthetic-tool", arguments: { secret: true } }, { type: "text", text: "second block" }], "entry_1"),
    { type: "message", id: "entry_3", parentId: "entry_2", timestamp, message: { role: "assistant", blocks: [{ type: "text", text: "compat block" }] } },
  ], 16, "batch_1");
  assert.deepEqual(batch.fragments.map(({ entryId, parentEntryId, textBlockIndex, role, text }) =>
    ({ entryId, parentEntryId, textBlockIndex, role, text })), [
    { entryId: "entry_1", parentEntryId: null, textBlockIndex: 0, role: "user", text: "  user statement  " },
    { entryId: "entry_2", parentEntryId: "entry_1", textBlockIndex: 1, role: "assistant", text: "assistant text" },
    { entryId: "entry_2", parentEntryId: "entry_1", textBlockIndex: 3, role: "assistant", text: "second block" },
    { entryId: "entry_3", parentEntryId: "entry_2", textBlockIndex: 0, role: "assistant", text: "compat block" },
  ]);
  assert.ok(Object.isFrozen(batch));
  assert.ok(Object.isFrozen(batch.fragments));
  assert.ok(Object.isFrozen(batch.fragments[0]));
  assert.equal(batch.fragments[0]?.sourceTimestamp, timestamp);
});

test("excludes thinking, tool/custom/system/compaction entries, attachments, and empty text", () => {
  const branch: unknown[] = [
    { type: "message", id: "thinking", parentId: null, timestamp, message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }] } },
    { type: "message", id: "toolcall", parentId: "thinking", timestamp, message: { role: "assistant", content: [{ type: "toolCall", name: "x" }] } },
    { type: "message", id: "toolresult", parentId: "toolcall", timestamp, message: { role: "toolResult", content: "tool output" } },
    { type: "custom_message", id: "custom", parentId: "toolresult", timestamp, message: { role: "user", content: "custom" } },
    { type: "message", id: "system", parentId: "custom", timestamp, message: { role: "system", content: "system prompt" } },
    { type: "compaction", id: "compact", parentId: "system", timestamp, message: { role: "assistant", content: "summary" } },
    { type: "message", id: "attachment", parentId: "compact", timestamp, message: { role: "user", content: [{ type: "image", data: "synthetic" }] } },
    user("blank", " \n\t "),
  ];
  assert.throws(() => buildSharedBatch("session_1", "blank", branch, 16, "batch_1"), /empty share selection/);
  assert.throws(() => buildSharedBatch("session_1", "blank", [user("blank", " \n")], 16, "batch_1"), /empty share selection/);
});

test("selects latest N text blocks and keeps branch order", () => {
  const batch = buildSharedBatch("session_1", "entry_5", [user("entry_1", "one"), user("entry_2", "two"),
    assistant("entry_3", [{ type: "text", text: "three-a" }, { type: "text", text: "three-b" }]),
    user("entry_4", "four"), assistant("entry_5", [{ type: "text", text: "five" }])], 3, "batch_1");
  assert.deepEqual(batch.fragments.map(fragment => fragment.text), ["three-b", "four", "five"]);
  assert.deepEqual(batch.fragments.map(fragment => fragment.entryId), ["entry_3", "entry_4", "entry_5"]);
});

test("rejects malformed IDs, counts, timestamps, duplicate selected fragments, and oversized fragments", () => {
  assert.throws(() => buildSharedBatch("bad id", "leaf", [user("entry", "x")], 1, "batch_1"));
  assert.throws(() => buildSharedBatch("session", "leaf", [user("entry", "x")], 0, "batch_1"));
  assert.throws(() => buildSharedBatch("session", "leaf", [user("entry", "x")], 1.5, "batch_1"));
  assert.throws(() => buildSharedBatch("session", "leaf", [user("entry", "x")], 17, "batch_1"));
  assert.throws(() => buildSharedBatch("session", "leaf", [{ ...user("entry", "x") as object, timestamp: "invalid" }], 1, "batch_1"));
  assert.throws(() => buildSharedBatch("session", "leaf", [user("entry", "x"), assistant("entry", [{ type: "text", text: "duplicate" }])], 2, "batch_1"), /duplicate/);
  assert.throws(() => buildSharedBatch("session", "leaf", [user("entry", "x".repeat(MAX_FRAGMENT_CODE_UNITS + 1))], 1, "batch_1"), /fragment too large/);
  assert.throws(() => buildSharedBatch("session", "leaf", [user("entry", "x")], 1, "invalid batch id!"));
});

test("enforces the exact 24KiB serialized UTF-8 batch ceiling", () => {
  const entries = Array.from({ length: 8 }, (_, index) => user(`entry_${index}`, "a"));
  const baseline = buildSharedBatch("session_1", "entry_7", entries, 16, "batch_1");
  const baseBytes = Buffer.byteLength(JSON.stringify(baseline), "utf8");
  let remaining = MAX_BATCH_BYTES - baseBytes;
  const sizes = Array<number>(8).fill(1);
  for (let index = 0; index < sizes.length && remaining > 0; index += 1) {
    const extra = Math.min(MAX_FRAGMENT_CODE_UNITS - 1, remaining);
    sizes[index] = sizes[index]! + extra;
    remaining -= extra;
  }
  assert.equal(remaining, 0);
  const exactEntries = sizes.map((size, index) => user(`entry_${index}`, "x".repeat(size)));
  const exact = buildSharedBatch("session_1", "entry_7", exactEntries, 16, "batch_1");
  assert.equal(Buffer.byteLength(JSON.stringify(exact), "utf8"), MAX_BATCH_BYTES);
  const over = exactEntries.map((entry, index) => index === 7 ? user("entry_7", "x".repeat(sizes[index]! + 1)) : entry);
  assert.throws(() => buildSharedBatch("session_1", "entry_7", over, 16, "batch_1"), /batch too large/);
  const unicode = buildSharedBatch("session_1", "entry_7", [user("entry_7", "界")], 1, "batch_1");
  const ascii = buildSharedBatch("session_1", "entry_7", [user("entry_7", "a")], 1, "batch_1");
  assert.ok(Buffer.byteLength(JSON.stringify(unicode), "utf8") > Buffer.byteLength(JSON.stringify(ascii), "utf8"));
});
