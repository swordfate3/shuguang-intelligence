import { closeSync, constants, fstatSync, openSync, readFileSync, statSync, writeFileSync, fsyncSync } from "node:fs";
import { isAbsolute } from "node:path";
import { OpenAICompatibleModel } from "./openai-compatible.ts";

export interface ModelFileConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly credentialEnv: string;
  readonly maxCalls: number;
  readonly reasoningEffort: "off" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly timeoutMs?: number;
}

/** Validate configuration without resolving credentials, connecting or executing commands. */
export function parseModelConfig(value: unknown): ModelFileConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model configuration");
  const config = value as Record<string, unknown>;
  const required = ["baseUrl", "model", "credentialEnv", "maxCalls", "reasoningEffort"];
  const allowed = [...required, "timeoutMs"];
  const hasTimeoutMs = Object.hasOwn(config, "timeoutMs");
  if (required.some(key => !Object.hasOwn(config, key)) || Object.keys(config).some(key => !allowed.includes(key)) ||
      typeof config.baseUrl !== "string" || typeof config.model !== "string" ||
      config.model.length > 256 || /[\x00-\x1f\x7f-\x9f]/u.test(config.model) ||
      typeof config.credentialEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,95}$/.test(config.credentialEnv) ||
      typeof config.reasoningEffort !== "string" || !["off", "low", "medium", "high", "xhigh", "max"].includes(config.reasoningEffort) ||
      typeof config.maxCalls !== "number" || !Number.isSafeInteger(config.maxCalls) || config.maxCalls < 1 || config.maxCalls > 10 ||
      (hasTimeoutMs && (typeof config.timeoutMs !== "number" || !Number.isSafeInteger(config.timeoutMs) ||
        config.timeoutMs < 1 || config.timeoutMs > 30_000))) {
    throw new Error("Invalid model configuration fields");
  }
  const result: ModelFileConfig = {
    baseUrl: config.baseUrl, model: config.model, credentialEnv: config.credentialEnv,
    maxCalls: config.maxCalls, reasoningEffort: config.reasoningEffort as ModelFileConfig["reasoningEffort"],
    ...(hasTimeoutMs ? { timeoutMs: config.timeoutMs as number } : {}),
  };
  // Reuse the adapter's exact URL/model policy. Construction performs no I/O.
  new OpenAICompatibleModel({ ...result, apiKey: "synthetic-config-validation-only" });
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 4096) throw new Error("Invalid model configuration size");
  return result;
}

/** Explicit Dawn configuration; no Pi discovery or credential command execution. */
export function loadModel(path: string): OpenAICompatibleModel {
  if (!isAbsolute(path) || statSync(path).size > 4096) throw new Error("Invalid model configuration file");
  const config = parseModelConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
  const key = process.env[config.credentialEnv];
  if (!key) throw new Error("Model credential environment variable unavailable");
  return new OpenAICompatibleModel({ ...config, apiKey: key });
}

/** Create one new private config, never replace an existing file or follow a final symlink. */
export function createModelConfig(path: string, value: unknown, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (!isAbsolute(path)) throw new Error("Absolute model configuration path required");
  const config = parseModelConfig(value);
  const json = `${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(json, "utf8") > 4096) throw new Error("Invalid model configuration size");
  signal.throwIfAborted();
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Invalid model configuration file");
    writeFileSync(fd, json, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  // No implicit rollback/deletion after exclusive creation: preserve failure evidence.
}
