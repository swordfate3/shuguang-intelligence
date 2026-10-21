/** Stable identity is separate from slowly evolving personality and self-beliefs. */
export interface SelfState {
  readonly identity: { readonly id: string; readonly name: string };
  readonly personality: {
    readonly curiosity: number;
    readonly caution: number;
    readonly expressiveness: number;
    readonly sociability: number;
  };
  readonly beliefs: readonly {
    readonly statement: string;
    readonly evidenceIds: readonly string[];
    readonly status: "tentative" | "supported" | "disputed";
  }[];
  readonly interests: readonly {
    readonly topic: string;
    readonly strength: number;
    readonly evidenceIds: readonly string[];
  }[];
  readonly relationships: readonly {
    readonly personId: string;
    readonly statedBoundaries: readonly string[];
    readonly sharedMemoryIds: readonly string[];
    readonly subjectiveView: string;
  }[];
  readonly commitments: readonly {
    readonly id: string;
    readonly description: string;
    readonly status: "open" | "fulfilled" | "withdrawn";
    readonly evidenceIds: readonly string[];
  }[];
}
