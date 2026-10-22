import type { ModelPort } from "../adapters/models/port.ts";
import { assertDawnResponse, PROTOCOL_VERSION } from "../protocol/index.ts";
import type { DawnRequest, DawnResponse } from "../protocol/index.ts";
import type { ModelSelectionState, ThinkingLevel } from "../protocol/model-controls.ts";

/** Explicit controls on the same model instance; selection never resets its call budget. */
export interface ModelControlPort extends ModelPort {
  modelState(): ModelSelectionState;
  discoverModels(signal: AbortSignal): Promise<ModelSelectionState>;
  selectModel(expectedRevision: number, model: string, signal: AbortSignal): ModelSelectionState;
  selectThinking(expectedRevision: number, thinking: ThinkingLevel, signal: AbortSignal): ModelSelectionState;
}
export class ModelSelectionConflictError extends Error {
  constructor() { super("Model selection changed; query it before selecting again."); }
}
export function supportsModelControl(model: ModelPort | undefined): model is ModelControlPort {
  const candidate = model as Partial<ModelControlPort> | undefined;
  return !!candidate && typeof candidate.modelState === "function" && typeof candidate.discoverModels === "function" &&
    typeof candidate.selectModel === "function" && typeof candidate.selectThinking === "function";
}

type ModelControlRequest =
  | { readonly version: typeof PROTOCOL_VERSION; readonly requestId: string; readonly type: "model-status" | "model-list" }
  | Extract<DawnRequest, { type: "model-select" | "thinking-select" }>;

/** Execute an already validated model-control request without involving subject state. */
export async function handleModelControl(
  model: ModelPort | undefined, request: ModelControlRequest, signal: AbortSignal,
): Promise<DawnResponse> {
  signal.throwIfAborted();
  const base = { version: PROTOCOL_VERSION, requestId: request.requestId };
  if (!supportsModelControl(model)) {
    signal.throwIfAborted();
    return { ...base, type: "error", code: "NOT_IMPLEMENTED", message: "Model controls are not configured." };
  }
  try {
    let state: ModelSelectionState;
    switch (request.type) {
      case "model-status": state = model.modelState(); break;
      case "model-list": state = await model.discoverModels(signal); break;
      case "model-select": state = model.selectModel(request.expectedRevision, request.model, signal); break;
      case "thinking-select": state = model.selectThinking(request.expectedRevision, request.thinking, signal); break;
    }
    signal.throwIfAborted();
    const response: DawnResponse = { ...base, type: "model", state };
    assertDawnResponse(response);
    return response;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
    if (error instanceof ModelSelectionConflictError) {
      return { ...base, type: "error", code: "CONFLICT", message: "Model selection revision changed; read model status before retrying." };
    }
    return { ...base, type: "error", code: "UNAVAILABLE", message: "Model control request is unavailable." };
  }
}
