import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../packages/dawn/src/runtime/cli.ts";
import { runServer } from "../packages/dawn/src/runtime/serve.ts";
import { SqliteSubjectStore } from "../packages/dawn/src/adapters/storage/sqlite-subject.ts";
import { createTokenFile, readTokenFile } from "../packages/dawn/src/adapters/transport/token-file.ts";
import { HttpDawnTransport } from "../packages/dawn/src/adapters/transport/http-client.ts";
import { APP_VERSION } from "../packages/dawn/src/runtime/version.ts";
import type { DawnRequest, DawnResponse } from "../packages/dawn/src/protocol/index.ts";

const DEADLINE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
const checks: { name: string; count: number }[] = [];
const signal = (deadline: AbortSignal): AbortSignal => AbortSignal.any([deadline, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);

function recordCheck(name: string, count: number): void {
  assert.ok(Number.isSafeInteger(count) && count > 0);
  checks.push({ name, count });
}

async function readBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 64 * 1024) throw new Error("request too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
}

async function withinDeadline<T>(work: Promise<T>, deadline: AbortSignal): Promise<T> {
  if (deadline.aborted) throw new Error("acceptance deadline exceeded");
  let onAbort!: () => void;
  const expired = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("acceptance deadline exceeded"));
    deadline.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([work, expired]); }
  finally { deadline.removeEventListener("abort", onAbort); }
}

async function listen(server: Server, deadline: AbortSignal): Promise<number> {
  await withinDeadline(new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  }), deadline);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("invalid loopback listener");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function rejectBadToken(port: number, request: DawnRequest, wrongToken: string, deadline: AbortSignal): Promise<number> {
  const body = Buffer.from(JSON.stringify(request), "utf8");
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, method: "POST", path: "/v1/request",
      signal: signal(deadline), agent: false,
      headers: { Authorization: `Bearer ${wrongToken}`, Host: `127.0.0.1:${port}`,
        "Content-Type": "application/json; charset=utf-8", "Content-Length": body.byteLength, Connection: "close" },
    }, response => {
      const status = response.statusCode ?? 0;
      response.resume();
      response.once("end", () => resolve(status));
      response.once("error", reject);
    });
    req.once("error", reject);
    req.end(body);
  });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "shuguang-acceptance-"));
  const db = join(dir, "subject.sqlite");
  const config = join(dir, "model.json");
  const tokenPath = join(dir, "service.token");
  const credentialEnv = `DAWN_ACCEPTANCE_FIXTURE_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const hadCredential = Object.hasOwn(process.env, credentialEnv);
  const previousCredential = process.env[credentialEnv];
  const deadlineController = new AbortController();
  const onInterrupt = () => deadlineController.abort();
  process.once("SIGTERM", onInterrupt);
  process.once("SIGINT", onInterrupt);
  const deadlineTimer = setTimeout(() => deadlineController.abort(), DEADLINE_MS);
  let upstream: Server | undefined;
  let activeServer: Awaited<ReturnType<typeof startSubjectServer>> | undefined;
  let credentialChanged = false;
  const modelCalls: { messages: { role: string; content: string }[]; max_tokens: number }[] = [];

  async function startSubjectServer(): Promise<{ transport: HttpDawnTransport; port: number; stop(): Promise<void> }> {
    const controller = new AbortController();
    const stopOnDeadline = () => controller.abort();
    deadlineController.signal.addEventListener("abort", stopOnDeadline, { once: true });
    let readyResolve!: (endpoint: string) => void;
    let readyReject!: (error: Error) => void;
    let ready = false;
    const endpoint = new Promise<string>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const running = runServer(["--subject-db", db, "--token-file", tokenPath, "--port", "0", "--model-config", config],
      controller.signal, info => { ready = true; readyResolve(info.endpoint); });
    void running.then(() => { if (!ready) readyReject(new Error("server stopped before ready")); }, readyReject);
    try {
      const url = await withinDeadline(endpoint, deadlineController.signal);
      const port = Number(new URL(url).port);
      return { transport: new HttpDawnTransport(url, readTokenFile(tokenPath)), port,
        stop: async () => {
          controller.abort();
          deadlineController.signal.removeEventListener("abort", stopOnDeadline);
          await running;
        } };
    } catch (error) {
      controller.abort();
      deadlineController.signal.removeEventListener("abort", stopOnDeadline);
      await running.catch(() => undefined);
      throw error;
    }
  }

  async function request(transport: HttpDawnTransport, value: DawnRequest): Promise<DawnResponse> {
    return transport.request(value, signal(deadlineController.signal));
  }

  try {
    // This unique synthetic credential is the only environment value read by the model adapter.
    process.env[credentialEnv] = "synthetic-local-acceptance-key";
    credentialChanged = true;

    upstream = createServer((incoming, response) => {
      void (async () => {
        try {
          const value = await readBody(incoming) as { messages?: { role: string; content: string }[]; max_tokens?: number };
          assert.ok(Array.isArray(value.messages));
          assert.equal(value.max_tokens, 1024);
          const messages = value.messages!;
          const context = JSON.parse(messages[1]!.content) as {
            current: { experienceId: string; at: string };
            projection: { concerns: { id: string }[] };
          };
          const first = modelCalls.length === 0;
          modelCalls.push({ messages, max_tokens: value.max_tokens! });
          const content = JSON.stringify(first ? {
            reply: "好的，我会优先用循序渐进的方式解释理解问题。",
            appraisal: { evidenceIds: [context.current.experienceId], concernId: "understanding", desirability: 0.6,
              expectedness: 0.5, controllability: 0.7, intensity: 0.8 },
            candidates: [{ type: "world_belief", belief: { id: "fixture_preference_belief",
              statement: "用户偏好循序渐进地理解问题", origin: "user_statement",
              evidenceIds: [context.current.experienceId], confidence: 0.7, status: "tentative",
              supersedesIds: [], updatedAt: context.current.at } }],
          } : { reply: "我们继续循序渐进地理解问题。", appraisal: null, candidates: [] });
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
            usage: { prompt_tokens: 31, completion_tokens: 19 } }));
        } catch {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end("{}");
        }
      })();
    });
    upstream.headersTimeout = REQUEST_TIMEOUT_MS;
    upstream.requestTimeout = REQUEST_TIMEOUT_MS;
    const upstreamPort = await listen(upstream, deadlineController.signal);

    writeFileSync(config, JSON.stringify({ baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, model: "synthetic-local",
      credentialEnv, maxCalls: 10, timeoutMs: 4_000, reasoningEffort: "low" }), { mode: 0o600 });
    const initialized = await runCli(["subject-init", "--db", db, "--id", "acceptance_fixture", "--name", "合成主体", "--limit", "2"],
      signal(deadlineController.signal)) as { schemaVersion: number; revision: number; lifecycle: string };
    assert.equal(initialized.schemaVersion, 2);
    assert.equal(initialized.revision, 0);
    const awake = (await runCli(["subject-wake", "--db", db, "--revision", "0"], signal(deadlineController.signal))) as { revision: number; lifecycle: string };
    assert.equal(awake.revision, 1);
    assert.equal(awake.lifecycle, "awake");
    recordCheck("subject-cli-init-wake", 2);

    createTokenFile(tokenPath);
    const authToken = readTokenFile(tokenPath);
    let server = await startSubjectServer();
    activeServer = server;
    // Test harness readiness only; never writes to stdout or exposes fixture data.
    if (process.send) process.send({ type: "fixture-ready" });
    const cliEndpoint = `http://127.0.0.1:${server.port}`;
    const cliStatus = await runCli(["request", "--endpoint", cliEndpoint, "--token-file", tokenPath, "--", "status"],
      signal(deadlineController.signal)) as DawnResponse;
    assert.equal(cliStatus.type, "status");
    if (cliStatus.type === "status") { assert.equal(cliStatus.lifecycle, "awake"); assert.equal(cliStatus.revision, 1); }
    const badToken = `${authToken[0] === "A" ? "B" : "A"}${authToken.slice(1)}`;
    assert.equal(await rejectBadToken(server.port, { version: 1, type: "status", requestId: "bad_token" }, badToken,
      deadlineController.signal), 401);
    const firstResponse = await runCli(["request", "--endpoint", cliEndpoint, "--token-file", tokenPath, "--", "say",
      "合成偏好：请用循序渐进的方式解释如何理解问题。"], signal(deadlineController.signal)) as DawnResponse;
    assert.equal(firstResponse.type, "reply");
    if (firstResponse.type === "reply") assert.equal(firstResponse.text, "好的，我会优先用循序渐进的方式解释理解问题。");
    assert.equal(modelCalls.length, 1);
    recordCheck("authenticated-loopback-http", 2);
    recordCheck("request-cli-status-and-say", 2);

    await server.stop();
    activeServer = undefined;
    const firstStore = SqliteSubjectStore.open(db, signal(deadlineController.signal));
    let firstState;
    try {
      firstState = await firstStore.read(signal(deadlineController.signal));
      assert.equal(firstState.revision, 3);
      assert.equal(firstState.experiences.length, 2);
      assert.equal(firstState.memory.records.length, 2);
      assert.deepEqual(firstState.experiences.map(item => item.origin), ["user_statement", "inference"]);
      assert.deepEqual(firstState.memory.records.map(item => item.origin), ["user_statement", "inference"]);
      assert.deepEqual(firstState.memory.records.map(item => item.sourceIds[0]), firstState.experiences.map(item => item.id));
      assert.equal(firstState.cognition.beliefs.length, 1);
      assert.equal(firstState.cognition.beliefs[0]!.status, "tentative");
      assert.ok(firstState.affect.valence > 0);
    } finally { firstStore.close(); }
    recordCheck("first-turn-state-provenance", 8);

    // Reopening verifies the complete persisted snapshot, not a partial diagnostic projection.
    const reopened = SqliteSubjectStore.open(db, signal(deadlineController.signal));
    try { assert.deepEqual(await reopened.read(signal(deadlineController.signal)), firstState); }
    finally { reopened.close(); }
    recordCheck("exact-state-reopen", 1);

    server = await startSubjectServer();
    activeServer = server;
    const sleeping = await request(server.transport, { version: 1, type: "sleep", requestId: "sleep_control", expectedRevision: 3 });
    assert.equal(sleeping.type, "status");
    if (sleeping.type === "status") { assert.equal(sleeping.lifecycle, "sleeping"); assert.equal(sleeping.revision, 4); }
    const blocked = await request(server.transport, { version: 1, type: "say", requestId: "sleeping_say",
      text: "睡眠时这条请求不能触发模型。" });
    assert.equal(blocked.type, "error");
    assert.equal(modelCalls.length, 1);
    const awakeAgain = await request(server.transport, { version: 1, type: "wake", requestId: "wake_control", expectedRevision: 4 });
    assert.equal(awakeAgain.type, "status");
    if (awakeAgain.type === "status") { assert.equal(awakeAgain.lifecycle, "awake"); assert.equal(awakeAgain.revision, 5); }
    recordCheck("wire-lifecycle-and-sleep-gate", 5);

    const secondResponse = await request(server.transport, { version: 1, type: "say", requestId: "second_turn",
      text: "请继续循序渐进地解释理解问题。" });
    assert.equal(secondResponse.type, "reply");
    assert.equal(modelCalls.length, 2);
    const secondMessages = modelCalls[1]!.messages;
    assert.ok(secondMessages.some(message => message.role === "user" &&
      message.content === "合成偏好：请用循序渐进的方式解释如何理解问题。"));
    assert.ok(secondMessages.some(message => message.role === "assistant" &&
      message.content === "好的，我会优先用循序渐进的方式解释理解问题。"));
    const secondContext = JSON.parse(secondMessages[1]!.content) as { projection: {
      memories: unknown[]; beliefs: { id: string; status: string }[]; affect: { valence: number };
    } };
    assert.ok(secondContext.projection.memories.length > 0);
    assert.ok(secondContext.projection.beliefs.some(belief => belief.id === "fixture_preference_belief" && belief.status === "tentative"));
    assert.ok(secondContext.projection.affect.valence > 0);
    recordCheck("second-turn-history-memory-belief-affect", 5);

    await server.stop();
    activeServer = undefined;
    const afterSecond = SqliteSubjectStore.open(db, signal(deadlineController.signal));
    let secondState;
    try {
      secondState = await afterSecond.read(signal(deadlineController.signal));
      assert.equal(secondState.revision, 7);
      assert.equal(secondState.experiences.length, 4);
      assert.equal(secondState.memory.records.length, 4);
    } finally { afterSecond.close(); }

    // The service is restarted after consuming the full lifetime quota.
    server = await startSubjectServer();
    activeServer = server;
    const acrossServerRestart = SqliteSubjectStore.open(db, signal(deadlineController.signal));
    try { assert.deepEqual(await acrossServerRestart.read(signal(deadlineController.signal)), secondState); }
    finally { acrossServerRestart.close(); }
    const overBudget = await request(server.transport, { version: 1, type: "say", requestId: "over_budget",
      text: "额度耗尽后不应再次调用模型。" });
    assert.equal(overBudget.type, "error");
    assert.equal(modelCalls.length, 2);
    const budget = await runCli(["subject-budget", "--db", db], signal(deadlineController.signal)) as {
      budget: { limit: number; reserved: number; completed: number; failed: number; pending: number }; autonomy: boolean;
    };
    assert.deepEqual(budget, { budget: { limit: 2, reserved: 2, completed: 2, failed: 0, pending: 0 }, autonomy: false });
    recordCheck("restart-persistent-call-budget", 5);

    const safeBudgetOutput = JSON.stringify(budget);
    assert.doesNotMatch(safeBudgetOutput, /循序渐进|合成偏好|理解问题|fixture_preference_belief/);
    assert.equal(Object.keys(budget).sort().join(","), "autonomy,budget");
    recordCheck("budget-cli-privacy", 2);

    await server.stop();
    activeServer = undefined;
    assert.equal(modelCalls.length, 2);
  } finally {
    deadlineController.abort();
    process.removeListener("SIGTERM", onInterrupt);
    process.removeListener("SIGINT", onInterrupt);
    let cleanupFailed = false;
    if (activeServer) {
      try { await activeServer.stop(); } catch { cleanupFailed = true; }
    }
    if (upstream) {
      try { await closeServer(upstream); } catch { cleanupFailed = true; }
    }
    if (credentialChanged) {
      try {
        if (hadCredential) process.env[credentialEnv] = previousCredential!;
        else delete process.env[credentialEnv];
      } catch { cleanupFailed = true; }
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    clearTimeout(deadlineTimer);
    if (cleanupFailed) throw new Error("acceptance cleanup failed");
  }
  console.log(JSON.stringify({ version: APP_VERSION, status: "passed", checks }));
}

void main().catch(() => {
  console.error("Acceptance failed (details omitted).");
  process.exitCode = 1;
});
