import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertResearchPlan, isResearchPlan, loadResearchPlan, researchPlanPreview, runResearchLoop, type ResearchPlan, type ResearchStatus, type ResearchBridge } from "../src/research.ts";
import { parseCompanionConfig, buildHostBridgeRegistration } from "../src/config.ts";
import type { SearchProviderPort } from "../src/search-provider.ts";
const now = () => new Date().toISOString();
function plan(): ResearchPlan { return { version: 1, runId: "run", expiresAt: new Date(Date.now() + 120_000).toISOString(), maxSearches: 2, maxModelCalls: 4,
  goals: [0, 1].map(i => ({ id: `g${i}`, question: `Public question ${i}`, query: `exact public query ${i}`, topics: ["public"], practice: [{ id: `p${i}`, prompt: "Practice", answer: "PRIVATE_PRACTICE" }], assessment: [{ id: `a${i}`, prompt: "Heldout", answer: "PRIVATE_TEST" }] })) }; }
type MutableStatus = { -readonly [K in keyof ResearchStatus]: ResearchStatus[K] };
function initial(): MutableStatus { return { runId: "run", status: "active", revision: 0, fence: 0, pendingModel: false, searchReserved: 0, modelReserved: 0, searchesReserved: 0, modelCallsReserved: 0, maxSearches: 2, maxModelCalls: 4, completedGoals: 0, totalGoals: 2, allGoalsPassed: false, verification: "verification_pending", tasks: [], goals: [0, 1].map(i => ({ goalId: `g${i}`, stage: "unstarted", grade: null, verification: "verification_pending" })) }; }
function executor(options: { providerFail?: boolean; afterClaimFail?: boolean; modelNoReservation?: boolean; abortAfterClaim?: AbortController } = {}) {
  let state = initial(), searches = 0, steps = 0, pauses = 0;
  const requests: string[] = [], queries: string[] = [];
  const bridge: ResearchBridge = { close() {}, async request(input) {
    requests.push(input.type);
    if (input.type === "research-pause") { pauses++; state = { ...state, status: "paused", pendingModel: false }; }
    if (input.type === "research-next") {
      if (!state.tasks.some(t => ["queued", "claimed", "accepted"].includes(t.status)) && state.tasks.length < 2) {
        const i = state.tasks.length; state.tasks = [...state.tasks, { runId: "run", taskId: `t${i}`, goalId: `g${i}`, revision: 0, capability: "web.search", status: "queued" }];
      }
      return { type: "research-task", task: state.tasks.find(t => t.status === "queued") ?? null };
    }
    if (input.type === "research-claim") {
      if (options.afterClaimFail) throw new Error("ACK lost");
      const i = state.tasks.findIndex(t => t.taskId === input.taskId);
      const t = state.tasks[i]!; assert.equal(t.status, "queued");
      const task = { ...t, status: "claimed" as const, revision: 1 };
      state.tasks = state.tasks.map((t, n) => n === i ? task : t); state.searchReserved++; state.searchesReserved++;
      state.goals = state.goals.map((g, n) => n === i ? { ...g, stage: "claimed" } : g);
      return { type: "research-claim", claim: { ...task, query: `exact public query ${i}`, claimId: `c${i}`, fence: 0, maxResults: 3, expiresAt: plan().expiresAt } };
    }
    if (input.type === "research-submit") {
      const task = state.tasks.find(t => t.taskId === input.receipt.taskId)!;
      state.tasks = state.tasks.map(t => t === task ? { ...t, status: "accepted" } : t);
      state.goals = state.goals.map(g => g.goalId === task.goalId ? { ...g, stage: "accepted" } : g);
    }
    if (input.type === "research-step") {
      steps++; if (options.modelNoReservation) return { type: "research", status: structuredClone(state) };
      state.modelReserved++; state.modelCallsReserved++;
      const index = Math.floor((state.modelReserved - 1) / 2), assessment = state.modelReserved % 2 === 0;
      state.goals = state.goals.map((g, i) => i !== index ? g : { ...g, stage: assessment ? "completed" : "study", grade: assessment ? { correct: 1, total: 1, passed: true } : null, verification: assessment ? "passed" : "verification_pending" });
      if (assessment) { state.completedGoals++; state.tasks = state.tasks.map(t => t.goalId === `g${index}` ? { ...t, status: "completed" } : t); }
      if (state.completedGoals === 2) { state.status = "completed"; state.allGoalsPassed = true; state.verification = "passed"; }
      // Deliberately complete before ACK: pendingModel is never observed true.
    }
    return { type: "research", status: structuredClone(state) };
  } };
  const provider: SearchProviderPort = { providerId: "tavily-search-v1", status: () => ({ supported: true, available: true }), async search(input) {
    searches++; queries.push(input.query); if (options.providerFail) throw new Error("synthetic provider failure");
    options.abortAfterClaim?.abort();
    return { providerId: "tavily-search-v1", retrievedAt: now(), results: [{ url: "https://www.wikipedia.org/page", title: "Public", text: "Untrusted", origin: "host_summary" }] };
  } };
  return { bridge, provider, requests, queries, counts: () => ({ searches, steps, pauses }) };
}

test("Pi exact plan supports multiple goals, shares no answer keys in preview and rejects unsafe input", () => {
  const p = plan(); assertResearchPlan(p); assert.equal(isResearchPlan(p), true);
  const preview = researchPlanPreview(p, "fixed search", "Dawn own model");
  assert.match(preview, /exact public query 0/); assert.doesNotMatch(preview, /PRIVATE_PRACTICE|PRIVATE_TEST/);
  for (const invalid of [{ ...p, command: "execute" }, { ...p, maxSearches: 9 }, { ...p, goals: [] }, { ...p, goals: p.goals.map(g => ({ ...g, query: "private\nquery" })) }, { ...p, goals: p.goals.map(g => ({ ...g, query: "bad\ud800" })) }]) assert.equal(isResearchPlan(invalid), false);
  const getter = { ...p }; Object.defineProperty(getter, "goals", { get() { assert.fail("getter must not execute"); }, enumerable: true }); assert.equal(isResearchPlan(getter), false);
});

test("plan file is explicit, bounded, UTF8, no-follow, owner-safe and duplicate-key rejecting", t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-research-plan-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "plan.json"); writeFileSync(path, JSON.stringify(plan()), { mode: 0o600 }); assertResearchPlan(loadResearchPlan(path));
  symlinkSync(path, join(dir, "link")); assert.throws(() => loadResearchPlan(join(dir, "link"))); assert.throws(() => loadResearchPlan("relative"));
  chmodSync(path, 0o622); assert.throws(() => loadResearchPlan(path)); chmodSync(path, 0o600);
  for (const body of [" ".repeat(65537), Buffer.from([255]), '{"version":1,"version":1}', JSON.stringify(plan()).replace('"version":1', '"version":1,"version":1')]) { writeFileSync(path, body); assert.throws(() => loadResearchPlan(path)); }
});

test("search configuration remains optional, fixed-provider and no-secret Docker registration", () => {
  const base = { version: 1, projectDirectory: "/synthetic/repo", search: { provider: "tavily", credentialEnv: "TEST_TAVILY_KEY" } };
  const config = parseCompanionConfig(base); assert.deepEqual(config.search, base.search);
  assert.doesNotMatch(JSON.stringify(buildHostBridgeRegistration(config)), /TEST_TAVILY_KEY|tavily/);
  for (const search of [{ provider: "other", credentialEnv: "KEY" }, { provider: "tavily", credentialEnv: "KEY", endpoint: "https://other" }, { provider: "tavily", credentialEnv: "bad-name" }]) assert.throws(() => parseCompanionConfig({ ...base, search }));
});

test("fast model completion before ACK still runs exactly two searches and four ordered phases", async () => {
  const f = executor(), p = plan(); const result = await runResearchLoop({ ...f, runId: "run", expiresAt: p.expiresAt, signal: new AbortController().signal });
  assert.equal(result.status, "completed"); assert.equal(result.allGoalsPassed, true); assert.deepEqual(f.counts(), { searches: 2, steps: 4, pauses: 0 });
  assert.deepEqual(f.queries, p.goals.map(g => g.query));
  assert.equal(f.requests.filter(t => t === "research-claim").length, 2);
});

test("claim ACK loss never invokes a provider or repeats claim", async () => {
  const f = executor({ afterClaimFail: true }); await assert.rejects(runResearchLoop({ ...f, runId: "run", expiresAt: plan().expiresAt, signal: new AbortController().signal }));
  assert.equal(f.counts().searches, 0); assert.equal(f.requests.filter(t => t === "research-claim").length, 1); assert.equal(f.counts().pauses, 1);
});

test("provider error is one charged execution, no receipt/model/fallback and best-effort pause", async () => {
  const f = executor({ providerFail: true }); await assert.rejects(runResearchLoop({ ...f, runId: "run", expiresAt: plan().expiresAt, signal: new AbortController().signal }));
  assert.deepEqual(f.counts(), { searches: 1, steps: 0, pauses: 1 }); assert.ok(!f.requests.includes("research-submit"));
});

test("cancellation after search refuses receipt and no model phase", async () => {
  const controller = new AbortController(), f = executor({ abortAfterClaim: controller });
  await assert.rejects(runResearchLoop({ ...f, runId: "run", expiresAt: plan().expiresAt, signal: controller.signal }));
  assert.equal(f.counts().searches, 1); assert.ok(!f.requests.includes("research-submit")); assert.equal(f.counts().steps, 0);
});

test("absence of a new model reservation fails rather than spinning or resending step", async () => {
  const f = executor({ modelNoReservation: true }); await assert.rejects(runResearchLoop({ ...f, runId: "run", expiresAt: plan().expiresAt, signal: new AbortController().signal }), /未能预占/);
  assert.equal(f.counts().steps, 1); assert.equal(f.counts().pauses, 1);
});

test("bridge invalidation aborts provider DNS/HTTP work even with no pending protocol request", async () => {
  const f = executor(), bridgeClosed = new AbortController(); let entered!: () => void, release!: () => void, externalDispatch = 0;
  const awaiting = new Promise<void>(resolve => { entered = resolve; }), dns = new Promise<void>(resolve => { release = resolve; });
  let providerSignal: AbortSignal | undefined;
  const provider: SearchProviderPort = { providerId: "tavily-search-v1", status: () => ({ supported: true, available: true }), async search(input) {
    providerSignal = input.signal; entered(); await dns; input.signal?.throwIfAborted(); externalDispatch++;
    throw new Error("Should not dispatch after lost binding");
  } };
  const work = runResearchLoop({ bridge: { ...f.bridge, signal: bridgeClosed.signal }, provider, runId: "run", expiresAt: plan().expiresAt, signal: new AbortController().signal });
  const rejected = assert.rejects(work);
  await awaiting; bridgeClosed.abort(); assert.equal(providerSignal?.aborted, true); release(); await rejected;
  assert.equal(externalDispatch, 0); assert.ok(!f.requests.includes("research-submit"));
});
