export interface Intention {
  readonly id: string;
  readonly origin: "user" | "commitment" | "self";
  readonly description: string;
  readonly reasonIds: readonly string[];
  readonly status: "proposed" | "ready" | "active" | "waiting" | "completed" | "abandoned";
  readonly priority: number;
}

/** Motivation is not authorization. No execution permissions belong in this state. */
export interface AgencyState {
  readonly motivations: {
    readonly curiosity: number;
    readonly competence: number;
    readonly connection: number;
    readonly recreation: number;
    readonly rest: number;
  };
  readonly intentions: readonly Intention[];
  readonly activeActivityId: string | null;
}
