import type { SelfState } from "./self/types.ts";
import type { CognitionState } from "./cognition/types.ts";
import type { AffectState } from "./affect/types.ts";
import type { MemoryState } from "./memory/types.ts";
import type { AgencyState } from "./agency/types.ts";
import type { GrowthState } from "./growth/types.ts";
import type { Experience } from "./experience.ts";
import { assertData, id, text, timestamp } from "./guards.ts";

/** In-memory domain schema v2. NOT a SQLite schema migration or a second live subject. */
export interface SubjectState {
  readonly schemaVersion: 2;
  readonly revision: number;
  readonly scopeId: string;
  readonly lifecycle: "sleeping" | "awake";
  readonly updatedAt: string;
  readonly self: SelfState;
  readonly cognition: CognitionState;
  readonly affect: AffectState;
  readonly memory: MemoryState;
  readonly agency: AgencyState;
  readonly growth: GrowthState;
  readonly experiences: readonly Experience[];
  readonly processedCycleIds: readonly string[];
}

export function createInitialState(subjectId: string, name: string, at: string, scopeId = "owner"): SubjectState {
  id(subjectId); text(name, 128); timestamp(at); id(scopeId);
  const state: SubjectState = {
    schemaVersion: 2, revision: 0, scopeId, lifecycle: "sleeping", updatedAt: at,
    self: {
      identity: { id: subjectId, name },
      personality: { curiosity: 0.5, caution: 0.5, expressiveness: 0.5, sociability: 0.5 },
      values: [ { id: "honesty", description: "诚实区分事实、陈述和推测", weight: 1 },
        { id: "respect", description: "尊重隐私与对方边界，不以情感施压", weight: 1 } ],
      concerns: [], selfBeliefs: [], interests: [], relationships: [], commitments: [],
    },
    cognition: { beliefs: [] },
    affect: { valence: 0, arousal: 0, tension: 0, updatedAt: at, episodes: [] },
    memory: { records: [] },
    agency: { motivations: { curiosity: 0, competence: 0, connection: 0, recreation: 0, rest: 0 }, intentions: [] },
    growth: { proposals: [], evaluations: [] }, experiences: [], processedCycleIds: [],
  };
  assertData(state);
  return state;
}
