import type { SelfState } from "../self/types.ts";
export interface GrowthProposal {
  readonly id: string;
  readonly kind: "interest" | "personality";
  readonly target: string;
  readonly delta: number;
  readonly evidenceIds: readonly string[];
  readonly status: "candidate" | "accepted" | "rejected";
  readonly evaluationIds: readonly string[];
}
/** Evaluations are supplied by a trusted test/observer, not accepted from model text as proof. */
export interface GrowthEvaluation {
  readonly id: string;
  readonly proposalId: string;
  readonly evidenceIds: readonly string[];
  readonly outcome: "pass" | "fail";
  readonly at: string;
}
export interface GrowthState {
  readonly proposals: readonly GrowthProposal[];
  readonly evaluations: readonly GrowthEvaluation[];
}
export type PersonalityAxis = keyof SelfState["personality"];
