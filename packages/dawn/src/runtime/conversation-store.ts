import type { ConversationBatch } from "../core/conversation-source.ts";
export interface ConversationGrant {
  readonly grantId: string;
  readonly batchId: string;
  readonly batchHash: string;
  readonly bindingId: string;
  readonly status: "active" | "revoked";
  readonly expiresAt: string;
}
export interface ConversationImportStatus {
  readonly batchId: string;
  readonly status: "accepted" | "consumed";
  readonly newSources: number;
  readonly revision: number;
}
/** Caller identity is injected by the authenticated private transport, never parsed from batch JSON. */
export interface ConversationStore {
  authorizeConversation(batch: ConversationBatch, bindingId: string, expiresAt: string, signal: AbortSignal): Promise<ConversationGrant>;
  acceptConversation(batch: ConversationBatch, grantId: string, bindingId: string, signal: AbortSignal): Promise<ConversationImportStatus>;
  consumeConversation(batchId: string, grantId: string, bindingId: string, at: string, signal: AbortSignal): Promise<ConversationImportStatus>;
  conversationImportStatus(batchId: string, bindingId: string, signal: AbortSignal): Promise<ConversationImportStatus | undefined>;
  revokeConversation(grantId: string, bindingId: string, signal: AbortSignal): Promise<void>;
}
