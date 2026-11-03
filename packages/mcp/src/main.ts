import { HttpDawnTransport } from "../../dawn/src/adapters/transport/http-client.ts";
import { readTokenFile } from "../../dawn/src/adapters/transport/token-file.ts";
import { HELP, parseMcpOptions } from "./config.ts";
import { serveStdio } from "./server.ts";

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  // Even help stays off the protocol channel.
  process.stderr.write(HELP);
} else {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const options = parseMcpOptions(args);
    const transport = new HttpDawnTransport(options.endpoint, readTokenFile(options.tokenFile));
    await serveStdio({ input: process.stdin, output: process.stdout, transport,
      allowWrite: options.allowWrite, signal: controller.signal });
  } catch {
    process.stderr.write("Shuguang MCP failed: check explicit arguments, private token, service and protocol. No automatic retry or recovery.\n");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
