import type { StateStore } from "./state-store.ts";

/** Lifecycle only: waking does not imply autonomous scheduling or model calls. */
export class LifecycleController {
  readonly #store: StateStore;
  readonly #now: () => string;

  constructor(store: StateStore, now: () => string = () => new Date().toISOString()) {
    this.#store = store;
    this.#now = now;
  }

  status(signal: AbortSignal) {
    return this.#store.read(signal);
  }

  wake(expectedRevision: number, signal: AbortSignal) {
    return this.#store.changeLifecycle({ expectedRevision, lifecycle: "awake", at: this.#now() }, signal);
  }

  sleep(expectedRevision: number, signal: AbortSignal) {
    return this.#store.changeLifecycle({ expectedRevision, lifecycle: "sleeping", at: this.#now() }, signal);
  }
}
