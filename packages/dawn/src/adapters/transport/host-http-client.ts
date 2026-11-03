import { Agent, request as httpRequest } from "node:http";
import { assertHostRequest, assertHostResponse, HOST_MAX_BYTES, type HostRequest, type HostResponse } from "../../protocol/host.ts";
import { parseDawnEndpoint } from "./http-client.ts";
import { assertServiceToken } from "./token-file.ts";
/** One socket for the entire private binding; no replacement connection or automatic retry. */
export class HostHttpClient {
  readonly #endpoint: ReturnType<typeof parseDawnEndpoint>;
  readonly #agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  #socket: import("node:net").Socket | undefined;
  #closed = false;
  #pending = false;
  #executor: string | undefined;
  readonly ownerToken: string;
  constructor(endpoint: string, ownerToken: string) {
    this.#endpoint = parseDawnEndpoint(endpoint); assertServiceToken(ownerToken); this.ownerToken = ownerToken;
  }
  close(): void { this.#closed = true; this.#agent.destroy(); }
  async request(request: HostRequest, signal: AbortSignal): Promise<HostResponse> {
    signal.throwIfAborted(); assertHostRequest(request);
    if (this.#closed || this.#pending || (request.type !== "pair" && !this.#executor) || (request.type === "pair" && this.#executor)) throw new Error("Host channel unavailable");
    this.#pending = true;
    try {
      const owner = ["pair", "authorize", "revoke", "research-start", "research-stop", "research-resume", "research-status"].includes(request.type);
      const body = Buffer.from(JSON.stringify(request));
      const active = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      const result = await new Promise<HostResponse>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: HostResponse): void => {
          if (settled) return; settled = true;
          if (error) { this.close(); reject(new Error("Private host request failed")); }
          else resolve(value!);
        };
        const req = httpRequest({ hostname: "127.0.0.1", port: this.#endpoint.port, path: "/host/v1/request", method: "POST", agent: this.#agent, signal: active,
          headers: { Host: this.#endpoint.host, Authorization: `Bearer ${owner ? this.ownerToken : this.#executor}`,
            "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length } }, response => {
          if (response.statusCode !== 200 || !/^application\/json; charset=utf-8$/i.test(response.headers["content-type"] ?? "")) {
            response.destroy(); finish(new Error("Invalid host HTTP response")); return;
          }
          const chunks: Buffer[] = []; let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > HOST_MAX_BYTES) { response.destroy(); finish(new Error("Host response too large")); }
            else chunks.push(chunk);
          });
          response.once("aborted", () => finish(new Error("Host response interrupted")));
          response.once("error", () => finish(new Error("Host response failed")));
          response.once("end", () => {
            if (settled) return;
            try {
              active.throwIfAborted();
              const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
              assertHostResponse(value);
              if (value.requestId !== request.requestId) throw new Error("Host response mismatch");
              const expected = request.type === "pair" ? "paired" : request.type === "status" ? "status" : request.type === "authorize" ? "grant" : request.type === "revoke" ? "revoked"
                : request.type === "research-next" ? "research-task" : request.type === "research-claim" ? "research-claim"
                : request.type.startsWith("research-") ? "research" : "import";
              if (value.type !== "error" && value.type !== expected) throw new Error("Unexpected host response type");
              // Even shape-valid string fields must not reflect a bearer credential into Pi.
              const encoded = JSON.stringify(value);
              if (request.type !== "pair" && (encoded.includes(this.ownerToken) || (this.#executor && encoded.includes(this.#executor)))) {
                throw new Error("Private credential reflected in host response");
              }
              if (request.type === "pair") {
                if (value.type !== "paired") throw new Error("Host pairing failed");
                this.#executor = value.executorToken;
              }
              finish(undefined, value);
            } catch { finish(new Error("Invalid host response")); }
          });
        });
        req.once("socket", socket => {
          if (this.#socket && this.#socket !== socket) { req.destroy(); finish(new Error("Replacement host socket denied")); return; }
          if (!this.#socket) {
            this.#socket = socket;
            socket.once("close", () => { this.#closed = true; });
          }
          if (this.#closed) req.destroy();
        });
        req.once("error", () => finish(new Error("Host connection failed")));
        req.end(body);
      });
      active.throwIfAborted();
      return result;
    } finally { this.#pending = false; }
  }
}
