import { isAbsolute } from "node:path";
import { parseDawnEndpoint } from "../../dawn/src/adapters/transport/http-client.ts";

export interface McpOptions {
  readonly endpoint: string;
  readonly tokenFile: string;
  readonly allowWrite: boolean;
}

export const HELP = `Shuguang MCP stdio bridge (Node >=24)
Usage: node packages/mcp/src/main.ts --endpoint http://127.0.0.1:7341 --token-file /absolute/private/service.token [--allow-write]
Default: cached model status and subject status only. --allow-write explicitly enables conversation, lifecycle and model controls.
Connects to an already-running Dawn service. Does not initialize, wake, retry, read host conversation or start learning.
Keep stdout exclusively for MCP messages. Configuration errors are reported to stderr without secrets.
`;

/** Validate every argument before reading a credential; no environment or path discovery. */
export function parseMcpOptions(args: readonly string[]): McpOptions {
  let endpoint: string | undefined;
  let tokenFile: string | undefined;
  let allowWrite = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--allow-write" && !allowWrite) { allowWrite = true; continue; }
    if ((key === "--endpoint" && endpoint === undefined) || (key === "--token-file" && tokenFile === undefined)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("Invalid MCP arguments");
      if (key === "--endpoint") endpoint = value; else tokenFile = value;
      continue;
    }
    throw new Error("Invalid MCP arguments");
  }
  if (!endpoint || !tokenFile || !isAbsolute(tokenFile) || /[\u0000-\u001f\u007f]/u.test(tokenFile)) {
    throw new Error("Invalid MCP arguments");
  }
  parseDawnEndpoint(endpoint);
  return { endpoint, tokenFile, allowWrite };
}
