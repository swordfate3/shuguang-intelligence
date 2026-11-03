import { HostHttpClient } from "./adapters/transport/host-http-client.ts";
import { parseDawnEndpoint } from "./adapters/transport/http-client.ts";
import { readTokenFile } from "./adapters/transport/token-file.ts";
import { serveHostBridge } from "./runtime/host-bridge.ts";
import { isAbsolute } from "node:path";

const controller = new AbortController();
const stop = (): void => controller.abort();
process.once("SIGINT", stop); process.once("SIGTERM", stop);
try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--endpoint" || args[2] !== "--owner-token-file" || !args[1] || !args[3] || !isAbsolute(args[3])) throw new Error("Invalid bridge options");
  parseDawnEndpoint(args[1]); // Validate all args before reading the explicit private credential.
  const client = new HostHttpClient(args[1], readTokenFile(args[3]));
  try { await serveHostBridge(process.stdin, process.stdout, client, controller.signal); }
  finally { client.close(); }
} catch {
  console.error("私有宿主桥已关闭或未完成请求；不会重试、初始化或停止曙光服务。");
  process.exitCode = 1;
} finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
