import { isAbsolute, resolve } from "node:path";
import { parseDawnEndpoint } from "../../dawn/src/adapters/transport/http-client.ts";

export interface HttpMcpOptions {
  readonly endpoint: string;
  readonly tokenFile: string;
  readonly authTokenFile: string;
  readonly publicUrl: string;
  readonly host: "127.0.0.1" | "0.0.0.0";
  readonly port: number;
  readonly allowWrite: boolean;
}

/** TLS is terminated by a separately configured trusted proxy, never inferred from headers. */
export function parsePublicUrl(value: string): { host: string; origin: string } {
  try {
    const url = new URL(value);
    const authority = /^https:\/\/([^/]+)\/mcp$/.exec(value)?.[1];
    if (!authority || url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        url.pathname !== "/mcp" || !url.hostname ||
        // Preserve an explicitly configured default port in the exact Host guard.
        (authority !== url.host && authority !== `${url.hostname}:443`)) throw new Error();
    return { host: authority, origin: url.origin };
  } catch { throw new Error("Invalid MCP public URL"); }
}

export const HTTP_HELP = `Shuguang MCP Streamable HTTP bridge (Node >=24)
Usage: node packages/mcp/src/http-main.ts --endpoint http://127.0.0.1:7341 --token-file /absolute/private/service.token --auth-token-file /absolute/private/remote.token --public-url https://host/mcp [--host 127.0.0.1|0.0.0.0] [--port 7342] [--allow-write]
Requires an existing Dawn service and separately provisioned remote Bearer token, distinct from BOTH service and owner tokens.
Default: loopback listener and read-only tools. TLS must be terminated by a trusted proxy preserving the exact public Host; forwarded headers are ignored.
JSON responses only; no SSE, retries, automatic initialization or wake. Disconnect is not cancellation; explicit cancellation/DELETE may abort access work, never stop Dawn.
`;

/** Validate all arguments before opening either explicit credential file. No discovery. */
export function parseHttpMcpOptions(args: readonly string[]): HttpMcpOptions {
  const values = new Map<string, string>();
  let allowWrite = false;
  const keys = ["--endpoint", "--token-file", "--auth-token-file", "--public-url", "--host", "--port"];
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === "--allow-write" && !allowWrite) { allowWrite = true; continue; }
    if (!keys.includes(key) || values.has(key)) throw new Error("Invalid MCP HTTP arguments");
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("Invalid MCP HTTP arguments");
    values.set(key, value);
  }
  const endpoint = values.get("--endpoint"), tokenFile = values.get("--token-file");
  const authTokenFile = values.get("--auth-token-file"), publicUrl = values.get("--public-url");
  const host = values.get("--host") ?? "127.0.0.1", portValue = values.get("--port") ?? "7342";
  if (!endpoint || !tokenFile || !authTokenFile || !publicUrl || resolve(tokenFile) === resolve(authTokenFile) ||
      [tokenFile, authTokenFile].some(path => !isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) ||
      (host !== "127.0.0.1" && host !== "0.0.0.0") || !/^[1-9]\d{0,4}$/.test(portValue) || Number(portValue) > 65535) {
    throw new Error("Invalid MCP HTTP arguments");
  }
  parseDawnEndpoint(endpoint);
  parsePublicUrl(publicUrl);
  return { endpoint, tokenFile, authTokenFile, publicUrl, host, port: Number(portValue), allowWrite };
}
