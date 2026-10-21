import { assertData, clamp, id, ids, list, object, text } from "./guards.ts";
import type { SubjectState } from "./state.ts";
import { assertSubjectState } from "./validation.ts";
import { chooseIntention } from "./agency/logic.ts";
import type { ActivityOption } from "./agency/types.ts";

export interface LearningQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly answer: string;
}

export interface LearningGoal {
  readonly id: string;
  readonly title: string;
  readonly topics: string[];
  readonly material: string;
  readonly practice: readonly LearningQuestion[];
  readonly assessment: readonly LearningQuestion[];
}

export interface LearningPack {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly goals: readonly LearningGoal[];
}

/** Study receives material and practice prompts; all answer keys remain private. */
export interface LearningStudyProjection {
  readonly title: string;
  readonly topics: readonly string[];
  readonly material: string;
  readonly practice: readonly { readonly id: string; readonly prompt: string }[];
}

/** Held-out assessment contains prompts only, never material or answer keys. */
export interface LearningAssessmentProjection {
  readonly title: string;
  readonly topics: readonly string[];
  readonly questions: readonly { readonly id: string; readonly prompt: string }[];
}

const PACK_MAX_BYTES = 64_000;
const MAX_GOALS = 16;
const MAX_QUESTIONS = 8;
const MAX_TOPICS = 6;

// Pack content is data, not a mechanism for fetching or including external resources.
const EXTERNAL_REFERENCE = /(?:\b(?:https?|ftp|file|data|mailto|javascript|blob|smb|ssh):(?:\/\/)?[^\s<>"']*|\bwww\.[^\s<>"']+|\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?:\/[^\s<>"']*)?|\b(?:[A-Za-z0-9-]{2,}\.)+[A-Za-z]{2,63}(?::\d+)?(?:\/[^\s<>"']*)?|(?:^|[\s"'(])(?:\.\.?\/|~\/|\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+|[A-Za-z]:[\\/])[^\s"'<>)]*|\b[A-Za-z0-9_.-]{2,}\/[A-Za-z0-9_.-]{2,}(?:\/[A-Za-z0-9_.-]+)*|\b[A-Za-z0-9_.-]+\.(?:txt|md|pdf|json|csv|xml|html?|ya?ml|toml|ini|log|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|svg|zip|gz|tar|mp[34]|wav|sqlite3?|db)\b|\b[A-Za-z0-9_.-]+\\[A-Za-z0-9_.-]+(?:\\[A-Za-z0-9_.-]+)*)/iu;

function packText(value: unknown, max: number): asserts value is string {
  text(value, max);
  if (EXTERNAL_REFERENCE.test(value)) throw new Error("Learning pack cannot contain external URLs or file references");
}

/**
 * Build JSON-safe copies with null prototypes before measuring. This avoids
 * invoking inherited toJSON hooks after assertData has checked own fields.
 */
function safeJsonCopy(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const copy = Object.setPrototypeOf([], null) as unknown[];
    for (let index = 0; index < value.length; index++) {
      copy[index] = safeJsonCopy(Object.getOwnPropertyDescriptor(value, String(index))!.value);
    }
    return copy;
  }
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    copy[key] = safeJsonCopy(Object.getOwnPropertyDescriptor(value, key)!.value);
  }
  return copy;
}

function assertQuestion(value: unknown, seenIds: Set<string>): asserts value is LearningQuestion {
  const question = object(value, ["id", "prompt", "answer"]);
  id(question.id);
  if (seenIds.has(question.id)) throw new Error("Duplicate learning pack identifier");
  seenIds.add(question.id);
  packText(question.prompt, 1000);
  packText(question.answer, 256);
}

function assertQuestionList(value: unknown, seenIds: Set<string>): asserts value is LearningQuestion[] {
  list(value, MAX_QUESTIONS);
  if (value.length === 0) throw new Error("Learning question group must not be empty");
  for (const question of value) assertQuestion(question, seenIds);
}

function assertGoal(value: unknown, seenIds: Set<string>): asserts value is LearningGoal {
  const goal = object(value, ["id", "title", "topics", "material", "practice", "assessment"]);
  id(goal.id);
  if (seenIds.has(goal.id)) throw new Error("Duplicate learning pack identifier");
  seenIds.add(goal.id);
  packText(goal.title, 256);
  list(goal.topics, MAX_TOPICS);
  goal.topics.forEach(topic => packText(topic, 128));
  if (new Set((goal.topics as string[]).map(topic => topic.toLowerCase())).size !== goal.topics.length) {
    throw new Error("Duplicate learning topic");
  }
  packText(goal.material, 6000);
  assertQuestionList(goal.practice, seenIds);
  assertQuestionList(goal.assessment, seenIds);
}

/** Strict, data-only, bounded validation for imported learning packs. */
export function assertLearningPack(value: unknown): asserts value is LearningPack {
  assertData(value);
  const pack = object(value, ["version", "id", "title", "goals"]);
  if (pack.version !== 1) throw new Error("Unsupported learning pack version");
  id(pack.id);
  packText(pack.title, 256);
  list(pack.goals, MAX_GOALS);
  if (pack.goals.length === 0) throw new Error("Learning pack needs at least one goal");

  // Pack identity is separate metadata; only goal and question IDs share a namespace.
  const seenIds = new Set<string>();
  for (const goal of pack.goals) assertGoal(goal, seenIds);
  if (Buffer.byteLength(JSON.stringify(safeJsonCopy(value)), "utf8") > PACK_MAX_BYTES) {
    throw new Error("Learning pack exceeds 64000-byte limit");
  }
}

/** Scan valid JSON syntax to reject duplicate object keys before JSON.parse loses them. */
function rejectDuplicateJsonKeys(source: string): void {
  let index = 0;
  const whitespace = (): void => { while (/\s/u.test(source[index] ?? "")) index++; };
  const string = (): string => {
    const start = index++;
    while (index < source.length) {
      const character = source[index++];
      if (character === "\\") index++;
      else if (character === '"') return JSON.parse(source.slice(start, index)) as string;
    }
    throw new Error("Invalid JSON string");
  };
  const value = (): void => {
    whitespace();
    const character = source[index];
    if (character === '"') { string(); return; }
    if (character === "{") {
      index++;
      whitespace();
      if (source[index] === "}") { index++; return; }
      const keys = new Set<string>();
      while (true) {
        whitespace();
        if (source[index] !== '"') throw new Error("Invalid JSON object key");
        const key = string();
        if (keys.has(key)) throw new Error("Duplicate JSON object key");
        keys.add(key);
        whitespace();
        if (source[index++] !== ":") throw new Error("Invalid JSON object separator");
        value();
        whitespace();
        const separator = source[index++];
        if (separator === "}") return;
        if (separator !== ",") throw new Error("Invalid JSON object separator");
      }
    }
    if (character === "[") {
      index++;
      whitespace();
      if (source[index] === "]") { index++; return; }
      while (true) {
        value();
        whitespace();
        const separator = source[index++];
        if (separator === "]") return;
        if (separator !== ",") throw new Error("Invalid JSON array separator");
      }
    }
    while (index < source.length && !/[\s,\]}]/u.test(source[index]!)) index++;
    if (index === 0) throw new Error("Invalid JSON value");
  };

  value();
  whitespace();
  if (index !== source.length) throw new Error("Invalid JSON trailing content");
}

/** Parse JSON with duplicate-key rejection, then apply the same strict pack contract. */
export function parseLearningPack(source: string): LearningPack {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > PACK_MAX_BYTES) {
    throw new Error("Learning pack JSON exceeds 64000-byte limit");
  }
  const parsed: unknown = JSON.parse(source);
  rejectDuplicateJsonKeys(source);
  assertLearningPack(parsed);
  return structuredClone(parsed);
}

/**
 * Deterministic preference ranking over unfinished pack goals. Existing agency
 * learn scoring uses interests/concerns; matching unresolved beliefs add a
 * bounded uncertainty signal. Current valence/tension modestly modulate matching
 * concern relevance. Equal scores retain pack order; result is detached.
 */
export function selectLearningGoal(pack: LearningPack, state: SubjectState,
  finishedGoalIds: readonly string[]): LearningGoal | undefined {
  assertData({ pack, state, finishedGoalIds });
  assertLearningPack(pack);
  assertSubjectState(state);
  ids(finishedGoalIds, 1000);

  const finished = new Set(finishedGoalIds);
  const candidates = pack.goals.map((goal, index) => ({ goal, index })).filter(candidate => !finished.has(candidate.goal.id));
  if (candidates.length === 0) return undefined;

  const ranked = candidates.map(({ goal, index }) => {
    const topics = goal.topics.map(topic => topic.toLowerCase());
    const uncertainty = Math.min(1, state.cognition.beliefs.filter(belief =>
      (belief.status === "tentative" || belief.status === "disputed") &&
      topics.some(topic => belief.statement.toLowerCase().includes(topic))).length / 4);
    const option: ActivityOption = {
      id: `goal_${String(index).padStart(2, "0")}`,
      kind: "learn",
      description: goal.title,
      topics: [...goal.topics],
      evidenceIds: [],
      cost: 0,
      available: true,
    };
    const agency = chooseIntention(state.self, state.affect, [option], {
      experienceId: "learning-selection", availableBudget: 0, stopRequested: false, uncertainty,
    });
    const concernRelevance = Math.max(0,
      ...state.self.concerns.filter(concern => concern.topics.some(topic => topics.includes(topic.toLowerCase()))).map(concern => concern.weight));
    const relevance = Math.max(concernRelevance,
      ...state.self.interests.filter(interest => topics.includes(interest.topic.toLowerCase())).map(interest => interest.strength));
    const affectMotivation = clamp(0.5 + 0.25 * state.affect.valence + 0.25 * state.affect.tension);
    const overallInterest = Math.max(0, ...state.self.interests.map(interest => interest.strength));
    const overallConcern = Math.max(0, ...state.self.concerns.map(concern => concern.weight));
    // Match agency's learn score, but evaluate uncertainty per goal rather than
    // giving every candidate the same unrelated workspace-wide uncertainty.
    const fallbackScore = 0.45 * clamp(0.65 * state.self.personality.curiosity + 0.25 * overallInterest + 0.1 * uncertainty)
      + 0.2 * overallConcern + 0.2 * relevance + 0.15 * uncertainty;
    const agencyScore = agency.intentions[0]?.score ?? fallbackScore;
    return { goal, index, score: agencyScore + 0.1 * concernRelevance * affectMotivation };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  return structuredClone(ranked[0]!.goal);
}

/** Study view deliberately excludes held-out assessment prompts. */
export function studyProjection(goal: LearningGoal): LearningStudyProjection {
  assertData(goal);
  assertGoal(goal, new Set());
  return {
    title: goal.title,
    topics: [...goal.topics],
    material: goal.material,
    practice: goal.practice.map(question => ({ id: question.id, prompt: question.prompt })),
  };
}

/** Assessment view contains held-out prompts only; no material or answer keys. */
export function assessmentProjection(goal: LearningGoal): LearningAssessmentProjection {
  assertData(goal);
  assertGoal(goal, new Set());
  return {
    title: goal.title,
    topics: [...goal.topics],
    questions: goal.assessment.map(question => ({ id: question.id, prompt: question.prompt })),
  };
}

function normalizedAnswer(answer: string): string {
  return answer.normalize("NFC").trim().toLowerCase().replace(/\s+/gu, " ");
}

/** Exact normalized answer matching only; this is not evidence of generalization. */
export function gradeAnswers(questions: readonly LearningQuestion[],
  answers: readonly { readonly id: string; readonly answer: string }[]): { correct: number; total: number; passed: boolean } {
  assertData({ questions, answers });
  list(questions, MAX_QUESTIONS);
  const questionIds = new Set<string>();
  questions.forEach(question => assertQuestion(question, questionIds));

  list(answers, MAX_QUESTIONS);
  const byId = new Map<string, string>();
  for (const answerValue of answers) {
    const answer = object(answerValue, ["id", "answer"]);
    id(answer.id);
    if (typeof answer.answer !== "string" || answer.answer.length > 1024) throw new Error("Invalid submitted answer");
    if (!questionIds.has(answer.id) || byId.has(answer.id)) throw new Error("Unknown or duplicate submitted answer ID");
    byId.set(answer.id, answer.answer);
  }
  if (byId.size !== questionIds.size || [...questionIds].some(questionId => !byId.has(questionId))) {
    throw new Error("Every learning question must have exactly one submitted answer");
  }

  let correct = 0;
  for (const question of questions) {
    if (normalizedAnswer(byId.get(question.id)!) === normalizedAnswer(question.answer)) correct++;
  }
  const total = questions.length;
  return { correct, total, passed: total > 0 && correct === total };
}
