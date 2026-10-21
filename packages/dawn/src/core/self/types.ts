/** Values influence preferences, never grant permissions. Only self-beliefs live here. */
export interface SelfState {
  readonly identity: { readonly id: string; readonly name: string };
  readonly personality: { readonly curiosity: number; readonly caution: number; readonly expressiveness: number; readonly sociability: number };
  readonly values: readonly { readonly id: string; readonly description: string; readonly weight: number }[];
  readonly concerns: readonly { readonly id: string; readonly description: string; readonly topics: readonly string[]; readonly weight: number }[];
  readonly selfBeliefs: readonly { readonly id: string; readonly statement: string; readonly evidenceIds: readonly string[]; readonly status: "tentative" | "supported" | "disputed" }[];
  readonly interests: readonly { readonly topic: string; readonly strength: number; readonly evidenceIds: readonly string[] }[];
  readonly relationships: readonly { readonly personId: string; readonly boundaries: readonly string[]; readonly evidenceIds: readonly string[] }[];
  readonly commitments: readonly { readonly id: string; readonly description: string; readonly status: "open" | "fulfilled" | "withdrawn"; readonly evidenceIds: readonly string[] }[];
}
