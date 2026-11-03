import { assertResearchPlan, assertResearchReceipt, assertResearchStatus, assertResearchTaskSummary, assertResearchClaim,
  type ResearchPlan, type ResearchReceipt, type ResearchStatus, type ResearchTaskSummary, type ResearchClaim } from "../core/research.ts";
import { assertConversationBatch, type ConversationBatch } from "../core/conversation-source.ts";
import { assertData, id, object, timestamp, integer } from "../core/guards.ts";
import type { ConversationGrant, ConversationImportStatus } from "../runtime/conversation-store.ts";
export const HOST_MAX_BYTES = 64 * 1024;
export type HostRequest = { readonly version: 1; readonly requestId: string } & (
  | { readonly type: "pair" }
  | { readonly type: "status" }
  | { readonly type: "authorize"; readonly batch: ConversationBatch; readonly expiresAt: string }
  | { readonly type: "accept"; readonly batch: ConversationBatch; readonly grantId: string }
  | { readonly type: "consume"; readonly batchId: string; readonly grantId: string }
  | { readonly type: "import-status"; readonly batchId: string }
  | { readonly type: "revoke"; readonly grantId: string }
  | { readonly type: "research-start"; readonly plan: ResearchPlan }
  | { readonly type: "research-status" | "research-next" | "research-step" | "research-stop" | "research-resume" | "research-pause"; readonly runId: string }
  | { readonly type: "research-claim"; readonly taskId: string; readonly expectedRevision: number }
  | { readonly type: "research-submit"; readonly receipt: ResearchReceipt }
);
export type HostResponse = { readonly version: 1; readonly requestId: string } & (
  | { readonly type: "paired"; readonly bindingId: string; readonly executorToken: string; readonly expiresAt: string }
  | { readonly type: "status"; readonly subjectId: string; readonly scopeId: string; readonly revision: number; readonly lifecycle: "awake" | "sleeping"; readonly supported: boolean; readonly researchSupported?: boolean }
  | { readonly type: "grant"; readonly grant: ConversationGrant }
  | { readonly type: "import"; readonly result: ConversationImportStatus | null }
  | { readonly type: "revoked" }
  | { readonly type: "research"; readonly status: ResearchStatus }
  | { readonly type: "research-task"; readonly task: ResearchTaskSummary | null }
  | { readonly type: "research-claim"; readonly claim: ResearchClaim }
  | { readonly type: "error"; readonly code: "UNAUTHORIZED" | "UNAVAILABLE" | "INVALID_REQUEST" | "UNSUPPORTED" }
);
export function assertHostRequest(value: unknown): asserts value is HostRequest {
  assertData(value);
  const base = value as Record<string, unknown>;
  if (!base || base.version !== 1) throw new Error("Invalid host request");
  id(base.requestId);
  const fields = ["version", "requestId", "type"];
  switch (base.type) {
    case "pair": case "status": object(value, fields); break;
    case "research-start": object(value, [...fields, "plan"]); assertResearchPlan(base.plan); break;
    case "research-status": case "research-next": case "research-step": case "research-stop": case "research-resume": case "research-pause":
      object(value, [...fields, "runId"]); id(base.runId); break;
    case "research-claim": object(value, [...fields, "taskId", "expectedRevision"]); id(base.taskId); integer(base.expectedRevision); break;
    case "research-submit": object(value, [...fields, "receipt"]); assertResearchReceipt(base.receipt); break;
    case "authorize": object(value, [...fields, "batch", "expiresAt"]); assertConversationBatch(base.batch); timestamp(base.expiresAt); break;
    case "accept": object(value, [...fields, "batch", "grantId"]); assertConversationBatch(base.batch); id(base.grantId); break;
    case "consume": object(value, [...fields, "batchId", "grantId"]); id(base.batchId); id(base.grantId); break;
    case "import-status": object(value, [...fields, "batchId"]); id(base.batchId); break;
    case "revoke": object(value, [...fields, "grantId"]); id(base.grantId); break;
    default: throw new Error("Invalid host request");
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > HOST_MAX_BYTES) throw new Error("Host request too large");
  if ("batch" in base && Buffer.byteLength(JSON.stringify(base.batch), "utf8") > 24 * 1024) throw new Error("Batch too large");
}

export function assertHostResponse(value: unknown): asserts value is HostResponse {
  assertData(value);
  const r = value as Record<string, unknown>;
  if (!r || r.version !== 1) throw new Error("Invalid host response");
  id(r.requestId);
  const base = ["version", "requestId", "type"];
  switch (r.type) {
    case "paired":
      object(r, [...base, "bindingId", "executorToken", "expiresAt"]); id(r.bindingId); timestamp(r.expiresAt);
      if (typeof r.executorToken !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(r.executorToken)) throw new Error("Invalid executor credential");
      break;
    case "status":
      object(r, [...base, "subjectId", "scopeId", "revision", "lifecycle", "supported", ...(Object.hasOwn(r, "researchSupported") ? ["researchSupported"] : [])]);
      if (Object.hasOwn(r, "researchSupported") && typeof r.researchSupported !== "boolean") throw new Error("Invalid research support");
      id(r.subjectId); id(r.scopeId); integer(r.revision);
      if (!["awake", "sleeping"].includes(r.lifecycle as string) || typeof r.supported !== "boolean") throw new Error("Invalid host status");
      break;
    case "grant": {
      object(r, [...base, "grant"]);
      const g = object(r.grant, ["grantId", "batchId", "batchHash", "bindingId", "status", "expiresAt"]);
      id(g.grantId); id(g.batchId); id(g.bindingId); timestamp(g.expiresAt);
      if (typeof g.batchHash !== "string" || !/^[a-f0-9]{64}$/.test(g.batchHash) || !["active", "revoked"].includes(g.status as string)) throw new Error("Invalid grant");
      break;
    }
    case "import": {
      object(r, [...base, "result"]);
      if (r.result !== null) {
        const i = object(r.result, ["batchId", "status", "newSources", "revision"]);
        id(i.batchId); integer(i.newSources); integer(i.revision);
        if (!["accepted", "consumed"].includes(i.status as string)) throw new Error("Invalid import status");
      }
      break;
    }
    case "revoked": object(r, base); break;
    case "research": object(r, [...base, "status"]); assertResearchStatus(r.status); break;
    case "research-task": object(r, [...base, "task"]); if (r.task !== null) assertResearchTaskSummary(r.task); break;
    case "research-claim": object(r, [...base, "claim"]); assertResearchClaim(r.claim); break;
    case "error":
      object(r, [...base, "code"]);
      if (!["UNAUTHORIZED", "UNAVAILABLE", "INVALID_REQUEST", "UNSUPPORTED"].includes(r.code as string)) throw new Error("Invalid host error");
      break;
    default: throw new Error("Invalid host response");
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > HOST_MAX_BYTES) throw new Error("Host response too large");
}
