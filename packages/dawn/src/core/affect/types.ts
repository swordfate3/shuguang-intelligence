/** Appraisals are untrusted interpretations of evidence, not arbitrary target moods. */
export interface Appraisal {
  readonly evidenceIds: readonly string[];
  readonly concernId: string;
  readonly desirability: number;
  readonly expectedness: number;
  readonly controllability: number;
  readonly intensity: number;
}
export interface AffectState {
  readonly valence: number;
  readonly arousal: number;
  readonly tension: number;
  readonly updatedAt: string;
  readonly episodes: readonly {
    readonly id: string;
    readonly label: "satisfaction" | "concern" | "frustration" | "surprise";
    readonly intensity: number;
    readonly sourceEventIds: readonly string[];
    readonly concernId: string;
    readonly startedAt: string;
  }[];
}
