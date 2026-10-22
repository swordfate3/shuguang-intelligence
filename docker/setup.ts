import { execFile } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createModelConfig, parseModelConfig, type ModelFileConfig } from "../packages/dawn/src/adapters/models/config.ts";
import { createModelConfigTerminal, type ModelConfigTerminal } from "../packages/dawn/src/adapters/models/config-terminal.ts";
import {
  assertPrivateDir, readCredentialFromTTY, resolveDataDirectory, storeCredential, verifyFiles,
} from "./manage.ts";

const FILES = ["subject.sqlite", "service.token", "model.json", "model.env"] as const;
const MAX_ENV_BYTES = 4_224;
const MAX_CONFIG_BYTES = 4_096;
const AUTHORIZATION_NOTE = `设置授权说明：只按需创建缺失的本地文件；首次新建主体时会固化仓库中的合成示例 pack；将来显式运行学习时，教材、练习题和笔记会按阶段发送给模型供应商。
调用次数是固定次数上限，不是金额或费用。设置过程不会自动 wake、generate、learn，也不会连接模型或网络。
learning-init 成功后若后续步骤失败，会保留已创建文件作为部分证据，不自动删除或重试。只有输入 yes 才继续写入。`;
const FIXED_MODEL_NOTE = `固定学习/模型设置：示例 pack 学习额度 4 次；新建主体的共享总调用上限单独设置（至少 4 次）。
仅在新建模型配置时，maxCalls 固定为 4，timeoutMs 固定为 30000，credentialEnv 固定为 DAWN_MODEL_API_KEY；不会询问或猜测，也不会改写已有模型配置。`;
const CANCELLED = "设置已取消。";
const INVALID = "输入无效，请按提示重新输入。";
const SAFE_ERROR = "设置失败；未输出路径、凭据或底层异常。已有文件不会自动覆盖或清理。";

export interface SetupUI {
  ask(prompt: string, signal: AbortSignal): Promise<string>;
  show(text: string): void;
  close?(): void;
}

export interface SetupDependencies {
  readonly ui?: SetupUI;
  readonly readCredential?: (signal: AbortSignal) => Promise<string>;
  readonly storeCredential?: (dataDir: string, key: string, signal: AbortSignal) => void;
  readonly runCommand?: (args: readonly string[], signal: AbortSignal) => Promise<void>;
  readonly verifyFiles?: (dataDir: string) => void;
}

interface ExistingFiles {
  readonly subject: boolean;
  readonly token: boolean;
  readonly model: boolean;
  readonly env: boolean;
}

interface SetupAnswers {
  readonly name?: string;
  readonly totalCalls?: number;
  readonly model?: ModelFileConfig;
}

function safeFail(): never {
  throw new Error(SAFE_ERROR);
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException(CANCELLED, "AbortError");
}

function inspectExistingFiles(dataDir: string): ExistingFiles {
  const results: boolean[] = [];
  for (const name of FILES) {
    const path = join(dataDir, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        results.push(false);
        continue;
      }
      safeFail();
    }
    const uid = process.getuid?.();
    if (stat.isSymbolicLink() || !stat.isFile() || uid === undefined || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
      safeFail();
    }
    results.push(true);
  }
  return { subject: results[0]!, token: results[1]!, model: results[2]!, env: results[3]! };
}

function readBounded(path: string, limit: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || uid === undefined || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.size > limit) safeFail();
    const chunks: Buffer[] = [];
    let size = 0;
    const chunk = Buffer.alloc(1024);
    while (size <= limit) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, limit + 1 - size), null);
      if (count === 0) break;
      size += count;
      if (size > limit) safeFail();
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } catch {
    return safeFail();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readExistingModel(dataDir: string): ModelFileConfig | undefined {
  const path = join(dataDir, "model.json");
  let exists: boolean;
  try { lstatSync(path); exists = true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    return safeFail();
  }
  if (!exists) return undefined;
  try {
    const parsed: unknown = JSON.parse(readBounded(path, MAX_CONFIG_BYTES));
    const config = parseModelConfig(parsed);
    if (!/^[A-Z][A-Z0-9_]*_API_KEY$/.test(config.credentialEnv)) return safeFail();
    return config;
  } catch {
    return safeFail();
  }
}

function verifyExistingEnv(dataDir: string, config: ModelFileConfig): void {
  const content = readBounded(join(dataDir, "model.env"), MAX_ENV_BYTES);
  const prefix = `${config.credentialEnv}='`;
  if (!content.startsWith(prefix) || !content.endsWith("'\n")) safeFail();
  const key = content.slice(prefix.length, -2);
  if (key.length < 1 || key.length > 4096 || !/^[\x21-\x7e]+$/.test(key) || /['"\\]/.test(key)) safeFail();
}

function candidateModel(fields: Partial<ModelFileConfig>): ModelFileConfig {
  return {
    baseUrl: fields.baseUrl ?? "https://example.invalid/v1",
    model: fields.model ?? "setup-validation-only",
    credentialEnv: "DAWN_MODEL_API_KEY",
    maxCalls: 4,
    reasoningEffort: fields.reasoningEffort ?? "off",
    timeoutMs: 30_000,
  };
}

function validModel(fields: Partial<ModelFileConfig>): boolean {
  try { parseModelConfig(candidateModel(fields)); return true; }
  catch { return false; }
}

async function askValue(
  ui: SetupUI,
  signal: AbortSignal,
  prompt: string,
  validate: (answer: string) => string | undefined,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    abortIfNeeded(signal);
    const answer = await ui.ask(prompt, signal);
    abortIfNeeded(signal);
    const accepted = validate(answer);
    if (accepted !== undefined) return accepted;
    ui.show(INVALID);
  }
  throw new Error(CANCELLED);
}

function accepted(answer: string): boolean {
  return answer.trim().toLowerCase() === "yes";
}

async function collectAnswers(
  ui: SetupUI,
  signal: AbortSignal,
  state: ExistingFiles,
  existingModel: ModelFileConfig | undefined,
): Promise<SetupAnswers | undefined> {
  ui.show(AUTHORIZATION_NOTE);

  let name: string | undefined;
  let totalCalls: number | undefined;
  if (!state.subject || !existingModel) ui.show(FIXED_MODEL_NOTE);
  if (!state.subject) {
    name = await askValue(ui, signal, "主体名称 [曙光]：", answer => {
      const value = answer.trim() || "曙光";
      return value.length > 0 && value.length <= 128 && !value.startsWith("--") &&
        !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ? value : undefined;
    });
    totalCalls = Number(await askValue(ui, signal, "共享总调用上限（4–10000）[20]：", answer => {
      const value = answer.trim() || "20";
      if (!/^[1-9]\d*$/.test(value)) return undefined;
      const number = Number(value);
      return Number.isSafeInteger(number) && number >= 4 && number <= 10_000 ? String(number) : undefined;
    }));
  }

  let model = existingModel;
  if (!model) {
    const baseUrl = await askValue(ui, signal, "模型 API baseUrl（必填；不自动猜测或联网）：", answer => {
      const value = answer.trim();
      return value && validModel({ baseUrl: value }) ? value : undefined;
    });
    const modelId = await askValue(ui, signal, "模型 ID（必填；不自动选择）：", answer => {
      const value = answer.trim();
      return value && validModel({ baseUrl, model: value }) ? value : undefined;
    });
    const reasoningEffort = await askValue(ui, signal, "thinking（off/low/medium/high/xhigh/max）[off]：", answer => {
      const value = answer.trim() || "off";
      return ["off", "low", "medium", "high", "xhigh", "max"].includes(value) ? value : undefined;
    }) as ModelFileConfig["reasoningEffort"];
    model = parseModelConfig({ ...candidateModel({ baseUrl, model: modelId, reasoningEffort }) });
  }

  if (!state.env && state.model) {
    ui.show("现有 model.json 将保持不变。凭据只会隐藏录入并排他创建缺失的 model.env；不会重写模型配置。");
  }
  ui.show(`设置预览（不含密钥；已有文件不覆盖）：\n${JSON.stringify({
    subject: state.subject ? "保留原主体与预算" : { id: "dawn", name, totalCalls, learningCalls: 4, pack: "learning-pack.example.json" },
    model: state.model ? "保留原模型配置" : model,
    credential: state.env ? "保留原凭据" : "确认后隐藏录入并新建 model.env",
  }, null, 2)}`);
  const confirmation = await askValue(ui, signal, "确认以上设置并创建缺失文件？（yes/no）: ", answer => {
    const value = answer.trim().toLowerCase();
    return value === "yes" || value === "no" || value === "" ? value : undefined;
  });
  if (!accepted(confirmation)) return undefined;
  return { ...(name === undefined ? {} : { name }), ...(totalCalls === undefined ? {} : { totalCalls }),
    ...(model === undefined ? {} : { model }) };
}

function defaultRunCommand(args: readonly string[], signal: AbortSignal): Promise<void> {
  abortIfNeeded(signal);
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const mainPath = join(projectRoot, "packages/dawn/src/main.ts");
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(process.execPath, [mainPath, ...args], {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      signal,
    }, error => {
      if (error) rejectPromise(new Error(SAFE_ERROR));
      else resolvePromise();
    });
  });
}

/** First-run TTY setup; only current container storage formats are written. */
export async function runSetup(
  dataDir: string,
  signal: AbortSignal,
  deps: SetupDependencies = {},
): Promise<{ readonly setupCompleted: boolean; readonly alreadyConfigured?: boolean }> {
  const privateDir = assertPrivateDir(dataDir);
  abortIfNeeded(signal);
  const state = inspectExistingFiles(privateDir);
  if (state.subject !== state.token) safeFail();

  if (state.subject && state.token && state.model && state.env) {
    (deps.verifyFiles ?? verifyFiles)(privateDir);
    return { setupCompleted: true, alreadyConfigured: true };
  }

  const existingModel = readExistingModel(privateDir);
  // With model.json absent, model.env's binding is unknowable. Preserve it, allow an
  // explicitly authorized model config to be added, then let the normal file verifier
  // reject any mismatch; never guess a variable name or replace the existing env file.
  if (state.env && existingModel) verifyExistingEnv(privateDir, existingModel);

  let terminal: ModelConfigTerminal | undefined;
  let ui = deps.ui;
  if (!ui) {
    terminal = createModelConfigTerminal();
    ui = terminal.ui;
  }
  let answers: SetupAnswers | undefined;
  try {
    answers = await collectAnswers(ui, signal, state, existingModel);
  } finally {
    terminal?.close();
    if (terminal) process.stdin.pause();
    else ui.close?.();
  }
  if (!answers) return { setupCompleted: false };
  abortIfNeeded(signal);

  const runCommand = deps.runCommand ?? defaultRunCommand;
  if (!state.subject) {
    const packPath = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "config/learning-pack.example.json");
    await runCommand(["learning-init", "--db", join(privateDir, "subject.sqlite"), "--id", "dawn",
      "--name", answers.name!, "--limit", String(answers.totalCalls!), "--learning-limit", "4", "--pack", packPath], signal);
    abortIfNeeded(signal);
  }
  if (!state.token) {
    await runCommand(["token-init", "--token-file", join(privateDir, "service.token")], signal);
    abortIfNeeded(signal);
  }

  if (!state.model) {
    if (!answers.model) safeFail();
    createModelConfig(join(privateDir, "model.json"), answers.model, signal);
  }
  if (!state.env) {
    const readCredential = deps.readCredential ?? ((abort: AbortSignal) =>
      readCredentialFromTTY(process.stdin, process.stdout, abort));
    const key = await readCredential(signal);
    abortIfNeeded(signal);
    (deps.storeCredential ?? storeCredential)(privateDir, key, signal);
  }
  abortIfNeeded(signal);
  (deps.verifyFiles ?? verifyFiles)(privateDir);
  return { setupCompleted: true };
}

async function main(args: readonly string[]): Promise<void> {
  if (args.length !== 0) safeFail();
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const result = await runSetup(resolveDataDirectory(), controller.signal);
    if (result.setupCompleted) process.stdout.write(result.alreadyConfigured
      ? "设置文件完整，离线检查通过；未修改文件或提示确认。\n"
      : "设置文件已准备；尚未 wake、generate 或 learn。\n");
    else {
      process.stdout.write("设置已取消；未开始创建设置文件。\n");
      process.exitCode = 1; // The host must not proceed to compose up after a declined setup.
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write(`${SAFE_ERROR}\n`);
    process.exitCode = 1;
  });
}
