import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, type SetupDependencies, type SetupUI } from "../../../docker/setup.ts";
import { verifyFiles as verifyFilesCommand } from "../../../docker/manage.ts";

const TOKEN = "S".repeat(43);
const KEY = "Synthetic-key-value!";
const MODEL = {
  baseUrl: "https://127.0.0.1:9876/v1", model: "synthetic-setup-model", credentialEnv: "DAWN_MODEL_API_KEY",
  maxCalls: 4, reasoningEffort: "off", timeoutMs: 30_000,
};

function fixture(t: TestContext): string {
  const parent = mkdtempSync(join(tmpdir(), "dawn-container-setup-"));
  const data = join(parent, "data");
  mkdirSync(data, { mode: 0o700 });
  chmodSync(data, 0o700);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return data;
}

function put(data: string, name: string, content: string): void {
  const path = join(data, name);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function completeFiles(data: string): void {
  put(data, "subject.sqlite", "synthetic sqlite placeholder");
  put(data, "service.token", `${TOKEN}\n`);
  put(data, "model.json", JSON.stringify(MODEL));
  put(data, "model.env", `${MODEL.credentialEnv}='${KEY}'\n`);
}

class ScriptUI implements SetupUI {
  readonly prompts: string[] = [];
  readonly shown: string[] = [];
  closed = false;
  private readonly answers: string[];
  constructor(answers: string[]) { this.answers = answers; }
  async ask(prompt: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    this.prompts.push(prompt);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error("synthetic setup answers exhausted");
    return answer;
  }
  show(text: string): void { this.shown.push(text); }
  close(): void { this.closed = true; }
}

function mockCommands(data: string, log: string[], failToken = false): NonNullable<SetupDependencies["runCommand"]> {
  return async (args, signal) => {
    signal.throwIfAborted();
    log.push(args.join(" "));
    if (args[0] === "learning-init") put(data, "subject.sqlite", "synthetic SQLite evidence; never opened");
    else if (args[0] === "token-init") {
      if (failToken) throw new Error("synthetic command failure containing private text");
      put(data, "service.token", `${TOKEN}\n`);
    } else assert.fail(`unexpected command ${args[0]}`);
  };
}

test("complete private files are verified read-only without UI, writes, or SQLite access", async t => {
  const data = fixture(t);
  completeFiles(data);
  const before = ["subject.sqlite", "service.token", "model.json", "model.env"].map(name => ({
    contents: readFileSync(join(data, name)), stat: lstatSync(join(data, name)),
  }));
  const result = await runSetup(data, new AbortController().signal, {
    ui: { async ask() { assert.fail("complete setup must not prompt"); }, show() { assert.fail("complete setup must not display prompts"); } },
  });
  assert.deepEqual(result, { setupCompleted: true, alreadyConfigured: true });
  for (const [index, name] of ["subject.sqlite", "service.token", "model.json", "model.env"].entries()) {
    assert.deepEqual(readFileSync(join(data, name)), before[index]!.contents);
    assert.equal(lstatSync(join(data, name)).mtimeMs, before[index]!.stat.mtimeMs);
  }
});

test("first setup creates only approved config, shared budgets and files using injected CLI; secret prompt starts after UI closes", async t => {
  const data = fixture(t);
  const ui = new ScriptUI(["", "", "https://127.0.0.1:9876/v1", "synthetic-setup-model", "", "yes"]);
  const calls: string[] = [];
  let keyRead = false;
  const result = await runSetup(data, new AbortController().signal, {
    ui,
    runCommand: mockCommands(data, calls),
    async readCredential(signal) {
      assert.equal(ui.closed, true, "readline UI must close before raw TTY reader starts");
      assert.equal(calls.length, 2, "database and service token are established before model/key writes");
      signal.throwIfAborted(); keyRead = true; return KEY;
    },
  });
  assert.deepEqual(result, { setupCompleted: true });
  assert.equal(keyRead, true);
  assert.match(ui.shown[0]!, /调用次数是固定次数上限，不是金额或费用/);
  assert.match(ui.shown[0]!, /不会自动 wake、generate、learn/);
  assert.ok(ui.shown.some(message => message.includes("学习额度 4 次") && message.includes("maxCalls 固定为 4") &&
    message.includes("timeoutMs 固定为 30000") && message.includes("DAWN_MODEL_API_KEY")));
  assert.deepEqual(calls.map(call => call.split(" ")[0]), ["learning-init", "token-init"]);
  assert.match(calls[0]!, /--name 曙光 --limit 20 --learning-limit 4/);
  assert.match(calls[0]!, /learning-pack\.example\.json/);
  assert.equal(readFileSync(join(data, "subject.sqlite"), "utf8"), "synthetic SQLite evidence; never opened");
  assert.deepEqual(JSON.parse(readFileSync(join(data, "model.json"), "utf8")), MODEL);
  assert.equal(readFileSync(join(data, "model.env"), "utf8"), `${MODEL.credentialEnv}='${KEY}'\n`);
  for (const name of ["subject.sqlite", "service.token", "model.json", "model.env"]) {
    assert.equal(lstatSync(join(data, name)).mode & 0o777, 0o600);
  }
});

test("default process.execPath CLI commands create a synthetic learning DB and token without a shell or network", async t => {
  const data = fixture(t);
  const ui = new ScriptUI(["", "", "https://127.0.0.1:9876/v1", "synthetic-setup-model", "", "yes"]);
  const result = await runSetup(data, new AbortController().signal, {
    ui,
    async readCredential(signal) { assert.equal(ui.closed, true); signal.throwIfAborted(); return KEY; },
    // The default offline preflight checks bounded files/config/credential, not SQLite contents.
  });
  assert.deepEqual(result, { setupCompleted: true });
  assert.match(readFileSync(join(data, "service.token"), "ascii"), /^[A-Za-z0-9_-]{43}\n$/);
  assert.deepEqual(JSON.parse(readFileSync(join(data, "model.json"), "utf8")), MODEL);
  assert.equal(readFileSync(join(data, "model.env"), "utf8"), `${MODEL.credentialEnv}='${KEY}'\n`);
  for (const name of ["subject.sqlite", "service.token", "model.json", "model.env"]) {
    assert.equal(lstatSync(join(data, name)).mode & 0o777, 0o600);
  }
});

test("existing model is never rewritten; missing env requires explicit confirmation and hidden credential injection", async t => {
  const data = fixture(t);
  put(data, "subject.sqlite", "synthetic existing database; untouched");
  put(data, "service.token", `${TOKEN}\n`);
  const modelText = `${JSON.stringify(MODEL, null, 2)}\n`;
  put(data, "model.json", modelText);
  const ui = new ScriptUI(["yes"]);
  let stored = 0;
  const result = await runSetup(data, new AbortController().signal, {
    ui,
    runCommand: async () => assert.fail("existing subject/token must not be recreated"),
    async readCredential() { assert.equal(ui.closed, true); return KEY; },
    storeCredential(path, key, signal) {
      stored += 1;
      assert.equal(path, data); assert.equal(key, KEY); signal.throwIfAborted();
      put(data, "model.env", `${MODEL.credentialEnv}='${key}'\n`);
    },
  });
  assert.deepEqual(result, { setupCompleted: true });
  assert.equal(stored, 1);
  assert.ok(ui.shown.some(message => message.includes("不会重写模型配置")));
  assert.equal(readFileSync(join(data, "model.json"), "utf8"), modelText);
  assert.equal(readFileSync(join(data, "subject.sqlite"), "utf8"), "synthetic existing database; untouched");
});

test("explicit refusal to supplement an existing model leaves files unchanged", async t => {
  const data = fixture(t);
  put(data, "subject.sqlite", "synthetic database");
  put(data, "service.token", `${TOKEN}\n`);
  put(data, "model.json", JSON.stringify(MODEL));
  const ui = new ScriptUI(["no"]);
  let keyRead = false;
  const result = await runSetup(data, new AbortController().signal, {
    ui,
    async readCredential() { keyRead = true; return KEY; },
    runCommand: async () => assert.fail("must not initialize files"),
  });
  assert.deepEqual(result, { setupCompleted: false });
  assert.equal(keyRead, false);
  assert.throws(() => lstatSync(join(data, "model.env")), { code: "ENOENT" });
});

test("existing env without model is preserved; completing config succeeds only when the stored binding matches", async t => {
  for (const [variable, shouldVerify] of [[MODEL.credentialEnv, true], ["OTHER_API_KEY", false]] as const) {
    const data = fixture(t);
    put(data, "subject.sqlite", "synthetic existing DB evidence");
    put(data, "service.token", `${TOKEN}\n`);
    put(data, "model.env", `${variable}='${KEY}'\n`);
    const originalEnv = readFileSync(join(data, "model.env"), "utf8");
    const ui = new ScriptUI(["https://127.0.0.1:9876/v1", "synthetic-setup-model", "off", "yes"]);
    let verifierCalled = false;
    const deps: SetupDependencies = {
      ui,
      runCommand: async () => assert.fail("existing subject and token must not be recreated"),
      verifyFiles(path) {
        verifierCalled = true;
        assert.equal(path, data);
        verifyFilesCommand(path);
      },
    };
    if (shouldVerify) {
      assert.deepEqual(await runSetup(data, new AbortController().signal, deps), { setupCompleted: true });
    } else {
      await assert.rejects(runSetup(data, new AbortController().signal, deps));
    }
    assert.equal(verifierCalled, true);
    assert.equal(readFileSync(join(data, "model.env"), "utf8"), originalEnv, "existing env is never replaced");
    assert.deepEqual(JSON.parse(readFileSync(join(data, "model.json"), "utf8")), MODEL);
  }
});

test("database/token asymmetry fails before UI or token regeneration", async t => {
  for (const present of ["subject.sqlite", "service.token"] as const) {
    const data = fixture(t);
    if (present === "subject.sqlite") put(data, present, "synthetic DB");
    if (present === "service.token") put(data, present, `${TOKEN}\n`);
    let prompted = false;
    let commandRun = false;
    await assert.rejects(runSetup(data, new AbortController().signal, {
      ui: { async ask() { prompted = true; return "yes"; }, show() { prompted = true; } },
      async runCommand() { commandRun = true; },
    }));
    assert.equal(prompted, false);
    assert.equal(commandRun, false);
  }
});

test("learning-init evidence remains after subsequent token command failure", async t => {
  const data = fixture(t);
  const ui = new ScriptUI(["曙光", "20", "https://127.0.0.1:9876/v1", "synthetic-setup-model", "off", "yes"]);
  const calls: string[] = [];
  await assert.rejects(runSetup(data, new AbortController().signal, {
    ui, runCommand: mockCommands(data, calls, true),
    async readCredential(signal) { signal.throwIfAborted(); return KEY; },
  }), /synthetic command failure|设置失败/);
  assert.equal(calls.length, 2);
  assert.equal(readFileSync(join(data, "subject.sqlite"), "utf8"), "synthetic SQLite evidence; never opened");
  assert.throws(() => lstatSync(join(data, "service.token")), { code: "ENOENT" });
  assert.throws(() => lstatSync(join(data, "model.json")), { code: "ENOENT" });
});

test("only explicit yes starts writes; EOF/abort and malformed or unsafe existing files are rejected", async t => {
  const data = fixture(t);
  const no = new ScriptUI(["", "", "https://127.0.0.1:9876/v1", "synthetic-setup-model", "", "no"]);
  const refused = await runSetup(data, new AbortController().signal, { ui: no, runCommand: async () => assert.fail("no writes") });
  assert.deepEqual(refused, { setupCompleted: false });
  assert.equal(no.prompts.length, 6);
  assert.deepEqual(readdirSync(data), []);
  assert.ok(no.shown.some(text => text.includes("设置预览") && text.includes('"totalCalls": 20')));

  const abortedData = fixture(t);
  const controller = new AbortController();
  const abortedUi: SetupUI = {
    async ask() { controller.abort(); return "yes"; }, show() {},
  };
  await assert.rejects(runSetup(abortedData, controller.signal, { ui: abortedUi }), { name: "AbortError" });
  assert.deepEqual(readdirSync(abortedData), []);

  const badModelData = fixture(t);
  put(badModelData, "model.json", "{}\n");
  let prompted = false;
  await assert.rejects(runSetup(badModelData, new AbortController().signal, {
    ui: { async ask() { prompted = true; return "yes"; }, show() { prompted = true; } },
  }));
  assert.equal(prompted, false);

  const symlinkData = fixture(t);
  put(symlinkData, "subject.sqlite", "synthetic DB");
  symlinkSync(join(symlinkData, "subject.sqlite"), join(symlinkData, "service.token"));
  await assert.rejects(runSetup(symlinkData, new AbortController().signal, { ui: no }));
});
