import { assertData, choice, id, ids, list, object, text, timestamp, unit } from "../guards.ts";
import type { SelfState } from "./types.ts";

const PERSONALITY_AXES = ["curiosity", "caution", "expressiveness", "sociability"] as const;
const MAX_ITEMS = 1000;

/** Validate the complete self snapshot without invoking accessors or accepting unknown fields. */
export function assertSelf(value: unknown): asserts value is SelfState {
  assertData(value);
  const self = object(value, ["identity", "personality", "values", "concerns", "selfBeliefs", "interests", "relationships", "commitments"]);

  const identity = object(self.identity, ["id", "name"]);
  id(identity.id);
  text(identity.name, 128);

  const personality = object(self.personality, PERSONALITY_AXES);
  for (const axis of PERSONALITY_AXES) unit(personality[axis]);

  list(self.values, MAX_ITEMS);
  const valueIds = new Set<string>();
  for (const item of self.values) {
    const entry = object(item, ["id", "description", "weight"]);
    id(entry.id);
    if (valueIds.has(entry.id)) throw new Error("Duplicate self value ID");
    valueIds.add(entry.id);
    text(entry.description, 2048);
    unit(entry.weight);
  }

  list(self.concerns, MAX_ITEMS);
  const concernIds = new Set<string>();
  for (const item of self.concerns) {
    const entry = object(item, ["id", "description", "topics", "weight"]);
    id(entry.id);
    if (concernIds.has(entry.id)) throw new Error("Duplicate self concern ID");
    concernIds.add(entry.id);
    text(entry.description, 2048);
    list(entry.topics, MAX_ITEMS);
    const topics = new Set<string>();
    for (const topic of entry.topics) {
      text(topic, 128);
      const key = topic.toLowerCase();
      if (topics.has(key)) throw new Error("Duplicate self concern topic");
      topics.add(key);
    }
    unit(entry.weight);
  }

  list(self.selfBeliefs, MAX_ITEMS);
  const beliefIds = new Set<string>();
  for (const item of self.selfBeliefs) {
    const entry = object(item, ["id", "statement", "evidenceIds", "status"]);
    id(entry.id);
    if (beliefIds.has(entry.id)) throw new Error("Duplicate self-belief ID");
    beliefIds.add(entry.id);
    text(entry.statement, 2048);
    ids(entry.evidenceIds, MAX_ITEMS);
    choice(entry.status, ["tentative", "supported", "disputed"]);
  }

  list(self.interests, MAX_ITEMS);
  const interestTopics = new Set<string>();
  for (const item of self.interests) {
    const entry = object(item, ["topic", "strength", "evidenceIds"]);
    text(entry.topic, 128);
    const key = entry.topic.toLowerCase();
    if (interestTopics.has(key)) throw new Error("Duplicate self interest topic");
    interestTopics.add(key);
    unit(entry.strength);
    ids(entry.evidenceIds, MAX_ITEMS);
  }

  list(self.relationships, MAX_ITEMS);
  const personIds = new Set<string>();
  for (const item of self.relationships) {
    const entry = object(item, ["personId", "boundaries", "evidenceIds"]);
    id(entry.personId);
    if (personIds.has(entry.personId)) throw new Error("Duplicate self relationship ID");
    personIds.add(entry.personId);
    list(entry.boundaries, MAX_ITEMS);
    entry.boundaries.forEach(boundary => text(boundary, 256));
    ids(entry.evidenceIds, MAX_ITEMS);
  }

  list(self.commitments, MAX_ITEMS);
  const commitmentIds = new Set<string>();
  for (const item of self.commitments) {
    const entry = object(item, ["id", "description", "status", "evidenceIds"]);
    id(entry.id);
    if (commitmentIds.has(entry.id)) throw new Error("Duplicate self commitment ID");
    commitmentIds.add(entry.id);
    text(entry.description, 2048);
    choice(entry.status, ["open", "fulfilled", "withdrawn"]);
    ids(entry.evidenceIds, MAX_ITEMS);
  }
}

/** Exact, case-insensitive topic overlap; no model inference or fuzzy matching. */
export function selfRelevance(self: SelfState, topics: readonly string[]): number {
  assertSelf(self);
  assertData(topics);
  list(topics, MAX_ITEMS);
  const requested = new Set<string>();
  for (const topic of topics) {
    text(topic, 128);
    requested.add(topic.toLowerCase());
  }

  let score = 0;
  for (const interest of self.interests) {
    if (requested.has(interest.topic.toLowerCase())) score = Math.max(score, interest.strength);
  }
  for (const concern of self.concerns) {
    if (concern.topics.some(topic => requested.has(topic.toLowerCase()))) score = Math.max(score, concern.weight);
  }
  return score;
}

export type ProjectedSelf = Pick<SelfState, "identity" | "personality" | "values" | "interests">;

/** Public/minimal model projection. Private beliefs, relationships, concerns and commitments are omitted. */
export function projectSelf(self: SelfState): ProjectedSelf {
  assertSelf(self);
  return structuredClone({
    identity: self.identity,
    personality: self.personality,
    values: self.values,
    interests: self.interests,
  });
}
