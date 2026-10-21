import type { SubjectState } from "../core/state.ts";
import type { CycleInput, CycleAuthority } from "../core/cycle.ts";

export interface SubjectAttempt {
  readonly requestId: string;
  readonly sequence: number;
  readonly expectedRevision: number;
  readonly user: string;
}
export interface SubjectBudget {
  readonly limit: number; readonly reserved: number; readonly completed: number; readonly failed: number; readonly pending: number;
}
export interface DialoguePair { readonly user: string; readonly assistant: string }
export interface TurnCommit {
  readonly reply: string;
  readonly cycles: readonly { readonly input: CycleInput; readonly authority: CycleAuthority }[];
  readonly usage: { readonly modelId: string; readonly inputTokens: number; readonly outputTokens: number };
}
/** One transaction owner per subject DB: repository methods never commit independently. */
export interface SubjectStore {
  read(signal: AbortSignal): Promise<SubjectState>;
  changeLifecycle(expectedRevision: number, lifecycle: "awake" | "sleeping", at: string, signal: AbortSignal): Promise<SubjectState>;
  /** T1 commits a nonrefundable charge before model I/O, fenced by current awake revision. */
  reserve(requestId: string, user: string, expectedRevision: number, signal: AbortSignal): Promise<SubjectAttempt>;
  history(signal: AbortSignal): Promise<readonly DialoguePair[]>;
  /** T2 re-runs typed cycles under CAS, commits state/event/exchange/usage atomically. */
  complete(attempt: SubjectAttempt, commit: TurnCommit, signal: AbortSignal): Promise<SubjectState>;
  fail(attempt: SubjectAttempt, signal: AbortSignal): Promise<void>;
  budget(signal: AbortSignal): Promise<SubjectBudget>;
}
