import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { HostRequest, HostResponse } from "../protocol/host.ts";
import type { ConversationStore } from "./conversation-store.ts";
import type { SubjectStore } from "./subject-store.ts";
import type { ResearchStore } from "./research-store.ts";
import { ResearchRunner } from "./research-runner.ts";
import type { ModelPort } from "../adapters/models/port.ts";

function matches(a: string, b: string): boolean {
  const x = Buffer.alloc(128), y = Buffer.alloc(128);
  const left = Buffer.from(a), right = Buffer.from(b);
  left.copy(x, 0, 0, 128); right.copy(y, 0, 0, 128);
  return timingSafeEqual(x, y) && left.length === right.length && left.length <= 128;
}
interface Binding { id: string; token: string; expiresAt: string; controller: AbortController; expiryTimer?: ReturnType<typeof setTimeout> }
/** Private roles are derived from socket + credential, never request JSON or MCP clientInfo. */
export class HostImportService {
  readonly #bindings = new Map<object, Binding>();
  readonly #closed = new WeakSet<object>();
  #tail: Promise<void> = Promise.resolve();
  readonly store: SubjectStore & ConversationStore & { supportsHostImport: boolean };
  readonly ownerToken: string;
  readonly #research: ResearchStore | undefined;
  readonly #runner: ResearchRunner | undefined;
  constructor(store: SubjectStore & ConversationStore & { supportsHostImport: boolean }, ownerToken: string, model?: ModelPort) {
    this.store = store; this.ownerToken = ownerToken;
    const candidate = store as typeof store & Partial<ResearchStore>;
    this.#research = candidate.supportsResearch === true ? candidate as ResearchStore : undefined;
    this.#runner = this.#research && model ? new ResearchRunner(this.#research, model) : undefined;
  }
  disconnect(connection: object): void {
    this.#closed.add(connection);
    const binding = this.#bindings.get(connection);
    if (binding?.expiryTimer) clearTimeout(binding.expiryTimer);
    binding?.controller.abort();
    this.#bindings.delete(connection);
    if (binding && this.#research) {
      const cleanup = this.#tail.then(() => this.#research!.pauseResearchBinding(binding.id, new AbortController().signal));
      this.#tail = cleanup.then(() => undefined, () => undefined);
    }
  }
  async close(): Promise<void> {
    for (const connection of this.#bindings.keys()) this.disconnect(connection);
    await this.#tail;
    await this.#runner?.close();
  }
  handle(request: HostRequest, token: string, connection: object, signal: AbortSignal): Promise<HostResponse> {
    const operation = this.#tail.then(() => this.#handle(request, token, connection, signal));
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  async #handle(request: HostRequest, token: string, connection: object, signal: AbortSignal): Promise<HostResponse> {
    const base = { version: 1 as const, requestId: request.requestId };
    const error = (code: "UNAUTHORIZED" | "UNAVAILABLE" | "UNSUPPORTED"): HostResponse => ({ ...base, type: "error", code });
    try {
      signal.throwIfAborted();
      if (this.#closed.has(connection)) return error("UNAUTHORIZED");
      if (request.type === "pair") {
        if (!matches(token, this.ownerToken) || this.#bindings.has(connection)) return error("UNAUTHORIZED");
        if (!this.store.supportsHostImport) return error("UNSUPPORTED");
        const binding: Binding = { id: randomUUID(), token: randomBytes(32).toString("base64url"),
          expiresAt: new Date(Date.now() + 600_000).toISOString(), controller: new AbortController() };
        binding.expiryTimer = setTimeout(() => this.disconnect(connection), 600_000);
        binding.expiryTimer.unref();
        this.#bindings.set(connection, binding);
        return { ...base, type: "paired", bindingId: binding.id, executorToken: binding.token, expiresAt: binding.expiresAt };
      }
      const binding = this.#bindings.get(connection);
      if (!binding || Date.now() >= Date.parse(binding.expiresAt)) { this.disconnect(connection); return error("UNAUTHORIZED"); }
      const owner = ["authorize", "revoke", "research-start", "research-stop", "research-resume", "research-status"].includes(request.type);
      if (!matches(token, owner ? this.ownerToken : binding.token)) return error("UNAUTHORIZED");
      const active = AbortSignal.any([signal, binding.controller.signal]);
      active.throwIfAborted();
      let result: HostResponse;
      switch (request.type) {
        case "research-start":
          if (!this.#research || Date.parse(request.plan.expiresAt) > Date.parse(binding.expiresAt)) return error("UNSUPPORTED");
          if (!this.#runner) return error("UNAVAILABLE");
          result = { ...base, type: "research", status: await this.#research.startResearch(request.plan, binding.id, active) }; break;
        case "research-status":
          if (!this.#research) return error("UNSUPPORTED");
          result = { ...base, type: "research", status: await this.#research.ownerResearchStatus(request.runId, active) }; break;
        case "research-next":
          if (!this.#research) return error("UNSUPPORTED");
          result = { ...base, type: "research-task", task: await this.#research.nextResearchTask(request.runId, binding.id, active) }; break;
        case "research-claim":
          if (!this.#research) return error("UNSUPPORTED");
          result = { ...base, type: "research-claim", claim: await this.#research.claimResearch(request.taskId, request.expectedRevision, binding.id, active) }; break;
        case "research-submit":
          if (!this.#research) return error("UNSUPPORTED");
          result = { ...base, type: "research", status: await this.#research.submitResearch(request.receipt, binding.id, active) }; break;
        case "research-step":
          if (!this.#research || !this.#runner) return error("UNAVAILABLE");
          await this.#runner.start(request.runId, binding.id, binding.controller.signal);
          result = { ...base, type: "research", status: await this.#research.researchStatus(request.runId, binding.id, active) }; break;
        case "research-stop":
          if (!this.#research) return error("UNSUPPORTED");
          result = { ...base, type: "research", status: await this.#research.ownerStopResearch(request.runId, active) };
          this.#runner?.cancel(request.runId); break;
        case "research-resume":
          if (!this.#research) return error("UNSUPPORTED");
          result = { ...base, type: "research", status: await this.#research.resumeResearch(request.runId, binding.id, active) }; break;
        case "research-pause":
          if (!this.#research) return error("UNSUPPORTED");
          result = { ...base, type: "research", status: await this.#research.pauseResearch(request.runId, binding.id, active) };
          this.#runner?.cancel(request.runId); break;
        case "status": {
          const state = await this.store.read(active);
          result = { ...base, type: "status", subjectId: state.self.identity.id, scopeId: state.scopeId,
            revision: state.revision, lifecycle: state.lifecycle, supported: this.store.supportsHostImport, researchSupported: this.#research !== undefined && this.#runner !== undefined }; break;
        }
        case "authorize": {
          const expiry = Date.parse(request.expiresAt);
          if (expiry <= Date.now() || expiry > Date.now() + 300_000 || expiry > Date.parse(binding.expiresAt)) return error("UNAVAILABLE");
          result = { ...base, type: "grant", grant: await this.store.authorizeConversation(request.batch, binding.id, request.expiresAt, active) }; break;
        }
        case "accept": result = { ...base, type: "import", result: await this.store.acceptConversation(request.batch, request.grantId, binding.id, active) }; break;
        case "consume": result = { ...base, type: "import", result: await this.store.consumeConversation(request.batchId, request.grantId, binding.id, new Date().toISOString(), active) }; break;
        case "import-status": result = { ...base, type: "import", result: await this.store.conversationImportStatus(request.batchId, binding.id, active) ?? null }; break;
        case "revoke": await this.store.revokeConversation(request.grantId, binding.id, active); result = { ...base, type: "revoked" }; break;
      }
      active.throwIfAborted();
      return result;
    } catch { return error("UNAVAILABLE"); }
  }
}
