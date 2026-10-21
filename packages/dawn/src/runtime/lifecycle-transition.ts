import type { SubjectState } from "../legacy/state.ts";
import { RevisionConflictError } from "./state-store.ts";
import type { LifecycleChange, StateChangeEvent } from "./state-store.ts";

/** Pure transition shared by memory and durable stores. No permissions or external effects. */
export function transitionLifecycle(state: SubjectState, change: LifecycleChange): {
  state: SubjectState;
  event: StateChangeEvent | null;
} {
  if (!Number.isSafeInteger(change.expectedRevision) || change.expectedRevision !== state.revision) {
    throw new RevisionConflictError();
  }
  if (change.lifecycle !== "awake" && change.lifecycle !== "sleeping") throw new Error("Invalid lifecycle");
  const date = new Date(change.at);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== change.at || date.getTime() < Date.parse(state.updatedAt)) {
    throw new Error("Invalid or backwards timestamp");
  }
  if (change.lifecycle === state.lifecycle) return { state, event: null };
  const revision = state.revision + 1;
  if (!Number.isSafeInteger(revision)) throw new Error("Revision overflow");
  return {
    state: { ...state, revision, lifecycle: change.lifecycle, updatedAt: change.at },
    event: {
      id: `${state.self.identity.id}:${revision}`, type: "lifecycle_changed", revision,
      from: state.lifecycle, to: change.lifecycle, at: change.at,
    },
  };
}
