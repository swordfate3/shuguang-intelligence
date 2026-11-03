import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";

export interface LocalCompanionConfig {
  readonly version: 1;
  readonly url?: never;
  readonly projectDirectory: string;
  readonly dockerContext?: string;
  readonly composeProject?: string;
  readonly allowWrite: boolean;
  readonly search?: { readonly provider: "tavily"; readonly credentialEnv: string };
}
export interface RemoteCompanionConfig {
  readonly version: 1;
  readonly url: string;
  readonly credentialEnv: string;
  readonly allowWrite: boolean;
  readonly search?: never;
}
export type CompanionConfig = LocalCompanionConfig | RemoteCompanionConfig;
export const REMOTE_BRIDGE_UNSUPPORTED = "远程连接当前仅支持普通MCP交流与控制；片段共享和研究私有桥尚不支持";
const WRITE_TOOLS = ["shuguang_say", "shuguang_wake", "shuguang_sleep", "shuguang_model_list",
  "shuguang_model_select", "shuguang_thinking_select"] as const;
const MAX_BYTES = 8192;
function safeRemoteUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096 || !/^https:\/\/[^/]/u.test(value) ||
      /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\?#]/u.test(value)) return false;
  try {
    const url = new URL(value);
    // Reject even empty userinfo/query/fragment, not only their parsed values.
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password &&
      !value.slice(8).split("/")[0]!.includes("@");
  } catch { return false; }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && isAbsolute(value) &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

/** Connection configuration only. Does not read credentials, contact Docker or inspect source trees. */
export function parseCompanionConfig(value: unknown): CompanionConfig {
  if (record(value) && Object.hasOwn(value, "url")) {
    if (Object.keys(value).length !== 4 || Object.keys(value).some(k => !["version", "url", "credentialEnv", "allowWrite"].includes(k)) ||
        value.version !== 1 || !safeRemoteUrl(value.url) || typeof value.allowWrite !== "boolean" ||
        typeof value.credentialEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.credentialEnv)) {
      throw new Error("Invalid Shuguang Pi configuration");
    }
    return { version: 1, url: value.url, credentialEnv: value.credentialEnv, allowWrite: value.allowWrite };
  }
  if (!record(value) || Object.keys(value).some(k => !["version", "projectDirectory", "dockerContext", "composeProject", "allowWrite", "search"].includes(k)) ||
      value.version !== 1 || !safePath(value.projectDirectory) ||
      (value.allowWrite !== undefined && typeof value.allowWrite !== "boolean") ||
      (value.search !== undefined && (!record(value.search) || Object.keys(value.search).length !== 2 ||
        Object.keys(value.search).some(k => !["provider", "credentialEnv"].includes(k)) || value.search.provider !== "tavily" ||
        typeof value.search.credentialEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.search.credentialEnv))) ||
      (value.dockerContext !== undefined && (typeof value.dockerContext !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.dockerContext))) ||
      (value.composeProject !== undefined && (typeof value.composeProject !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value.composeProject)))) {
    throw new Error("Invalid Shuguang Pi configuration");
  }
  return { version: 1, projectDirectory: value.projectDirectory, allowWrite: value.allowWrite === true,
    ...(typeof value.dockerContext === "string" ? { dockerContext: value.dockerContext } : {}),
    ...(typeof value.composeProject === "string" ? { composeProject: value.composeProject } : {}),
    ...(record(value.search) ? { search: { provider: "tavily", credentialEnv: value.search.credentialEnv as string } } : {}),
  };
}

/** Explicit path only; no auto-discovery of Pi config, service tokens, model env or conversation. */
export function loadCompanionConfig(path: string): CompanionConfig {
  if (!safePath(path)) throw new Error("Invalid Shuguang Pi configuration");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES ||
        (typeof process.getuid === "function" && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))) {
      throw new Error("Invalid Shuguang Pi configuration");
    }
    // Bound actual reads too; a file may grow after fstat. Reject rather than trust a partial prefix.
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count > MAX_BYTES) throw new Error("Invalid Shuguang Pi configuration");
    return parseCompanionConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count))));
  } finally { closeSync(fd); }
}

/** Fixed executable/argv, not a shell string or arbitrary MCP command supplied by a model. */
export function buildMcpRegistration(config: CompanionConfig): McpServerConfig {
  const validated = parseCompanionConfig(config);
  if (validated.url !== undefined) {
    return {
      url: validated.url,
      headers: { Authorization: `Bearer \${${validated.credentialEnv}}` },
      exposure: "codemode", timeout: 45,
      // Both native Pi and pi-mcp-adapter enforce per-tool hidden exposure. The adapter
      // disables an entire server for exposure:hidden, so do not use that as a default.
      ...(validated.allowWrite ? {} : { toolExposure: Object.fromEntries(WRITE_TOOLS.map(name => [name, "hidden" as const])) }),
      description: "曙光远程主体：普通MCP交流与控制；客户端工具限制不替代服务器ACL，不支持片段共享和研究私有桥。",
    };
  }
  const args = [
    ...(validated.dockerContext ? ["--context", validated.dockerContext] : []),
    "compose", "--project-directory", validated.projectDirectory,
    "-f", join(validated.projectDirectory, "compose.yaml"),
    ...(validated.composeProject ? ["--project-name", validated.composeProject] : []),
    "exec", "-T", "dawn", "dawn-container", "mcp",
    ...(validated.allowWrite ? ["--allow-write"] : []),
  ];
  return { command: "docker", args, exposure: "codemode", timeout: 45,
    description: "曙光独立主体：显式交流与状态工具；不自动采集对话、检索或启动学习。" };
}

/** The private bridge reuses only the validated Compose prefix, never credentials or arbitrary commands. */
export function buildHostBridgeRegistration(config: CompanionConfig): Extract<McpServerConfig, { command: string }> {
  // Session-source sharing uses the private bridge independently of ordinary MCP tool write access.
  const validated = parseCompanionConfig({ ...config, allowWrite: false });
  if (validated.url !== undefined) throw new Error(REMOTE_BRIDGE_UNSUPPORTED);
  const registration = buildMcpRegistration(validated);
  if (!("command" in registration)) throw new Error(REMOTE_BRIDGE_UNSUPPORTED);
  const args = [...(registration.args ?? [])];
  const mcpIndex = args.lastIndexOf("mcp");
  if (registration.command !== "docker" || mcpIndex < 0 || args[mcpIndex + 1] === "--allow-write") {
    throw new Error("Invalid private bridge registration");
  }
  args.splice(mcpIndex, args.length - mcpIndex, "host-bridge");
  return { command: registration.command, args, exposure: "codemode", timeout: 45,
    description: "曙光私有会话来源桥；仅由明确的本地命令启动。" };
}
