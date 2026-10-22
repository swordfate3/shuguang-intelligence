import type { ModelPort } from "./port.ts";
import { isModelId, isThinkingLevel, THINKING_LEVELS, type ModelSelectionState, type ThinkingLevel } from "../../protocol/model-controls.ts";
import { ModelSelectionConflictError, type ModelControlPort } from "../../runtime/model-control.ts";

const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_MODELS_RESPONSE_BYTES = 1024 * 1024;
const MAX_DISCOVERY_ITEMS = 128;
// Leave ample space for the current ID, counters and protocol envelope inside 64 KiB.
const MAX_CATALOG_BYTES = 48 * 1024;
const DISCOVERY_TIMEOUT_MS = 8_000;

/** Only fixed, locally authored messages may cross this adapter's error boundary. */
class ModelError extends Error {}

function fail(code: string): never {
  throw new ModelError(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function endpoint(baseUrl: unknown): string {
  if (typeof baseUrl !== "string") fail("MODEL_INVALID_CONFIG");
  // Check the original spelling too: URL normalizes dot segments, whitespace,
  // backslashes and alternate IPv4 spellings, which must not expand this policy.
  const match = /^(https?):\/\/([^/?#@\\\s]+)(?:\/v1)?\/*$/.exec(baseUrl);
  if (!match) fail("MODEL_INVALID_CONFIG");
  let url: URL;
  try { url = new URL(baseUrl); } catch { fail("MODEL_INVALID_CONFIG"); }
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && /^127\.0\.0\.1(?::\d+)?$/.test(match[2]!)))) {
    fail("MODEL_INVALID_CONFIG");
  }
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function messagesFor(request: unknown): { role: string; content: string }[] {
  if (!record(request) || Object.keys(request).some(key => key !== "messages" && key !== "maxOutputTokens") ||
      !safeInteger(request.maxOutputTokens, 1, 1024) || !Array.isArray(request.messages) || request.messages.length === 0) {
    fail("MODEL_INVALID_REQUEST");
  }
  // Array.from also visits sparse entries, unlike map.
  return Array.from(request.messages, (message: unknown) => {
    if (!record(message) || Object.keys(message).some(key => key !== "role" && key !== "text") ||
        !["system", "user", "assistant"].includes(message.role as string) ||
        typeof message.text !== "string" || message.text.trim().length === 0) {
      fail("MODEL_INVALID_REQUEST");
    }
    return { role: message.role as string, content: message.text };
  });
}

async function readBounded(response: Response, maxBytes = MAX_RESPONSE_BYTES, tooLargeCode = "MODEL_RESPONSE_TOO_LARGE"): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    fail(tooLargeCode);
  }
  if (!response.body) fail("MODEL_INVALID_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) fail(tooLargeCode);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    fail("MODEL_INVALID_RESPONSE");
  }
}

function parseResponse(value: unknown, modelId: string): Awaited<ReturnType<ModelPort["generate"]>> {
  if (!record(value) || "error" in value || !Array.isArray(value.choices) || !record(value.choices[0])) {
    fail("MODEL_INVALID_RESPONSE");
  }
  const choice = value.choices[0];
  if (choice.finish_reason !== "stop") fail("MODEL_INCOMPLETE_RESPONSE");
  if (!record(choice.message) || typeof choice.message.content !== "string" ||
      choice.message.content.trim().length === 0 || choice.message.content.length > 16_000 ||
      !record(value.usage) || !safeInteger(value.usage.prompt_tokens, 0, Number.MAX_SAFE_INTEGER) ||
      !safeInteger(value.usage.completion_tokens, 0, Number.MAX_SAFE_INTEGER)) {
    fail("MODEL_INVALID_RESPONSE");
  }
  return {
    text: choice.message.content,
    modelId,
    usage: { inputTokens: value.usage.prompt_tokens, outputTokens: value.usage.completion_tokens },
  };
}

/** No retries, fallback, environment lookup, or host model credentials. */
export class OpenAICompatibleModel implements ModelControlPort {
  #endpoint: string;
  #modelsEndpoint: string;
  #model: string;
  #models: string[];
  #selectionRevision = 0;
  #apiKey: string;
  #timeoutMs: number;
  #maxCalls: number;
  #thinking: ThinkingLevel;
  #calls = 0;
  #activeCalls = 0;
  #discovering = false;

  constructor(options: {
    baseUrl: string;
    model: string;
    apiKey: string;
    timeoutMs?: number;
    maxCalls?: number;
    reasoningEffort?: ThinkingLevel;
  }) {
    if (!record(options)) fail("MODEL_INVALID_CONFIG");
    this.#endpoint = endpoint(options.baseUrl);
    if (!isModelId(options.model) ||
        typeof options.apiKey !== "string" || !/^[\x21-\x7e]+$/.test(options.apiKey)) {
      fail("MODEL_INVALID_CONFIG");
    }
    const timeoutMs = options.timeoutMs === undefined ? 8_000 : options.timeoutMs;
    const maxCalls = options.maxCalls === undefined ? 10 : options.maxCalls;
    if (!safeInteger(timeoutMs, 1, 30_000) || !safeInteger(maxCalls, 1, Number.MAX_SAFE_INTEGER)) {
      fail("MODEL_INVALID_CONFIG");
    }
    const reasoningEffort = options.reasoningEffort === undefined ? "low" : options.reasoningEffort;
    if (!isThinkingLevel(reasoningEffort)) fail("MODEL_INVALID_CONFIG");
    this.#model = options.model;
    this.#models = [options.model];
    this.#modelsEndpoint = `${this.#endpoint.slice(0, -"/chat/completions".length)}/models`;
    this.#apiKey = options.apiKey;
    this.#timeoutMs = timeoutMs;
    this.#maxCalls = maxCalls;
    this.#thinking = reasoningEffort;
  }

  modelState(): ModelSelectionState {
    return Object.freeze({
      selectionRevision: this.#selectionRevision,
      model: this.#model,
      thinking: this.#thinking,
      levels: Object.freeze([...THINKING_LEVELS]),
      models: Object.freeze([...this.#models]),
      calls: this.#calls,
      maxCalls: this.#maxCalls,
    });
  }

  selectModel(expectedRevision: number, model: string, signal: AbortSignal): ModelSelectionState {
    this.#assertControlAvailable(expectedRevision, signal);
    if (typeof model !== "string") fail("MODEL_UNKNOWN_ID");
    if (model === this.#model) return this.modelState();
    if (!isModelId(model) || !this.#models.includes(model)) fail("MODEL_UNKNOWN_ID");
    this.#assertRevisionCanAdvance();
    this.#model = model;
    this.#selectionRevision += 1;
    return this.modelState();
  }

  selectThinking(expectedRevision: number, thinking: ThinkingLevel, signal: AbortSignal): ModelSelectionState {
    this.#assertControlAvailable(expectedRevision, signal);
    if (!isThinkingLevel(thinking)) fail("MODEL_INVALID_THINKING_LEVEL");
    if (thinking !== this.#thinking) {
      this.#assertRevisionCanAdvance();
      this.#thinking = thinking;
      this.#selectionRevision += 1;
    }
    return this.modelState();
  }

  async discoverModels(signal: AbortSignal): Promise<ModelSelectionState> {
    this.#assertSignal(signal);
    this.#assertIdle();
    this.#discovering = true;
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => controller.abort();
    try {
      signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, DISCOVERY_TIMEOUT_MS);
      const response = await fetch(this.#modelsEndpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.#apiKey}` },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        fail("MODEL_DISCOVERY_HTTP_ERROR");
      }
      const discovered = parseModels(await readBounded(response, MAX_MODELS_RESPONSE_BYTES, "MODEL_DISCOVERY_RESPONSE_TOO_LARGE"));
      if (signal.aborted) throw new DOMException("MODEL_CANCELLED", "AbortError");
      if (timedOut) fail("MODEL_TIMEOUT");
      this.#models = discovered;
      return this.modelState();
    } catch (error) {
      if (signal.aborted) throw new DOMException("MODEL_CANCELLED", "AbortError");
      if (timedOut) fail("MODEL_TIMEOUT");
      if (error instanceof ModelError) throw error;
      fail("MODEL_DISCOVERY_FAILED");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      controller.abort();
      this.#discovering = false;
    }
  }

  #assertSignal(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException("MODEL_CANCELLED", "AbortError");
  }

  #assertIdle(): void {
    if (this.#discovering || this.#activeCalls > 0) fail("MODEL_CONTROL_BUSY");
  }

  #assertControlAvailable(expectedRevision: number, signal: AbortSignal): void {
    this.#assertSignal(signal);
    this.#assertIdle();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== this.#selectionRevision) {
      throw new ModelSelectionConflictError();
    }
  }

  #assertRevisionCanAdvance(): void {
    if (this.#selectionRevision >= Number.MAX_SAFE_INTEGER) fail("MODEL_SELECTION_REVISION_EXHAUSTED");
  }

  async generate(request: Parameters<ModelPort["generate"]>[0], signal: AbortSignal): ReturnType<ModelPort["generate"]> {
    if (this.#discovering) fail("MODEL_CONTROL_BUSY");
    const selectedModel = this.#model;
    const selectedThinking = this.#thinking;
    let reserved = false;
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => controller.abort();
    try {
      if (signal.aborted) throw new DOMException("MODEL_CANCELLED", "AbortError");
      const messages = messagesFor(request);
      const bodyValue: Record<string, unknown> = {
        model: selectedModel,
        messages,
        max_tokens: request.maxOutputTokens,
        stream: false,
      };
      if (selectedThinking !== "off") bodyValue.reasoning_effort = selectedThinking;
      const body = JSON.stringify(bodyValue);
      if (this.#calls >= this.#maxCalls) fail("MODEL_CALL_BUDGET_EXHAUSTED");
      // Reserve synchronously, before any await; failures and cancellations after
      // dispatch still count. Pre-cancelled/invalid inputs do not spend a call.
      this.#calls += 1;
      this.#activeCalls += 1;
      reserved = true;
      signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
      const response = await fetch(this.#endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        fail("MODEL_HTTP_ERROR");
      }
      const result = parseResponse(await readBounded(response), selectedModel);
      if (signal.aborted) throw new DOMException("MODEL_CANCELLED", "AbortError");
      if (timedOut) fail("MODEL_TIMEOUT");
      return result;
    } catch (error) {
      // Never propagate fetch errors, upstream bodies, URLs, or caller-provided
      // abort reasons (which can themselves contain secrets).
      if (signal.aborted) throw new DOMException("MODEL_CANCELLED", "AbortError");
      if (timedOut) fail("MODEL_TIMEOUT");
      if (error instanceof ModelError) throw error;
      return fail("MODEL_REQUEST_FAILED");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      controller.abort();
      if (reserved) this.#activeCalls -= 1;
    }
  }
}

function parseModels(value: unknown): string[] {
  if (!record(value) || !Array.isArray(value.data) || value.data.length > MAX_DISCOVERY_ITEMS) {
    fail("MODEL_INVALID_MODELS_RESPONSE");
  }
  const models = new Set<string>();
  for (const entry of value.data) {
    if (!record(entry) || !isModelId(entry.id)) fail("MODEL_INVALID_MODELS_RESPONSE");
    models.add(entry.id);
  }
  const result = [...models];
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_CATALOG_BYTES) fail("MODEL_INVALID_MODELS_RESPONSE");
  return result;
}
