import type { LearningPack } from "../core/learning.ts";

export interface LearningResult {
  readonly notes: string;
  readonly answers: readonly { readonly id: string; readonly answer: string }[];
}

export interface LearningAttempt {
  readonly id: string;
  readonly goalId: string;
  readonly phase: "study" | "assessment";
  readonly expectedRevision: number;
}

export interface LearningAttemptDetail {
  readonly id: string;
  readonly goalId: string;
  readonly phase: "study" | "assessment";
  readonly status: "pending" | "completed" | "failed";
  readonly result: LearningResult | null;
}

export interface LearningStatus {
  readonly status: "active" | "stopped" | "completed" | "exhausted";
  readonly pack: LearningPack;
  readonly limit: number;
  readonly reserved: number;
  readonly attempts: readonly LearningAttemptDetail[];
}

/** Typed, durable learning operations sharing the subject database transaction owner. */
export interface LearningStore {
  learningStatus(signal: AbortSignal): Promise<LearningStatus | undefined>;
  reserveLearning(goalId: string, phase: "study" | "assessment", expectedRevision: number, signal: AbortSignal): Promise<LearningAttempt>;
  completeLearning(attempt: LearningAttempt, result: LearningResult, at: string, signal: AbortSignal): Promise<import("../core/state.ts").SubjectState>;
  failLearning(attempt: LearningAttempt, signal: AbortSignal): Promise<void>;
  stopLearning(signal: AbortSignal): Promise<void>;
  recoverLearning(signal: AbortSignal): Promise<void>;
}
