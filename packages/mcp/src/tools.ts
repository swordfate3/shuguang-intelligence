import { randomUUID } from "node:crypto";
import {
  assertDawnRequest, assertDawnResponse, MAX_MESSAGE_CHARS,
  type DawnRequest, type DawnTransport,
} from "../../dawn/src/protocol/index.ts";
import { THINKING_LEVELS } from "../../dawn/src/protocol/model-controls.ts";

export interface CallToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}
export class ToolParamsError extends Error {
  constructor() { super("Invalid tool parameters"); }
}
const FAILURE = "曙光工具执行失败或不可用；未自动重试、切换或唤醒。取消不保证撤回已提交操作，失败不保证退还额度。";
export function toolFailure(): CallToolResult {
  return { content: [{ type: "text", text: FAILURE }], isError: true };
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
const revision = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const model = {
  type: "string", minLength: 1, maxLength: 256,
  pattern: "^(?!\\s)(?!.*\\s$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]+$",
  description: "精确模型 ID；不得有首尾空白、控制或格式字符。JSON Schema maxLength 按 Unicode 码点计数；既有 Dawn 协议额外限制最多256个UTF-16代码单元，emoji等非BMP字符通常占2个单元。",
};
function definition(name: string, description: string, properties: Record<string, unknown>, readOnly: boolean, openWorld = false): ToolDefinition {
  return {
    name: `shuguang_${name}`, description,
    inputSchema: { type: "object", properties: structuredClone(properties), required: Object.keys(properties), additionalProperties: false },
    // Writes use CAS or consume budget; even a repeated lifecycle call may conflict.
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: openWorld },
  };
}
function definitions(): ToolDefinition[] {
  return [
    definition("status", "只读查询既有曙光服务的生命周期与状态版本；不调用模型、不唤醒。", {}, true),
    definition("model_status", "只读查询当前模型、thinking、选择版本与进程调用次数；不联网刷新目录、不生成。", {}, true),
    definition("say", "仅发送调用者显式选择的 message 文字；会消耗永久调用额度，失败不退，不自动唤醒或重试。不采集聊天历史，不是自动学习接口。调用者文字可能是代理转述而非用户事实；现有协议没有新增可信来源机制，不能声称已区分来源。可能保存交流及失败台账。", {
      message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_CHARS, pattern: "\\S", description: "显式选择披露的文字，非纯空白，原样发送。JSON Schema maxLength 按 Unicode 码点计数；既有 Dawn 协议额外限制最多16000个UTF-16代码单元，emoji等非BMP字符通常占2个单元。" },
    }, false, true),
    definition("wake", "按 expectedRevision 显式唤醒；改变持久状态，不生成、不启动学习。", { expectedRevision: revision }, false),
    definition("sleep", "按 expectedRevision 显式休眠；改变持久状态，不承诺撤回已提交操作。", { expectedRevision: revision }, false),
    definition("model_list", "显式向已配置供应商联网 GET 模型目录并更新缓存，需写权限；不是纯本地只读，也不证明模型兼容或费用。", {}, false, true),
    definition("model_select", "按 expectedRevision 选择既有服务实例的模型；版本指模型选择版本，不写配置，不探测、不生成、不自动回退。", { expectedRevision: revision, model }, false),
    definition("thinking_select", "按 expectedRevision 选择 thinking；off 仅省略参数，不保证关闭思考，不探测模型能力。", {
      expectedRevision: revision, thinking: { type: "string", enum: [...THINKING_LEVELS] },
    }, false),
  ];
}

/** A thin mapping only: no history, credentials, service startup, learning, retry or fallback. */
export function createTools(options: { transport: DawnTransport; allowWrite?: boolean }) {
  const allowWrite = options.allowWrite === true;
  const transport = options.transport;
  return {
    list(): ToolDefinition[] {
      return definitions().filter(tool => allowWrite || tool.annotations.readOnlyHint);
    },
    async call(name: string, args: unknown, signal: AbortSignal): Promise<CallToolResult> {
      const tool = definitions().find(item => item.name === name);
      // Unknown and unexposed names have the same protocol error, with no hidden-tool details.
      if (!tool || (!allowWrite && !tool.annotations.readOnlyHint)) throw new ToolParamsError();
      const values = args === undefined ? {} : args;
      if (!isRecord(values) || !hasOnlyKeys(values, tool.inputSchema.required) ||
          tool.inputSchema.required.some(key => !Object.hasOwn(values, key))) throw new ToolParamsError();
      const base = { version: 1 as const, requestId: randomUUID() };
      const type = name.slice("shuguang_".length).replaceAll("_", "-");
      const candidate = type === "say" ? { ...base, type, text: values.message } : { ...base, type, ...values };
      // Structure errors are RPC invalid-params; known-tool domain/type/range errors are
      // tool results (MCP CallToolResult guidance). Both are blocked before any transport IO.
      try { assertDawnRequest(candidate); } catch { return toolFailure(); }
      const request: DawnRequest = candidate;
      try {
        signal.throwIfAborted();
        const response = await transport.request(request, signal);
        signal.throwIfAborted();
        assertDawnResponse(response);
        const expectedType = request.type === "say" ? "reply" : request.type.startsWith("model-") || request.type === "thinking-select" ? "model" : "status";
        if (response.requestId !== request.requestId || response.type === "error" || response.type !== expectedType) return toolFailure();
        // Validation excludes unknown fields; never forward transport errors or raw error envelopes.
        return { content: [{ type: "text", text: JSON.stringify(response) }] };
      } catch { return toolFailure(); }
    },
  };
}
