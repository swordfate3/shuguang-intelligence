import { HttpDawnTransport } from "../../dawn/src/adapters/transport/http-client.ts";
import { readTokenFile } from "../../dawn/src/adapters/transport/token-file.ts";
import { HTTP_HELP, parseHttpMcpOptions } from "./http-config.ts";
import { startHttpMcpServer, type HttpMcpServer } from "./http-server.ts";

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stderr.write(HTTP_HELP);
} else {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let server: HttpMcpServer | undefined;
  try {
    const options = parseHttpMcpOptions(args);
    const serviceToken = readTokenFile(options.tokenFile);
    const authToken = readTokenFile(options.authTokenFile);
    // Owner token is deliberately never discovered/read. Operators must provision the remote
    // token independently of that private channel too; this process can only compare known tokens.
    server = await startHttpMcpServer({ transport: new HttpDawnTransport(options.endpoint, serviceToken),
      serviceToken, authToken, publicUrl: options.publicUrl, host: options.host, port: options.port,
      allowWrite: options.allowWrite, signal: controller.signal });
    await server.done;
  } catch {
    if (!controller.signal.aborted) {
      process.stderr.write("Shuguang MCP HTTP failed: check explicit arguments, independent private tokens, TLS proxy and listener. No automatic retry or recovery.\n");
      process.exitCode = 1;
    }
  } finally {
    await server?.close();
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}
