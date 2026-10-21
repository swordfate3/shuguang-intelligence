import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { TextDecoder } from "node:util";
import {
  assertDawnRequest,
  assertDawnResponse,
  MAX_WIRE_BYTES,
  SAY_SERVER_TIMEOUT_MS,
  type DawnHandler,
  type DawnRequest,
} from "../../protocol/index.ts";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const REQUEST_TIMEOUT_MS = 10_000;
const HEADER_TIMEOUT_MS = 5_000;
const MAX_CONNECTIONS = 64;
const MAX_CONCURRENT_REQUESTS = 16;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const errors = {
  unauthorized: { error: "unauthorized" },
  forbidden: { error: "forbidden" },
  notFound: { error: "not_found" },
  methodNotAllowed: { error: "method_not_allowed" },
  tooLarge: { error: "request_too_large" },
  badRequest: { error: "bad_request" },
  unavailable: { error: "unavailable" },
} as const;

type ErrorKey = keyof typeof errors;

type PendingRequest = {
  readonly controller: AbortController;
  timer: NodeJS.Timeout;
};

/** Start an explicitly requested, token-authenticated localhost HTTP transport. */
export async function startHttpServer(options: {
  token: string;
  port: number;
  handler: DawnHandler;
  signal?: AbortSignal;
}): Promise<{ port: number; close(): Promise<void> }> {
  if (!TOKEN_PATTERN.test(options.token)) throw new TypeError("Invalid HTTP server token");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new TypeError("Invalid HTTP server port");
  }
  if (typeof options.handler !== "function") throw new TypeError("Invalid HTTP server handler");
  if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");

  const token = Buffer.from(options.token, "ascii");
  const paddedToken = Buffer.alloc(128);
  token.copy(paddedToken);
  const pending = new Set<PendingRequest>();
  const sockets = new Set<import("node:net").Socket>();
  let activeRequests = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let server!: Server;

  const sendError = (response: ServerResponse, key: ErrorKey, status: number): void => {
    if (response.destroyed || response.headersSent) return;
    const body = Buffer.from(JSON.stringify(errors[key]), "utf8");
    response.writeHead(status, {
      "Content-Type": JSON_CONTENT_TYPE,
      "Content-Length": body.byteLength,
      "Cache-Control": "no-store",
      Connection: "close",
    });
    response.end(body);
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    options.signal?.removeEventListener("abort", onAbort);
    closePromise = new Promise<void>(resolve => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
      for (const item of pending) {
        clearTimeout(item.timer);
        item.controller.abort();
      }
      pending.clear();
      activeRequests = 0;
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
    });
    return closePromise;
  };

  const onAbort = (): void => { void close(); };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (closing) {
      sendError(response, "unavailable", 503);
      return;
    }

    if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
      sendError(response, "unavailable", 503);
      return;
    }
    activeRequests += 1;
    const controller = new AbortController();
    let finished = false;
    let state!: PendingRequest;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(state.timer);
      pending.delete(state);
      activeRequests = Math.max(0, activeRequests - 1);
    };
    const startedAt = performance.now();
    const expire = (): void => {
      controller.abort();
      sendError(response, "badRequest", 400);
      if (!response.destroyed && !response.writableFinished) {
        response.once("finish", () => request.destroy());
      } else {
        request.destroy();
      }
    };
    state = { controller, timer: setTimeout(expire, REQUEST_TIMEOUT_MS) };
    state.timer.unref();
    pending.add(state);
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableFinished) controller.abort();
    });

    try {
      const hostHeaders: string[] = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        if (request.rawHeaders[index]?.toLowerCase() === "host") {
          hostHeaders.push(request.rawHeaders[index + 1] ?? "");
        }
      }
      if (request.headers.origin !== undefined || hostHeaders.length !== 1 ||
          hostHeaders[0] !== `127.0.0.1:${actualPort}`) {
        sendError(response, "forbidden", 403);
        return;
      }
      if (request.url !== "/v1/request") {
        sendError(response, "notFound", 404);
        return;
      }
      if (request.method !== "POST") {
        sendError(response, "methodNotAllowed", 405);
        return;
      }

      const authHeaders: string[] = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        if (request.rawHeaders[index]?.toLowerCase() === "authorization") {
          authHeaders.push(request.rawHeaders[index + 1] ?? "");
        }
      }
      const authorization = request.headers.authorization ?? "";
      const match = authHeaders.length === 1 ? /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(authorization) : null;
      const matchedToken = match?.[1];
      const presented = matchedToken === undefined ? Buffer.alloc(0) : Buffer.from(matchedToken, "ascii");
      const paddedPresented = Buffer.alloc(128);
      if (presented.byteLength <= paddedPresented.byteLength) presented.copy(paddedPresented);
      const tokenMatches = timingSafeEqual(paddedToken, paddedPresented) && presented.byteLength === token.byteLength;
      if (!match || !tokenMatches) {
        sendError(response, "unauthorized", 401);
        return;
      }

      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" ||
          !/^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/i.test(contentType)) {
        sendError(response, "badRequest", 400);
        return;
      }

      const declaredLength = request.headers["content-length"];
      if (declaredLength !== undefined && Number(declaredLength) > MAX_WIRE_BYTES) {
        sendError(response, "tooLarge", 413);
        return;
      }

      const chunks: Buffer[] = [];
      let byteLength = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += bytes.byteLength;
        if (byteLength > MAX_WIRE_BYTES) {
          sendError(response, "tooLarge", 413);
          return;
        }
        chunks.push(bytes);
      }
      if (controller.signal.aborted || closing) return;

      let value: unknown;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, byteLength));
        value = JSON.parse(text);
        assertDawnRequest(value);
      } catch {
        sendError(response, "badRequest", 400);
        return;
      }

      // Only a fully authenticated, bounded and validated say gets the longer
      // generation budget. Body upload and control requests retain their 10s cap.
      if ((value as DawnRequest).type === "say") {
        clearTimeout(state.timer);
        const remaining = SAY_SERVER_TIMEOUT_MS - (performance.now() - startedAt);
        if (remaining <= 0) { expire(); return; }
        state.timer = setTimeout(expire, remaining);
        state.timer.unref();
      }
      let result: unknown;
      try {
        result = await options.handler(value as DawnRequest, controller.signal);
        if (controller.signal.aborted || closing || response.destroyed) return;
        assertDawnResponse(result);
        if (result.requestId !== (value as DawnRequest).requestId) throw new Error("Invalid response correlation");
        const body = Buffer.from(JSON.stringify(result), "utf8");
        if (body.byteLength > MAX_WIRE_BYTES) throw new Error("Response too large");
        response.writeHead(200, {
          "Content-Type": JSON_CONTENT_TYPE,
          "Content-Length": body.byteLength,
          "Cache-Control": "no-store",
          Connection: "close",
        });
        response.end(body);
      } catch {
        if (!controller.signal.aborted && !closing && !response.destroyed) {
          sendError(response, "unavailable", 503);
        }
      }
    } catch {
      if (!controller.signal.aborted && !closing && !response.destroyed) {
        sendError(response, "badRequest", 400);
      }
    } finally {
      finish();
    }
  };

  let actualPort = options.port;
  server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      // Keep unexpected transport/parser failures contained; never expose their details.
      try {
        if (!response.destroyed && !response.headersSent) sendError(response, "unavailable", 503);
        else if (!response.destroyed) response.destroy();
      } catch {
        response.destroy();
      }
    });
  });
  server.headersTimeout = HEADER_TIMEOUT_MS;
  // The per-request timer below returns a fixed JSON 400 and aborts body/handler work.
  // Avoid Node's built-in 408 response, which bypasses our wire error envelope.
  server.requestTimeout = 0;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 64;
  server.maxConnections = MAX_CONNECTIONS;
  server.maxRequestsPerSocket = 1;
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => {
    if (!socket.writable || socket.destroyed) return;
    const body = Buffer.from(JSON.stringify(errors.badRequest), "utf8");
    socket.end(`HTTP/1.1 400 Bad Request\r\nContent-Type: ${JSON_CONTENT_TYPE}\r\nContent-Length: ${body.byteLength}\r\nConnection: close\r\n\r\n${body.toString("utf8")}`);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("HTTP server did not bind a TCP port");
  }
  actualPort = address.port;
  if (options.signal?.aborted) {
    await close();
    throw new DOMException("The operation was aborted", "AbortError");
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) void close();

  return { port: actualPort, close };
}
