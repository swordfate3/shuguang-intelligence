import type { SubjectState } from "./state.ts";

class InvalidSubjectStateError extends Error {
  constructor(path: string) {
    super(`Invalid subject state: ${path}`);
    this.name = "InvalidSubjectStateError";
  }
}

type Snapshot = Record<string, unknown>;

function invalid(path: string): never {
  throw new InvalidSubjectStateError(path);
}

/** Read a schema object as data only, rejecting missing, extra, and accessor fields. */
function objectAt(value: unknown, path: string, fields: readonly string[]): Snapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path);

  const object = value as object;
  const result: Snapshot = Object.create(null) as Snapshot;
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== "string" || !fields.includes(key)) invalid(`${path}.<unknown>`);
  }
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(object, field);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid(`${path}.${field}`);
    result[field] = descriptor.value;
  }
  return result;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path);
  const array = value as unknown[];
  const length = array.length;
  for (const key of Reflect.ownKeys(array)) {
    if (key === "length") continue;
    if (typeof key !== "string") invalid(`${path}.<unknown>`);
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
      invalid(`${path}.<unknown>`);
    }
  }

  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
    if (!descriptor || !("value" in descriptor)) invalid(`${path}[${index}]`);
    items.push(descriptor.value);
  }
  return items;
}

function stringAt(value: unknown, path: string): void {
  if (typeof value !== "string" || value.trim().length === 0) invalid(path);
}

function numberAt(value: unknown, path: string, minimum: number, maximum: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(path);
  }
}

function enumAt(value: unknown, path: string, values: readonly string[]): void {
  if (typeof value !== "string" || !values.includes(value)) invalid(path);
}

function timestampAt(value: unknown, path: string): void {
  if (typeof value !== "string") invalid(path);
  try {
    if (new Date(value).toISOString() !== value) invalid(path);
  } catch {
    invalid(path);
  }
}

function stringsAt(value: unknown, path: string): void {
  arrayAt(value, path).forEach((item, index) => stringAt(item, `${path}[${index}]`));
}

function validateSubjectState(value: unknown): void {
  const state = objectAt(value, "state", [
    "schemaVersion", "revision", "self", "affect", "agency", "growthProposals",
    "memoryIds", "lifecycle", "updatedAt",
  ]);
  if (state.schemaVersion !== 1) invalid("state.schemaVersion");
  if (typeof state.revision !== "number" || !Number.isSafeInteger(state.revision) || state.revision < 0) {
    invalid("state.revision");
  }
  timestampAt(state.updatedAt, "state.updatedAt");
  enumAt(state.lifecycle, "state.lifecycle", ["sleeping", "awake"]);
  stringsAt(state.memoryIds, "state.memoryIds");

  const self = objectAt(state.self, "state.self", [
    "identity", "personality", "beliefs", "interests", "relationships", "commitments",
  ]);
  const identity = objectAt(self.identity, "state.self.identity", ["id", "name"]);
  stringAt(identity.id, "state.self.identity.id");
  stringAt(identity.name, "state.self.identity.name");

  const personality = objectAt(self.personality, "state.self.personality", [
    "curiosity", "caution", "expressiveness", "sociability",
  ]);
  for (const field of ["curiosity", "caution", "expressiveness", "sociability"]) {
    numberAt(personality[field], `state.self.personality.${field}`, 0, 1);
  }

  arrayAt(self.beliefs, "state.self.beliefs").forEach((item, index) => {
    const path = `state.self.beliefs[${index}]`;
    const belief = objectAt(item, path, ["statement", "evidenceIds", "status"]);
    stringAt(belief.statement, `${path}.statement`);
    stringsAt(belief.evidenceIds, `${path}.evidenceIds`);
    enumAt(belief.status, `${path}.status`, ["tentative", "supported", "disputed"]);
  });

  arrayAt(self.interests, "state.self.interests").forEach((item, index) => {
    const path = `state.self.interests[${index}]`;
    const interest = objectAt(item, path, ["topic", "strength", "evidenceIds"]);
    stringAt(interest.topic, `${path}.topic`);
    numberAt(interest.strength, `${path}.strength`, 0, 1);
    stringsAt(interest.evidenceIds, `${path}.evidenceIds`);
  });

  arrayAt(self.relationships, "state.self.relationships").forEach((item, index) => {
    const path = `state.self.relationships[${index}]`;
    const relationship = objectAt(item, path, [
      "personId", "statedBoundaries", "sharedMemoryIds", "subjectiveView",
    ]);
    stringAt(relationship.personId, `${path}.personId`);
    stringsAt(relationship.statedBoundaries, `${path}.statedBoundaries`);
    stringsAt(relationship.sharedMemoryIds, `${path}.sharedMemoryIds`);
    stringAt(relationship.subjectiveView, `${path}.subjectiveView`);
  });

  arrayAt(self.commitments, "state.self.commitments").forEach((item, index) => {
    const path = `state.self.commitments[${index}]`;
    const commitment = objectAt(item, path, ["id", "description", "status", "evidenceIds"]);
    stringAt(commitment.id, `${path}.id`);
    stringAt(commitment.description, `${path}.description`);
    enumAt(commitment.status, `${path}.status`, ["open", "fulfilled", "withdrawn"]);
    stringsAt(commitment.evidenceIds, `${path}.evidenceIds`);
  });

  const affect = objectAt(state.affect, "state.affect", [
    "valence", "arousal", "tension", "updatedAt", "episodes",
  ]);
  numberAt(affect.valence, "state.affect.valence", -1, 1);
  numberAt(affect.arousal, "state.affect.arousal", 0, 1);
  numberAt(affect.tension, "state.affect.tension", 0, 1);
  timestampAt(affect.updatedAt, "state.affect.updatedAt");
  arrayAt(affect.episodes, "state.affect.episodes").forEach((item, index) => {
    const path = `state.affect.episodes[${index}]`;
    const episode = objectAt(item, path, ["id", "label", "intensity", "sourceEventIds", "startedAt"]);
    stringAt(episode.id, `${path}.id`);
    stringAt(episode.label, `${path}.label`);
    numberAt(episode.intensity, `${path}.intensity`, 0, 1);
    stringsAt(episode.sourceEventIds, `${path}.sourceEventIds`);
    timestampAt(episode.startedAt, `${path}.startedAt`);
  });

  const agency = objectAt(state.agency, "state.agency", ["motivations", "intentions", "activeActivityId"]);
  const motivations = objectAt(agency.motivations, "state.agency.motivations", [
    "curiosity", "competence", "connection", "recreation", "rest",
  ]);
  for (const field of ["curiosity", "competence", "connection", "recreation", "rest"]) {
    numberAt(motivations[field], `state.agency.motivations.${field}`, 0, 1);
  }
  arrayAt(agency.intentions, "state.agency.intentions").forEach((item, index) => {
    const path = `state.agency.intentions[${index}]`;
    const intention = objectAt(item, path, ["id", "origin", "description", "reasonIds", "status", "priority"]);
    stringAt(intention.id, `${path}.id`);
    enumAt(intention.origin, `${path}.origin`, ["user", "commitment", "self"]);
    stringAt(intention.description, `${path}.description`);
    stringsAt(intention.reasonIds, `${path}.reasonIds`);
    enumAt(intention.status, `${path}.status`, ["proposed", "ready", "active", "waiting", "completed", "abandoned"]);
    numberAt(intention.priority, `${path}.priority`, 0, 1);
  });
  if (agency.activeActivityId !== null) stringAt(agency.activeActivityId, "state.agency.activeActivityId");

  arrayAt(state.growthProposals, "state.growthProposals").forEach((item, index) => {
    const path = `state.growthProposals[${index}]`;
    const proposal = objectAt(item, path, ["id", "kind", "description", "evidenceIds", "status", "evaluationIds"]);
    stringAt(proposal.id, `${path}.id`);
    enumAt(proposal.kind, `${path}.kind`, ["knowledge", "method", "preference", "personality"]);
    stringAt(proposal.description, `${path}.description`);
    stringsAt(proposal.evidenceIds, `${path}.evidenceIds`);
    enumAt(proposal.status, `${path}.status`, ["candidate", "trial", "accepted", "rejected", "revoked"]);
    stringsAt(proposal.evaluationIds, `${path}.evaluationIds`);
  });
}

/**
 * Validate a complete schema-v1 subject snapshot without exposing snapshot values in errors.
 * This checks IDs for non-emptiness only; resolving references belongs to storage.
 */
export function assertSubjectState(value: unknown): asserts value is SubjectState {
  try {
    validateSubjectState(value);
  } catch (error) {
    if (error instanceof InvalidSubjectStateError) throw error;
    // Proxies and other exotic inputs may throw while being inspected; do not leak their data/errors.
    invalid("state");
  }
}
