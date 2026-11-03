import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, Agent } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteSubjectStore } from "../src/adapters/storage/sqlite-subject.ts";
import { HttpDawnTransport } from "../src/adapters/transport/http-client.ts";
import { startHttpServer } from "../src/adapters/transport/http-server.ts";
import { createTokenFile, readTokenFile } from "../src/adapters/transport/token-file.ts";
import { createInitialState } from "../src/core/state.ts";
import type { ConversationBatch } from "../src/core/conversation-source.ts";
import type { LearningPack } from "../src/core/learning.ts";
import type { HostRequest, HostResponse } from "../src/protocol/host.ts";
import { HostImportService } from "../src/runtime/host-service.ts";
import { SubjectService } from "../src/runtime/subject-service.ts";

const WARNING_FLAG = "--disable-warning=ExperimentalWarning";
const bridgeEntry = fileURLToPath(new URL("../src/host-bridge-main.ts", import.meta.url));
const at = "2026-02-03T04:05:06.000Z";
const pack: LearningPack = { version: 1, id: "synthetic-pack", title: "Synthetic pack", goals: [{ id: "goal", title: "Goal",
  topics: ["synthetic"], material: "Synthetic-only learning material.", practice: [{ id: "practice", prompt: "Practice?", answer: "A" }],
  assessment: [{ id: "assessment", prompt: "Assessment?", answer: "B" }] }] };
const signal = () => new AbortController().signal;
const ownerBatch = (): ConversationBatch => ({ version: 1, batchId: "batch_synthetic_01", sessionId: "session_synthetic_01",
  leafEntryId: "entry_assistant_01", fragments: [
    { entryId: "entry_user_01", parentEntryId: null, textBlockIndex: 0, role: "user", text: "合成用户原文：我喜欢🌅；无需联网。", sourceTimestamp: at },
    { entryId: "entry_assistant_01", parentEntryId: "entry_user_01", textBlockIndex: 0, role: "assistant", text: "合成助手推测，不是用户事实。", sourceTimestamp: at },
  ] });

interface HttpResult { readonly status: number; readonly body: unknown }
function post(endpoint: string, token: string, body: unknown, agent: Agent | false = false, extraHeaders: Record<string, string> = {}): Promise<HttpResult> {
  const port = Number(new URL(endpoint).port);
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: "/host/v1/request", method: "POST", agent,
      headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8",
        "Content-Length": payload.length, ...extraHeaders } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) as unknown : null }); }
        catch { reject(new Error("Invalid synthetic HTTP response")); }
      });
    });
    request.once("error", reject);
    request.end(payload);
  });
}

async function fixture(work: (ctx: {
  dir: string; db: string; ownerToken: string; serviceToken: string; endpoint: string;
  store: SqliteSubjectStore; host: HostImportService; subject: SubjectService; server: Awaited<ReturnType<typeof startHttpServer>>;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dawn-host-import-"));
  const db = join(dir, "synthetic-subject.sqlite");
  const ownerFile = join(dir, "owner-token"); const serviceFile = join(dir, "service-token");
  createTokenFile(ownerFile); createTokenFile(serviceFile);
  const ownerToken = readTokenFile(ownerFile); const serviceToken = readTokenFile(serviceFile);
  const store = SqliteSubjectStore.createHostLearning(db, createInitialState("synthetic-dawn", "Synthetic Dawn", at), 8, pack, 4, signal());
  let subject: SubjectService | undefined;
  let host: HostImportService | undefined;
  let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;
  try {
    await store.changeLifecycle(0, "awake", at, signal());
    subject = new SubjectService(store);
    host = new HostImportService(store, ownerToken);
    server = await startHttpServer({ token: serviceToken, port: 0, handler: (request, requestSignal) => subject!.handle(request, requestSignal), hostService: host });
    await work({ dir, db, ownerToken, serviceToken, endpoint: `http://127.0.0.1:${server.port}`, store, host, subject, server });
  } finally {
    await host?.close();
    await server?.close();
    await subject?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

interface BridgeProcess {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  nextLine(): Promise<HostResponse>;
  exit(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  killAndWait(): Promise<void>;
}
function spawnBridge(endpoint: string, ownerFile: string): BridgeProcess {
  const child = spawn(process.execPath, [WARNING_FLAG, bridgeEntry, "--endpoint", endpoint, "--owner-token-file", ownerFile], { stdio: ["pipe", "pipe", "pipe"] });
  let out = ""; let err = ""; let pending = ""; let ended = false;
  const lines: string[] = []; const waiters: Array<{ resolve(value: string): void; reject(error: Error): void }> = [];
  child.stdout!.setEncoding("utf8").on("data", chunk => {
    out += chunk; pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n"); if (newline < 0) break;
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      const waiter = waiters.shift(); if (waiter) waiter.resolve(line); else lines.push(line);
    }
  });
  child.stdout!.once("close", () => { ended = true; for (const waiter of waiters.splice(0)) waiter.reject(new Error("Bridge stdout closed")); });
  child.stderr!.setEncoding("utf8").on("data", chunk => { err += chunk; });
  const exitPromise = once(child, "close").then(([code, exitSignal]) => ({ code: code as number | null, signal: exitSignal as NodeJS.Signals | null }));
  const bounded = async <T>(promise: Promise<T>, ms = 5000): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Bridge child timed out")), ms); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  return {
    child, stdout: () => out, stderr: () => err,
    async nextLine() {
      const line = lines.shift() ?? await bounded(new Promise<string>((resolve, reject) => {
        if (ended) { reject(new Error("Bridge stdout closed")); return; }
        waiters.push({ resolve, reject });
      }));
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { throw new Error("Bridge emitted invalid JSONL"); }
      return parsed as HostResponse;
    },
    exit: ms => bounded(exitPromise, ms),
    async killAndWait() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await bounded(exitPromise, 5000);
      }
    },
  };
}
function request(type: HostRequest["type"], fields: Record<string, unknown> = {}): HostRequest {
  return { version: 1, requestId: randomUUID(), type, ...fields } as HostRequest;
}
async function bridgeRequest(bridge: BridgeProcess, value: HostRequest): Promise<HostResponse> {
  bridge.child.stdin!.write(`${JSON.stringify(value)}\n`);
  const response = await bridge.nextLine();
  assert.equal(response.requestId, value.requestId);
  return response;
}
async function dawnStatus(endpoint: string, serviceToken: string) {
  return new HttpDawnTransport(endpoint, serviceToken).request({ version: 1, requestId: randomUUID(), type: "status" }, AbortSignal.timeout(5000));
}

test("real host-bridge stdio imports an exact synthetic batch, closes on EOF/SIGTERM, and v4 cold-reopens", { timeout: 30_000 }, async t => {
  await fixture(async ({ dir, db, ownerToken, serviceToken, endpoint, store }) => {
    const ownerFile = join(dir, "owner-token");
    const bridge = spawnBridge(endpoint, ownerFile);
    t.after(() => bridge.killAndWait());
    try {
      const initial = await bridgeRequest(bridge, request("status"));
      assert.equal(initial.type, "status");
      if (initial.type !== "status") throw new Error("Expected private host status");
      assert.equal(initial.subjectId, "synthetic-dawn"); assert.equal(initial.revision, 1); assert.equal(initial.lifecycle, "awake"); assert.equal(initial.supported, true);

      const batch = ownerBatch();
      const authorized = await bridgeRequest(bridge, request("authorize", { batch, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
      assert.equal(authorized.type, "grant");
      if (authorized.type !== "grant") throw new Error("Expected import grant");
      assert.equal(authorized.grant.batchId, batch.batchId); assert.equal(authorized.grant.status, "active");
      const accepted = await bridgeRequest(bridge, request("accept", { batch, grantId: authorized.grant.grantId }));
      assert.equal(accepted.type, "import");
      if (accepted.type !== "import" || !accepted.result) throw new Error("Expected accepted batch");
      assert.deepEqual(accepted.result, { batchId: batch.batchId, status: "accepted", newSources: 0, revision: 1 });
      const consumed = await bridgeRequest(bridge, request("consume", { batchId: batch.batchId, grantId: authorized.grant.grantId }));
      assert.equal(consumed.type, "import");
      if (consumed.type !== "import" || !consumed.result) throw new Error("Expected consumed batch");
      assert.deepEqual(consumed.result, { batchId: batch.batchId, status: "consumed", newSources: 2, revision: 3 });

      bridge.child.stdin!.end();
      assert.deepEqual(await bridge.exit(), { code: 0, signal: null });
      assert.doesNotMatch(bridge.stdout(), new RegExp(`${ownerToken}|executorToken|paired`));
      assert.equal(bridge.stderr(), "");
      const afterEof = await dawnStatus(endpoint, serviceToken);
      assert.equal(afterEof.type, "status");
      if (afterEof.type !== "status") throw new Error("Expected independent Dawn status after EOF");
      assert.equal(afterEof.revision, 3); assert.equal(afterEof.lifecycle, "awake");

      const signalled = spawnBridge(endpoint, ownerFile);
      t.after(() => signalled.killAndWait());
      const signalStatus = await bridgeRequest(signalled, request("status"));
      assert.equal(signalStatus.type, "status");
      signalled.child.kill("SIGTERM");
      const signalExit = await signalled.exit();
      assert.equal(signalExit.code, 1); assert.equal(signalExit.signal, null);
      assert.doesNotMatch(signalled.stdout(), new RegExp(`${ownerToken}|executorToken|paired`));
      assert.doesNotMatch(signalled.stderr(), new RegExp(`${ownerToken}|executorToken|paired`));
      const afterSignal = await dawnStatus(endpoint, serviceToken);
      assert.equal(afterSignal.type, "status");
      if (afterSignal.type !== "status") throw new Error("Expected Dawn status after bridge SIGTERM");
      assert.equal(afterSignal.revision, 3);

      await store.close();
      const cold = SqliteSubjectStore.open(db, signal());
      try {
        const state = await cold.read(signal());
        assert.equal(state.revision, 3); assert.equal(state.lifecycle, "awake");
        assert.deepEqual(state.experiences.map(experience => experience.origin), ["user_statement", "inference"]);
        assert.deepEqual(state.experiences.map(experience => experience.content), batch.fragments.map(fragment => fragment.text));
        assert.equal(state.experiences[0]!.subjectId, state.experiences[1]!.subjectId);
        assert.equal(state.experiences[0]!.scopeId, state.experiences[1]!.scopeId);
        assert.deepEqual(await cold.history(signal()), []);
        assert.deepEqual(await cold.budget(signal()), { limit: 8, reserved: 0, completed: 0, failed: 0, pending: 0 });
        assert.deepEqual(await cold.conversationImportStatus(batch.batchId, authorized.grant.bindingId, signal()), accepted.result && {
          batchId: batch.batchId, status: "consumed", newSources: 2, revision: 3,
        });
      } finally { cold.close(); }
    } finally { await bridge.killAndWait(); }
  });
});

test("ordinary service token cannot pair, executor cannot authorize, closed-socket binding is invalid, and Origin is rejected", { timeout: 15_000 }, async () => {
  await fixture(async ({ ownerToken, serviceToken, endpoint }) => {
    const ordinaryPair = await post(endpoint, serviceToken, request("pair"));
    assert.equal(ordinaryPair.status, 200);
    assert.deepEqual(ordinaryPair.body, { version: 1, requestId: (ordinaryPair.body as { requestId: string }).requestId, type: "error", code: "UNAUTHORIZED" });

    const badOrigin = await post(endpoint, ownerToken, request("pair"), false, { Origin: "http://127.0.0.1" });
    assert.equal(badOrigin.status, 403);
    assert.deepEqual(badOrigin.body, { error: "forbidden" });
    const badHost = await new Promise<HttpResult>((resolve, reject) => {
      const port = Number(new URL(endpoint).port);
      const req = httpRequest({ hostname: "127.0.0.1", port, path: "/host/v1/request", method: "POST", agent: false,
        headers: { Host: "localhost", Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json; charset=utf-8" } }, response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.once("error", reject); response.once("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }));
      });
      req.once("error", reject); req.end(JSON.stringify(request("pair")));
    });
    assert.equal(badHost.status, 403); assert.deepEqual(badHost.body, { error: "forbidden" });

    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const pairedResponse = await post(endpoint, ownerToken, request("pair"), agent);
      assert.equal(pairedResponse.status, 200);
      const paired = pairedResponse.body as HostResponse;
      assert.equal(paired.type, "paired");
      if (paired.type !== "paired") throw new Error("Expected paired host binding");
      const auth = await post(endpoint, paired.executorToken, request("authorize", { batch: ownerBatch(), expiresAt: new Date(Date.now() + 30_000).toISOString() }), agent);
      assert.equal(auth.status, 200);
      assert.deepEqual(auth.body, { version: 1, requestId: (auth.body as { requestId: string }).requestId, type: "error", code: "UNAUTHORIZED" });
      const status = await post(endpoint, paired.executorToken, request("status"), agent);
      assert.equal(status.status, 200); assert.equal((status.body as HostResponse).type, "status");
    } finally { agent.destroy(); }

    // The executor credential is not sufficient on a replacement TCP socket.
    const ownerAgent = new Agent({ keepAlive: true, maxSockets: 1 });
    let executorToken = "";
    try {
      const paired = (await post(endpoint, ownerToken, request("pair"), ownerAgent)).body as HostResponse;
      assert.equal(paired.type, "paired");
      if (paired.type !== "paired") throw new Error("Expected paired host binding");
      executorToken = paired.executorToken;
    } finally { ownerAgent.destroy(); }
    const replacement = await post(endpoint, executorToken, request("status"));
    assert.equal(replacement.status, 200);
    assert.deepEqual(replacement.body, { version: 1, requestId: (replacement.body as { requestId: string }).requestId, type: "error", code: "UNAUTHORIZED" });
  });
});

test("HostHttpClient does not retry or create a replacement socket after an ambiguous failure", { timeout: 15_000 }, async () => {
  const ownerToken = "o".repeat(43);
  let connections = 0; let requests = 0;
  const fake = createServer((incoming, response) => {
    requests += 1;
    incoming.resume(); incoming.once("end", () => {
      // The server may have executed the request, but the client receives no acknowledgement.
      response.destroy();
    });
  });
  fake.on("connection", () => { connections += 1; });
  await new Promise<void>(resolve => fake.listen(0, "127.0.0.1", resolve));
  const address = fake.address();
  if (!address || typeof address === "string") throw new Error("Synthetic server failed to listen");
  const client = new (await import("../src/adapters/transport/host-http-client.ts")).HostHttpClient(`http://127.0.0.1:${address.port}`, ownerToken);
  try {
    await assert.rejects(client.request(request("pair"), AbortSignal.timeout(3000)), error => {
      assert.equal((error as Error).message, "Private host request failed"); return true;
    });
    await assert.rejects(client.request(request("pair"), AbortSignal.timeout(3000)), /Host channel unavailable/);
    assert.equal(requests, 1); assert.equal(connections, 1);
  } finally {
    client.close();
    await new Promise<void>(resolve => fake.close(() => resolve()));
  }
});

test("shape-valid host responses cannot reflect owner or executor secrets into private bridge output", { timeout: 15000 }, async () => {
  for (const mode of ["owner", "executor"]) {
    const dir = mkdtempSync(join(tmpdir(), "dawn-host-reflection-"));
    const ownerFile = join(dir, "owner.token"); createTokenFile(ownerFile);
    const owner = readTokenFile(ownerFile), executor = "e".repeat(43);
    const fake = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
      incoming.once("end", () => {
        const req = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HostRequest;
        const body = JSON.stringify(req.type === "pair"
          ? { version: 1, requestId: req.requestId, type: "paired", bindingId: "binding", executorToken: executor, expiresAt: new Date(Date.now() + 60000).toISOString() }
          : { version: 1, requestId: req.requestId, type: "status", subjectId: mode === "owner" ? owner : executor, scopeId: "owner", revision: 0, lifecycle: "sleeping", supported: true });
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) }); response.end(body);
      });
    });
    await new Promise<void>(resolve => fake.listen(0, "127.0.0.1", resolve));
    const address = fake.address(); assert.ok(address && typeof address !== "string");
    const bridge = spawnBridge(`http://127.0.0.1:${address.port}`, ownerFile);
    try {
      bridge.child.stdin!.write(JSON.stringify(request("status")) + "\n");
      const result = await bridge.exit();
      assert.equal(result.code, 1); assert.equal(bridge.stdout(), "");
      assert.ok(!bridge.stderr().includes(owner) && !bridge.stderr().includes(executor));
      assert.match(bridge.stderr(), /不会重试/);
    } finally {
      await bridge.killAndWait();
      fake.closeAllConnections(); await new Promise<void>(resolve => fake.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
