import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SharedBatch } from "./sharing.ts";
import { assertResearchClaim, assertResearchPlan, assertResearchReceipt, assertResearchStatus, isResearchStatus,
  type ResearchClaim, type ResearchPlan, type ResearchReceipt, type ResearchStatus, type ResearchTaskSummary } from "./research.ts";

export type HostRequest = { readonly version: 1; readonly requestId: string } & (
  | { readonly type: "pair" }
  | { readonly type: "status" }
  | { readonly type: "authorize"; readonly batch: SharedBatch; readonly expiresAt: string }
  | { readonly type: "accept"; readonly batch: SharedBatch; readonly grantId: string }
  | { readonly type: "consume"; readonly batchId: string; readonly grantId: string }
  | { readonly type: "import-status"; readonly batchId: string }
  | { readonly type: "revoke"; readonly grantId: string }
  | { readonly type: "research-start"; readonly plan: ResearchPlan }
  | { readonly type: "research-status" | "research-next" | "research-step" | "research-stop" | "research-resume" | "research-pause"; readonly runId: string }
  | { readonly type: "research-claim"; readonly taskId: string; readonly expectedRevision: number }
  | { readonly type: "research-submit"; readonly receipt: ResearchReceipt }
);
export type HostResponse = { readonly version: 1; readonly requestId: string } & (
  | { readonly type: "status"; readonly subjectId: string; readonly scopeId: string; readonly revision: number; readonly lifecycle: "awake" | "sleeping"; readonly supported: boolean; readonly researchSupported?: boolean }
  | { readonly type: "grant"; readonly grant: { readonly grantId: string; readonly batchId: string; readonly batchHash: string; readonly bindingId: string; readonly status: "active" | "revoked"; readonly expiresAt: string } }
  | { readonly type: "import"; readonly result: { readonly batchId: string; readonly status: "accepted" | "consumed"; readonly newSources: number; readonly revision: number } | null }
  | { readonly type: "revoked" }
  | { readonly type: "research"; readonly status: ResearchStatus }
  | { readonly type: "research-task"; readonly task: ResearchTaskSummary | null }
  | { readonly type: "research-claim"; readonly claim: ResearchClaim }
  | { readonly type: "error"; readonly code: "UNAUTHORIZED" | "UNAVAILABLE" | "INVALID_REQUEST" | "UNSUPPORTED" }
);

const MAX_FRAME_BYTES = 64 * 1024;
// Eight bounded receipts can exceed the former 256KiB session cap. Still fixed and finite.
const MAX_TOTAL_INPUT_BYTES = 1024 * 1024;
const MAX_TOTAL_OUTPUT_BYTES = 1024 * 1024;
const MAX_SESSION_FRAMES = 2048;
const MAX_STDERR_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 2_000;
const ERROR = "曙光私有桥不可用；未能完成会话共享。";

type Spawn = typeof spawn;
interface Pending {
  readonly requestId: string;
  readonly requestType: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly resolve: (response: HostResponse) => void;
  readonly reject: (error: Error) => void;
}

export type HostRequestInput = HostRequest extends infer R ? R extends HostRequest
  ? R["type"] extends "pair" ? never : Omit<R, "version" | "requestId">
  : never : never;
export interface HostClient {
  /** Any EOF/error/explicit close invalidates execution authority, including during provider IO. */
  readonly signal: AbortSignal;
  request(request: HostRequestInput, signal?: AbortSignal): Promise<HostResponse>;
  close(): void;
}

function fixedError(): Error { return new Error(ERROR); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function validBatch(value: unknown): value is SharedBatch {
  if (!isRecord(value) || !exactKeys(value, ["version", "batchId", "sessionId", "leafEntryId", "fragments"]) ||
      value.version !== 1 || typeof value.batchId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.batchId) ||
      typeof value.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.sessionId) ||
      typeof value.leafEntryId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.leafEntryId) ||
      !Array.isArray(value.fragments) || value.fragments.length < 1 || value.fragments.length > 16) return false;
  const seen = new Set<string>();
  for (const fragment of value.fragments) {
    if (!isRecord(fragment) || !exactKeys(fragment, ["entryId", "parentEntryId", "textBlockIndex", "role", "text", "sourceTimestamp"]) ||
        typeof fragment.entryId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(fragment.entryId) ||
        !(fragment.parentEntryId === null || (typeof fragment.parentEntryId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(fragment.parentEntryId))) ||
        !Number.isSafeInteger(fragment.textBlockIndex) || (fragment.textBlockIndex as number) < 0 || (fragment.textBlockIndex as number) > 1023 ||
        (fragment.role !== "user" && fragment.role !== "assistant") || typeof fragment.text !== "string" ||
        fragment.text.length < 1 || fragment.text.length > 4000 || typeof fragment.sourceTimestamp !== "string" ||
        !Number.isFinite(Date.parse(fragment.sourceTimestamp))) return false;
    const key = `${fragment.entryId}:${fragment.textBlockIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= 24 * 1024;
}
function validRequestInput(value: unknown): value is HostRequestInput {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "status": return exactKeys(value, ["type"]);
    case "authorize": return exactKeys(value, ["type", "batch", "expiresAt"]) && validBatch(value.batch) &&
      typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt));
    case "accept": return exactKeys(value, ["type", "batch", "grantId"]) && validBatch(value.batch) &&
      typeof value.grantId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.grantId);
    case "consume": return exactKeys(value, ["type", "batchId", "grantId"]) &&
      typeof value.batchId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.batchId) &&
      typeof value.grantId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.grantId);
    case "import-status": return exactKeys(value, ["type", "batchId"]) &&
      typeof value.batchId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.batchId);
    case "revoke": return exactKeys(value, ["type", "grantId"]) &&
      typeof value.grantId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.grantId);
    case "research-start": return exactKeys(value, ["type", "plan"]) && validResearchPlan(value.plan);
    case "research-status": case "research-next": case "research-step": case "research-stop": case "research-resume": case "research-pause":
      return exactKeys(value, ["type", "runId"]) && typeof value.runId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.runId);
    case "research-claim": return exactKeys(value, ["type", "taskId", "expectedRevision"]) &&
      typeof value.taskId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.taskId) && Number.isSafeInteger(value.expectedRevision) && (value.expectedRevision as number) >= 0;
    case "research-submit": return exactKeys(value, ["type", "receipt"]) && validResearchReceipt(value.receipt);
    default: return false;
  }
}
function validResearchPlan(value: unknown): value is ResearchPlan {
  try { assertResearchPlan(value); return true; } catch { return false; }
}
function validResearchReceipt(value: unknown): value is ResearchReceipt {
  try { assertResearchReceipt(value); return true; } catch { return false; }
}
function isResearchTask(value: unknown): value is ResearchTaskSummary {
  return isRecord(value) && exactKeys(value, ["runId", "taskId", "goalId", "revision", "capability", "status"]) &&
    typeof value.runId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.runId) &&
    typeof value.taskId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.taskId) &&
    typeof value.goalId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.goalId) &&
    Number.isSafeInteger(value.revision) && (value.revision as number) >= 0 && value.capability === "web.search" &&
    ["queued", "claimed", "accepted", "completed", "failed", "unknown"].includes(String(value.status));
}
function expectedResponseType(type: string): HostResponse["type"] {
  switch (type) {
    case "status": return "status";
    case "authorize": return "grant";
    case "revoke": return "revoked";
    case "accept": case "consume": case "import-status": return "import";
    case "research-next": return "research-task";
    case "research-claim": return "research-claim";
    case "research-start": case "research-status": case "research-step": case "research-submit":
    case "research-stop": case "research-resume": case "research-pause": return "research";
    default: return "error";
  }
}
function validResponse(value: unknown): value is HostResponse {
  if (!isRecord(value) || value.version !== 1 || typeof value.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(value.requestId) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "status": return exactKeys(value, ["version", "requestId", "type", "subjectId", "scopeId", "revision", "lifecycle", "supported",
      ...(Object.hasOwn(value, "researchSupported") ? ["researchSupported"] : [])]) &&
      typeof value.subjectId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.subjectId) &&
      typeof value.scopeId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.scopeId) &&
      Number.isSafeInteger(value.revision) && (value.lifecycle === "awake" || value.lifecycle === "sleeping") && typeof value.supported === "boolean" &&
      (!Object.hasOwn(value, "researchSupported") || typeof value.researchSupported === "boolean");
    case "grant": {
      if (!exactKeys(value, ["version", "requestId", "type", "grant"]) || !isRecord(value.grant)) return false;
      const grant = value.grant;
      return exactKeys(grant, ["grantId", "batchId", "batchHash", "bindingId", "status", "expiresAt"]) &&
        typeof grant.grantId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(grant.grantId) &&
        typeof grant.batchId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(grant.batchId) &&
        typeof grant.bindingId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(grant.bindingId) &&
        typeof grant.batchHash === "string" && /^[a-f0-9]{64}$/u.test(grant.batchHash) &&
        (grant.status === "active" || grant.status === "revoked") && typeof grant.expiresAt === "string" &&
        Number.isFinite(Date.parse(grant.expiresAt));
    }
    case "import": {
      if (!exactKeys(value, ["version", "requestId", "type", "result"])) return false;
      if (value.result === null) return true;
      if (!isRecord(value.result)) return false;
      const result = value.result;
      return exactKeys(result, ["batchId", "status", "newSources", "revision"]) &&
        typeof result.batchId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(result.batchId) &&
        (result.status === "accepted" || result.status === "consumed") &&
        Number.isSafeInteger(result.newSources) && (result.newSources as number) >= 0 &&
        Number.isSafeInteger(result.revision) && (result.revision as number) >= 0;
    }
    case "revoked": return exactKeys(value, ["version", "requestId", "type"]);
    case "research": return exactKeys(value, ["version", "requestId", "type", "status"]) && isResearchStatus(value.status);
    case "research-task": return exactKeys(value, ["version", "requestId", "type", "task"]) &&
      (value.task === null || isResearchTask(value.task));
    case "research-claim": {
      if (!exactKeys(value, ["version", "requestId", "type", "claim"])) return false;
      try { assertResearchClaim(value.claim); return true; } catch { return false; }
    }
    case "error": return exactKeys(value, ["version", "requestId", "type", "code"]) &&
      ["UNAUTHORIZED", "UNAVAILABLE", "INVALID_REQUEST", "UNSUPPORTED"].includes(String(value.code));
    // The pair response includes executorToken and is never permitted across the Pi boundary.
    default: return false;
  }
}

/** Bounded UTF-8 JSONL client. It never retries or returns pairing secrets to the caller. */
export function createHostClient(command: string, args: readonly string[], options: {
  readonly spawnProcess?: Spawn;
  readonly signal?: AbortSignal;
  /** Internal bounded timing seam for deterministic tests; production defaults remain fixed. */
  readonly requestTimeoutMs?: number;
  readonly killGraceMs?: number;
} = {}): HostClient {
  const spawnProcess = options.spawnProcess ?? spawn;
  const requestTimeoutMs = Number.isSafeInteger(options.requestTimeoutMs) && options.requestTimeoutMs! > 0 && options.requestTimeoutMs! <= REQUEST_TIMEOUT_MS
    ? options.requestTimeoutMs! : REQUEST_TIMEOUT_MS;
  const killGraceMs = Number.isSafeInteger(options.killGraceMs) && options.killGraceMs! >= 0 && options.killGraceMs! <= KILL_GRACE_MS
    ? options.killGraceMs! : KILL_GRACE_MS;
  const lifecycle = new AbortController();
  const child = spawnProcess(command, [...args], { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBytes = 0;
  let totalOutputBytes = 0;
  let totalInputBytes = 0;
  let closed = false;
  let childExited = false;
  let terminationStarted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let frameCount = 0;
  const pending = new Map<string, Pending>();

  const settle = (entry: Pending, error: Error | undefined, response?: HostResponse): void => {
    if (pending.get(entry.requestId) !== entry) return;
    pending.delete(entry.requestId);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.abort);
    if (error) entry.reject(error);
    else entry.resolve(response!);
  };
  const terminate = (): void => {
    if (terminationStarted || childExited) return;
    terminationStarted = true;
    try { child.stdin.destroy(); } catch { /* fixed failure */ }
    try { child.kill("SIGTERM"); } catch { /* bounded fallback below */ }
    killTimer = setTimeout(() => {
      killTimer = undefined;
      if (!childExited) {
        try { child.kill("SIGKILL"); } catch { /* already unavailable */ }
      }
    }, killGraceMs);
    killTimer.unref?.();
  };
  const fail = (): void => {
    if (closed) return;
    closed = true;
    lifecycle.abort();
    options.signal?.removeEventListener("abort", fail);
    for (const entry of [...pending.values()]) settle(entry, fixedError());
    terminate();
  };
  const onClosed = (): void => {
    childExited = true;
    if (killTimer) clearTimeout(killTimer);
    killTimer = undefined;
    fail();
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
    if (closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalOutputBytes += bytes.byteLength;
    if (totalOutputBytes > MAX_TOTAL_OUTPUT_BYTES) { fail(); return; }
    stdoutBuffer = Buffer.concat([stdoutBuffer, bytes]);
    if (stdoutBuffer.length > MAX_FRAME_BYTES && !stdoutBuffer.includes(0x0a)) { fail(); return; }
    for (;;) {
      const newline = stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const frame = stdoutBuffer.subarray(0, newline);
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      if (frame.length === 0 || frame.length > MAX_FRAME_BYTES || ++frameCount > MAX_SESSION_FRAMES) { fail(); return; }
      let decoded: unknown;
      try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)); }
      catch { fail(); return; }
      if (!validResponse(decoded)) { fail(); return; }
      const entry = pending.get(decoded.requestId);
      if (!entry || (decoded.type !== "error" && decoded.type !== expectedResponseType(entry.requestType))) {
        fail(); return;
      }
      settle(entry, undefined, decoded);
    }
    if (stdoutBuffer.length > MAX_FRAME_BYTES) fail();
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    // Always drain, but bound total discarded diagnostics and never expose their contents.
    stderrBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
    if (stderrBytes > MAX_STDERR_BYTES) fail();
  });
  // Each stream and the process can emit errors independently; prevent uncaught EventEmitter errors.
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  child.stdout.on("end", fail);
  child.stdout.on("close", fail);
  child.stderr.on("error", fail);
  child.on("error", fail);
  child.on("close", onClosed);
  child.on("exit", () => {
    childExited = true;
    fail();
    if (killTimer) clearTimeout(killTimer);
    killTimer = undefined;
  });
  if (options.signal) {
    if (options.signal.aborted) fail();
    else options.signal.addEventListener("abort", fail, { once: true });
  }

  return {
    signal: lifecycle.signal,
    request(request, signal) {
      if (closed || options.signal?.aborted || signal?.aborted || pending.size !== 0 || !validRequestInput(request)) return Promise.reject(fixedError());
      let frame: Buffer;
      let requestId: string;
      let requestType: string;
      try {
        // Normalize through JSON before adding protocol-owned fields; never serialize caller getters/prototypes twice.
        const normalized: unknown = JSON.parse(JSON.stringify(request));
        if (!validRequestInput(normalized)) return Promise.reject(fixedError());
        requestId = randomUUID();
        requestType = normalized.type;
        frame = Buffer.from(`${JSON.stringify({ version: 1, requestId, ...normalized })}\n`, "utf8");
      } catch { return Promise.reject(fixedError()); }
      if (frame.byteLength - 1 > MAX_FRAME_BYTES || totalInputBytes + frame.byteLength > MAX_TOTAL_INPUT_BYTES) return Promise.reject(fixedError());
      totalInputBytes += frame.byteLength;
      return new Promise<HostResponse>((resolve, reject) => {
        const requestSignal = signal ?? options.signal ?? new AbortController().signal;
        const abort = (): void => fail();
        const timer = setTimeout(() => fail(), requestTimeoutMs);
        const entry: Pending = { requestId, requestType, timer, signal: requestSignal, abort, resolve, reject };
        pending.set(requestId, entry);
        requestSignal.addEventListener("abort", abort, { once: true });
        try { child.stdin.write(frame, (error?: Error | null) => { if (error) fail(); }); }
        catch { fail(); }
      });
    },
    close: fail,
  };
}
