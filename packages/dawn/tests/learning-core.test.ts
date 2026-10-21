import assert from "node:assert/strict";
import test from "node:test";
import {
  assessmentProjection, assertLearningPack, gradeAnswers, parseLearningPack,
  selectLearningGoal, studyProjection,
} from "../src/core/learning.ts";
import type { LearningGoal, LearningPack, LearningQuestion } from "../src/core/learning.ts";
import { createInitialState } from "../src/core/state.ts";
import type { SubjectState } from "../src/core/state.ts";

const AT = "2026-01-01T00:00:00.000Z";

function question(id: string, prompt = `Prompt for ${id}`, answer = `Answer for ${id}`): LearningQuestion {
  return { id, prompt, answer };
}

function goal(id: string, topics: string[] = ["astronomy"], patch: Partial<LearningGoal> = {}): LearningGoal {
  return {
    id, title: `Goal ${id}`, topics, material: "Synthetic study material.",
    practice: [question(`${id}-practice`, "Name a nearby star.", "The Sun")],
    assessment: [question(`${id}-assessment`, "Name the star at the center of our system.", "The Sun")],
    ...patch,
  };
}

function pack(goals: LearningGoal[] = [goal("intro")]): LearningPack {
  return { version: 1, id: "astronomy-pack", title: "Synthetic astronomy", goals };
}

function stateWithEvidence(): SubjectState {
  const initial = createInitialState("dawn-test", "Dawn", AT);
  return {
    ...initial,
    experiences: [{
      id: "evidence", subjectId: "dawn-test", scopeId: "owner", kind: "reading", origin: "document",
      content: "Synthetic astronomy source", topics: ["astronomy"], occurredAt: AT, recordedAt: AT, sourceIds: [],
    }],
  };
}

function withInterest(topic: string): SubjectState {
  const initial = stateWithEvidence();
  return {
    ...initial,
    self: { ...initial.self, interests: [{ topic, strength: 1, evidenceIds: ["evidence"] }] },
  };
}

function withUncertainty(): SubjectState {
  const initial = stateWithEvidence();
  return {
    ...initial,
    cognition: { beliefs: [{
      id: "uncertain", statement: "Astronomy remains uncertain", origin: "document", evidenceIds: ["evidence"],
      confidence: 0.2, status: "tentative", supersedesIds: [], updatedAt: AT,
    }] },
  };
}

test("strict pack contract accepts version 1 and rejects unknown fields, accessors, and custom objects without invoking getters", () => {
  const valid = pack();
  assertLearningPack(valid);
  let getterCalls = 0;
  const getter = Object.defineProperty({}, "version", {
    enumerable: true, get() { getterCalls++; throw new Error("private sentinel"); },
  });
  assert.throws(() => assertLearningPack(getter));
  const nestedGetter = { ...valid, goals: [Object.defineProperty({}, "id", {
    enumerable: true, get() { getterCalls++; throw new Error("private sentinel"); },
  })] };
  assert.throws(() => assertLearningPack(nestedGetter));
  assert.equal(getterCalls, 0);
  assert.throws(() => assertLearningPack({ ...valid, extra: true }));
  assert.throws(() => assertLearningPack({ ...valid, version: 2 }));
  assert.throws(() => assertLearningPack({ ...valid, goals: [Object.assign(Object.create({ inherited: true }), valid.goals[0])] }));
  assert.throws(() => assertLearningPack({ ...valid, goals: [new Array(1)] }));
  assert.throws(() => assertLearningPack({ ...valid, goals: [valid.goals[0], valid.goals[0]] }));
  assert.throws(() => assertLearningPack({ ...valid, goals: [] }));
});

test("strict pack contract enforces item bounds, unique IDs, and rejects external URL/file references", () => {
  const valid = pack();
  assert.throws(() => assertLearningPack({ ...valid, goals: Array.from({ length: 17 }, (_, i) => goal(`g${i}`)) }));
  assert.throws(() => assertLearningPack(pack([goal("many-practice", [], {
    practice: Array.from({ length: 9 }, (_, i) => question(`p${i}`)),
  })])));
  assert.throws(() => assertLearningPack(pack([goal("many-assessment", [], {
    assessment: Array.from({ length: 9 }, (_, i) => question(`a${i}`)),
  })])));
  assert.throws(() => assertLearningPack(pack([goal("empty-practice", [], { practice: [] })])));
  assert.throws(() => assertLearningPack(pack([goal("empty-assessment", [], { assessment: [] })])));
  assert.throws(() => assertLearningPack(pack([goal("many-topics", Array.from({ length: 7 }, (_, i) => `topic${i}`))])));
  assert.throws(() => assertLearningPack(pack([goal("long-material", [], { material: "x".repeat(6001) })])));
  assert.throws(() => assertLearningPack(pack([goal("long-prompt", [], { practice: [question("p", "x".repeat(1001))] })])));
  assert.throws(() => assertLearningPack(pack([goal("long-answer", [], { practice: [question("p", "Prompt", "x".repeat(257))] })])));
  assert.throws(() => assertLearningPack(pack([goal("same-question", [], {
    practice: [question("reused")], assessment: [question("reused")],
  })])));
  assert.throws(() => assertLearningPack(pack([goal("url", [], { material: "Read https://example.invalid/lesson" })])));
  assert.throws(() => assertLearningPack(pack([goal("domain", [], { material: "Read from example.invalid" })])));
  assert.throws(() => assertLearningPack(pack([goal("file", [], { material: "Use file:///tmp/private.txt" })])));
  assert.throws(() => assertLearningPack(pack([goal("path", [], { material: "Open ./lessons/private.txt" })])));

  const tooLarge = pack(Array.from({ length: 11 }, (_, i) => goal(`large${i}`, [], { material: "m".repeat(6000) })));
  assert.throws(() => assertLearningPack(tooLarge), /64000/);
});

test("JSON parser validates packs and rejects duplicate keys instead of silently accepting the last value", () => {
  const text = JSON.stringify(pack());
  assert.deepEqual(parseLearningPack(text), pack());
  assert.throws(() => parseLearningPack('{"version":1,"version":1}'));
  assert.throws(() => parseLearningPack('{"version":1,"id":"x","title":"x","goals":[],"goals":[]}'));
  assert.throws(() => parseLearningPack(" ".repeat(64_001)));
  assert.throws(() => parseLearningPack("not json"));
});

test("study and assessment projections isolate practice answers, held-out questions, and material", () => {
  const selected = goal("projection", ["astronomy"], {
    material: "Private study-only material.",
    practice: [question("practice", "Practice prompt", "Practice answer secret")],
    assessment: [question("held-out", "Assessment prompt secret", "Assessment answer secret")],
  });
  const study = studyProjection(selected);
  const assessment = assessmentProjection(selected);
  assert.deepEqual(study, {
    title: selected.title, topics: ["astronomy"], material: "Private study-only material.",
    practice: [{ id: "practice", prompt: "Practice prompt" }],
  });
  assert.deepEqual(assessment, {
    title: selected.title, topics: ["astronomy"], questions: [{ id: "held-out", prompt: "Assessment prompt secret" }],
  });
  assert.equal(JSON.stringify(study).includes("Practice answer secret"), false);
  assert.equal(JSON.stringify(study).includes("Assessment answer secret"), false);
  assert.equal(JSON.stringify(study).includes("Assessment prompt secret"), false);
  assert.equal(JSON.stringify(assessment).includes("Assessment answer secret"), false);
  assert.equal(JSON.stringify(assessment).includes("Private study-only material"), false);
  assert.notEqual(study.topics, selected.topics);
  selected.topics.push("changed");
  assert.deepEqual(study.topics, ["astronomy"]);
});

test("selection uses matching interests and uncertainty deterministically, excludes finished goals, and clones results", () => {
  const candidatePack = pack([goal("music", ["music"]), goal("space", ["astronomy"]), goal("math", ["algebra"])]);
  const interested = withInterest("astronomy");
  const byInterest = selectLearningGoal(candidatePack, interested, []);
  assert.equal(byInterest?.id, "space");
  assert.notEqual(byInterest, candidatePack.goals[1]);
  assert.notEqual(byInterest?.topics, candidatePack.goals[1]?.topics);

  const uncertainPack = pack([goal("music", ["music"]), goal("uncertain-space", ["astronomy"])]);
  assert.equal(selectLearningGoal(uncertainPack, withUncertainty(), [])?.id, "uncertain-space");
  assert.equal(selectLearningGoal(candidatePack, interested, ["space"])?.id, "music");
  const concernState = stateWithEvidence();
  const withConcern: SubjectState = {
    ...concernState,
    self: { ...concernState.self, concerns: [{
      id: "concern-astronomy", description: "Astronomy is unresolved", topics: ["astronomy"], weight: 1,
    }] },
  };
  assert.equal(selectLearningGoal(candidatePack, withConcern, [])?.id, "space");

  const mixedBase = stateWithEvidence();
  const mixedPreferences: SubjectState = {
    ...mixedBase,
    self: {
      ...mixedBase.self,
      interests: [{ topic: "astronomy", strength: 0.9, evidenceIds: ["evidence"] }],
      concerns: [{ id: "concern-music", description: "Music concern", topics: ["music"], weight: 0.7 }],
    },
  };
  const mixedPack = pack([goal("interest", ["astronomy"]), goal("concern", ["music"])]);
  assert.equal(selectLearningGoal(mixedPack, mixedPreferences, [])?.id, "interest");
  const tensePreferences: SubjectState = {
    ...mixedPreferences,
    affect: { ...mixedPreferences.affect, tension: 1 },
  };
  assert.equal(selectLearningGoal(mixedPack, tensePreferences, [])?.id, "concern");
  assert.equal(selectLearningGoal(candidatePack, interested, candidatePack.goals.map(item => item.id)), undefined);

  const tiedPack = pack([goal("first", ["unmatched-a"]), goal("second", ["unmatched-b"])]);
  const tieState = stateWithEvidence();
  assert.equal(selectLearningGoal(tiedPack, tieState, [])?.id, "first");
});

test("grading requires exact unique question coverage and compares NFC lowercase collapsed whitespace", () => {
  const questions = [question("q1", "First?", "Café au lait"), question("q2", "Second?", "ONE\tTWO")];
  assert.deepEqual(gradeAnswers(questions, [
    { id: "q1", answer: "  CAFE\u0301   AU  LAIT " }, { id: "q2", answer: "one two" },
  ]), { correct: 2, total: 2, passed: true });
  assert.deepEqual(gradeAnswers(questions, [
    { id: "q1", answer: "Café au lait" }, { id: "q2", answer: "one three" },
  ]), { correct: 1, total: 2, passed: false });
  for (const answers of [
    [{ id: "q1", answer: "Café au lait" }],
    [{ id: "q1", answer: "Café au lait" }, { id: "q1", answer: "Café au lait" }],
    [{ id: "q1", answer: "Café au lait" }, { id: "unknown", answer: "ONE TWO" }],
    [{ id: "q1", answer: "Café au lait", extra: true }, { id: "q2", answer: "ONE TWO" }],
    [{ id: "q1", answer: "Café au lait" }, { id: "q2", answer: "x".repeat(1025) }],
  ]) assert.throws(() => gradeAnswers(questions, answers));
  assert.throws(() => gradeAnswers(questions, new Array(2)));
  assert.throws(() => gradeAnswers([question("q", "P", "A"), question("q", "P", "A")], [
    { id: "q", answer: "A" }, { id: "q", answer: "A" },
  ]));
  assert.deepEqual(gradeAnswers([], []), { correct: 0, total: 0, passed: false });
});
