export type ActivityKind = "reply" | "learn" | "recreate" | "reflect" | "rest";
export interface ActivityOption {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly description: string;
  readonly topics: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly cost: number;
  readonly available: boolean;
}
/** A proposed intention has no execution authorization or tool capability. */
export interface Intention {
  readonly id: string;
  readonly activityId: string;
  readonly kind: ActivityKind;
  readonly description: string;
  readonly reasonIds: readonly string[];
  readonly score: number;
  readonly status: "proposed";
}
export interface AgencyState {
  readonly motivations: { readonly curiosity: number; readonly competence: number; readonly connection: number; readonly recreation: number; readonly rest: number };
  readonly intentions: readonly Intention[];
}
