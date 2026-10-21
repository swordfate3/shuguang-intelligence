import assert from "node:assert/strict";
import test from "node:test";
import { assertDawnRequest, assertDawnResponse } from "../src/protocol/index.ts";

const base = { version: 1, requestId: "request-1" };
test("protocol validates exact request and response envelopes", () => {
  for (const value of [
    { ...base, type: "status" }, { ...base, type: "wake", expectedRevision: 0 },
    { ...base, type: "sleep", expectedRevision: 2 }, { ...base, type: "say", text: "你好" },
  ]) assertDawnRequest(value);
  assertDawnResponse({ ...base, type: "status", lifecycle: "awake", revision: 1,
    runtime: { instanceId: "instance-1", startedAt: "2026-01-01T00:00:00.000Z", autonomy: false } });
  assertDawnResponse({ ...base, type: "error", code: "NOT_IMPLEMENTED", message: "no model" });
  assertDawnResponse({ ...base, type: "reply", text: "hello" });
});

test("protocol rejects bad fields, unsafe revisions, excessive text and unsupported metadata", () => {
  for (const value of [null, [], {}, { ...base, type: "status", extra: true },
    { ...base, version: 2, type: "status" }, { ...base, requestId: "\n", type: "status" },
    { ...base, type: "wake", expectedRevision: -1 }, { ...base, type: "wake", expectedRevision: 1.5 },
    { ...base, type: "wake", expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, type: "say", text: " " }, { ...base, type: "say", text: "x".repeat(16_001) },
  ]) assert.throws(() => assertDawnRequest(value));
  for (const value of [
    { ...base, type: "reply", text: " " }, { ...base, type: "error", code: "UNKNOWN", message: "error" },
    { ...base, type: "status", lifecycle: "awake", revision: 0 },
    { ...base, type: "status", lifecycle: "awake", revision: 0,
      runtime: { instanceId: "id", startedAt: "invalid", autonomy: false } },
    { ...base, type: "status", lifecycle: "awake", revision: 0,
      runtime: { instanceId: "id", startedAt: "2026-01-01T00:00:00.000Z", autonomy: true } },
  ]) assert.throws(() => assertDawnResponse(value));
});
