import { isModelId, isThinkingLevel, THINKING_LEVELS, type ModelSelectionState, type ThinkingLevel } from "./model-controls.ts";

/** Side-effect-free v1 contract shared by the independent service and clients. */
export const PROTOCOL_VERSION = 1 as const;
export const MAX_WIRE_BYTES = 64 * 1024;
export const MAX_MESSAGE_CHARS = 16_000;
/** Total request budgets. Model timeout is independently capped at 30s. */
export const SAY_SERVER_TIMEOUT_MS = 35_000;
export const SAY_CLIENT_TIMEOUT_MS = 40_000;
export const CONTROL_TIMEOUT_MS = 10_000;

export type DawnRequest = {
  readonly version: typeof PROTOCOL_VERSION;
  readonly requestId: string;
} & (
  | { readonly type: "status" }
  | { readonly type: "model-status" }
  /** Explicitly performs authenticated GET model discovery; this is not a cached status read. */
  | { readonly type: "model-list" }
  | { readonly type: "wake" | "sleep"; readonly expectedRevision: number }
  | { readonly type: "model-select"; readonly expectedRevision: number; readonly model: string }
  | { readonly type: "thinking-select"; readonly expectedRevision: number; readonly thinking: ThinkingLevel }
  | { readonly type: "say"; readonly text: string }
);

export type DawnResponse = {
  readonly version: typeof PROTOCOL_VERSION;
  readonly requestId: string;
} & (
  | { readonly type: "status"; readonly lifecycle: "sleeping" | "awake"; readonly revision: number;
      readonly runtime: { readonly instanceId: string; readonly startedAt: string; readonly autonomy: false } }
  | { readonly type: "reply"; readonly text: string }
  | { readonly type: "model"; readonly state: ModelSelectionState }
  | { readonly type: "error"; readonly code: "NOT_IMPLEMENTED" | "UNAVAILABLE" | "CONFLICT" | "INVALID_REQUEST";
      readonly message: string }
);

/** Transport failures throw; valid application error envelopes remain typed responses. */
export interface DawnTransport {
  request(request: DawnRequest, signal: AbortSignal): Promise<DawnResponse>;
}

export type DawnHandler = (request: DawnRequest, signal: AbortSignal) => Promise<DawnResponse>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid protocol object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error("Invalid protocol fields");
  }
}
function base(value: Record<string, unknown>): void {
  if (value.version !== PROTOCOL_VERSION || typeof value.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.requestId)) throw new Error("Invalid protocol version or correlation id");
}
function revision(value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid revision");
}
function text(value: unknown, max: number): void {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid protocol text");
}

function assertModelSelectionState(value: unknown): asserts value is ModelSelectionState {
  const state = record(value);
  keys(state, ["selectionRevision", "model", "thinking", "levels", "models", "calls", "maxCalls"]);
  revision(state.selectionRevision);
  if (!isModelId(state.model) || !isThinkingLevel(state.thinking) ||
      !Array.isArray(state.levels) || state.levels.length < 1 || state.levels.length > THINKING_LEVELS.length ||
      !Array.isArray(state.models) || state.models.length > 128 ||
      typeof state.calls !== "number" || !Number.isSafeInteger(state.calls) || state.calls < 0 ||
      typeof state.maxCalls !== "number" || !Number.isSafeInteger(state.maxCalls) || state.maxCalls < 1 ||
      state.calls > state.maxCalls) throw new Error("Invalid model selection state");
  const levels = Array.from(state.levels);
  const models = Array.from(state.models);
  if (levels.some(level => !isThinkingLevel(level)) || new Set(levels).size !== levels.length ||
      !levels.includes(state.thinking) || models.some(model => !isModelId(model)) || new Set(models).size !== models.length) {
    throw new Error("Invalid model selection state");
  }
}

/** Runtime validation is required even when callers have TypeScript types. */
export function assertDawnRequest(value: unknown): asserts value is DawnRequest {
  const request = record(value);
  base(request);
  switch (request.type) {
    case "status": case "model-status": case "model-list": keys(request, ["version", "requestId", "type"]); break;
    case "wake": case "sleep":
      keys(request, ["version", "requestId", "type", "expectedRevision"]);
      revision(request.expectedRevision); break;
    case "model-select":
      keys(request, ["version", "requestId", "type", "expectedRevision", "model"]);
      revision(request.expectedRevision);
      if (!isModelId(request.model)) throw new Error("Invalid model id");
      break;
    case "thinking-select":
      keys(request, ["version", "requestId", "type", "expectedRevision", "thinking"]);
      revision(request.expectedRevision);
      if (!isThinkingLevel(request.thinking)) throw new Error("Invalid thinking level");
      break;
    case "say":
      keys(request, ["version", "requestId", "type", "text"]);
      text(request.text, MAX_MESSAGE_CHARS); break;
    default: throw new Error("Invalid request type");
  }
}

export function assertDawnResponse(value: unknown): asserts value is DawnResponse {
  const response = record(value);
  base(response);
  switch (response.type) {
    case "status": {
      keys(response, ["version", "requestId", "type", "lifecycle", "revision", "runtime"]);
      revision(response.revision);
      if (response.lifecycle !== "awake" && response.lifecycle !== "sleeping") throw new Error("Invalid lifecycle");
      const runtime = record(response.runtime);
      keys(runtime, ["instanceId", "startedAt", "autonomy"]);
      text(runtime.instanceId, 128);
      if (runtime.autonomy !== false || typeof runtime.startedAt !== "string" ||
          !Number.isFinite(Date.parse(runtime.startedAt)) || new Date(runtime.startedAt).toISOString() !== runtime.startedAt) {
        throw new Error("Invalid runtime metadata");
      }
      break;
    }
    case "reply":
      keys(response, ["version", "requestId", "type", "text"]);
      text(response.text, MAX_MESSAGE_CHARS); break;
    case "model":
      keys(response, ["version", "requestId", "type", "state"]);
      assertModelSelectionState(response.state);
      if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_WIRE_BYTES) throw new Error("Model state exceeds wire limit");
      break;
    case "error":
      keys(response, ["version", "requestId", "type", "code", "message"]);
      if (typeof response.code !== "string" || !["NOT_IMPLEMENTED", "UNAVAILABLE", "CONFLICT", "INVALID_REQUEST"].includes(response.code)) throw new Error("Invalid error code");
      text(response.message, 256); break;
    default: throw new Error("Invalid response type");
  }
}
