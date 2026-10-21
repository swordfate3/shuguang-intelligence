import type { SelfState } from "./self-types.ts";
import type { AffectState } from "./affect-types.ts";
import type { AgencyState } from "./agency-types.ts";
import type { GrowthProposal } from "./growth-types.ts";

export interface SubjectState {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly self: SelfState;
  readonly affect: AffectState;
  readonly agency: AgencyState;
  readonly growthProposals: readonly GrowthProposal[];
  readonly memoryIds: readonly string[];
  readonly lifecycle: "sleeping" | "awake";
  readonly updatedAt: string;
}

/** Initial values are explicit bootstrap defaults, not learned traits or restored memories. */
export function createInitialState(id: string, name: string, at: string): SubjectState {
  const date = new Date(at);
  if (!id.trim() || !name.trim() || !Number.isFinite(date.getTime()) || date.toISOString() !== at) {
    throw new Error("Invalid initial identity or timestamp");
  }
  return {
    schemaVersion: 1,
    revision: 0,
    self: {
      identity: { id, name },
      personality: { curiosity: 0.5, caution: 0.5, expressiveness: 0.5, sociability: 0.5 },
      beliefs: [], interests: [], relationships: [], commitments: [],
    },
    affect: { valence: 0, arousal: 0, tension: 0, updatedAt: at, episodes: [] },
    agency: {
      motivations: { curiosity: 0, competence: 0, connection: 0, recreation: 0, rest: 0 },
      intentions: [], activeActivityId: null,
    },
    growthProposals: [], memoryIds: [], lifecycle: "sleeping", updatedAt: at,
  };
}
