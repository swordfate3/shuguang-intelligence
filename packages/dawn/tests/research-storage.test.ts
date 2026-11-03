import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach, afterEach, mock } from "node:test";
import { SqliteSubjectStore } from "../src/adapters/storage/sqlite-subject.ts";
import { createInitialState } from "../src/core/state.ts";
import { assertResearchStatus, assertResearchTaskSummary, assertResearchClaim, assertResearchPlan, assertResearchReceipt, selectResearchGoal, type ResearchPlan, type ResearchReceipt } from "../src/core/research.ts";
import type { LearningPack } from "../src/core/learning.ts";
import { evidenceRoots } from "../src/core/evidence.ts";
import { SqliteResearchLedger } from "../src/adapters/storage/sqlite-research.ts";

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 2) }));
afterEach(() => mock.timers.reset());
const signal = () => new AbortController().signal;
const now = () => new Date().toISOString();
const pack: LearningPack = { version: 1, id: "pack", title: "Pack", goals: [{ id: "local", title: "Local", topics: ["local"], material: "Local material", practice: [{ id: "lp", prompt: "Practice", answer: "A" }], assessment: [{ id: "la", prompt: "Test", answer: "B" }] }] };
function plan(runId = "run", count = 2): ResearchPlan {
  return { version: 1, runId, expiresAt: "2026-01-03T00:00:00.000Z", maxSearches: 2, maxModelCalls: 4,
    goals: Array.from({ length: count }, (_, i) => ({ id: `g${i}`, question: `Question ${i}`, query: `approved public query ${i}`, topics: [`topic${i}`],
      practice: [{ id: `p${i}`, prompt: "Practice only", answer: "practicekey" }], assessment: [{ id: `a${i}`, prompt: "Held out", answer: "privatekey" }] })) };
}
async function fixture(work: (s: SqliteSubjectStore, path: string) => Promise<void>, limit = 12) {
  const dir = mkdtempSync(join(tmpdir(), "dawn-research-")); const path = join(dir, "subject.sqlite");
  const s = SqliteSubjectStore.createResearchLearning(path, createInitialState("dawn", "Dawn", "2026-01-01T00:00:00.000Z"), limit, pack, 4, signal());
  try { await s.changeLifecycle(0, "awake", now(), signal()); await work(s, path); }
  finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
}
async function accepted(s: SqliteSubjectStore, runId = "run", binding = "binding"): Promise<ResearchReceipt> {
  const task = await s.nextResearchTask(runId, binding, signal()); assert.ok(task);
  assert.doesNotMatch(JSON.stringify(task), /query|privatekey|Question/);
  const claim = await s.claimResearch(task.taskId, task.revision, binding, signal());
  assert.match(claim.query, /^approved/); assert.equal(claim.maxResults, 3);
  await assert.rejects(s.claimResearch(task.taskId, task.revision, binding, signal()), /claim conflict/);
  const receipt: ResearchReceipt = { version: 1, receiptId: `r_${task.goalId}`, taskId: task.taskId, providerId: "fake", retrievedAt: now(), results: [
    { url: "https://example.org/document", title: "Document", text: "Synthetic document", origin: "document" },
    { url: "https://example.org/summary", title: "Summary", text: "Synthetic host inference", origin: "host_summary" },
  ] };
  await s.submitResearch(receipt, binding, signal()); return receipt;
}
function sql(path: string, work: (db: DatabaseSync) => void) { const db = new DatabaseSync(path); try { work(db); } finally { db.close(); } }

test("v5 two goals, four fake model results, isolated assessment, receipts idempotent, trusted replay and shared counts", async () => {
  await fixture(async (s, path) => {
    assert.equal(s.supportsResearch, true); assert.equal(s.supportsHostImport, true);
    await s.startResearch(plan(), "binding", signal());
    for (let i = 0; i < 2; i++) {
      const receipt = await accepted(s);
      const status = await s.researchStatus("run", "binding", signal());
      assert.deepEqual(await s.submitResearch(structuredClone(receipt), "binding", signal()), status);
      await assert.rejects(s.submitResearch({ ...receipt, providerId: "changed" }, "binding", signal()), /conflict/);
      assert.equal((await s.budget(signal())).reserved, i * 2);
      const study = await s.reserveResearch("run", "binding", signal()); assert.ok(study); assert.equal(study.projection.phase, "study");
      assert.doesNotMatch(JSON.stringify(study.projection), /privatekey|practicekey|Held out/);
      await assert.rejects(s.reserve("chat", "hello", (await s.read(signal())).revision, signal()), /pending/);
      await assert.rejects(s.reserveLearning("local", "study", (await s.read(signal())).revision, signal()), /pending/);
      await s.completeResearch(study.attempt, { notes: `Saved notes ${i}`, answers: [{ id: `p${i}`, answer: "practicekey" }] }, now(), signal());
      const assessment = await s.reserveResearch("run", "binding", signal()); assert.ok(assessment);
      assert.deepEqual(assessment.projection, { phase: "assessment", notes: `Saved notes ${i}`, questions: [{ id: `a${i}`, prompt: "Held out" }] });
      await s.completeResearch(assessment.attempt, { notes: "", answers: [{ id: `a${i}`, answer: i ? "wrong" : "privatekey" }] }, now(), signal());
    }
    const status = await s.researchStatus("run", "binding", signal());
    assert.equal(status.status, "completed"); assert.equal(status.allGoalsPassed, false); assert.equal(status.verification, "failed");
    assert.equal(status.modelReserved, 4); assert.equal(status.searchReserved, 2);
    assert.equal((await s.budget(signal())).reserved, 4); assert.deepEqual(await s.history(signal()), []);
    const state = await s.read(signal()); assert.equal(state.experiences.length, 8);
    assert.equal(state.experiences.filter(e => e.kind === "reading").length, 2, "repeated same pages do not acquire new evidence roots");
    assert.deepEqual(state.experiences.slice(0, 2).map(e => e.origin), ["document", "inference"]);
    assert.equal(state.growth.evaluations.length, 0);
    s.close(); const cold = SqliteSubjectStore.open(path, signal());
    try { assert.deepEqual(await cold.read(signal()), state); assert.deepEqual(await cold.researchStatus("run", "binding", signal()), status); }
    finally { cold.close(); }
  });
});

test("changed excerpts and provider summaries of the same page retain the original evidence root across tasks and cold replay", async () => {
  await fixture(async (s, path) => {
    await s.startResearch(plan(), "binding", signal());
    for (let i = 0; i < 2; i++) {
      const t = await s.nextResearchTask("run", "binding", signal()); assert.ok(t);
      await s.claimResearch(t.taskId, t.revision, "binding", signal());
      await s.submitResearch({ version: 1, receiptId: `samepage${i}`, taskId: t.taskId, providerId: "fake", retrievedAt: now(), results: [
        { url: "https://example.org/a", title: "Page", text: `Different excerpt ${i}`, origin: i ? "host_summary" : "document" },
      ] }, "binding", signal());
      const study = await s.reserveResearch("run", "binding", signal()); assert.ok(study);
      await s.completeResearch(study.attempt, { notes: `notes ${i}`, answers: [{ id: `p${i}`, answer: "practicekey" }] }, now(), signal());
      const assessment = await s.reserveResearch("run", "binding", signal()); assert.ok(assessment);
      await s.completeResearch(assessment.attempt, { notes: "", answers: [{ id: `a${i}`, answer: "privatekey" }] }, now(), signal());
    }
    const state = await s.read(signal()); const readings = state.experiences.filter(e => e.kind === "reading");
    assert.equal(readings.length, 2); assert.equal(readings[1]!.origin, "inference");
    assert.deepEqual(evidenceRoots(readings.map(e => e.id), state.experiences, state.self.identity.id, state.scopeId, now()), [readings[0]!.id]);
    s.close(); const cold = SqliteSubjectStore.open(path, signal()); try { assert.deepEqual(await cold.read(signal()), state); } finally { cold.close(); }
  });
});

test("audit ordinary limit cannot roll back fail plus terminal cleanup or strand the shared model slot", async () => {
  await fixture(async (s, path) => {
    await s.startResearch(plan("run", 1), "binding", signal()); await accepted(s);
    sql(path, db => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const ledger = new SqliteResearchLedger(db), state = ledger.validate();
        for (let i = 0; i < 3997; i++) {
          ledger.apply(state, { type: "fence", runId: "run", status: "paused", at: now() });
          ledger.apply(state, { type: "resume", runId: "run", bindingId: "binding", at: now() });
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
    const attempt = await s.reserveResearch("run", "binding", signal()); assert.ok(attempt);
    await s.failResearch(attempt.attempt, signal());
    assert.equal((await s.budget(signal())).pending, 0); assert.equal((await s.budget(signal())).failed, 1);
    assert.equal((await s.ownerResearchStatus("run", signal())).status, "completed");
    await assert.rejects(s.startResearch(plan("another"), "binding", signal()), /capacity/);
    const chat = await s.reserve("chat_after_cleanup", "Synthetic", (await s.read(signal())).revision, signal()); await s.fail(chat, signal());
    const cold = SqliteSubjectStore.open(path, signal()); try { assert.equal((await cold.budget(signal())).failed, 2); } finally { cold.close(); }
  });
});

test("fragment and canonical URL variants are metadata, not independent page roots", async () => {
  await fixture(async (s, path) => {
    await s.startResearch(plan("run", 1), "binding", signal()); const t = await s.nextResearchTask("run", "binding", signal()); assert.ok(t);
    await s.claimResearch(t.taskId, t.revision, "binding", signal());
    await s.submitResearch({ version: 1, receiptId: "fragments", taskId: t.taskId, providerId: "fake", retrievedAt: now(), results: [
      { url: "https://EXAMPLE.org:443/a#one", title: "Page", text: "One excerpt", origin: "document" },
      { url: "https://example.org/a#two", title: "Page", text: "Another excerpt", origin: "host_summary" },
    ] }, "binding", signal());
    const a = await s.reserveResearch("run", "binding", signal()); assert.ok(a);
    await s.completeResearch(a.attempt, { notes: "notes", answers: [{ id: "p0", answer: "practicekey" }] }, now(), signal());
    const state = await s.read(signal()), readings = state.experiences.filter(e => e.kind === "reading");
    assert.equal(readings.length, 2); assert.equal(evidenceRoots(readings.map(e => e.id), state.experiences, "dawn", "owner", now()).length, 1);
    const cold = SqliteSubjectStore.open(path, signal()); try { assert.deepEqual(await cold.read(signal()), state); } finally { cold.close(); }
  });
});

test("failed and unknown attempts retain shared fees and never dispatch again; restart is explicit and open read only", async () => {
  await fixture(async (s, path) => {
    await s.startResearch(plan(), "binding", signal()); await accepted(s);
    const a = await s.reserveResearch("run", "binding", signal()); assert.ok(a);
    s.close(); const cold = SqliteSubjectStore.open(path, signal());
    try {
      assert.equal((await cold.researchStatus("run", "binding", signal())).status, "active");
      await cold.pauseResearchOnRestart(signal());
      assert.equal((await cold.researchStatus("run", "binding", signal())).status, "paused_restart");
      await assert.rejects(cold.completeResearch(a.attempt, { notes: "late", answers: [{ id: "p0", answer: "practicekey" }] }, now(), signal()), /inactive/);
      assert.equal((await cold.budget(signal())).failed, 1);
      const resumed = await cold.resumeResearch("run", "newbinding", signal()); assert.equal(resumed.tasks[0]!.status, "unknown");
      await assert.rejects(cold.researchStatus("run", "binding", signal()), /binding/);
      const next = await cold.nextResearchTask("run", "newbinding", signal()); assert.equal(next?.goalId, "g1");
    } finally { cold.close(); }
  });
});

test("claim ACK loss is charged unknown on disconnect; only never dispatched stages resume", async () => {
  await fixture(async s => {
    await s.startResearch(plan(), "binding", signal()); const t = await s.nextResearchTask("run", "binding", signal()); assert.ok(t);
    await s.claimResearch(t.taskId, t.revision, "binding", signal());
    await s.pauseResearchBinding("binding", signal());
    const status = await s.resumeResearch("run", "new", signal()); assert.equal(status.searchReserved, 1); assert.equal(status.tasks[0]!.status, "unknown");
    await assert.rejects(s.claimResearch(t.taskId, 0, "new", signal()), /conflict/);
    assert.equal((await s.nextResearchTask("run", "new", signal()))?.goalId, "g1");
  });
});

test("sleep fences research in lifecycle transaction but preserves original pack authorization", async () => {
  await fixture(async s => {
    await s.startResearch(plan(), "binding", signal()); await accepted(s);
    const a = await s.reserveResearch("run", "binding", signal()); assert.ok(a);
    const state = await s.read(signal()); await s.changeLifecycle(state.revision, "sleeping", now(), signal());
    assert.equal((await s.researchStatus("run", "binding", signal())).status, "stopped");
    assert.equal((await s.learningStatus(signal()))?.status, "active");
    await assert.rejects(s.completeResearch(a.attempt, { notes: "late", answers: [{ id: "p0", answer: "practicekey" }] }, now(), signal()));
    const sleeping = await s.read(signal()); await s.changeLifecycle(sleeping.revision, "awake", now(), signal());
    await assert.rejects(s.resumeResearch("run", "binding", signal()), /cannot resume/);
    assert.equal((await s.budget(signal())).reserved, 1);
  });
});

test("completion rollback has no partial source, notes, score, audit or refunded reservation", async () => {
  await fixture(async (s, path) => {
    await s.startResearch(plan(), "binding", signal()); await accepted(s);
    const a = await s.reserveResearch("run", "binding", signal()); assert.ok(a);
    sql(path, db => db.exec("CREATE TRIGGER fail_research_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected'); END;"));
    await assert.rejects(s.completeResearch(a.attempt, { notes: "notes", answers: [{ id: "p0", answer: "practicekey" }] }, now(), signal()), /injected/);
    assert.equal((await s.read(signal())).experiences.length, 0); assert.equal((await s.budget(signal())).pending, 1);
    sql(path, db => db.exec("DROP TRIGGER fail_research_event")); await s.failResearch(a.attempt, signal());
    assert.equal((await s.budget(signal())).failed, 1); assert.equal((await s.nextResearchTask("run", "binding", signal()))?.goalId, "g1");
  });
});

test("cold replay rejects receipt, attempt, schema and audit tampering", async () => {
  for (const target of ["receipt", "attempt", "schema", "audit"]) await fixture(async (s, path) => {
    await s.startResearch(plan(), "binding", signal()); await accepted(s);
    const a = await s.reserveResearch("run", "binding", signal()); assert.ok(a);
    await s.completeResearch(a.attempt, { notes: "notes", answers: [{ id: "p0", answer: "practicekey" }] }, now(), signal()); s.close();
    sql(path, db => {
      if (target === "receipt") db.exec("UPDATE research_receipts SET dataJSON=replace(dataJSON,'Synthetic document','Changed document')");
      if (target === "attempt") db.exec("UPDATE research_model_attempts SET dataJSON=replace(dataJSON,'notes','changed')");
      if (target === "schema") db.exec("ALTER TABLE research_runs ADD COLUMN unexpected TEXT");
      if (target === "audit") db.exec("UPDATE research_events SET eventJSON=replace(eventJSON,'approved public query','tampered query')");
    });
    assert.throws(() => SqliteSubjectStore.open(path, signal()), /Research|research/);
  });
});

test("unassessed goals save notes but never report passed; stop refuses pending result", async () => {
  await fixture(async s => {
    const p = plan("run", 1); const open = { ...p, goals: p.goals.map(g => ({ ...g, assessment: [] })) };
    await s.startResearch(open, "binding", signal()); await accepted(s);
    const a = await s.reserveResearch("run", "binding", signal()); assert.ok(a);
    const status = await s.completeResearch(a.attempt, { notes: "notes", answers: [{ id: "p0", answer: "practicekey" }] }, now(), signal());
    assert.equal(status.status, "completed"); assert.equal(status.verification, "verification_pending"); assert.equal(status.allGoalsPassed, false);
  });
  await fixture(async s => {
    await s.startResearch(plan(), "binding", signal()); await accepted(s); const a = await s.reserveResearch("run", "binding", signal()); assert.ok(a);
    await s.stopResearch("run", "binding", signal()); await assert.rejects(s.completeResearch(a.attempt, { notes: "late", answers: [{ id: "p0", answer: "practicekey" }] }, now(), signal()));
    assert.equal((await s.budget(signal())).failed, 1);
  });
});

test("shared chat and pack precharges cannot be bypassed by research", async () => {
  await fixture(async s => {
    const chat = await s.reserve("chat", "hello", (await s.read(signal())).revision, signal()); await s.fail(chat, signal());
    const packAttempt = await s.reserveLearning("local", "study", (await s.read(signal())).revision, signal()); await s.failLearning(packAttempt, signal());
    await s.startResearch(plan(), "binding", signal()); await accepted(s); const a = await s.reserveResearch("run", "binding", signal()); assert.ok(a); await s.failResearch(a.attempt, signal());
    assert.equal(await s.nextResearchTask("run", "binding", signal()), null);
    assert.equal((await s.researchStatus("run", "binding", signal())).status, "exhausted");
    assert.equal((await s.budget(signal())).reserved, 3);
  }, 4);
});

test("strict plan and receipt caps, canonical times, and deterministic public-only selection", () => {
  const p = plan(); assertResearchPlan(p);
  assert.throws(() => assertResearchPlan({ ...p, maxSearches: 9 }));
  assert.throws(() => assertResearchPlan({ ...p, expiresAt: "2026-01-03" }));
  assert.throws(() => assertResearchPlan({ ...p, owner: "forged" }));
  const state = createInitialState("dawn", "Dawn", "2026-01-01T00:00:00.000Z");
  const evidence = { id: "interest_source", subjectId: "dawn", scopeId: "owner", kind: "reflection" as const, origin: "inference" as const,
    content: "I prefer the second topic", topics: ["preference"], occurredAt: state.updatedAt, recordedAt: state.updatedAt, sourceIds: [] };
  const preference = { ...state, experiences: [evidence], self: { ...state.self, interests: [{ topic: "topic1", strength: 1, evidenceIds: [evidence.id] }] } };
  assert.equal(selectResearchGoal(p, preference, [])?.query, p.goals[1]!.query);
  assert.throws(() => assertResearchReceipt({ version: 1, receiptId: "r", taskId: "t", providerId: "fake", retrievedAt: now(), results: [{ url: "https://example.org", title: "title", text: "x".repeat(16000), origin: "document" }] }));
});

test("accepted receipts survive binding pause and explicit resume without another search", async () => {
  await fixture(async s => {
    await s.startResearch(plan(), "binding", signal()); await accepted(s);
    await s.pauseResearchBinding("binding", signal());
    const resumed = await s.resumeResearch("run", "new", signal());
    assert.equal(resumed.searchReserved, 1); assert.equal(await s.nextResearchTask("run", "new", signal()), null);
    assert.ok(await s.reserveResearch("run", "new", signal()));
  });
});

test("conversation consumption and research model pending are mutually exclusive; abort never charges", async () => {
  await fixture(async s => {
    const batch = { version: 1 as const, batchId: "batch", sessionId: "session", leafEntryId: "entry", fragments: [
      { entryId: "entry", parentEntryId: null, textBlockIndex: 0, role: "user" as const, text: "Synthetic owner statement", sourceTimestamp: now() },
    ] };
    const grant = await s.authorizeConversation(batch, "binding", "2026-01-03T00:00:00.000Z", signal());
    await s.acceptConversation(batch, grant.grantId, "binding", signal());
    await s.startResearch(plan(), "binding", signal()); await accepted(s);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(s.reserveResearch("run", "binding", controller.signal));
    assert.equal((await s.budget(signal())).reserved, 0);
    const a = await s.reserveResearch("run", "binding", signal()); assert.ok(a);
    await assert.rejects(s.consumeConversation("batch", grant.grantId, "binding", now(), signal()), /pending/);
    await s.failResearch(a.attempt, signal());
    assert.equal((await s.consumeConversation("batch", grant.grantId, "binding", now(), signal())).newSources, 1);
  });
});

test("bounded runs and source collections refuse overflow, expiry and malformed result without partial acceptance", async () => {
  await fixture(async s => {
    for (let i = 0; i < 64; i++) await s.startResearch(plan(`run${i}`, 1), "binding", signal());
    await assert.rejects(s.startResearch(plan("overflow"), "binding", signal()), /start/);
    const t = await s.nextResearchTask("run0", "binding", signal()); assert.ok(t);
    await s.claimResearch(t.taskId, t.revision, "binding", signal());
    const receipt = { version: 1 as const, receiptId: "overflow", taskId: t.taskId, providerId: "fake", retrievedAt: now(), results:
      Array.from({ length: 4 }, () => ({ url: "https://example.org/a", title: "T", text: "Text", origin: "document" as const })) };
    await assert.rejects(s.submitResearch(receipt, "binding", signal()));
    assert.equal((await s.researchStatus("run0", "binding", signal())).tasks[0]!.status, "claimed");
    mock.timers.tick(2 * 86400000);
    await assert.rejects(s.submitResearch({ ...receipt, results: receipt.results.slice(0, 1) }, "binding", signal()), /expired/);
    await s.stopResearch("run0", "binding", signal());
    assert.equal((await s.researchStatus("run0", "binding", signal())).tasks[0]!.status, "unknown");
  });
});

test("new public status and claim validators match exact emitted safe contract", async () => {
  await fixture(async s => {
    const status = await s.startResearch(plan(), "binding", signal()); assertResearchStatus(status);
    assert.throws(() => assertResearchStatus({ ...status, notes: "secret" }));
    const t = await s.nextResearchTask("run", "binding", signal()); assertResearchTaskSummary(t);
    assertResearchClaim(await s.claimResearch(t.taskId, t.revision, "binding", signal()));
    assertResearchStatus(await s.researchStatus("run", "binding", signal()));
  });
});

test("allGoalsPassed requires the independently graded held-out phase", async () => {
  await fixture(async s => {
    await s.startResearch(plan("run", 1), "binding", signal()); await accepted(s);
    const a = await s.reserveResearch("run", "binding", signal()); assert.ok(a);
    await s.completeResearch(a.attempt, { notes: "Learner notes", answers: [{ id: "p0", answer: "practicekey" }] }, now(), signal());
    assert.equal((await s.researchStatus("run", "binding", signal())).allGoalsPassed, false);
    const b = await s.reserveResearch("run", "binding", signal()); assert.ok(b);
    const status = await s.completeResearch(b.attempt, { notes: "", answers: [{ id: "a0", answer: "privatekey" }] }, now(), signal());
    assert.equal(status.status, "completed"); assert.equal(status.allGoalsPassed, true); assert.equal(status.verification, "passed");
  });
});

test("near core collection capacity exhausts before claiming or reserving any fee", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-research-capacity-")); const path = join(dir, "db.sqlite");
  const initial = createInitialState("dawn", "Dawn", "2026-01-01T00:00:00.000Z");
  const s = SqliteSubjectStore.createResearchLearning(path, { ...initial, processedCycleIds: Array.from({ length: 996 }, (_, i) => `old_${i}`) }, 6, pack, 4, signal());
  try {
    await s.changeLifecycle(0, "awake", now(), signal()); await s.startResearch(plan(), "binding", signal());
    assert.equal(await s.nextResearchTask("run", "binding", signal()), null);
    const status = await s.researchStatus("run", "binding", signal());
    assert.equal(status.status, "exhausted"); assert.equal(status.searchReserved, 0); assert.equal(status.modelReserved, 0);
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("search single flight is shared across separate approved runs, not only within one run", async () => {
  await fixture(async s => {
    await s.startResearch(plan("run1", 1), "binding", signal()); await s.startResearch(plan("run2", 1), "binding", signal());
    const one = await s.nextResearchTask("run1", "binding", signal()), two = await s.nextResearchTask("run2", "binding", signal()); assert.ok(one); assert.ok(two);
    await s.claimResearch(one.taskId, one.revision, "binding", signal());
    await assert.rejects(s.claimResearch(two.taskId, two.revision, "binding", signal()), /overlap/);
    assert.equal((await s.ownerResearchStatus("run2", signal())).searchReserved, 0);
    await s.stopResearch("run1", "binding", signal());
    await s.claimResearch(two.taskId, two.revision, "binding", signal());
    assert.equal((await s.ownerResearchStatus("run2", signal())).searchReserved, 1);
  });
});

test("v5 prevents a second chat precharge from violating shared single pending invariant", async () => {
  await fixture(async s => {
    const revision = (await s.read(signal())).revision;
    const first = await s.reserve("first", "Synthetic chat", revision, signal());
    await assert.rejects(s.reserve("second", "Synthetic chat", revision, signal()), /pending/);
    assert.equal((await s.budget(signal())).reserved, 1);
    await s.fail(first, signal()); assert.equal((await s.budget(signal())).pending, 0);
  });
});
