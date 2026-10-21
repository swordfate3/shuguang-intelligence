import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelPort } from "../src/adapters/models/port.ts";
import { SqliteSubjectStore } from "../src/adapters/storage/sqlite-subject.ts";
import { createInitialState } from "../src/core/state.ts";
import type { LearningPack } from "../src/core/learning.ts";
import { prepareTurn } from "../src/runtime/deliberation.ts";
import { runAutonomousLearning } from "../src/runtime/learning-runner.ts";
import type { LearningRepository } from "../src/runtime/learning-runner.ts";

const t0 = "2026-01-01T00:00:00.000Z";
const signal = () => new AbortController().signal;

function temp(t: { after(callback: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "dawn-learning-runner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "subject.sqlite");
}

function pack(goalIds = ["orbit", "comets"]): LearningPack {
  return {
    version: 1, id: "synthetic-astronomy", title: "Synthetic astronomy",
    goals: goalIds.map((id, index) => {
      const value = index === 0 ? "73" : "82";
      const label = index === 0 ? "ORANGE" : "VIOLET";
      return {
        id, title: `Synthetic ${id}`, topics: ["天文学"],
        material: `The core value is ${value}. The practice label is ${label}.`,
        practice: [{ id: `${id}-practice`, prompt: "What is the practice label?", answer: label }],
        assessment: [{ id: `${id}-heldout`, prompt: `HELDOUT_PROMPT_${id}: what is the core value?`, answer: value }],
      };
    }),
  };
}

function createStore(path: string, learningPack = pack(), limit = 8, learningLimit = 6): SqliteSubjectStore {
  return SqliteSubjectStore.createLearning(path,
    createInitialState("synthetic-dawn", "Synthetic Dawn", t0), limit, learningPack, learningLimit, signal());
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

type LearningRequest = Parameters<ModelPort["generate"]>[0];
type LearningInput = { phase: "study" | "assessment"; goal: Record<string, unknown> };

function inputOf(request: LearningRequest): LearningInput {
  const final = request.messages.at(-1);
  assert.equal(final?.role, "user");
  return JSON.parse(final!.text) as LearningInput;
}

function createSyntheticModel(onRequest?: (request: LearningRequest, input: LearningInput) => void): ModelPort {
  return {
    async generate(request, abort) {
      abort.throwIfAborted();
      const input = inputOf(request);
      onRequest?.(request, input);
      const goal = input.goal;
      const mnemonic = String(goal.title).replace(/^Synthetic /u, "").toLowerCase() + "cipher";
      let output: { notes: string; answers: { id: string; answer: string }[] };
      if (input.phase === "study") {
        const material = String(goal.material);
        const value = material.match(/core value is (\d+)/i)?.[1];
        const label = material.match(/practice label is ([A-Z]+)/i)?.[1];
        assert.ok(value && label, "synthetic study material should be sufficient to form notes");
        const practice = goal.practice as { id: string; answer: string }[];
        output = { notes: `Learned note: core value is ${value}; practice label is ${label}; mnemonic ${mnemonic}.`,
          answers: practice.map(question => ({ id: question.id, answer: label })) };
      } else {
        const notes = String(goal.learnedNotes ?? "");
        const value = notes.match(/core value is (\d+)/i)?.[1];
        assert.ok(value, "assessment answer must be derived from notes sent to the new model call");
        const questions = goal.questions as { id: string }[];
        output = { notes: "", answers: questions.map(question => ({ id: question.id, answer: value })) };
      }
      return { text: JSON.stringify(output), modelId: "synthetic-learning-model",
        usage: { inputTokens: 10, outputTokens: 8 } };
    },
  };
}

function clock() {
  let minute = 1;
  return () => new Date(Date.parse(t0) + minute++ * 60_000).toISOString();
}

function recursivelyCollectAnswerKeys(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    value.forEach(item => recursivelyCollectAnswerKeys(item, found));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "answer") found.push(child);
      recursivelyCollectAnswerKeys(child, found);
    }
  }
  return found;
}

test("one authorization autonomously completes two goals in four calls, isolates held-out items, shares budget, and reopens exactly", async t => {
  const path = temp(t);
  const authorizedPack = pack();
  const store = createStore(path, authorizedPack, 5, 4);
  const enteredRequests: LearningRequest[] = [];
  try {
    await store.changeLifecycle(0, "awake", t0, signal());
    const model = createSyntheticModel((request, input) => {
      enteredRequests.push(structuredClone(request));
      const authorizedGoal = authorizedPack.goals.find(goal => goal.title === input.goal.title)!;
      // Inspect the JSON data projection only: SYSTEM's output schema legitimately names an answer field.
      assert.deepEqual(recursivelyCollectAnswerKeys(input), []);
      if (input.phase === "assessment") {
        assert.deepEqual(input.goal.questions, authorizedGoal.assessment.map(({ id, prompt }) => ({ id, prompt })));
      }
      if (input.phase === "study") {
        assert.equal(authorizedPack.goals.some(goal => JSON.stringify(request.messages).includes(goal.assessment[0]!.prompt)), false);
        assert.equal("learnedNotes" in input.goal, false);
      } else {
        assert.equal(typeof input.goal.learnedNotes, "string");
        assert.match(String(input.goal.learnedNotes), /core value is/);
        assert.equal("material" in input.goal, false);
      }
    });
    const report = await runAutonomousLearning(store, model, signal(), clock());
    assert.equal(enteredRequests.length, 4);
    assert.deepEqual(enteredRequests.map(request => inputOf(request).phase), ["study", "assessment", "study", "assessment"]);
    assert.equal(JSON.stringify(report).includes("\"allGoalsPassed\":true"), true);

    const status = await store.learningStatus(signal());
    assert.ok(status);
    assert.equal(status.reserved, 4);
    assert.equal(status.status, "completed");
    assert.deepEqual(status.attempts.map(attempt => [attempt.goalId, attempt.phase, attempt.status]), [
      ["orbit", "study", "completed"], ["orbit", "assessment", "completed"],
      ["comets", "study", "completed"], ["comets", "assessment", "completed"],
    ]);
    assert.deepEqual(await store.budget(signal()), { limit: 5, reserved: 4, completed: 4, failed: 0, pending: 0 });
    const chatCharge = await store.reserve("chat-after-learning", "ordinary dialogue", (await store.read(signal())).revision, signal());
    await store.fail(chatCharge, signal());
    assert.deepEqual(await store.budget(signal()), { limit: 5, reserved: 5, completed: 4, failed: 1, pending: 0 },
      "ordinary chat and learning attempts debit the same persistent subject budget");
    await assert.rejects(store.reserve("chat-over-budget", "another dialogue", (await store.read(signal())).revision, signal()),
      /budget exhausted/);
    assert.deepEqual(await store.history(signal()), [], "learning attempts and failed chat attempts must not become chat history");

    const learnedState = await store.read(signal());
    const learnedNotes = status.attempts.filter(attempt => attempt.phase === "study")
      .map(attempt => attempt.result?.notes ?? "");
    assert.equal(learnedNotes.length, 2);
    for (const note of learnedNotes) {
      assert.ok(learnedState.memory.records.some(memory => memory.content === note && memory.origin === "inference"),
        "model notes should persist as inference memories, not user chat");
    }
    const ordinaryTurn = prepareTurn(learnedState, await store.history(signal()), {
      user: "请解释天文学中学到的规则。", cycleId: "ordinary-cycle", experienceId: "ordinary-experience",
      at: new Date(Date.parse(t0) + 10 * 60_000).toISOString(),
    });
    const ordinaryContext = ordinaryTurn.messages.map(message => message.text).join("\n");
    assert.ok(learnedNotes.some(note => ordinaryContext.includes(note)),
      "related Chinese-topic dialogue should receive at least one usable learning note in the actual model context");
    const firstNote = learnedNotes[0]!;
    const firstGoalId = status.attempts.find(attempt => attempt.phase === "study")!.goalId;
    const targetedRecall = prepareTurn(learnedState, await store.history(signal()), {
      user: `请解释天文学中 ${firstGoalId}cipher 对应的规则。`, cycleId: "targeted-cycle", experienceId: "targeted-experience",
      at: new Date(Date.parse(t0) + 10 * 60_000).toISOString(),
    });
    assert.ok(targetedRecall.messages.some(message => message.text.includes(firstNote)),
      "a Chinese astronomy query containing a note-specific token should recall that older note");
    assert.equal(ordinaryTurn.messages.at(-1)?.text, "请解释天文学中学到的规则。");
    assert.deepEqual(await store.history(signal()), []);

    const persistedStatus = structuredClone(status);
    store.close();
    const reopened = SqliteSubjectStore.open(path, signal());
    try {
      assert.deepEqual(await reopened.read(signal()), learnedState);
      assert.deepEqual(await reopened.learningStatus(signal()), persistedStatus);
      assert.deepEqual(await reopened.budget(signal()), { limit: 5, reserved: 5, completed: 4, failed: 1, pending: 0 });
      assert.deepEqual(await reopened.history(signal()), []);
    } finally { reopened.close(); }
  } finally { store.close(); }
});

test("a failed assessment is terminal only for its goal; runner finishes other goals and reports incomplete passing", async t => {
  const path = temp(t);
  const authorizedPack = pack();
  const store = createStore(path, authorizedPack, 5, 4);
  const synthetic = createSyntheticModel();
  let calls = 0;
  try {
    await store.changeLifecycle(0, "awake", t0, signal());
    const model: ModelPort = {
      async generate(request, abort) {
        calls++;
        const generated = await synthetic.generate(request, abort);
        const input = inputOf(request);
        if (input.phase === "assessment" && input.goal.title === "Synthetic orbit") {
          return { ...generated, text: JSON.stringify({ notes: "", answers: [{ id: "orbit-heldout", answer: "deliberately wrong" }] }) };
        }
        return generated;
      },
    };
    const report = await runAutonomousLearning(store, model, signal(), clock()) as Record<string, unknown>;
    assert.equal(calls, 4, "a failed assessment must not block the next goal or be retried");
    assert.equal(report.status, "completed", "all goals have a terminal assessment result");
    assert.equal(report.allGoalsPassed, false);
    assert.equal(report.passedGoals, 1);
    assert.equal(report.totalGoals, 2);
    const goalReports = report.goals as { id: string; grade?: { passed: boolean } }[];
    assert.equal(goalReports.find(goal => goal.id === "orbit")?.grade?.passed, false);
    assert.equal(goalReports.find(goal => goal.id === "comets")?.grade?.passed, true);
    const status = await store.learningStatus(signal());
    assert.ok(status);
    assert.equal(status.status, "completed");
    assert.deepEqual(status.attempts.map(attempt => [attempt.goalId, attempt.phase, attempt.status]), [
      ["orbit", "study", "completed"], ["orbit", "assessment", "completed"],
      ["comets", "study", "completed"], ["comets", "assessment", "completed"],
    ]);
    assert.deepEqual(await store.budget(signal()), { limit: 5, reserved: 4, completed: 4, failed: 0, pending: 0 });
  } finally { store.close(); }
});

test("a new runner resumes assessment from committed notes; pending work requires explicit recovery and is never resent", async t => {
  const path = temp(t);
  const store = createStore(path, pack(["orbit"]), 4, 4);
  const afterStudy = new AbortController();
  const stopAfterCommit = new Error("synthetic stop after durable study");
  let firstRunnerCalls = 0;
  try {
    await store.changeLifecycle(0, "awake", t0, signal());
    const delegate: LearningRepository = {
      read: store.read.bind(store), learningStatus: store.learningStatus.bind(store),
      reserveLearning: store.reserveLearning.bind(store), failLearning: store.failLearning.bind(store),
      completeLearning: async (...args) => {
        const state = await store.completeLearning(...args);
        if (args[0].phase === "study") afterStudy.abort(stopAfterCommit);
        return state;
      },
    };
    await assert.rejects(runAutonomousLearning(delegate, createSyntheticModel(() => { firstRunnerCalls++; }), afterStudy.signal, clock()),
      error => error === stopAfterCommit);
    assert.equal(firstRunnerCalls, 1);
    assert.equal((await store.learningStatus(signal()))?.attempts[0]?.status, "completed");
    store.close();

    const restarted = SqliteSubjectStore.open(path, signal());
    const enteredAssessment = deferred();
    const releaseAssessment = deferred();
    const cancelOldRunner = new AbortController();
    const cancelled = new Error("synthetic old runner termination");
    let assessmentCalls = 0;
    const assessmentModel: ModelPort = {
      async generate(request, abort) {
        abort.throwIfAborted();
        const input = inputOf(request);
        assert.equal(input.phase, "assessment", "the restarted runner should continue directly to assessment");
        assert.match(String(input.goal.learnedNotes), /core value is 73/);
        assessmentCalls++;
        enteredAssessment.resolve();
        await releaseAssessment.promise;
        // Simulate an upstream that returns a valid answer despite cancellation.
        return { text: JSON.stringify({ notes: "", answers: [{ id: "orbit-heldout", answer: "73" }] }),
          modelId: "synthetic-learning-model", usage: { inputTokens: 10, outputTokens: 8 } };
      },
    };
    const oldRun = runAutonomousLearning(restarted, assessmentModel, cancelOldRunner.signal, clock());
    await enteredAssessment.promise;
    restarted.close(); // Simulated process death leaves the durable assessment reservation pending.
    cancelOldRunner.abort(cancelled);
    await assert.rejects(oldRun, error => error === cancelled);
    releaseAssessment.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));

    const recovery = SqliteSubjectStore.open(path, signal());
    try {
      let resends = 0;
      await assert.rejects(runAutonomousLearning(recovery, createSyntheticModel(() => { resends++; }), signal(), clock()), /Pending learning call/);
      assert.equal(resends, 0);
      assert.equal(assessmentCalls, 1);
      assert.equal((await recovery.learningStatus(signal()))?.attempts.filter(attempt => attempt.status === "pending").length, 1);
      await recovery.recoverLearning(signal());
      const recovered = await recovery.learningStatus(signal());
      assert.ok(recovered);
      assert.equal(recovered.reserved, 2, "recovery consumes the already charged assessment attempt");
      assert.deepEqual(recovered.attempts.map(attempt => [attempt.phase, attempt.status]), [
        ["study", "completed"], ["assessment", "failed"],
      ]);
      const terminal = await runAutonomousLearning(recovery, createSyntheticModel(() => { resends++; }), signal(), clock());
      assert.equal(JSON.stringify(terminal).includes("\"status\":\"completed\""), true);
      assert.equal(resends, 0, "recovery must not redispatch the pending assessment");
      assert.deepEqual(await recovery.budget(signal()), { limit: 4, reserved: 2, completed: 1, failed: 1, pending: 0 });
    } finally { recovery.close(); }
  } finally { store.close(); }
});

test("cancellation ignores a late model result without a late learning commit", async t => {
  const path = temp(t);
  const store = createStore(path, pack(["orbit"]), 4, 4);
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  const reason = new Error("synthetic cancellation");
  try {
    await store.changeLifecycle(0, "awake", t0, signal());
    const before = await store.read(signal());
    const model: ModelPort = { async generate(_request, _signal) {
      entered.resolve();
      await release.promise;
      return { text: JSON.stringify({ notes: "late notes", answers: [{ id: "orbit-practice", answer: "ORANGE" }] }),
        modelId: "synthetic-learning-model", usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    const run = runAutonomousLearning(store, model, controller.signal, clock());
    await entered.promise;
    controller.abort(reason);
    await assert.rejects(run, error => error === reason);
    assert.deepEqual(await store.read(signal()), before);
    assert.deepEqual((await store.learningStatus(signal()))?.attempts.map(attempt => attempt.status), ["failed"]);
    release.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(await store.read(signal()), before, "late generation must not commit after the runner has cancelled");
    assert.deepEqual(await store.budget(signal()), { limit: 4, reserved: 1, completed: 0, failed: 1, pending: 0 });
  } finally { release.resolve(); store.close(); }
});

test("persistent stop fences a late commit and bad JSON is charged/failed without fabricated scores", async t => {
  const stopPath = temp(t);
  const stoppedStore = createStore(stopPath, pack(["orbit"]), 4, 4);
  const entered = deferred();
  const release = deferred();
  try {
    await stoppedStore.changeLifecycle(0, "awake", t0, signal());
    const before = await stoppedStore.read(signal());
    const model: ModelPort = { async generate(_request, _signal) {
      entered.resolve(); await release.promise;
      return { text: JSON.stringify({ notes: "late notes", answers: [{ id: "orbit-practice", answer: "ORANGE" }] }),
        modelId: "synthetic-learning-model", usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    const run = runAutonomousLearning(stoppedStore, model, signal(), clock());
    await entered.promise;
    await stoppedStore.stopLearning(signal());
    release.resolve();
    await assert.rejects(run, /stopped/);
    assert.deepEqual(await stoppedStore.read(signal()), before, "revoked authorization must reject the in-flight result");
    const stopped = await stoppedStore.learningStatus(signal());
    assert.equal(stopped?.status, "stopped");
    assert.deepEqual(stopped?.attempts.map(attempt => attempt.status), ["failed"]);
    assert.deepEqual(await stoppedStore.budget(signal()), { limit: 4, reserved: 1, completed: 0, failed: 1, pending: 0 });
  } finally { release.resolve(); stoppedStore.close(); }

  const badPath = temp(t);
  const badStore = createStore(badPath, pack(["orbit"]), 4, 4);
  try {
    await badStore.changeLifecycle(0, "awake", t0, signal());
    const before = await badStore.read(signal());
    let calls = 0;
    const malformed: ModelPort = { async generate() {
      calls++;
      return { text: "{not valid JSON", modelId: "synthetic-learning-model", usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    await assert.rejects(runAutonomousLearning(badStore, malformed, signal(), clock()));
    assert.equal(calls, 1);
    assert.deepEqual(await badStore.read(signal()), before);
    const status = await badStore.learningStatus(signal());
    assert.equal(status?.reserved, 1);
    assert.deepEqual(status?.attempts.map(attempt => [attempt.phase, attempt.status, attempt.result]), [["study", "failed", null]]);
    assert.deepEqual(await badStore.budget(signal()), { limit: 4, reserved: 1, completed: 0, failed: 1, pending: 0 });
    assert.deepEqual(await badStore.history(signal()), []);
  } finally { badStore.close(); }
});

test("v2 subject databases remain usable for ordinary subject operations but cannot acquire learning", async t => {
  const path = temp(t);
  const legacyVersion = SqliteSubjectStore.create(path, createInitialState("synthetic-dawn", "Synthetic Dawn", t0), 4, signal());
  try { await legacyVersion.changeLifecycle(0, "awake", t0, signal()); }
  finally { legacyVersion.close(); }
  assert.throws(() => SqliteSubjectStore.createLearning(path,
    createInitialState("synthetic-dawn", "Synthetic Dawn", t0), 4, pack(["orbit"]), 2, signal()), /EEXIST/,
    "learning initialization must not adopt, upgrade, or replace an existing v2 subject file");
  const v2 = SqliteSubjectStore.open(path, signal());
  try {
    assert.equal(await v2.learningStatus(signal()), undefined);
    let calls = 0;
    await assert.rejects(runAutonomousLearning(v2, createSyntheticModel(() => { calls++; }), signal(), clock()), /No explicitly authorized learning pack/);
    assert.equal(calls, 0);
    assert.equal((await v2.read(signal())).lifecycle, "awake");
    assert.deepEqual(await v2.budget(signal()), { limit: 4, reserved: 0, completed: 0, failed: 0, pending: 0 });
  } finally { v2.close(); }
});
