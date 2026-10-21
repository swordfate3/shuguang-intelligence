/** Engineering state, not evidence of subjective consciousness. All axes are bounded. */
export interface AffectState {
  readonly valence: number; // [-1, 1]
  readonly arousal: number; // [0, 1]
  readonly tension: number; // [0, 1]
  readonly updatedAt: string;
  readonly episodes: readonly {
    readonly id: string;
    readonly label: string;
    readonly intensity: number;
    readonly sourceEventIds: readonly string[];
    readonly startedAt: string;
  }[];
}
