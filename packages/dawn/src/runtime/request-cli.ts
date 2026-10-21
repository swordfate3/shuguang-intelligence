import { HttpDawnTransport, parseDawnEndpoint } from "../adapters/transport/http-client.ts";
import { readTokenFile } from "../adapters/transport/token-file.ts";
import { parseCommand } from "./control-client.ts";
import { assertDawnRequest } from "../protocol/index.ts";
import type { DawnResponse } from "../protocol/index.ts";

/** Run the standalone request subcommand with explicit endpoint and credential file. */
export async function runRequestCli(args: readonly string[], signal: AbortSignal): Promise<DawnResponse> {
  signal.throwIfAborted();
  if (args[0] !== "request") throw usageError();

  let separator = -1;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === "--") {
      separator = index;
      break;
    }
  }
  if (separator < 0) throw usageError();

  let endpoint: string | undefined;
  let tokenFile: string | undefined;
  for (let index = 1; index < separator;) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value === "--" || value.startsWith("--")) throw usageError();
    if (flag === "--endpoint" && endpoint === undefined) endpoint = value;
    else if (flag === "--token-file" && tokenFile === undefined) tokenFile = value;
    else throw usageError();
    index += 2;
  }
  if (endpoint === undefined || tokenFile === undefined) throw usageError();

  const command = args.slice(separator + 1);
  const validLength = command[0] === "status" ? command.length === 1 :
    command[0] === "wake" || command[0] === "sleep" || command[0] === "say" ? command.length === 2 : false;
  if (!validLength) throw usageError();

  // Validate all command syntax and endpoint canonicalization before touching credentials.
  const commandText = command[0] === "say" ? `say ${command[1]!.trim()}` : command.join(" ");
  const parsedRequest = parseCommand(commandText);
  parseDawnEndpoint(endpoint);
  const request = parsedRequest.type === "say" ? { ...parsedRequest, text: command[1]! } : parsedRequest;
  assertDawnRequest(request);
  signal.throwIfAborted();

  const token = readTokenFile(tokenFile);
  signal.throwIfAborted();
  return new HttpDawnTransport(endpoint, token).request(request, signal);
}

function usageError(): Error {
  return new Error("用法：request --endpoint http://127.0.0.1:<port> --token-file <绝对路径> -- status | wake <revision> | sleep <revision> | say <消息>");
}
