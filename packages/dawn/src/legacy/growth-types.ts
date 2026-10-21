/** A reflection proposes change; it is not its own validation or approval. */
export interface GrowthProposal {
  readonly id: string;
  readonly kind: "knowledge" | "method" | "preference" | "personality";
  readonly description: string;
  readonly evidenceIds: readonly string[];
  readonly status: "candidate" | "trial" | "accepted" | "rejected" | "revoked";
  readonly evaluationIds: readonly string[];
}
