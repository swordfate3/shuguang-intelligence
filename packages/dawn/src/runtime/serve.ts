import { isAbsolute } from "node:path";
import { SqliteStateStore } from "../adapters/storage/sqlite.ts";
import { readTokenFile } from "../adapters/transport/token-file.ts";
import { startHttpServer } from "../adapters/transport/http-server.ts";
import { DawnService } from "./service.ts";
import { loadModel } from "../adapters/models/config.ts";
import { SqliteChatStore } from "../adapters/storage/sqlite-chat.ts";
import { SqliteSubjectStore } from "../adapters/storage/sqlite-subject.ts";
import { SubjectService } from "./subject-service.ts";

/** Foreground process owner. No daemonization, PID files, auto-init or implicit wake/sleep. */
export async function runServer(
  args: readonly string[],
  signal: AbortSignal,
  onReady: (status: { endpoint: string; instanceId: string; modelConnected: boolean }) => void,
): Promise<void> {
  signal.throwIfAborted();
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key || !["--db", "--subject-db", "--token-file", "--port", "--model-config", "--chat-db"].includes(key) || options.has(key) || !value || value.startsWith("--")) {
      throw new Error("Invalid serve options");
    }
    options.set(key, value);
  }
  const subjectPath = options.get("--subject-db");
  const legacyPath = options.get("--db");
  if (Boolean(subjectPath) === Boolean(legacyPath) || (subjectPath && options.has("--chat-db"))) {
    throw new Error("Choose exactly one explicit subject database or legacy database mode");
  }
  const path = subjectPath ?? legacyPath;
  const tokenPath = options.get("--token-file");
  const rawPort = options.get("--port");
  if (!path || !isAbsolute(path) || !tokenPath || !isAbsolute(tokenPath) || !rawPort ||
      !/^(0|[1-9]\d*)$/.test(rawPort) || Number(rawPort) > 65535) throw new Error("Explicit database, token file and valid port required");
  const modelConfig = options.get("--model-config");
  const chatPath = options.get("--chat-db");
  if ((!subjectPath && Boolean(modelConfig) !== Boolean(chatPath)) || (chatPath && (!isAbsolute(chatPath) || chatPath === path))) {
    throw new Error("Model configuration and separate absolute chat database must be provided together");
  }
  const model = modelConfig ? loadModel(modelConfig) : undefined;
  const token = readTokenFile(tokenPath);
  const store = subjectPath ? SqliteSubjectStore.open(path, signal) : SqliteStateStore.open(path, signal);
  let chat: SqliteChatStore | undefined;
  let service: DawnService | SubjectService | undefined;
  let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;
  try {
    if (chatPath) chat = SqliteChatStore.open(chatPath, (await store.read(signal)).self.identity.id, signal);
    const activeService = store instanceof SqliteSubjectStore
      ? new SubjectService(store, model)
      : new DawnService(store, undefined, model, chat);
    service = activeService;
    server = await startHttpServer({ token, port: Number(rawPort), handler: (request, requestSignal) => activeService.handle(request, requestSignal) });
    signal.throwIfAborted();
    onReady({ endpoint: `http://127.0.0.1:${server.port}`, instanceId: activeService.instanceId, modelConnected: model !== undefined });
    await new Promise<void>(resolve => {
      if (signal.aborted) { resolve(); return; }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    try { await server?.close(); }
    finally {
      try { await service?.close(); }
      finally {
        try { chat?.close(); }
        finally { store.close(); }
      }
    }
  }
}
