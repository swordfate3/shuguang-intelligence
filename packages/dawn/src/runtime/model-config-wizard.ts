import { lstatSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { createModelConfig, parseModelConfig, type ModelFileConfig } from "../adapters/models/config.ts";
import { createModelConfigTerminal } from "../adapters/models/config-terminal.ts";

export interface ModelConfigUI {
  ask(prompt: string, signal: AbortSignal): Promise<string>;
  show(text: string): void;
}

const INPUT_ERROR = "输入无效，请按提示重新输入。";
const FIELD_RETRIES = 5;
const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const USAGE_NOTE = `此向导只写入模型配置，不收集或读取密钥、不连接模型，也不执行配置中的命令。
配置仅声明凭据环境变量名称；保存配置不等于授权调用，数据库中的永久调用预算仍须单独显式设置。
完成后可在需要的命令上复用 --model-config <配置文件路径>；例如 learning-run 或 serve。
交流建议最多3次；学习若覆盖两个目标，建议最多4次调用。请按资料范围、预算和费用自行授权。`;
const COMPATIBILITY_NOTE = `仅支持 OpenAI Chat Completions 兼容接口；服务端必须支持 reasoning_effort 并返回 usage。
不自动发现供应商或模型，也不会验证模型名称/连接。`;

function invalidArguments(): never {
  throw new Error("用法：model-config --output <绝对的新文件路径>");
}

function validateOutputPath(args: readonly string[]): string {
  if (args.length !== 3 || args[0] !== "model-config" || args[1] !== "--output") invalidArguments();
  const path = args[2]!;
  if (!isAbsolute(path) || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path)) invalidArguments();

  let destinationExists = false;
  try {
    lstatSync(path); // Includes dangling symlinks: never treat them as an absent destination.
    destinationExists = true;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw new Error("无法验证输出路径；未覆盖任何文件。");
    }
  }
  if (destinationExists) throw new Error("输出路径必须是尚不存在的新文件，未覆盖任何文件。");
  try {
    if (!statSync(dirname(path)).isDirectory()) throw new Error();
  } catch {
    throw new Error("输出路径的父目录必须已存在且可访问；未创建文件。");
  }
  return path;
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("模型配置向导已取消。", "AbortError");
}

async function askValid(
  ui: ModelConfigUI,
  signal: AbortSignal,
  prompt: string,
  validate: (answer: string) => string | undefined,
): Promise<string> {
  for (let attempt = 0; attempt < FIELD_RETRIES; attempt += 1) {
    abortIfNeeded(signal);
    const answer = await ui.ask(prompt, signal);
    abortIfNeeded(signal);
    const valid = validate(answer);
    if (valid !== undefined) return valid;
    ui.show(INPUT_ERROR);
  }
  throw new Error("连续输入无效，向导已停止；未保存配置。");
}

function configCandidate(
  fields: Partial<ModelFileConfig>,
): ModelFileConfig {
  return {
    baseUrl: fields.baseUrl ?? "https://example.invalid/v1",
    model: fields.model ?? "wizard-validation-model",
    credentialEnv: fields.credentialEnv ?? "DAWN_MODEL_API_KEY",
    maxCalls: fields.maxCalls ?? 3,
    reasoningEffort: fields.reasoningEffort ?? "low",
    timeoutMs: fields.timeoutMs ?? 30_000,
  };
}

function isValidConfigField(fields: Partial<ModelFileConfig>): boolean {
  try {
    parseModelConfig(configCandidate(fields));
    return true;
  } catch {
    return false;
  }
}

function defaulted(answer: string, defaultValue: string): string {
  return answer.trim() === "" ? defaultValue : answer.trim();
}

function safePreviewJson(config: ModelFileConfig): string {
  const entries: [string, string | number][] = [
    ["baseUrl", config.baseUrl], ["model", config.model], ["credentialEnv", config.credentialEnv],
    ["maxCalls", config.maxCalls], ["reasoningEffort", config.reasoningEffort],
    ...(config.timeoutMs === undefined ? [] : [["timeoutMs", config.timeoutMs] as [string, number]]),
  ];
  const encode = (value: string | number) => typeof value === "string"
    ? (JSON.stringify(value) ?? '""').replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, character =>
      `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`)
    : String(value);
  return `{\n${entries.map(([key, value]) => `  ${JSON.stringify(key)}: ${encode(value)}`).join(",\n")}\n}`;
}

export async function runModelConfigWizard(
  args: readonly string[],
  signal: AbortSignal,
  ui?: ModelConfigUI,
): Promise<unknown> {
  // Validate CLI shape and destination before creating a terminal adapter or prompting.
  const outputPath = validateOutputPath(args);
  let terminal: ReturnType<typeof createModelConfigTerminal> | undefined;
  if (!ui) {
    terminal = createModelConfigTerminal();
    ui = terminal.ui;
  }

  try {
    abortIfNeeded(signal);
    ui.show(USAGE_NOTE);
    ui.show(COMPATIBILITY_NOTE);

    const purpose = await askValid(ui, signal, "用途：1 交流（默认，建议最多3次），2 学习（建议最多4次）：", answer => {
      const value = defaulted(answer, "1");
      return value === "1" || value === "2" ? value : undefined;
    });
    const connection = await askValid(ui, signal, "连接类型：1 OpenAI，2 自定义 OpenAI 兼容：", answer =>
      answer.trim() === "1" || answer.trim() === "2" ? answer.trim() : undefined);
    const baseDefault = connection === "1" ? "https://api.openai.com/v1" : "";
    const basePrompt = baseDefault
      ? `baseUrl [${baseDefault}]：`
      : "baseUrl（必填）：";
    const baseUrl = await askValid(ui, signal, basePrompt, answer => {
      const value = defaulted(answer, baseDefault);
      return value && isValidConfigField({ baseUrl: value }) ? value : undefined;
    });

    const model = await askValid(ui, signal, "模型 ID（必填，不会自动选择）：", answer => {
      const value = answer.trim();
      return value && isValidConfigField({ baseUrl, model: value }) ? value : undefined;
    });
    const credentialDefault = connection === "1" ? "OPENAI_API_KEY" : "DAWN_MODEL_API_KEY";
    const credentialEnv = await askValid(ui, signal, `凭据环境变量名称（仅填写变量名，请勿粘贴密钥）[${credentialDefault}]：`, answer => {
      const value = defaulted(answer, credentialDefault);
      return isValidConfigField({ baseUrl, model, credentialEnv: value }) ? value : undefined;
    });

    const reasoningEffort = await askValid(ui, signal, "reasoning_effort（low/medium/high/xhigh/max）[low]：", answer => {
      const value = defaulted(answer, "low");
      return (REASONING_EFFORTS as readonly string[]).includes(value) ? value : undefined;
    }) as ModelFileConfig["reasoningEffort"];

    const timeoutMs = await askValid(ui, signal, "超时毫秒（1–30000）[30000]：", answer => {
      const value = defaulted(answer, "30000");
      if (!/^[1-9]\d*$/.test(value)) return undefined;
      const number = Number(value);
      return Number.isSafeInteger(number) && number <= 30_000 ? String(number) : undefined;
    }).then(Number);

    const callsDefault = purpose === "1" ? 3 : 4;
    const maxCalls = await askValid(ui, signal, `本配置单次运行调用上限（1–10）[${callsDefault}]：`, answer => {
      const value = defaulted(answer, String(callsDefault));
      if (!/^[1-9]\d*$/.test(value)) return undefined;
      const number = Number(value);
      return Number.isSafeInteger(number) && number <= 10 &&
        isValidConfigField({ baseUrl, model, credentialEnv, reasoningEffort, timeoutMs: 30_000, maxCalls: number })
        ? String(number) : undefined;
    }).then(Number);

    abortIfNeeded(signal);
    let config: ModelFileConfig;
    try {
      config = parseModelConfig({ baseUrl, model, credentialEnv, reasoningEffort, timeoutMs, maxCalls });
    } catch {
      throw new Error("配置校验失败；未保存配置。");
    }

    ui.show(`配置预览（不含密钥）：\n${safePreviewJson(config)}\n输出路径：${outputPath}\n输入 yes 明确保存；no 或直接回车取消。`);
    const confirmation = await askValid(ui, signal, "确认保存？（yes/no）: ", answer => {
      const value = answer.trim().toLowerCase();
      return value === "yes" || value === "no" || value === "" ? value : undefined;
    });
    if (confirmation !== "yes") return { modelConfigCreated: false };

    abortIfNeeded(signal);
    try {
      createModelConfig(outputPath, config, signal);
    } catch {
      throw new Error("无法安全保存模型配置；未报告成功、未覆盖已有文件。若创建后写入失败，可能留有不完整文件，请先检查输出路径。");
    }
    return { modelConfigCreated: true };
  } finally {
    terminal?.close();
  }
}
