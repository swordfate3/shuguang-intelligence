import { randomUUID } from "node:crypto";
import { CoreRevisionConflictError } from "../core/cycle.ts";
import type { CycleInput, CycleAuthority } from "../core/cycle.ts";
import { assertDawnRequest, MAX_MESSAGE_CHARS, MAX_WIRE_BYTES, PROTOCOL_VERSION } from "../protocol/index.ts";
import type { DawnRequest, DawnResponse } from "../protocol/index.ts";
import type { ModelPort } from "../adapters/models/port.ts";
import type { SubjectAttempt, SubjectStore } from "./subject-store.ts";
import { parseDeliberation, prepareTurn } from "./deliberation.ts";
import { assertData, timestamp } from "../core/guards.ts";
import { handleModelControl } from "./model-control.ts";

/** Six-core application owner. The caller owns store and cancellation; no background autonomy. */
export class SubjectService {
  readonly instanceId = randomUUID();
  readonly startedAt: string;
  readonly #store: SubjectStore;
  readonly #model: ModelPort | undefined;
  readonly #now: () => string;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(store: SubjectStore, model?: ModelPort, now: () => string = () => new Date().toISOString()) {
    this.#store = store; this.#model = model; this.#now = now;
    this.startedAt = now(); timestamp(this.startedAt);
  }

  async handle(request: DawnRequest, signal: AbortSignal): Promise<DawnResponse> {
    signal.throwIfAborted();
    if (this.#closed) throw new Error("Subject service is closed");
    assertData(request); assertDawnRequest(request);
    const accepted = structuredClone(request);
    const result = this.#tail.then(() => this.#execute(accepted, signal));
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  close(): Promise<void> { this.#closed = true; return this.#tail; }

  async #execute(request: DawnRequest, signal: AbortSignal): Promise<DawnResponse> {
    signal.throwIfAborted();
    const base = { version: PROTOCOL_VERSION, requestId: request.requestId };
    try {
      if (request.type === "model-status" || request.type === "model-list" ||
          request.type === "model-select" || request.type === "thinking-select") {
        return await handleModelControl(this.#model, request, signal);
      }
      if (request.type === "say") {
        if (!this.#model) return { ...base, type: "error", code: "NOT_IMPLEMENTED", message: "No model is configured." };
        return { ...base, type: "reply", text: await this.#say(request, this.#model, signal) };
      }
      const state = request.type === "status" ? await this.#store.read(signal)
        : await this.#store.changeLifecycle(request.expectedRevision, request.type === "wake" ? "awake" : "sleeping", this.#now(), signal);
      signal.throwIfAborted();
      return { ...base, type: "status", lifecycle: state.lifecycle, revision: state.revision,
        runtime: { instanceId: this.instanceId, startedAt: this.startedAt, autonomy: false } };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw error;
      return error instanceof CoreRevisionConflictError
        ? { ...base, type: "error", code: "CONFLICT", message: "Subject revision changed; read status before continuing." }
        : { ...base, type: "error", code: "UNAVAILABLE", message: "Subject request could not return a successful reply." };
    }
  }

  async #say(request: Extract<DawnRequest, { type: "say" }>, model: ModelPort, signal: AbortSignal): Promise<string> {
    const state = await this.#store.read(signal);
    signal.throwIfAborted();
    if (state.lifecycle !== "awake") throw new Error("Subject is sleeping");
    if (state.experiences.length > 998 || state.memory.records.length > 998 || state.processedCycleIds.length > 998) {
      throw new Error("Subject turn capacity exhausted");
    }
    // Validate context before charging; a malformed local state must not consume model budget.
    const history = await this.#store.history(signal);
    const prepared = prepareTurn(state, history, { user: request.text, cycleId: randomUUID(), experienceId: randomUUID(), at: this.#now() });
    let attempt: SubjectAttempt | undefined;
    try {
      attempt = await this.#store.reserve(request.requestId, request.text, state.revision, signal);
      signal.throwIfAborted();
      // A model reply is a candidate envelope, not an authoritative state update.
      const generated = await model.generate({ messages: prepared.messages, maxOutputTokens: 1024 }, signal);
      signal.throwIfAborted();
      const deliberation = parseDeliberation(generated.text, state, prepared);
      const envelope = { version: PROTOCOL_VERSION, requestId: request.requestId, type: "reply", text: deliberation.reply };
      if (deliberation.reply.length > MAX_MESSAGE_CHARS || Buffer.byteLength(JSON.stringify(envelope)) > MAX_WIRE_BYTES) throw new Error("Invalid reply envelope");
      const authority: CycleAuthority = { allow: ["world_belief", "memory_correction", "growth_candidate"],
        availableBudget: 0, stopRequested: false, evaluations: [] };
      const userCycle: CycleInput = { ...prepared.input, appraisal: deliberation.appraisal, candidates: deliberation.candidates };
      // Distinct source-labelled records. The assistant's words are inference, not a user statement or observed fact.
      const assistantAt = this.#now(); timestamp(assistantAt);
      const assistantCycle: CycleInput = { cycleId: randomUUID(), expectedRevision: state.revision + 1, at: assistantAt,
        experience: { id: randomUUID(), subjectId: state.self.identity.id, scopeId: state.scopeId, kind: "conversation", origin: "inference",
          content: deliberation.reply, topics: [...prepared.input.experience.topics], occurredAt: assistantAt, recordedAt: assistantAt,
          sourceIds: [prepared.input.experience.id] }, appraisal: null, candidates: [], activities: [] };
      await this.#store.complete(attempt, { reply: deliberation.reply, cycles: [
        { input: userCycle, authority },
        { input: assistantCycle, authority: { ...authority, allow: [] } },
      ], usage: { modelId: generated.modelId, inputTokens: generated.usage.inputTokens, outputTokens: generated.usage.outputTokens } }, signal);
      signal.throwIfAborted();
      return deliberation.reply;
    } catch (error) {
      if (attempt) {
        try { await this.#store.fail(attempt, new AbortController().signal); }
        catch { /* Charged pending survives I/O failure; do not hide original cancellation or failure. */ }
      }
      throw error;
    }
  }
}
