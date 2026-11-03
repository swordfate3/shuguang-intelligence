import type { Readable, Writable } from "node:stream";
import type { DawnTransport } from "../../dawn/src/protocol/index.ts";
import { createTools, hasOnlyKeys, isRecord, ToolParamsError, toolFailure } from "./tools.ts";

export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MAX_INPUT_FRAME_BYTES = 64 * 1024;
export const MAX_IN_FLIGHT = 8;
export const MAX_OUTPUT_FRAME_BYTES = 256 * 1024;
export const MAX_OUTPUT_QUEUE_BYTES = 1024 * 1024;
export const MAX_OUTPUT_QUEUE_FRAMES = 16;
const VERSIONS = [MCP_PROTOCOL_VERSION, "2025-06-18", "2025-03-26"];
type Id = string | number;
interface Active { controller: AbortController; cancelled: boolean; method: string }

// A caller-owned stream may have destroy(error)'s error queued when a session ends,
// including before startup. Session cleanup must not expose that error as an uncaught
// exception. One sink per stream (not per session) lives until stream close; it holds
// no session/transport/buffer state and does not keep an IO handle alive. Callers that
// keep streams open retain this bounded guard; their own error listeners still run.
const guardedStreams = new WeakSet<Readable | Writable>();
const discardStreamError = (): void => {};
function guardStreamErrors(stream: Readable | Writable): void {
  if (guardedStreams.has(stream)) return;
  guardedStreams.add(stream);
  const cleanup = (): void => {
    stream.off("error", discardStreamError);
    stream.off("close", cleanup);
    guardedStreams.delete(stream);
  };
  stream.on("error", discardStreamError);
  stream.once("close", cleanup);
  // Node sets .closed before queued error/close events are emitted. Do not skip the
  // guard for pre-destroyed streams. The fallback also cleans up already-closed streams
  // whose close event occurred before this session; next-tick errors run before it.
  if (stream.closed) setImmediate(cleanup);
}

export interface StdioOptions {
  /** Raw bytes, not a stream previously passed to setEncoding(). */
  input: Readable;
  output: Writable;
  transport: DawnTransport;
  allowWrite?: boolean;
  signal?: AbortSignal;
}
export interface StdioServer {
  /** Settles on EOF, close, root abort, IO failure or output overflow; never leaks raw IO errors. */
  done: Promise<void>;
  /** Cancels this session, not the independent Dawn service. Does not own/end caller streams. */
  close(): void;
}
function validId(value: unknown): value is Id {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}
function emptyParams(value: unknown): boolean {
  return value === undefined || (isRecord(value) && hasOnlyKeys(value, ["_meta"]) &&
    (value._meta === undefined || isRecord(value._meta)));
}

/**
 * Starts one bounded, newline UTF-8 stdio session. This is a restricted MCP subset, not an SDK
 * or certification: tools only, no server requests, resources, prompts, sampling or logging.
 * Caller owns streams/transport and process signals. On shutdown pending output is discarded.
 * Session listeners are removed, but a shared error sink remains until each stream closes
 * to absorb already queued IO errors. Caller listeners are neither removed nor silenced.
 * Cancellation suppresses late replies, but cannot undo an upstream/DB commit or refund usage.
 */
export function createStdioServer(options: StdioOptions): StdioServer {
  const { input, output, signal } = options;
  if (input.readableEncoding !== null || input.readableObjectMode || output.writableObjectMode) {
    throw new Error("MCP stdio requires raw byte streams");
  }
  guardStreamErrors(input);
  guardStreamErrors(output);
  const tools = createTools({ transport: options.transport, allowWrite: options.allowWrite === true });
  let phase: "new" | "initializing" | "ready" = "new";
  let protocolVersion = MCP_PROTOCOL_VERSION;
  let stopped = false;
  const active = new Map<Id, Active>();
  const frame = Buffer.alloc(MAX_INPUT_FRAME_BYTES);
  let length = 0;
  let dropping = false;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const queue: Buffer[] = [];
  let queuedBytes = 0;
  let writing = false;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });

  function close(): void {
    if (stopped) return;
    stopped = true;
    for (const item of active.values()) { item.cancelled = true; item.controller.abort(); }
    active.clear();
    queue.length = 0; queuedBytes = 0; length = 0;
    input.pause();
    input.off("data", onData); input.off("end", close); input.off("close", close); input.off("error", close);
    output.off("drain", pump); output.off("close", close); output.off("finish", close); output.off("error", close);
    signal?.removeEventListener("abort", close);
    resolveDone();
  }
  function pump(): void {
    if (stopped || writing || output.writableNeedDrain || queue.length === 0) return;
    const bytes = queue[0]!;
    writing = true;
    try {
      output.write(bytes, error => {
        if (error) close();
        writing = false;
        if (stopped) return;
        queue.shift(); queuedBytes -= bytes.length;
        pump();
      });
    } catch {
      writing = false;
      close();
    }
  }
  function send(value: unknown): void {
    if (stopped) return;
    let bytes: Buffer;
    try { bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8"); } catch { close(); return; }
    if (bytes.length > MAX_OUTPUT_FRAME_BYTES || queue.length >= MAX_OUTPUT_QUEUE_FRAMES ||
        queuedBytes + bytes.length > MAX_OUTPUT_QUEUE_BYTES) { close(); return; }
    queue.push(bytes); queuedBytes += bytes.length;
    pump();
  }
  function error(id: Id | undefined, code: number, message: string): void {
    // Official 2025-11-25 schema / SDK v1.25.3: ErrorResponse.id is optional, never null.
    // 2025-06-18 and 2025-03-26 require a real RequestId. For uncorrelatable errors in
    // those sessions, terminate rather than invent an ID or emit an invalid envelope.
    if (id === undefined && protocolVersion !== MCP_PROTOCOL_VERSION) { close(); return; }
    send({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), error: { code, message } });
  }
  function notification(method: string, params: unknown): void {
    if (method === "notifications/initialized") {
      if (phase === "initializing" && emptyParams(params)) phase = "ready";
      return;
    }
    if (method !== "notifications/cancelled" || phase === "new" || !isRecord(params) ||
        !hasOnlyKeys(params, ["requestId", "reason", "_meta"]) || !validId(params.requestId) ||
        (params.reason !== undefined && typeof params.reason !== "string") ||
        (params._meta !== undefined && !isRecord(params._meta))) return;
    const item = active.get(params.requestId);
    // MCP initialize cannot be cancelled. Keep cancelled work in the bounded map until it settles:
    // an injected transport that ignores abort must not allow unbounded replacement work.
    if (item && item.method !== "initialize") {
      item.cancelled = true;
      item.controller.abort();
    }
  }
  async function dispatch(method: string, params: unknown, item: Active): Promise<unknown> {
    if (method === "ping") {
      if (!emptyParams(params)) throw new RpcError(-32602, "Invalid params");
      return {};
    }
    if (method === "initialize") {
      if (phase !== "new") throw new RpcError(-32600, "Already initialized");
      if (!isRecord(params) || !hasOnlyKeys(params, ["protocolVersion", "capabilities", "clientInfo", "_meta"]) ||
          typeof params.protocolVersion !== "string" || !params.protocolVersion || !isRecord(params.capabilities) ||
          !isRecord(params.clientInfo) || typeof params.clientInfo.name !== "string" || !params.clientInfo.name ||
          typeof params.clientInfo.version !== "string" || !params.clientInfo.version ||
          (params._meta !== undefined && !isRecord(params._meta))) throw new RpcError(-32602, "Invalid params");
      phase = "initializing";
      protocolVersion = VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_PROTOCOL_VERSION;
      return {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "shuguang-mcp", version: "0.1.0" },
        instructions: "仅显式工具调用；不采集聊天或自动学习。写权限由服务启动配置决定。文字可能是代理转述，现有协议未新增可信来源区分。取消不能撤回已提交操作或保证退款。",
      };
    }
    if (method !== "tools/list" && method !== "tools/call") throw new RpcError(-32601, "Method not found");
    if (phase !== "ready") throw new RpcError(-32002, "Server not initialized");
    if (method === "tools/list") {
      if (!emptyParams(params)) throw new RpcError(-32602, "Invalid params");
      return { tools: tools.list() };
    }
    if (!isRecord(params) || !hasOnlyKeys(params, ["name", "arguments", "_meta"]) ||
        typeof params.name !== "string" || !params.name ||
        (params.arguments !== undefined && !isRecord(params.arguments)) ||
        (params._meta !== undefined && !isRecord(params._meta))) throw new RpcError(-32602, "Invalid params");
    return tools.call(params.name, params.arguments, item.controller.signal);
  }
  function receive(bytes: Uint8Array): void {
    let value: unknown;
    try { value = JSON.parse(decoder.decode(bytes)); } catch { error(undefined, -32700, "Parse error"); return; }
    // Recognize no-ID notifications before strict envelope validation. Even malformed ones
    // receive no response; only valid supported notifications can change session state.
    if (isRecord(value) && !Object.hasOwn(value, "id") && typeof value.method === "string") {
      if (value.jsonrpc === "2.0" && value.method && hasOnlyKeys(value, ["jsonrpc", "method", "params"])) {
        notification(value.method, value.params);
      }
      return;
    }
    if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" || !value.method ||
        !hasOnlyKeys(value, ["jsonrpc", "method", "id", "params"]) || !validId(value.id)) {
      error(undefined, -32600, "Invalid Request"); return;
    }
    const id = value.id;
    // No correlation avoids producing two competing replies for the original active request.
    if (active.has(id)) { error(undefined, -32600, "Duplicate active request id"); return; }
    if (active.size >= MAX_IN_FLIGHT) { error(id, -32000, "Too many in-flight requests"); return; }
    const item: Active = { controller: new AbortController(), cancelled: false, method: value.method };
    active.set(id, item); // Reserve before dispatch, including synchronous methods/errors.
    void dispatch(value.method, value.params, item).then(result => {
      if (!stopped && !item.cancelled) send({ jsonrpc: "2.0", id, result });
    }, failure => {
      if (stopped || item.cancelled) return;
      if (failure instanceof RpcError) error(id, failure.code, failure.message);
      else if (failure instanceof ToolParamsError) error(id, -32602, "Invalid params");
      else if (item.method === "tools/call") send({ jsonrpc: "2.0", id, result: toolFailure() });
      else error(id, -32603, "Internal error");
    }).finally(() => { if (active.get(id) === item) active.delete(id); });
  }
  function onData(chunk: unknown): void {
    if (stopped) return;
    if (!(chunk instanceof Uint8Array)) { close(); return; }
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    while (start < bytes.length && !stopped) {
      const newline = bytes.indexOf(10, start);
      const end = newline === -1 ? bytes.length : newline;
      const size = end - start;
      if (!dropping) {
        if (length + size > MAX_INPUT_FRAME_BYTES) {
          length = 0; dropping = true;
          error(undefined, -32600, "Input frame too large");
        } else {
          frame.set(bytes.subarray(start, end), length); length += size;
        }
      }
      if (newline === -1) break;
      if (!dropping) receive(frame.subarray(0, length));
      length = 0; dropping = false;
      start = newline + 1;
    }
  }
  input.on("data", onData); input.on("end", close); input.on("close", close); input.on("error", close);
  output.on("drain", pump); output.on("close", close); output.on("error", close); output.on("finish", close);
  signal?.addEventListener("abort", close, { once: true });
  if (signal?.aborted || input.destroyed || input.readableEnded || output.destroyed || output.writableEnded) close();
  return { done, close };
}

/** Main entry point: await until the session ends. No stdout diagnostics or process ownership. */
export function serveStdio(options: StdioOptions): Promise<void> {
  return createStdioServer(options).done;
}
class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}
