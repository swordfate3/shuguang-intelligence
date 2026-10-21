/** Dialogue evidence is separate from learned facts or changes to the subject personality. */
export interface ChatExchange {
  readonly user: string;
  readonly assistant: string;
}

export interface ChatReservation {
  readonly requestId: string;
  readonly sequence: number;
  readonly subjectRevision: number;
  readonly user: string;
  readonly history: readonly ChatExchange[];
}

export interface ChatBudget {
  readonly limit: number;
  readonly reserved: number;
  readonly completed: number;
  readonly failed: number;
  readonly pending: number;
}

/** One owner conversation per DB/token. IDs/scopes cannot be chosen by model or wire input. */
export interface ChatStore {
  /** Atomically charge before dispatch, snapshot bounded history, reject duplicate request IDs. */
  reserve(requestId: string, user: string, subjectRevision: number, signal: AbortSignal): Promise<ChatReservation>;
  /** Atomically persist user+assistant pair and usage, fenced by latest reservation sequence; lifecycle is rechecked by the service. */
  complete(reservation: ChatReservation, assistant: string, usage: {
    readonly modelId: string; readonly inputTokens: number; readonly outputTokens: number;
  }, signal: AbortSignal): Promise<void>;
  /** Charge is never refunded. No raw upstream errors, user text or credential in failure reason. */
  fail(reservation: ChatReservation, signal: AbortSignal): Promise<void>;
  budget(signal: AbortSignal): Promise<ChatBudget>;
}
