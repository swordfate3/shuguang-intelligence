import type { Appraisal } from "../core/affect/types.ts";
import type { ChangeCandidate, CycleInput } from "../core/cycle.ts";
import type { Experience } from "../core/experience.ts";
import type { SubjectState } from "../core/state.ts";
import type { ModelPort } from "../adapters/models/port.ts";
import type { DialoguePair } from "./subject-store.ts";

export interface PreparedTurn {
  readonly input: CycleInput;
  readonly messages: Parameters<ModelPort["generate"]>[0]["messages"];
  readonly exposedEvidenceIds: readonly string[];
}
export interface Deliberation {
  readonly reply: string;
  readonly appraisal: Appraisal | null;
  readonly candidates: readonly ChangeCandidate[];
}
export interface PrepareTurnInput {
  readonly user: string; readonly cycleId: string; readonly experienceId: string; readonly at: string;
}
export type { Experience, SubjectState, DialoguePair };
