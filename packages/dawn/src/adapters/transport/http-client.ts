import { request as httpRequest } from "node:http";
import { TextDecoder } from "node:util";
import { assertDawnRequest, assertDawnResponse, MAX_WIRE_BYTES, SAY_CLIENT_TIMEOUT_MS, CONTROL_TIMEOUT_MS } from "../../protocol/index.ts";
import type { DawnRequest, DawnResponse, DawnTransport } from "../../protocol/index.ts";
import { assertServiceToken } from "./token-file.ts";

/** Keep explicit default ports in Host, matching the server's DNS-rebinding guard. */
export function parseDawnEndpoint(endpoint: string): { port: number; host: string } {
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(endpoint);
  const port = match ? Number(match[1]) : 0;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Dawn endpoint");
  return { port, host: `127.0.0.1:${port}` };
}

export class HttpDawnTransport implements DawnTransport {
  readonly #endpoint: { port: number; host: string };
  readonly #token: string;

  constructor(endpoint: string, token: string) {
    // Exact canonical form: no DNS, redirects, userinfo, path, query, hash or proxies.
    this.#endpoint = parseDawnEndpoint(endpoint);
    assertServiceToken(token);
    this.#token = token;
  }

  async request(request: DawnRequest, signal: AbortSignal): Promise<DawnResponse> {
    signal.throwIfAborted();
    assertDawnRequest(request);
    const body = Buffer.from(JSON.stringify(request), "utf8");
    if (body.byteLength > MAX_WIRE_BYTES) throw new Error("Dawn request exceeds size limit");
    const combined = AbortSignal.any([signal, AbortSignal.timeout(request.type === "say" ? SAY_CLIENT_TIMEOUT_MS : CONTROL_TIMEOUT_MS)]);
    const result = await new Promise<DawnResponse>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, value?: DawnResponse) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else if (value) resolve(value);
      };
      const req = httpRequest({
        hostname: "127.0.0.1", port: this.#endpoint.port,
        method: "POST", path: "/v1/request", signal: combined, agent: false,
        headers: {
          Authorization: `Bearer ${this.#token}`, Host: this.#endpoint.host,
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": body.byteLength, Connection: "close",
        },
      }, response => {
        // Node http never follows redirects. Reject before reading untrusted error bodies.
        if (response.statusCode !== 200 ||
            !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(response.headers["content-type"] ?? "")) {
          finish(new Error("Dawn service rejected the request"));
          response.destroy(); req.destroy(); return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_WIRE_BYTES) {
            finish(new Error("Dawn response exceeds size limit"));
            response.destroy(); req.destroy();
          } else { chunks.push(chunk); }
        });
        response.once("error", () => finish(new Error("Dawn response interrupted")));
        response.once("aborted", () => finish(new Error("Dawn response interrupted")));
        response.once("end", () => {
          if (settled) return;
          try {
            combined.throwIfAborted();
            const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
            assertDawnResponse(value);
            if (value.requestId !== request.requestId || (value.type !== "error" &&
                (request.type === "say" ? value.type !== "reply" : value.type !== "status"))) {
              throw new Error("Mismatched response");
            }
            finish(null, value);
          } catch { finish(new Error("Invalid Dawn service response")); }
        });
      });
      req.once("error", () => finish(new Error("Dawn service unavailable or request cancelled")));
      req.end(body);
    });
    combined.throwIfAborted();
    return result;
  }
}
