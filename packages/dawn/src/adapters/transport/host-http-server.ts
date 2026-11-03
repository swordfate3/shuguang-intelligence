import type { IncomingMessage, ServerResponse } from "node:http";
import { assertHostRequest, HOST_MAX_BYTES } from "../../protocol/host.ts";
import type { HostImportService } from "../../runtime/host-service.ts";
/** Called only after the enclosing transport's exact Host/Origin checks and resource admission. */
export async function handleHostHttp(service: HostImportService, request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<void> {
  const fail = (status: number): void => {
    if (!response.destroyed && !response.headersSent) {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
      response.end('{"error":"host_request_failed"}');
    }
  };
  try {
    const headers = (name: string): string[] => {
      const values: string[] = [];
      for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i]?.toLowerCase() === name) values.push(request.rawHeaders[i + 1] ?? "");
      return values;
    };
    const authorization = headers("authorization");
    const token = authorization.length === 1 ? /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(authorization[0]!)?.[1] : undefined;
    if (!token) { fail(401); return; }
    if (request.method !== "POST" || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) { fail(400); return; }
    if (Number(request.headers["content-length"] ?? 0) > HOST_MAX_BYTES) { fail(413); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > HOST_MAX_BYTES) { fail(413); return; }
      chunks.push(bytes);
    }
    signal.throwIfAborted();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    assertHostRequest(value);
    const result = await service.handle(value, token, request.socket, signal);
    signal.throwIfAborted();
    if (response.destroyed) return;
    const body = Buffer.from(JSON.stringify(result));
    if (body.length > HOST_MAX_BYTES) { fail(503); return; }
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length,
      "Cache-Control": "no-store", Connection: "keep-alive" });
    response.end(body);
  } catch { fail(400); }
}
