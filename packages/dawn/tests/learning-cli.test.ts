import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/runtime/cli.ts";
import { parseLearningResult } from "../src/runtime/learning-runner.ts";
import { SqliteSubjectStore } from "../src/adapters/storage/sqlite-subject.ts";

const signal = () => new AbortController().signal;
const pack = { version: 1, id: "cli-pack", title: "Synthetic study", goals: [{ id: "alpha", title: "Alpha rule", topics: ["alpha"],
  material: "Alpha has number 73. Beta has number 82.",
  practice: [{ id: "p-alpha", prompt: "Alpha number?", answer: "73" }],
  assessment: [{ id: "a-beta", prompt: "Beta number?", answer: "82" }] }] };

test("learning output cannot self-score, add permissions or rewrite notes during assessment", () => {
  for (const value of [
    "free text", '```json\n{"notes":"learned","answers":[]}\n```',
    JSON.stringify({ notes: "learned", answers: [], score: 1 }),
    JSON.stringify({ notes: "learned", answers: [], permissions: ["network"] }),
    JSON.stringify({ notes: "learned", answers: [{ id: "q", answer: "a", passed: true }] }),
    JSON.stringify({ notes: "learned", answers: [{ id: "q", answer: "a".repeat(1025) }] }),
    JSON.stringify({ notes: " ", answers: [] }),
  ]) assert.throws(() => parseLearningResult(value, "study"));
  assert.throws(() => parseLearningResult(JSON.stringify({ notes: "rewrite", answers: [] }), "assessment"));
  assert.deepEqual(parseLearningResult('{"notes":"","answers":[{"id":"q","answer":"a"}]}', "assessment"),
    { notes: "", answers: [{ id: "q", answer: "a" }] });
});

test("learning CLI validates explicit authorization before creating files", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-learning-cli-validation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = ["learning-init", "--db", join(dir, "subject.sqlite"), "--id", "dawn", "--name", "Dawn", "--limit", "10"];
  for (const args of [base, [...base, "--learning-limit", "1", "--pack", "missing"],
    [...base, "--learning-limit", "11", "--pack", "missing"], ["learning-run", "--db", "relative", "--model-config", "missing"],
    ["learning-status", "--db", join(dir, "none.sqlite"), "--force", "yes"],
    ["learning-stop", "--db", join(dir, "none.sqlite"), "--db", "duplicate"]]) {
    await assert.rejects(runCli(args, signal()));
  }
  assert.deepEqual(readdirSync(dir), []);
  const packFile = join(dir, "pack.json");
  writeFileSync(packFile, JSON.stringify(pack));
  const link = join(dir, "pack-link.json");
  symlinkSync(packFile, link);
  await assert.rejects(runCli([...base, "--learning-limit", "2", "--pack", link], signal()));
  assert.equal(existsSync(join(dir, "subject.sqlite")), false);
  writeFileSync(packFile, "x".repeat(64_001));
  await assert.rejects(runCli([...base, "--learning-limit", "2", "--pack", packFile], signal()));
  assert.equal(existsSync(join(dir, "subject.sqlite")), false);
});

test("learning CLI runs an authorized objective to completion through the actual model adapter", { timeout: 15_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-learning-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "subject.sqlite"), packFile = join(dir, "pack.json"), modelFile = join(dir, "model.json");
  writeFileSync(packFile, JSON.stringify(pack), { mode: 0o600 });
  let calls = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw) as { messages: { role: string; content: string }[] };
    const input = JSON.parse(request.messages.at(-1)!.content) as { phase: string; goal: Record<string, unknown> };
    assert.ok(!raw.includes('"answer":"73"') && !raw.includes('"answer":"82"'));
    const study = input.phase === "study";
    if (study) assert.ok(!raw.includes("a-beta"));
    else assert.match(String(input.goal.learnedNotes), /82/);
    calls++;
    const content = JSON.stringify(study ? { notes: "Alpha=73; Beta=82", answers: [{ id: "p-alpha", answer: "73" }] }
      : { notes: "", answers: [{ id: "a-beta", answer: "82" }] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "test-response", model: "synthetic-learning", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 30, completion_tokens: 30 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const credentialEnv = "DAWN_LEARNING_CLI_SYNTHETIC_" + process.pid;
  assert.equal(process.env[credentialEnv], undefined);
  process.env[credentialEnv] = "synthetic-test-only";
  t.after(() => { delete process.env[credentialEnv]; });
  writeFileSync(modelFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "synthetic-learning", credentialEnv,
    maxCalls: 2, reasoningEffort: "low", timeoutMs: 2000 }), { mode: 0o600 });
  await runCli(["learning-init", "--db", db, "--id", "dawn", "--name", "Dawn", "--limit", "6", "--learning-limit", "2", "--pack", packFile], signal());
  await runCli(["subject-wake", "--db", db, "--revision", "0"], signal());
  const result = await runCli(["learning-run", "--db", db, "--model-config", modelFile], signal());
  const report = JSON.stringify(result);
  assert.match(report, /"passed":true/);
  assert.doesNotMatch(report, /synthetic-test-only|Beta=82|Alpha=73|"answer"|material/);
  assert.equal(calls, 2);
  const store = SqliteSubjectStore.open(db, signal());
  try {
    assert.equal((await store.budget(signal())).reserved, 2);
    assert.equal((await store.history(signal())).length, 0);
    assert.ok((await store.read(signal())).memory.records.some(m => m.content.includes("Beta=82")));
  } finally { store.close(); }
  await runCli(["learning-stop", "--db", db], signal());
  assert.match(JSON.stringify(await runCli(["learning-status", "--db", db], signal())), /stopped/);
});
