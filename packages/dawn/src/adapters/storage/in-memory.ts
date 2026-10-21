import type { SubjectState } from "../../legacy/state.ts";
import { assertSubjectState } from "../../legacy/validation.ts";
import { transitionLifecycle } from "../../runtime/lifecycle-transition.ts";
import type { LifecycleChange, StateChangeEvent, StateStore } from "../../runtime/state-store.ts";

/** Development/test adapter only. No disk writes; restart loses all state. */
export class InMemoryStateStore implements StateStore {
  #state: SubjectState;
  #events: StateChangeEvent[] = [];

  constructor(initial: SubjectState) {
    assertSubjectState(initial);
    this.#state = structuredClone(initial);
  }

  async read(signal: AbortSignal): Promise<SubjectState> {
    signal.throwIfAborted();
    return structuredClone(this.#state);
  }

  async changeLifecycle(change: LifecycleChange, signal: AbortSignal): Promise<SubjectState> {
    signal.throwIfAborted();
    const next = transitionLifecycle(this.#state, change);
    if (!next.event) return structuredClone(this.#state);
    // No await inside this critical section: CAS, event and state move together.
    this.#events.push(next.event);
    this.#state = next.state;
    return structuredClone(this.#state);
  }

  events(): readonly StateChangeEvent[] {
    return structuredClone(this.#events);
  }
}
