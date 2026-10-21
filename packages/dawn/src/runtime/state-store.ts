import type { SubjectState } from "../legacy/state.ts";

export interface LifecycleChange {
  readonly expectedRevision: number;
  readonly lifecycle: SubjectState["lifecycle"];
  readonly at: string;
}

export interface StateChangeEvent {
  readonly id: string;
  readonly type: "lifecycle_changed";
  readonly revision: number;
  readonly from: SubjectState["lifecycle"];
  readonly to: SubjectState["lifecycle"];
  readonly at: string;
}

export interface StateStore {
  read(signal: AbortSignal): Promise<SubjectState>;
  /** Atomically CAS state and append event. No-op changes must not append duplicate events. */
  changeLifecycle(change: LifecycleChange, signal: AbortSignal): Promise<SubjectState>;
}

export class RevisionConflictError extends Error {
  constructor() {
    super("State revision conflict; read current state before proposing another change");
    this.name = "RevisionConflictError";
  }
}
