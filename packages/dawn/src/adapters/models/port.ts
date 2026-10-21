/** Dawn owns credentials and model calls; Pi model state is not part of this port. */
export interface ModelPort {
  generate(request: {
    readonly messages: readonly { readonly role: "system" | "user" | "assistant"; readonly text: string }[];
    readonly maxOutputTokens: number;
  }, signal: AbortSignal): Promise<{
    readonly text: string;
    readonly modelId: string;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  }>;
}

/** Explicit failure rather than a fake companion answer. */
export class UnconfiguredModel implements ModelPort {
  async generate(_request: Parameters<ModelPort["generate"]>[0], signal: AbortSignal): Promise<never> {
    signal.throwIfAborted();
    throw new Error("MODEL_NOT_CONFIGURED: no model API is connected in this skeleton");
  }
}
