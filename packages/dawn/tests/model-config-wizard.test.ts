import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { parseModelConfig } from "../src/adapters/models/config.ts";
import { createModelConfigTerminal } from "../src/adapters/models/config-terminal.ts";
import { runModelConfigWizard, type ModelConfigUI } from "../src/runtime/model-config-wizard.ts";

function fixture(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "dawn-model-config-wizard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

class ScriptUI implements ModelConfigUI {
  readonly prompts: string[] = [];
  readonly shown: string[] = [];
  private readonly answers: string[];
  constructor(answers: string[]) { this.answers = answers; }
  async ask(prompt: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    this.prompts.push(prompt);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error("synthetic script exhausted");
    return answer;
  }
  show(text: string): void { this.shown.push(text); }
}

const learningDefaults = ["2", "1", "", "synthetic-learning-model", "", "", "", ""];
const chatDefaults = ["", "1", "", "synthetic-chat-model", "", "", "", ""];

async function createWith(t: TestContext, answers: string[], filename = "model.json") {
  const dir = fixture(t);
  const path = join(dir, filename);
  const ui = new ScriptUI(answers);
  const result = await runModelConfigWizard(["model-config", "--output", path], new AbortController().signal, ui);
  return { dir, path, ui, result };
}

test("wizard defaults, order, private creation and credential-free validation", async t => {
  const { path, ui, result } = await createWith(t, [...learningDefaults, "yes"]);
  assert.deepEqual(result, { modelConfigCreated: true });
  assert.deepEqual(ui.prompts.map(prompt => prompt.slice(0, prompt.indexOf("[") > 0 ? prompt.indexOf("[") : prompt.length)), [
    "用途：1 交流（默认，建议最多3次），2 学习（建议最多4次）：", "连接类型：1 OpenAI，2 自定义 OpenAI 兼容：",
    "baseUrl ", "模型 ID（必填，不会自动选择）：", "凭据环境变量名称（仅填写变量名，请勿粘贴密钥）",
    "reasoning_effort（low/medium/high/xhigh/max）", "超时毫秒（1–30000）",
    "本配置单次运行调用上限（1–10）", "确认保存？（yes/no）: ",
  ]);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(value, {
    baseUrl: "https://api.openai.com/v1", model: "synthetic-learning-model", credentialEnv: "OPENAI_API_KEY",
    maxCalls: 4, reasoningEffort: "low", timeoutMs: 30_000,
  });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(value as object).sort(), ["baseUrl", "credentialEnv", "maxCalls", "model", "reasoningEffort", "timeoutMs"]);
  assert.ok(!readFileSync(path, "utf8").includes("apiKey"));
  assert.ok(!readFileSync(path, "utf8").includes("command"));
  // Parsing performs adapter validation but never resolves the declared env name.
  assert.deepEqual(parseModelConfig(value), value);
  const unsetCredential = "DAWN_MODEL_CONFIG_WIZARD_UNSET_TEST_KEY";
  const previous = process.env[unsetCredential];
  delete process.env[unsetCredential];
  t.after(() => { if (previous === undefined) delete process.env[unsetCredential]; else process.env[unsetCredential] = previous; });
  const noEnvConfig = { ...(value as object), credentialEnv: unsetCredential };
  assert.deepEqual(parseModelConfig(noEnvConfig), noEnvConfig);
  assert.ok(!ui.shown.join("\n").includes("apiKey"));
});

test("chat uses its 3-call default; custom endpoint and explicit fields are retained", async t => {
  const { path, result, ui } = await createWith(t, [
    "1", "2", "https://custom.example/v1", "custom-model", "CUSTOM_MODEL_CREDENTIAL", "high", "12000", "2", "yes",
  ]);
  assert.deepEqual(result, { modelConfigCreated: true });
  const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(config, {
    baseUrl: "https://custom.example/v1", model: "custom-model", credentialEnv: "CUSTOM_MODEL_CREDENTIAL",
    maxCalls: 2, reasoningEffort: "high", timeoutMs: 12_000,
  });
  const { path: defaultPath, result: defaultResult } = await createWith(t, [...chatDefaults, "yes"], "chat.json");
  assert.deepEqual(defaultResult, { modelConfigCreated: true });
  assert.equal((JSON.parse(readFileSync(defaultPath, "utf8")) as { maxCalls: number }).maxCalls, 3);
  assert.ok(ui.shown.some(text => text.includes("建议最多3次") && text.includes("建议最多4次")));
});

test("invalid answers are retried with fixed messages and never leaked into preview", async t => {
  const secret = "synthetic-secret-that-is-not-a-key";
  const ui = new ScriptUI([
    secret, "2", // bad then valid purpose
    "3", "2", // bad then custom connection
    "file:///etc/passwd", "https://127.0.0.1:1234/v1", // bad then loopback URL
    `model\u001b[31m`, "synthetic-safe-model", // terminal control rejected; safe replacement
    "not an env name", "SYNTHETIC_WIZARD_CREDENTIAL", // bad then valid env name
    "ultra", "max", // unsupported then valid effort
    "0", "30001", "8000", // timeout boundary retries
    "01", "11", "4", // calls retries
    "perhaps", "no", // confirmation retries then cancel
  ]);
  const dir = fixture(t);
  const path = join(dir, "cancelled.json");
  assert.deepEqual(await runModelConfigWizard(["model-config", "--output", path], new AbortController().signal, ui), { modelConfigCreated: false });
  assert.equal(ui.prompts.length, 2 + 2 + 2 + 2 + 2 + 2 + 3 + 3 + 2);
  const shown = ui.shown.join("\n");
  assert.ok(shown.includes("输入无效，请按提示重新输入。"));
  assert.ok(!shown.includes(secret));
  assert.ok(!shown.includes("/etc/passwd"));
  assert.ok(!shown.includes("ultra"));
  assert.ok(!shown.includes("perhaps"));
  assert.ok(!shown.includes('"apiKey"'));
  assert.ok(!shown.includes('"command"'));
  assert.throws(() => lstatSync(path), { code: "ENOENT" });
});

test("field retry limit stops after five attempts without echoing input or creating output", async t => {
  const dir = fixture(t);
  const path = join(dir, "retry-limit.json");
  const injected = "synthetic-should-not-echo";
  const ui = new ScriptUI([injected, injected, injected, injected, injected, "1"]);
  await assert.rejects(runModelConfigWizard(["model-config", "--output", path], new AbortController().signal, ui), /连续输入无效/);
  assert.equal(ui.prompts.length, 5);
  assert.equal(ui.shown.filter(message => message === "输入无效，请按提示重新输入。").length, 5);
  assert.ok(!ui.shown.join("\n").includes(injected));
  assert.throws(() => lstatSync(path), { code: "ENOENT" });
});

test("preview visibly escapes Unicode terminal formatting characters in valid model identifiers", async t => {
  const model = "synthetic\u2028\u202e-model";
  const { ui, result } = await createWith(t, ["1", "1", "", model, "", "", "", "", "yes"]);
  assert.deepEqual(result, { modelConfigCreated: true });
  const preview = ui.shown.find(text => text.includes("配置预览"));
  assert.ok(preview);
  assert.ok(preview.includes("\\u2028"));
  assert.ok(preview.includes("\\u202e"));
  assert.ok(!preview.includes("\u2028"));
  assert.ok(!preview.includes("\u202e"));
});

test("no confirmation and an aborted signal never create a destination", async t => {
  const dir = fixture(t);
  for (const [name, confirmation] of [["no.json", "no"], ["empty.json", ""]] as const) {
    const ui = new ScriptUI([...chatDefaults, confirmation]);
    assert.deepEqual(await runModelConfigWizard(["model-config", "--output", join(dir, name)], new AbortController().signal, ui), {
      modelConfigCreated: false,
    });
  }
  const eofPath = join(dir, "eof.json");
  const eofUi: ModelConfigUI = { async ask() { throw new Error("模型配置向导已取消；未保存配置。"); }, show() {} };
  await assert.rejects(runModelConfigWizard(["model-config", "--output", eofPath], new AbortController().signal, eofUi), /已取消/);
  assert.throws(() => lstatSync(eofPath), { code: "ENOENT" });

  const controller = new AbortController();
  const ui: ModelConfigUI = {
    async ask(_prompt, signal) { controller.abort(); signal.throwIfAborted(); return "yes"; },
    show() {},
  };
  const abortedPath = join(dir, "aborted.json");
  await assert.rejects(runModelConfigWizard(["model-config", "--output", abortedPath], controller.signal, ui), { name: "AbortError" });
  assert.throws(() => lstatSync(abortedPath), { code: "ENOENT" });
});

test("arguments and existing files or symlinks are rejected before UI", async t => {
  const dir = fixture(t);
  const existing = join(dir, "existing.json");
  writeFileSync(existing, "synthetic original");
  const target = join(dir, "symlink-target.json");
  const link = join(dir, "symlink.json");
  symlinkSync(target, link);
  const ui: ModelConfigUI = { async ask() { assert.fail("UI should not be called"); }, show() { assert.fail("UI should not be called"); } };
  for (const args of [
    ["model-config", "--output", "relative.json"],
    ["model-config", "--output", existing],
    ["model-config", "--output", link],
    ["model-config", "--output", join(dir, "missing", "out.json")],
    ...["\u0000", "\u001b", "\u007f", "\u0085"].map(control => ["model-config", "--output", `${join(dir, "unsafe")}${control}path.json`]),
    ["model-config", "--output", join(dir, "a.json"), "--extra"],
    ["model-config", "--output", join(dir, "a.json"), "--output", join(dir, "b.json")],
  ]) await assert.rejects(runModelConfigWizard(args, new AbortController().signal, ui));
  assert.equal(readFileSync(existing, "utf8"), "synthetic original");
  assert.equal(readlinkSync(link), target);
  assert.throws(() => lstatSync(target), { code: "ENOENT" });
  assert.throws(() => lstatSync(join(dir, "a.json")), { code: "ENOENT" });
});

test("terminal rejects non-TTY streams without reading piped input", () => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  assert.throws(() => createModelConfigTerminal(input, output), /需要交互式终端.*没有读取标准输入中的管道内容/);
  input.destroy();
});

test("terminal EOF and abort reject pending prompts rather than returning empty defaults", async t => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } }) as Writable & { isTTY: boolean };
  input.isTTY = true;
  output.isTTY = true;
  const terminal = createModelConfigTerminal(input, output);
  const eof = terminal.ui.ask("prompt: ", new AbortController().signal);
  input.end();
  await assert.rejects(eof, /已取消/);
  terminal.close();

  const inputInterrupt = new PassThrough() as PassThrough & { isTTY: boolean };
  const outputInterrupt = new Writable({ write(_chunk, _encoding, callback) { callback(); } }) as Writable & { isTTY: boolean };
  inputInterrupt.isTTY = true;
  outputInterrupt.isTTY = true;
  const interruptTerminal = createModelConfigTerminal(inputInterrupt, outputInterrupt);
  const interrupted = interruptTerminal.ui.ask("prompt: ", new AbortController().signal);
  inputInterrupt.emit("keypress", "\\u0003", { ctrl: true, name: "c" });
  await assert.rejects(interrupted, /已取消/);
  interruptTerminal.close();
  inputInterrupt.destroy();

  const input2 = new PassThrough() as PassThrough & { isTTY: boolean };
  const output2 = new Writable({ write(_chunk, _encoding, callback) { callback(); } }) as Writable & { isTTY: boolean };
  input2.isTTY = true;
  output2.isTTY = true;
  const terminal2 = createModelConfigTerminal(input2, output2);
  const controller = new AbortController();
  const pending = terminal2.ui.ask("prompt: ", controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  terminal2.close();
  input2.destroy();
});
