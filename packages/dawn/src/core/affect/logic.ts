import { createHash } from "node:crypto";
import { evidenceRoots } from "../evidence.ts";
import { assertExperience, resolveEvidence, type Experience } from "../experience.ts";
import { assertData, choice, clamp, id, ids, list, object, timestamp, unit } from "../guards.ts";
import { assertSelf } from "../self/logic.ts";
import type { SelfState } from "../self/types.ts";
import type { AffectState, Appraisal } from "./types.ts";

const MAX_EPISODES = 10000;
const MAX_EXPERIENCES = 1000;
const MAX_EVIDENCE = 32;
const HALF_LIFE_MS = 6 * 60 * 60 * 1000;
const MAX_EVENT_DELTA = 0.2;
const LABELS = ["satisfaction", "concern", "frustration", "surprise"] as const;

function assertAppraisal(value: unknown): asserts value is Appraisal {
  const appraisal = object(value, ["evidenceIds", "concernId", "desirability", "expectedness", "controllability", "intensity"]);
  ids(appraisal.evidenceIds, MAX_EVIDENCE);
  if (appraisal.evidenceIds.length === 0) throw new Error("Affect appraisal evidence required");
  id(appraisal.concernId);
  unit(appraisal.desirability, -1, 1);
  unit(appraisal.expectedness);
  unit(appraisal.controllability);
  unit(appraisal.intensity);
}

/** Validate the exact, data-only affect schema and its episode provenance. */
export function assertAffect(value: unknown): asserts value is AffectState {
  assertData(value);
  const state = object(value, ["valence", "arousal", "tension", "updatedAt", "episodes"]);
  unit(state.valence, -1, 1);
  unit(state.arousal);
  unit(state.tension);
  timestamp(state.updatedAt);
  list(state.episodes, MAX_EPISODES);

  const episodeIds = new Set<string>();
  const sourcesByConcern = new Set<string>();
  for (const item of state.episodes) {
    const episode = object(item, ["id", "label", "intensity", "sourceEventIds", "concernId", "startedAt"]);
    id(episode.id);
    if (episodeIds.has(episode.id)) throw new Error("Duplicate affect episode ID");
    episodeIds.add(episode.id);
    choice(episode.label, LABELS);
    unit(episode.intensity);
    ids(episode.sourceEventIds, MAX_EVIDENCE);
    if (episode.sourceEventIds.length === 0) throw new Error("Affect episode source required");
    id(episode.concernId);
    timestamp(episode.startedAt);
    if (episode.startedAt > state.updatedAt) throw new Error("Future affect episode");
    for (const sourceId of episode.sourceEventIds) {
      const key = `${episode.concernId}\u0000${sourceId}`;
      if (sourcesByConcern.has(key)) throw new Error("Repeated concern/source affect episode");
      sourcesByConcern.add(key);
    }
  }
}

function checkedExperiences(value: readonly Experience[]): readonly Experience[] {
  list(value, MAX_EXPERIENCES);
  const seen = new Set<string>();
  for (const experience of value) {
    assertExperience(experience);
    if (seen.has(experience.id)) throw new Error("Duplicate experience ID");
    seen.add(experience.id);
  }
  return value;
}

function episodeLabel(appraisal: Appraisal): AffectState["episodes"][number]["label"] {
  if (appraisal.expectedness <= 0.35 && appraisal.intensity >= 0.35) return "surprise";
  if (appraisal.desirability >= 0.25) return "satisfaction";
  if (appraisal.desirability <= -0.25 && appraisal.controllability <= 0.5) return "frustration";
  return "concern";
}

function episodeId(subjectId: string, scopeId: string, at: string, concernId: string, evidenceIds: readonly string[]): string {
  const canonical = JSON.stringify([subjectId, scopeId, at, concernId, [...evidenceIds].sort()]);
  return `affect_${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Apply deterministic appraisal rules to a snapshot; never changes SelfState.
 * The six-hour half-life is an explicit engineering heuristic for regression to
 * the neutral baseline, not an EMA reconstruction, psychological measurement,
 * evidence of consciousness, or proof of a felt mood. Episodes are append-only:
 * a repeated evidence/concern pair is rejected, while the same evidence may
 * support a distinct concern. This prevents duplicate impact without erasing
 * provenance. Each appraisal changes any one affect axis by at most 0.2.
 */
export function appraiseAffect(state: AffectState, self: SelfState, appraisal: Appraisal | null,
  experiences: readonly Experience[], subjectId: string, scopeId: string, at: string): AffectState {
  assertData({ state, self, appraisal, experiences, subjectId, scopeId, at });
  assertAffect(state);
  assertSelf(self);
  id(subjectId); id(scopeId); timestamp(at);
  if (self.identity.id !== subjectId) throw new Error("Affect subject does not match self");
  if (at < state.updatedAt) throw new Error("Affect time cannot move backwards");
  const available = checkedExperiences(experiences);

  const elapsedMs = Date.parse(at) - Date.parse(state.updatedAt);
  const decay = 2 ** (-elapsedMs / HALF_LIFE_MS);
  let valence = state.valence * decay;
  let arousal = state.arousal * decay;
  let tension = state.tension * decay;
  let episodes = state.episodes;

  if (appraisal !== null) {
    assertData(appraisal);
    assertAppraisal(appraisal);
    const concern = self.concerns.find(candidate => candidate.id === appraisal.concernId);
    if (!concern) throw new Error("Affect appraisal concern is not in self");
    const evidence = resolveEvidence(appraisal.evidenceIds, available, subjectId, scopeId, at);
    const concernTopics = new Set(concern.topics.map(topic => topic.toLowerCase()));
    if (!evidence.some(item => item.topics.some(topic => concernTopics.has(topic.toLowerCase())))) {
      throw new Error("Affect evidence is unrelated to concern topics");
    }
    const evidenceIds = [...appraisal.evidenceIds].sort();
    const roots = new Set(evidenceRoots(evidenceIds, available, subjectId, scopeId, at));
    for (const episode of state.episodes) {
      if (episode.concernId !== concern.id) continue;
      const previousRoots = new Set(evidenceRoots(episode.sourceEventIds, available, subjectId, scopeId, at));
      if ([...roots].some(root => previousRoots.has(root))) {
        throw new Error("Affect evidence already impacted this concern");
      }
    }

    const magnitude = MAX_EVENT_DELTA * concern.weight * appraisal.intensity;
    const valenceDelta = magnitude * appraisal.desirability;
    const arousalDelta = magnitude * (0.5 + 0.5 * (1 - appraisal.expectedness));
    const tensionDelta = magnitude * (
      Math.max(0, -appraisal.desirability) * (1 - appraisal.controllability) -
      Math.max(0, appraisal.desirability) * appraisal.controllability
    );
    // Defensive clamp also defines the bounded affect-state ranges.
    valence = clamp(valence + clamp(valenceDelta, -MAX_EVENT_DELTA, MAX_EVENT_DELTA), -1, 1);
    arousal = clamp(arousal + clamp(arousalDelta, -MAX_EVENT_DELTA, MAX_EVENT_DELTA));
    tension = clamp(tension + clamp(tensionDelta, -MAX_EVENT_DELTA, MAX_EVENT_DELTA));
    const episode = {
      id: episodeId(subjectId, scopeId, at, concern.id, evidenceIds),
      label: episodeLabel(appraisal),
      intensity: appraisal.intensity * concern.weight,
      sourceEventIds: evidenceIds,
      concernId: concern.id,
      startedAt: at,
    } as const;
    if (state.episodes.some(existing => existing.id === episode.id)) throw new Error("Duplicate affect episode ID");
    episodes = [...state.episodes, episode];
  }

  const next: AffectState = structuredClone({ valence, arousal, tension, updatedAt: at, episodes });
  assertAffect(next);
  return next;
}
