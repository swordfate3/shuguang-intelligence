import { assertData, id, integer, list, object, text, timestamp } from "./guards.ts";
import { gradeAnswers, type LearningQuestion } from "./learning.ts";
import type { SubjectState } from "./state.ts";
import { assertSubjectState } from "./validation.ts";

/** Exact owner-approved public questions and queries; private memory may only rank these entries. */
export interface ResearchGoal {
  readonly id: string;
  readonly question: string;
  readonly query: string;
  readonly topics: readonly string[];
  readonly practice: readonly LearningQuestion[];
  readonly assessment: readonly LearningQuestion[];
}
export interface ResearchPlan {
  readonly version: 1;
  readonly runId: string;
  readonly goals: readonly ResearchGoal[];
  readonly maxSearches: number;
  readonly maxModelCalls: number;
  readonly expiresAt: string;
}
export interface ResearchSearchResult {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly origin: "document" | "host_summary";
}
/** Fields attested by the trusted host adapter, never by model JSON. */
export interface ResearchReceipt {
  readonly version: 1;
  readonly receiptId: string;
  readonly taskId: string;
  readonly providerId: string;
  readonly retrievedAt: string;
  readonly results: readonly ResearchSearchResult[];
}
export function assertResearchPlan(value: unknown): asserts value is ResearchPlan {
  assertData(value);
  const p = object(value, ["version", "runId", "goals", "maxSearches", "maxModelCalls", "expiresAt"]);
  if (p.version !== 1) throw new Error("Unsupported research plan");
  id(p.runId); timestamp(p.expiresAt); integer(p.maxSearches, 1, 8); integer(p.maxModelCalls, 2, 32);
  list(p.goals, 8); if (!p.goals.length) throw new Error("Research plan requires goals");
  const seen = new Set<string>();
  for (const candidate of p.goals) {
    const g = object(candidate, ["id", "question", "query", "topics", "practice", "assessment"]);
    id(g.id); if (seen.has(g.id)) throw new Error("Duplicate research identifier"); seen.add(g.id);
    text(g.question, 1000); text(g.query, 1000);
    if (/[\p{Cc}\p{Cf}\p{Surrogate}]/u.test(g.query)) throw new Error("Invalid public research query");
    list(g.topics, 6);
    g.topics.forEach(t => text(t, 128));
    if (new Set(g.topics).size !== g.topics.length) throw new Error("Duplicate research topic");
    for (const [name, minimum] of [["practice", 1], ["assessment", 0]] as const) {
      list(g[name], 4); if (g[name].length < minimum) throw new Error("Missing research practice");
      const questions = g[name] as unknown as LearningQuestion[];
      // Reuse the exact private-key validation and grading semantics of pack learning.
      gradeAnswers(questions, questions.map(q => ({ id: q.id, answer: q.answer })));
      for (const q of questions) {
        if (seen.has(q.id)) throw new Error("Duplicate research identifier"); seen.add(q.id);
      }
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 48 * 1024) throw new Error("Research plan exceeds private frame budget");
}
export function assertResearchReceipt(value: unknown): asserts value is ResearchReceipt {
  assertData(value);
  const r = object(value, ["version", "receiptId", "taskId", "providerId", "retrievedAt", "results"]);
  if (r.version !== 1) throw new Error("Unsupported research receipt");
  id(r.receiptId); id(r.taskId); id(r.providerId); timestamp(r.retrievedAt); list(r.results, 3);
  let chars = 0;
  for (const value of r.results) {
    const item = object(value, ["url", "title", "text", "origin"]);
    text(item.url, 2048); text(item.title, 512); text(item.text, 16000);
    // Metadata only: this layer NEVER fetches returned URLs. Reject credential-bearing URLs.
    if (!/^https:\/\/[^\s]+$/u.test(item.url) || /[\p{Cc}\p{Cf}\p{Surrogate}]/u.test(item.url) || item.url.includes("\\")) throw new Error("Invalid research URL");
    let parsed: URL; try { parsed = new URL(item.url); } catch { throw new Error("Invalid research URL"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Invalid research URL");
    if (item.origin !== "document" && item.origin !== "host_summary") throw new Error("Invalid research origin");
    chars += item.url.length + item.title.length + item.text.length;
  }
  if (chars > 16000 || new TextEncoder().encode((r.results as ResearchSearchResult[]).map(r => r.url + r.title + r.text).join("")).length > 32768) throw new Error("Research result capacity exceeded");
}
/** Pure, stable ranking: interests/concerns and uncovered topics, never query synthesis. */
export function selectResearchGoal(plan: ResearchPlan, state: SubjectState, finished: readonly string[]): ResearchGoal | undefined {
  assertResearchPlan(plan); assertSubjectState(state); assertData(finished);
  const score = (goal: ResearchGoal): number => {
    const topics = goal.topics.map(t => t.toLowerCase());
    const interest = Math.max(0, ...state.self.interests.filter(i => topics.includes(i.topic.toLowerCase())).map(i => i.strength));
    const concern = Math.max(0, ...state.self.concerns.filter(c => c.topics.some(t => topics.includes(t.toLowerCase()))).map(c => c.weight));
    const uncovered = topics.filter(t => !state.experiences.some(e => e.topics.some(et => et.toLowerCase() === t))).length / Math.max(1, topics.length);
    return 0.5 * interest + 0.35 * concern + 0.15 * uncovered;
  };
  const available = plan.goals.filter(g => !finished.includes(g.id));
  available.sort((a, b) => score(b) - score(a));
  return available[0] ? structuredClone(available[0]) : undefined;
}

export type ResearchRunState = "active" | "paused" | "paused_restart" | "stopped" | "completed" | "exhausted";
export interface ResearchTaskSummary {
  readonly runId: string; readonly taskId: string; readonly goalId: string;
  readonly revision: number; readonly capability: "web.search";
  readonly status: "queued" | "claimed" | "accepted" | "completed" | "failed" | "unknown";
}
export interface ResearchClaim extends ResearchTaskSummary {
  readonly query: string; readonly claimId: string; readonly fence: number; readonly maxResults: 3; readonly expiresAt: string;
}
export interface ResearchStatus {
  readonly runId: string; readonly status: ResearchRunState; readonly revision: number; readonly pendingModel: boolean;
  readonly fence: number; readonly searchReserved: number; readonly modelReserved: number;
  readonly goals: readonly { readonly goalId: string; readonly stage: "unstarted" | ResearchTaskSummary["status"] | "study" | "assessment";
    readonly grade: { readonly correct: number; readonly total: number; readonly passed: boolean } | null;
    readonly verification: "verification_pending" | "passed" | "failed" }[];
  readonly searchesReserved: number; readonly modelCallsReserved: number;
  readonly maxSearches: number; readonly maxModelCalls: number;
  readonly completedGoals: number; readonly totalGoals: number; readonly allGoalsPassed: boolean;
  readonly verification: "verification_pending" | "passed" | "failed";
  readonly tasks: readonly ResearchTaskSummary[];
}
function taskFields(v: Record<string, unknown>): void {
  id(v.runId); id(v.taskId); id(v.goalId); integer(v.revision);
  if (v.capability !== "web.search" || !["queued", "claimed", "accepted", "completed", "failed", "unknown"].includes(v.status as string)) throw new Error("Invalid research task summary");
}
export function assertResearchTaskSummary(value: unknown): asserts value is ResearchTaskSummary {
  assertData(value); taskFields(object(value, ["runId", "taskId", "goalId", "revision", "capability", "status"]));
}
export function assertResearchClaim(value: unknown): asserts value is ResearchClaim {
  assertData(value);
  const v = object(value, ["runId", "taskId", "goalId", "revision", "capability", "status", "query", "claimId", "fence", "maxResults", "expiresAt"]);
  taskFields(v); text(v.query, 1000); id(v.claimId); integer(v.fence); timestamp(v.expiresAt);
  if (v.maxResults !== 3 || v.status !== "claimed") throw new Error("Invalid research claim");
}
export function assertResearchStatus(value: unknown): asserts value is ResearchStatus {
  assertData(value);
  const v = object(value, ["runId", "status", "revision", "pendingModel", "fence", "searchReserved", "modelReserved", "goals", "searchesReserved", "modelCallsReserved", "maxSearches", "maxModelCalls", "completedGoals", "totalGoals", "allGoalsPassed", "verification", "tasks"]);
  id(v.runId); integer(v.revision); integer(v.fence); integer(v.maxSearches, 1, 8);
  if (typeof v.pendingModel !== "boolean") throw new Error("Invalid research pending status"); integer(v.maxModelCalls, 2, 32);
  integer(v.searchReserved, 0, v.maxSearches); integer(v.modelReserved, 0, v.maxModelCalls);
  integer(v.totalGoals, 1, 8); integer(v.completedGoals, 0, v.totalGoals);
  if (v.searchReserved !== v.searchesReserved || v.modelReserved !== v.modelCallsReserved || typeof v.allGoalsPassed !== "boolean" ||
    !["active", "paused", "paused_restart", "stopped", "completed", "exhausted"].includes(v.status as string) ||
    !["verification_pending", "passed", "failed"].includes(v.verification as string)) throw new Error("Invalid research status");
  list(v.tasks, 8); v.tasks.forEach(assertResearchTaskSummary); list(v.goals, 8);
  if (v.goals.length !== v.totalGoals) throw new Error("Invalid research goal count");
  for (const item of v.goals) {
    const g = object(item, ["goalId", "stage", "grade", "verification"]); id(g.goalId);
    if (!["unstarted", "queued", "claimed", "accepted", "completed", "failed", "unknown", "study", "assessment"].includes(g.stage as string) ||
      !["verification_pending", "passed", "failed"].includes(g.verification as string)) throw new Error("Invalid research goal status");
    if (g.grade !== null) {
      const grade = object(g.grade, ["correct", "total", "passed"]); integer(grade.total, 1, 4); integer(grade.correct, 0, grade.total);
      if (grade.passed !== (grade.correct === grade.total)) throw new Error("Invalid research grade");
    }
  }
}
