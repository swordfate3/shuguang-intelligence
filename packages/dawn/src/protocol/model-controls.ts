/** Transport data only; no credentials, endpoint, subject data or Pi state. */
export const THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export interface ModelSelectionState {
  readonly selectionRevision: number;
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly levels: readonly ThinkingLevel[];
  readonly models: readonly string[];
  readonly calls: number;
  readonly maxCalls: number;
}
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}
export function isModelId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim() &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}
