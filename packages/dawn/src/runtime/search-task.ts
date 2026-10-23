import type { SubjectState } from "../core/state.ts";
import { assertSubjectState } from "../core/validation.ts";
import { assertData, id, integer, list, object, text, timestamp } from "../core/guards.ts";
import { chooseIntention } from "../core/agency/logic.ts";
import { isSearchQuery, assertSearchResult, type SearchPort, type SearchResult } from "../adapters/search/port.ts";

/** Exact queries, not a free-text privacy promise. Only these strings may leave Dawn. */
export interface SearchGrant {
  readonly version: 1;
  readonly id: string;
  readonly objective: string;
  readonly provider: string;
  readonly disclosure: "approved-queries-only";
  readonly limit: number;
  readonly expiresAt: string;
  readonly queries: readonly { readonly id: string; readonly query: string; readonly topics: readonly string[] }[];
}
export interface SearchAttempt {
  readonly sequence: number;
  readonly queryId: string;
  readonly expectedRevision: number;
  readonly status: "pending" | "completed" | "failed";
  readonly result: SearchResult | null;
}
export interface SearchTaskStatus {
  readonly subjectId: string;
  readonly scopeId: string;
  readonly grant: SearchGrant;
  readonly stopped: boolean;
  readonly attempts: readonly SearchAttempt[];
}
export interface SearchTaskStore {
  status(signal: AbortSignal): Promise<SearchTaskStatus>;
  reserve(queryId: string, expectedRevision: number, at: string, signal: AbortSignal): Promise<SearchAttempt>;
  complete(attempt: SearchAttempt, result: SearchResult, at: string, signal: AbortSignal): Promise<void>;
  fail(attempt: SearchAttempt, signal: AbortSignal): Promise<void>;
  stop(signal: AbortSignal): Promise<void>;
}
export function assertSearchGrant(value: unknown): asserts value is SearchGrant {
  assertData(value);
  const g = object(value, ["version", "id", "objective", "provider", "disclosure", "limit", "expiresAt", "queries"]);
  if (g.version !== 1 || typeof g.provider !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(g.provider) ||
      g.disclosure !== "approved-queries-only") throw new Error("Invalid search authorization");
  id(g.id); text(g.objective, 1000); integer(g.limit, 1, 10); timestamp(g.expiresAt); list(g.queries, 10);
  if (!g.queries.length) throw new Error("Search authorization needs approved queries");
  const ids = new Set<string>(), queries = new Set<string>();
  for (const value of g.queries) {
    const q = object(value, ["id", "query", "topics"]); id(q.id); text(q.query, 400); list(q.topics, 6);
    if (!isSearchQuery(q.query) || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(q.query) || q.query.trim() !== q.query) throw new Error("Invalid approved search query");
    for (const topic of q.topics) text(topic, 128);
    if (new Set(q.topics.map(topic => (topic as string).toLowerCase())).size !== q.topics.length) throw new Error("Duplicate search topics");
    if (ids.has(q.id) || queries.has(q.query.toLowerCase())) throw new Error("Duplicate approved search query");
    ids.add(q.id); queries.add(q.query.toLowerCase());
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 16_000) throw new Error("Search grant too large");
}

/** No model, state history, memory or held-out assessment is sent to the provider. */
export function selectSearchQuery(status: SearchTaskStatus, state: SubjectState): SearchGrant["queries"][number] | undefined {
  const used = new Set(status.attempts.map(a => a.queryId));
  const options = status.grant.queries.filter(q => !used.has(q.id)).map(q => ({
    id: q.id, kind: "learn" as const, description: q.query, topics: q.topics,
    evidenceIds: [] as string[], cost: 1, available: true,
  }));
  const agency = chooseIntention(state.self, state.affect, options, {
    experienceId: status.grant.id, availableBudget: status.grant.limit - status.attempts.length, stopRequested: status.stopped,
  });
  return status.grant.queries.find(q => q.id === agency.intentions[0]?.activityId);
}
export function searchReport(status: SearchTaskStatus, at: string): object {
  const state = status.stopped ? "stopped" : status.attempts.some(a => a.status === "pending") ? "pending"
    : status.attempts.some(a => a.status === "failed") ? "failed"
    : at >= status.grant.expiresAt ? "expired"
    : status.attempts.length >= status.grant.limit ? "exhausted"
    : status.attempts.length === status.grant.queries.length ? "completed" : "active";
  return { mode: "bounded-autonomous-search", taskId: status.grant.id, status: state,
    limit: status.grant.limit, reserved: status.attempts.length,
    completed: status.attempts.filter(a => a.status === "completed").length,
    failed: status.attempts.filter(a => a.status === "failed").length,
    pending: status.attempts.filter(a => a.status === "pending").length,
    knowledgeVerified: false, subjectMemoryChanged: false };
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Error("Search run cancelled"));
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    work.then(value => { if (!signal.aborted) resolve(value); }, reject)
      .finally(() => signal.removeEventListener("abort", stop)).catch(() => {});
  });
}
/** Foreground only, durable reservations before I/O, terminal failure, no pending recovery/retry. */
export async function runAutonomousSearch(
  store: SearchTaskStore, subject: { read(signal: AbortSignal): Promise<SubjectState> }, search: SearchPort,
  signal: AbortSignal, now: () => string = () => new Date().toISOString(),
): Promise<object> {
  const runSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
  for (;;) {
    runSignal.throwIfAborted();
    const status = await store.status(runSignal);
    const at = now(); timestamp(at);
    if (status.attempts.some(a => a.status === "pending")) throw new Error("Pending search exists; no automatic retry or recovery");
    if (status.stopped || at >= status.grant.expiresAt || status.attempts.some(a => a.status === "failed") ||
        status.attempts.length >= status.grant.limit || status.attempts.length === status.grant.queries.length) return searchReport(status, at);
    const state = await subject.read(runSignal); assertSubjectState(state);
    if (state.self.identity.id !== status.subjectId || state.scopeId !== status.scopeId || state.lifecycle !== "awake") {
      throw new Error("Search requires the authorized, explicitly awake subject");
    }
    const query = selectSearchQuery(status, state);
    if (!query) return { ...searchReport(status, at), status: "no-eligible-intention" };
    let attempt: SearchAttempt | undefined;
    try {
      attempt = await store.reserve(query.id, state.revision, at, runSignal);
      runSignal.throwIfAborted();
      // Recheck after reservation, before disclosing any approved query.
      const before = await subject.read(runSignal); assertSubjectState(before);
      const currentTask = await store.status(runSignal);
      if (currentTask.stopped || before.self.identity.id !== status.subjectId || before.scopeId !== status.scopeId ||
          before.revision !== state.revision || before.lifecycle !== "awake") throw new Error("Subject or task changed before search");
      const dispatchAt = now(); timestamp(dispatchAt);
      if (dispatchAt >= status.grant.expiresAt) throw new Error("Search grant expired before dispatch");
      runSignal.throwIfAborted();
      const result = await abortable(search.search(query.query, runSignal), runSignal);
      runSignal.throwIfAborted();
      assertSearchResult(result);
      if (result.provider !== status.grant.provider) throw new Error("Search provider changed");
      const latest = await subject.read(runSignal); assertSubjectState(latest);
      if (latest.self.identity.id !== status.subjectId || latest.scopeId !== status.scopeId ||
          latest.revision !== state.revision || latest.lifecycle !== "awake") throw new Error("Subject changed during search");
      await store.complete(attempt, result, now(), runSignal);
    } catch {
      if (attempt) { try { await store.fail(attempt, new AbortController().signal); } catch { /* Keep charged pending visible. */ } }
      throw new Error("Search task failed or cancelled; charged attempts were not refunded or retried");
    }
  }
}
