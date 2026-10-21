export interface CapabilityDescriptor {
  readonly id: string;
  readonly description: string;
  readonly effects: readonly ("network" | "filesystem" | "external_write" | "model_call")[];
  readonly requiredPermissions: readonly string[];
}

/** Authorization must be enforced by the executor, never by a model-provided flag. */
export interface CapabilityPort {
  list(): readonly CapabilityDescriptor[];
  execute(request: {
    readonly capabilityId: string;
    readonly actionId: string;
    readonly input: unknown;
  }, signal: AbortSignal): Promise<{ readonly output: unknown; readonly evidenceIds: readonly string[] }>;
}

export class UnavailableCapabilities implements CapabilityPort {
  list(): readonly CapabilityDescriptor[] { return []; }

  async execute(_request: Parameters<CapabilityPort["execute"]>[0], signal: AbortSignal): Promise<never> {
    signal.throwIfAborted();
    throw new Error("CAPABILITY_UNAVAILABLE: no external executor is connected");
  }
}
