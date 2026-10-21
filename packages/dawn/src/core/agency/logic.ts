import { createHash } from "node:crypto";
import { assertData, choice, clamp, id, ids, list, object, text, unit } from "../guards.ts";
import type { AffectState } from "../affect/types.ts";
import { assertAffect } from "../affect/logic.ts";
import type { SelfState } from "../self/types.ts";
import { assertSelf } from "../self/logic.ts";
import type { ActivityKind, ActivityOption, AgencyState, Intention } from "./types.ts";

const MAX_ITEMS = 1000;
const KINDS = ["reply", "learn", "recreate", "reflect", "rest"] as const;
const SCORE_THRESHOLD = 0.2;

export interface IntentionContext {
  readonly experienceId: string;
  readonly availableBudget: number;
  readonly stopRequested: boolean;
  /** Normalized unresolved workspace signal; a heuristic, not a confidence estimate. */
  readonly uncertainty?: number;
}

function assertIntention(value: unknown): asserts value is Intention {
  const intention = object(value, ["id", "activityId", "kind", "description", "reasonIds", "score", "status"]);
  id(intention.id);
  id(intention.activityId);
  choice(intention.kind, KINDS);
  text(intention.description, 2048);
  ids(intention.reasonIds, MAX_ITEMS);
  if (intention.reasonIds.length === 0) throw new Error("Intention reason required");
  unit(intention.score);
  choice(intention.status, ["proposed"]);
}

/** Validate an agency snapshot; proposed intentions are not execution authority. */
export function assertAgency(value: unknown): asserts value is AgencyState {
  assertData(value);
  const state = object(value, ["motivations", "intentions"]);
  const motivations = object(state.motivations, ["curiosity", "competence", "connection", "recreation", "rest"]);
  unit(motivations.curiosity); unit(motivations.competence); unit(motivations.connection);
  unit(motivations.recreation); unit(motivations.rest);
  list(state.intentions, MAX_ITEMS);
  const seen = new Set<string>();
  for (const item of state.intentions) {
    assertIntention(item);
    if (seen.has(item.id)) throw new Error("Duplicate intention ID");
    seen.add(item.id);
  }
}

function assertOption(value: unknown): asserts value is ActivityOption {
  const option = object(value, ["id", "kind", "description", "topics", "evidenceIds", "cost", "available"]);
  id(option.id);
  choice(option.kind, KINDS);
  text(option.description, 2048);
  list(option.topics, 64);
  option.topics.forEach(topic => text(topic, 128));
  if (new Set((option.topics as string[]).map(topic => topic.toLowerCase())).size !== option.topics.length) {
    throw new Error("Duplicate activity topic");
  }
  ids(option.evidenceIds, MAX_ITEMS);
  if (option.evidenceIds.length > 0 && !(option.evidenceIds as string[]).every(Boolean)) throw new Error("Invalid option evidence");
  if (typeof option.cost !== "number" || !Number.isFinite(option.cost) || option.cost < 0) throw new Error("Invalid activity cost");
  if (typeof option.available !== "boolean") throw new Error("Invalid activity availability");
}

function optionRelevance(self: SelfState, topics: readonly string[]): number {
  const requested = new Set(topics.map(topic => topic.toLowerCase()));
  let relevance = 0;
  for (const interest of self.interests) {
    if (requested.has(interest.topic.toLowerCase())) relevance = Math.max(relevance, interest.strength);
  }
  for (const concern of self.concerns) {
    if (concern.topics.some(topic => requested.has(topic.toLowerCase()))) relevance = Math.max(relevance, concern.weight);
  }
  return relevance;
}

function optionScore(kind: ActivityKind, relevance: number, motivations: AgencyState["motivations"], uncertainty: number): number {
  switch (kind) {
    case "reply": return 0.6 * motivations.connection + 0.4 * relevance;
    // Uncertainty explicitly increases both learning and reflection preference;
    // these are deterministic prioritization heuristics, not calibrated beliefs.
    case "learn": return 0.45 * motivations.curiosity + 0.2 * motivations.competence + 0.2 * relevance + 0.15 * uncertainty;
    case "recreate": return 0.8 * motivations.recreation + 0.2 * relevance;
    case "reflect": return 0.4 * motivations.curiosity + 0.6 * uncertainty;
    // Rest is based only on affect tension/arousal, not an invented physiology.
    case "rest": return motivations.rest;
  }
}

function intentionId(experienceId: string, optionId: string, kind: ActivityKind): string {
  const canonical = JSON.stringify([experienceId, optionId, kind]);
  return `intent_${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Rank only caller-supplied options; never creates tasks, permissions or tool
 * authorization. Recreation has intrinsic heuristic value independent of
 * learning gain. Workspace uncertainty (default 0) boosts learn/reflect. Stop
 * means no proposed intention and does not change lifecycle or core snapshots.
 */
export function chooseIntention(self: SelfState, affect: AffectState, options: readonly ActivityOption[],
  context: IntentionContext): AgencyState {
  assertData({ self, affect, options, context });
  assertSelf(self);
  assertAffect(affect);
  list(options, MAX_ITEMS);
  const optionIds = new Set<string>();
  for (const option of options) {
    assertOption(option);
    if (optionIds.has(option.id)) throw new Error("Duplicate activity option ID");
    optionIds.add(option.id);
  }
  const contextFields = Object.hasOwn(context, "uncertainty")
    ? ["experienceId", "availableBudget", "stopRequested", "uncertainty"]
    : ["experienceId", "availableBudget", "stopRequested"];
  const checkedContext = object(context, contextFields);
  id(checkedContext.experienceId);
  const availableBudget = checkedContext.availableBudget;
  if (typeof availableBudget !== "number" || !Number.isFinite(availableBudget) ||
    availableBudget < 0 || availableBudget > Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid available budget");
  }
  if (typeof checkedContext.stopRequested !== "boolean") throw new Error("Invalid stop request");
  const uncertainty = checkedContext.uncertainty === undefined ? 0 : checkedContext.uncertainty;
  unit(uncertainty);

  const interest = self.interests.reduce((maximum, item) => Math.max(maximum, item.strength), 0);
  const concern = self.concerns.reduce((maximum, item) => Math.max(maximum, item.weight), 0);
  const motivations: AgencyState["motivations"] = {
    curiosity: clamp(0.65 * self.personality.curiosity + 0.25 * interest + 0.1 * uncertainty),
    competence: concern,
    connection: self.personality.sociability,
    // Recreation is intrinsically worthwhile; it is not a proxy for learning.
    recreation: 0.65 + 0.35 * self.personality.expressiveness,
    rest: clamp(0.6 * affect.tension + 0.4 * affect.arousal),
  };

  let intentions: Intention[] = [];
  if (!checkedContext.stopRequested) {
    const candidates = options
      .filter(option => option.available && option.cost <= availableBudget)
      .map(option => ({ option, score: optionScore(option.kind, optionRelevance(self, option.topics), motivations, uncertainty) }))
      .filter(candidate => candidate.score > SCORE_THRESHOLD)
      .sort((left, right) => right.score - left.score || (left.option.id < right.option.id ? -1 : left.option.id > right.option.id ? 1 : 0));
    const selected = candidates[0];
    if (selected) {
      const reasons = [...new Set([checkedContext.experienceId, ...selected.option.evidenceIds])];
      intentions = [{
        id: intentionId(checkedContext.experienceId, selected.option.id, selected.option.kind),
        activityId: selected.option.id,
        kind: selected.option.kind,
        description: selected.option.description,
        reasonIds: reasons,
        score: selected.score,
        status: "proposed",
      }];
    }
  }
  const next: AgencyState = structuredClone({ motivations, intentions });
  assertAgency(next);
  return next;
}
