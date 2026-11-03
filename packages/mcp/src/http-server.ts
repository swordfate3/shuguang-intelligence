import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { DawnTransport } from "../../dawn/src/protocol/index.ts";
import { assertServiceToken } from "../../dawn/src/adapters/transport/token-file.ts";
import { parsePublicUrl } from "./http-config.ts";
import { createTools, hasOnlyKeys, isRecord, ToolParamsError, toolFailure } from "./tools.ts";

export const HTTP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const HTTP_MAX_BODY_BYTES = 64 * 1024;
export const HTTP_MAX_RESPONSE_BYTES = 256 * 1024;
export const HTTP_MAX_SESSIONS = 32;
export const HTTP_MAX_IN_FLIGHT = 8;
export const HTTP_MAX_GLOBAL_IN_FLIGHT = 64;
const MAX_CONNECTIONS = 128;
type Id = string | number;
interface Active {
  controller: AbortController;
  response: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}
interface Session {
  id: string;
  principal: Buffer;
  version: string;
  ready: boolean;
  closed: boolean;
  touched: number;
  readers: number;
  active: Map<Id, Active>;
}
export interface HttpMcpServerOptions {
  transport: DawnTransport;
  /** Independently provisioned remote token; never reuse service OR private owner credentials. */
  authToken: string;
  /** Required to deterministically reject accidental reuse of the internal service credential. */
  serviceToken: string;
  /** Optional known owner credentials to reject too; no credential discovery is performed. */
  forbiddenTokens?: readonly string[];
  publicUrl: string;
  host?: "127.0.0.1" | "0.0.0.0";
  /** Zero is supported only by this API for local fixtures. */
  port?: number;
  allowWrite?: boolean;
  signal?: AbortSignal;
  /** Bounded tuning for embedders/tests; cannot increase concurrency/size caps. */
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
  bodyTimeoutMs?: number;
  responseTimeoutMs?: number;
}
export interface HttpMcpServer {
  readonly port: number;
  readonly host: string;
  readonly done: Promise<void>;
  /** Owns only the MCP listener and access requests, never the independent Dawn transport/service. */
  close(): Promise<void>;
}
const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
const validId = (value: unknown): value is Id => typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
const emptyParams = (value: unknown): boolean => value === undefined || (isRecord(value) && hasOnlyKeys(value, ["_meta"]) && (value._meta === undefined || isRecord(value._meta)));
function duration(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 10 || result > 3_600_000) throw new Error("Invalid MCP HTTP limits");
  return result;
}
function header(req: IncomingMessage, name: string): string | undefined {
  // Node joins/discards some duplicate headers. Reject ambiguity before relying on its normalized map.
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() === name) count++;
  const value = req.headers[name];
  return count === 1 && typeof value === "string" ? value : undefined;
}
class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}

/**
 * Tools-only Streamable HTTP, single JSON POST and JSON response; GET intentionally returns 405.
 * Sessions are random, memory-only, credential-bound and not replay/resumption stores. HTTP loss
 * never aborts accepted work. Only explicit cancellation, access-session DELETE, deadline or server
 * shutdown does. Cancellation cannot undo commits/refund usage. Ignored aborts retain global work
 * slots until settlement (even after DELETE), preventing unbounded replacement of stuck transports.
 * TLS, rate limiting and isolation of a wildcard listener belong to the trusted reverse proxy.
 */
export async function startHttpMcpServer(options: HttpMcpServerOptions): Promise<HttpMcpServer> {
  const publicAddress = parsePublicUrl(options.publicUrl);
  const host = options.host ?? "127.0.0.1", port = options.port ?? 7342;
  if ((host !== "127.0.0.1" && host !== "0.0.0.0") || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid MCP HTTP listener");
  assertServiceToken(options.authToken); assertServiceToken(options.serviceToken);
  const principal = digest(options.authToken);
  for (const token of [options.serviceToken, ...(options.forbiddenTokens ?? [])]) {
    if (timingSafeEqual(principal, digest(token))) throw new Error("Independent MCP HTTP credential required");
  }
  const idleMs = duration(options.idleTimeoutMs, 300_000);
  const requestMs = duration(options.requestTimeoutMs, 60_000);
  const bodyMs = duration(options.bodyTimeoutMs, 10_000);
  const responseMs = duration(options.responseTimeoutMs, 10_000);
  options.signal?.throwIfAborted();
  const tools = createTools({ transport: options.transport, allowWrite: options.allowWrite === true });
  const sessions = new Map<string, Session>();
  const sockets = new Set<Socket>();
  const responses = new Set<ServerResponse>();
  let globalActive = 0, closing = false;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });

  function send(res: ServerResponse, status: number, value?: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    let serialized = value === undefined ? "" : JSON.stringify(value);
    // Even a shape-valid compromised upstream reply must not disclose access credentials.
    // Tool text has already been decoded/normalized by the Dawn response validator and serializer.
    if ([options.authToken, options.serviceToken, ...(options.forbiddenTokens ?? [])].some(token => token && serialized.includes(token))) {
      status = 500; serialized = '{"error":"MCP response unavailable"}';
    }
    let body = Buffer.from(serialized);
    if (body.length > HTTP_MAX_RESPONSE_BYTES) {
      status = 500; body = Buffer.from('{"error":"MCP response limit exceeded"}');
    }
    res.statusCode = status;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // No streaming/resumption, one bounded response per connection, also limits slow readers/pipelines.
    res.setHeader("Connection", "close");
    res.setHeader("Content-Length", body.length);
    if (body.length) res.setHeader("Content-Type", "application/json");
    const timer = setTimeout(() => res.destroy(), responseMs);
    timer.unref();
    const clear = () => { clearTimeout(timer); res.off("finish", clear); res.off("close", clear); };
    res.once("finish", clear); res.once("close", clear);
    res.end(body);
  }
  const fail = (res: ServerResponse, status: number, message: string): void => send(res, status, { error: message });
  const rpcError = (res: ServerResponse, id: Id, code: number, message: string): void => send(res, 200, { jsonrpc: "2.0", id, error: { code, message } });
  function cancel(id: Id, item: Active, message: string): void {
    if (item.cancelled) return;
    item.cancelled = true;
    clearTimeout(item.timer);
    item.controller.abort();
    rpcError(item.response, id, -32800, message);
  }
  function remove(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.id);
    for (const [id, item] of session.active) cancel(id, item, "Request cancelled");
  }
  function sweep(): void {
    const now = performance.now();
    for (const session of sessions.values()) {
      if (!session.active.size && !session.readers && now - session.touched >= idleMs) remove(session);
    }
  }
  const sweepTimer = setInterval(sweep, Math.min(idleMs, 1000));
  sweepTimer.unref();

  function readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | undefined> {
    return new Promise(resolve => {
      const chunks: Buffer[] = [];
      let size = 0, settled = false;
      const timer = setTimeout(() => finish(408, "Request body timeout"), bodyMs);
      timer.unref();
      function finish(status?: number, message?: string): void {
        if (settled) return;
        settled = true; clearTimeout(timer);
        req.off("data", data); req.off("end", end); req.off("aborted", aborted); req.off("error", aborted);
        res.off("close", aborted);
        if (status) { fail(res, status, message!); req.pause(); }
        resolve(status || req.aborted || res.destroyed ? undefined : Buffer.concat(chunks, size));
      }
      function data(chunk: Buffer): void {
        size += chunk.length;
        if (size > HTTP_MAX_BODY_BYTES) finish(413, "Request body limit exceeded");
        else chunks.push(chunk);
      }
      function end(): void { finish(); }
      function aborted(): void { finish(400, "Request interrupted"); }
      req.on("data", data); req.once("end", end); req.once("aborted", aborted); req.once("error", aborted); res.once("close", aborted);
    });
  }
  async function dispatch(session: Session, method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (method === "initialize") throw new RpcError(-32600, "Already initialized");
    if (method === "ping") {
      if (!emptyParams(params)) throw new RpcError(-32602, "Invalid params");
      return {};
    }
    if (method !== "tools/list" && method !== "tools/call") throw new RpcError(-32601, "Method not found");
    if (!session.ready) throw new RpcError(-32002, "Server not initialized");
    if (method === "tools/list") {
      if (!emptyParams(params)) throw new RpcError(-32602, "Invalid params");
      return { tools: tools.list() };
    }
    if (!isRecord(params) || !hasOnlyKeys(params, ["name", "arguments", "_meta"]) || typeof params.name !== "string" || !params.name ||
        (params.arguments !== undefined && !isRecord(params.arguments)) || (params._meta !== undefined && !isRecord(params._meta))) throw new RpcError(-32602, "Invalid params");
    return tools.call(params.name, params.arguments, signal);
  }
  function run(session: Session, id: Id, method: string, params: unknown, res: ServerResponse): void {
    if (session.active.has(id)) { fail(res, 409, "Duplicate active request id"); return; }
    if (session.active.size >= HTTP_MAX_IN_FLIGHT || globalActive >= HTTP_MAX_GLOBAL_IN_FLIGHT) {
      fail(res, 429, "Too many in-flight requests"); return;
    }
    const item: Active = { controller: new AbortController(), response: res, cancelled: false,
      timer: setTimeout(() => cancel(id, item, "Request deadline exceeded"), requestMs) };
    item.timer.unref();
    session.active.set(id, item); globalActive++;
    // Do not subscribe request/response socket close to item.controller: disconnect is NOT cancellation.
    void dispatch(session, method, params, item.controller.signal).then(result => {
      if (!item.cancelled && !session.closed) {
        const value = { jsonrpc: "2.0", id, result };
        if (Buffer.byteLength(JSON.stringify(value)) > HTTP_MAX_RESPONSE_BYTES) rpcError(res, id, -32603, "Response limit exceeded");
        else send(res, 200, value);
      }
    }, error => {
      if (item.cancelled || session.closed) return;
      if (error instanceof RpcError) rpcError(res, id, error.code, error.message);
      else if (error instanceof ToolParamsError) rpcError(res, id, -32602, "Invalid params");
      else if (method === "tools/call") send(res, 200, { jsonrpc: "2.0", id, result: toolFailure() });
      else rpcError(res, id, -32603, "Internal error");
    }).catch(() => {
      // A serialization/write failure is not an unhandled rejection and never exposes raw errors.
      if (!item.cancelled && !session.closed) rpcError(res, id, -32603, "Internal error");
    }).finally(() => {
      clearTimeout(item.timer); session.active.delete(id); globalActive--; session.touched = performance.now();
    });
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (closing) { fail(res, 503, "MCP unavailable"); return; }
    if (responses.size >= MAX_CONNECTIONS) { fail(res, 503, "MCP capacity exceeded"); return; }
    responses.add(res); res.once("close", () => responses.delete(res));
    // Node maxHeadersCount truncates rather than rejects. Keep complete headers under
    // maxHeaderSize, then reject excess explicitly before any optional security check.
    if (req.rawHeaders.length > 64) { fail(res, 431, "Too many request headers"); return; }
    if (req.url !== "/mcp") { fail(res, 404, "Not found"); return; }
    if (header(req, "host") !== publicAddress.host ||
        (req.headers.origin !== undefined && header(req, "origin") !== publicAddress.origin)) {
      fail(res, 403, "Invalid request origin or host"); return;
    }
    const authorization = header(req, "authorization") ?? "";
    const candidate = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(authorization)?.[1] ?? "";
    if (!timingSafeEqual(digest(candidate), principal)) {
      res.setHeader("WWW-Authenticate", "Bearer"); fail(res, 401, "Unauthorized"); return;
    }
    if (req.method !== "POST" && req.method !== "DELETE") {
      res.setHeader("Allow", "POST, DELETE"); fail(res, 405, "Method not allowed"); return;
    }
    const sid = header(req, "mcp-session-id");
    if (req.headers["mcp-session-id"] !== undefined && (!sid || !/^[A-Za-z0-9_-]{43}$/.test(sid))) {
      fail(res, 400, "Invalid session header"); return;
    }
    sweep();
    const session = sid ? sessions.get(sid) : undefined;
    if (sid && (!session || !timingSafeEqual(session.principal, digest(candidate)))) { fail(res, 404, "Session not found"); return; }
    const version = header(req, "mcp-protocol-version");
    // MCP transport compatibility rule: absent version assumes 2025-03-26, not a new negotiation.
    if ((req.headers["mcp-protocol-version"] !== undefined && !version) ||
        (version && !(HTTP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) ||
        (session && (version ?? "2025-03-26") !== session.version)) { fail(res, 400, "Invalid protocol version"); return; }
    if (req.method === "DELETE") {
      if (!session) { fail(res, 400, "Session required"); return; }
      remove(session); send(res, 200); return;
    }
    const type = header(req, "content-type") ?? "";
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(type) || req.headers["content-encoding"] !== undefined) {
      fail(res, 415, "JSON content required"); return;
    }
    const accept = header(req, "accept") ?? "";
    const accepted = accept.split(",").filter(part => !/;\s*q\s*=\s*0(?:\.0*)?\s*(?:;|$)/i.test(part)).map(part => part.split(";")[0]!.trim().toLowerCase());
    if (!accepted.includes("application/json") || !accepted.includes("text/event-stream")) {
      fail(res, 406, "Accept must include application/json and text/event-stream"); return;
    }
    const contentLength = req.headers["content-length"];
    if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > HTTP_MAX_BODY_BYTES)) {
      fail(res, 413, "Request body limit exceeded"); return;
    }
    if (session) session.readers++;
    let bytes: Buffer | undefined;
    try { bytes = await readBody(req, res); }
    finally { if (session) { session.readers--; session.touched = performance.now(); } }
    if (!bytes || closing || res.destroyed) return;
    if (session?.closed) { fail(res, 404, "Session not found"); return; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { fail(res, 400, "Invalid JSON"); return; }
    if (!isRecord(value) || value.jsonrpc !== "2.0" || !hasOnlyKeys(value, ["jsonrpc", "method", "params", "id"]) ||
        typeof value.method !== "string" || !value.method || (Object.hasOwn(value, "id") && !validId(value.id))) {
      fail(res, 400, "Invalid JSON-RPC message"); return;
    }
    if (!session) {
      if (value.method !== "initialize" || !validId(value.id)) { fail(res, 400, "Session required"); return; }
      const params = value.params;
      if (!isRecord(params) || !hasOnlyKeys(params, ["protocolVersion", "capabilities", "clientInfo", "_meta"]) ||
          typeof params.protocolVersion !== "string" || !params.protocolVersion || !isRecord(params.capabilities) ||
          !isRecord(params.clientInfo) || typeof params.clientInfo.name !== "string" || !params.clientInfo.name ||
          typeof params.clientInfo.version !== "string" || !params.clientInfo.version ||
          (params._meta !== undefined && !isRecord(params._meta))) { rpcError(res, value.id, -32602, "Invalid params"); return; }
      if (sessions.size >= HTTP_MAX_SESSIONS) { fail(res, 503, "Session capacity exceeded"); return; }
      const negotiated = (HTTP_PROTOCOL_VERSIONS as readonly string[]).includes(params.protocolVersion) ? params.protocolVersion : HTTP_PROTOCOL_VERSIONS[0];
      const id = randomBytes(32).toString("base64url");
      sessions.set(id, { id, principal: Buffer.from(principal), version: negotiated, ready: false, closed: false,
        touched: performance.now(), readers: 0, active: new Map() });
      res.setHeader("Mcp-Session-Id", id);
      send(res, 200, { jsonrpc: "2.0", id: value.id, result: { protocolVersion: negotiated, capabilities: { tools: {} },
        serverInfo: { name: "shuguang-mcp", version: "0.1.0" },
        instructions: "仅显式工具调用；写权限由服务配置决定。不自动唤醒、重试或学习。断线不是取消；取消不保证撤回提交或退款。" } });
      return;
    }
    session.touched = performance.now();
    if (!Object.hasOwn(value, "id")) {
      if (value.method === "notifications/initialized" && emptyParams(value.params)) session.ready = true;
      else if (value.method === "notifications/cancelled" && isRecord(value.params) &&
          hasOnlyKeys(value.params, ["requestId", "reason", "_meta"]) && validId(value.params.requestId) &&
          (value.params.reason === undefined || typeof value.params.reason === "string") &&
          (value.params._meta === undefined || isRecord(value.params._meta))) {
        const item = session.active.get(value.params.requestId);
        if (item) cancel(value.params.requestId, item, "Request cancelled");
      }
      send(res, 202); return;
    }
    run(session, value.id as Id, value.method, value.params, res);
  }
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: bodyMs, requestTimeout: bodyMs,
    connectionsCheckingInterval: Math.min(bodyMs, 1000), keepAliveTimeout: 1000 }, (req, res) => {
    // Absorb late socket/read errors even after body listeners are removed, never log raw data.
    req.on("error", () => {}); res.on("error", () => {});
    void handle(req, res).catch(() => fail(res, 500, "Internal error"));
  });
  server.maxHeadersCount = 0; // byte-bounded by maxHeaderSize; explicit count check above rejects, never truncates.
  server.maxRequestsPerSocket = 1;
  server.setTimeout(bodyMs + requestMs + responseMs, socket => socket.destroy());
  server.on("connection", socket => {
    if (closing || sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (error, socket) => {
    // Node's absolute HTTP request deadline can race our body timer. Both paths give a
    // fixed timeout response (never parser details), then promptly release the socket.
    if ((error as NodeJS.ErrnoException).code === "ERR_HTTP_REQUEST_TIMEOUT" && socket instanceof Socket && socket.writable) {
      socket.setTimeout(responseMs, () => socket.destroy());
      socket.end("HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
    } else socket.destroy();
  });
  server.on("checkContinue", (_req, res) => fail(res, 417, "Expect not supported"));
  server.on("checkExpectation", (_req, res) => fail(res, 417, "Expect not supported"));
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connect", (_req, socket) => socket.destroy());
  function close(): Promise<void> {
    if (closing) return done;
    closing = true; clearInterval(sweepTimer);
    options.signal?.removeEventListener("abort", onAbort);
    for (const session of sessions.values()) remove(session);
    server.close(() => resolveDone());
    for (const socket of sockets) socket.destroy();
    return done;
  }
  const onAbort = (): void => { void close(); };
  try {
    await new Promise<void>((resolve, reject) => {
      const error = (): void => { server.off("listening", listening); reject(new Error("MCP HTTP listen failed")); };
      const listening = (): void => { server.off("error", error); resolve(); };
      server.once("error", error); server.once("listening", listening); server.listen(port, host);
    });
  } catch { await close(); throw new Error("MCP HTTP listen failed"); }
  server.on("error", onAbort);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const address = server.address();
  if (options.signal?.aborted) await close();
  if (!address || typeof address === "string") { await close(); throw new Error("MCP HTTP listen failed"); }
  return { port: address.port, host, done, close };
}
