import type { ResearchPlan, ResearchReceipt, ResearchSearchResult } from "../core/research.ts";
import type { LearningResult } from "./learning-store.ts";
export type { ResearchPlan, ResearchReceipt, ResearchSearchResult } from "../core/research.ts";

import type { ResearchStatus, ResearchTaskSummary, ResearchClaim } from "../core/research.ts";
export type { ResearchStatus, ResearchTaskSummary, ResearchClaim, ResearchRunState } from "../core/research.ts";

export interface ResearchAttempt {
  readonly id: string; readonly runId: string; readonly taskId: string; readonly goalId: string;
  readonly phase: "study" | "assessment"; readonly expectedRevision: number;
  readonly bindingId: string; readonly fence: number;
}
export type ResearchProjection = {
  readonly phase: "study"; readonly question: string; readonly query: string;
  readonly results: readonly ResearchSearchResult[];
  readonly practice: readonly { readonly id: string; readonly prompt: string }[];
} | {
  readonly phase: "assessment"; readonly notes: string;
  readonly questions: readonly { readonly id: string; readonly prompt: string }[];
};
export interface ResearchReservation { readonly attempt: ResearchAttempt; readonly projection: ResearchProjection }

/** Authentication/owner role is injected and checked by runtime, never accepted from business JSON.
 * A claim response authorizes ONE execution in that live operation chain; status cannot recreate it.
 * open() is read-only validation. Server startup explicitly calls pauseResearchOnRestart after old runners stop.
 */
export interface ResearchStore {
  readonly supportsResearch: boolean;
  startResearch(plan: ResearchPlan, bindingId: string, signal: AbortSignal): Promise<ResearchStatus>;
  researchStatus(runId: string, bindingId: string, signal: AbortSignal): Promise<ResearchStatus>;
  /** Only private owner-authenticated control paths may call these cross-binding read/stop operations. */
  ownerResearchStatus(runId: string, signal: AbortSignal): Promise<ResearchStatus>;
  ownerStopResearch(runId: string, signal: AbortSignal): Promise<ResearchStatus>;
  nextResearchTask(runId: string, bindingId: string, signal: AbortSignal): Promise<ResearchTaskSummary | null>;
  claimResearch(taskId: string, expectedRevision: number, bindingId: string, signal: AbortSignal): Promise<ResearchClaim>;
  submitResearch(receipt: ResearchReceipt, bindingId: string, signal: AbortSignal): Promise<ResearchStatus>;
  reserveResearch(runId: string, bindingId: string, signal: AbortSignal): Promise<ResearchReservation | null>;
  completeResearch(attempt: ResearchAttempt, result: LearningResult, at: string, signal: AbortSignal): Promise<ResearchStatus>;
  failResearch(attempt: ResearchAttempt, signal: AbortSignal): Promise<void>;
  stopResearch(runId: string, bindingId: string, signal: AbortSignal): Promise<ResearchStatus>;
  pauseResearch(runId: string, bindingId: string, signal: AbortSignal): Promise<ResearchStatus>;
  pauseResearchBinding(bindingId: string, signal: AbortSignal): Promise<void>;
  pauseResearchOnRestart(signal: AbortSignal): Promise<void>;
  resumeResearch(runId: string, newBindingId: string, signal: AbortSignal): Promise<ResearchStatus>;
}
