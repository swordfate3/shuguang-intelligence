import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { startHttpServer } from "../src/adapters/transport/http-server.ts";
import type { DawnRequest, DawnResponse } from "../src/protocol/index.ts";
import { runRequestCli } from "../src/runtime/request-cli.ts";

const token = "r".repeat(43);
const signal = () => AbortSignal.timeout(2_000);
const statusResponse = (requestId: string): DawnResponse => ({
  version: 1, requestId, type: "status", lifecycle: "awake", revision: 7,
  runtime: { instanceId: "test-instance", startedAt: "2026-01-01T00:00:00.000Z", autonomy: false },
});

async function fixture(t: TestContext, handler: (request: DawnRequest) => DawnResponse) {
  const directory = mkdtempSync(join(tmpdir(), "dawn-request-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, "token");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const server = await startHttpServer({ token, port: 0, handler: async request => handler(request) });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.port}`;
  const args = (...command: string[]) => ["request", "--endpoint", endpoint, "--token-file", tokenFile, "--", ...command];
  return { args, tokenFile, endpoint };
}

test("status and lifecycle requests use the authenticated local service", async t => {
  const received: DawnRequest[] = [];
  const { args } = await fixture(t, request => {
    received.push(request);
    return statusResponse(request.requestId);
  });

  const status = await runRequestCli(args("status"), signal());
  const wake = await runRequestCli(args("wake", "6"), signal());
  assert.equal(status.type, "status");
  assert.equal(wake.type, "status");
  assert.deepEqual(received.map(request => request.type), ["status", "wake"]);
  assert.equal(received[1]?.type === "wake" ? received[1].expectedRevision : -1, 6);
});

test("say sends exactly its one argument, preserving all text", async t => {
  const message = "  exact quoted text, including spaces and punctuation!  ";
  let received: DawnRequest | undefined;
  const { args } = await fixture(t, request => {
    received = request;
    return { version: 1, requestId: request.requestId, type: "reply", text: "received" };
  });

  const response = await runRequestCli(args("say", message), signal());
  assert.equal(response.type, "reply");
  assert.equal(received?.type, "say");
  assert.equal(received?.type === "say" ? received.text : undefined, message);
  await assert.rejects(runRequestCli(args("say", "two", "arguments"), signal()));
});

test("valid application error envelopes are returned, not reported as success", async t => {
  const { args } = await fixture(t, request => ({
    version: 1, requestId: request.requestId, type: "error", code: "CONFLICT", message: "revision conflict",
  }));
  const response = await runRequestCli(args("wake", "7"), signal());
  assert.equal(response.type, "error");
  if (response.type === "error") assert.equal(response.code, "CONFLICT");
});

test("bad flags, missing config and invalid commands fail before credentials or network", async t => {
  const { args, endpoint } = await fixture(t, request => statusResponse(request.requestId));
  const base = args("status");
  const tokenFile = base[4]!;
  const missingToken = join(tmpdir(), "dawn-request-cli-missing-token");

  await assert.rejects(runRequestCli(["request", "--endpoint", endpoint, "--", "status"], signal()));
  await assert.rejects(runRequestCli(["request", "--endpoint", endpoint, "--token-file", missingToken, "--", "wake", "1.5"], signal()), /用法/);
  await assert.rejects(runRequestCli(["request", "--endpoint", endpoint, "--token-file", missingToken, "--", "status", "extra"], signal()), /用法/);
  await assert.rejects(runRequestCli(["request", "--unknown", "x", "--endpoint", endpoint, "--token-file", tokenFile, "--", "status"], signal()), /用法/);
  await assert.rejects(runRequestCli(["request", "--endpoint", endpoint, "--endpoint", endpoint, "--token-file", tokenFile, "--", "status"], signal()), /用法/);
  await assert.rejects(runRequestCli(["request", "--endpoint", endpoint, "--token-file", tokenFile, "--token-file", tokenFile, "--", "status"], signal()), /用法/);
  await assert.rejects(runRequestCli(["request", "--endpoint", "http://localhost:7341", "--token-file", missingToken, "--", "status"] , signal()), /Invalid Dawn endpoint/);
  await assert.rejects(runRequestCli(["request", "--endpoint", endpoint, "--token-file", missingToken, "--", "status"], signal()));
});

test("valid request to an unavailable service fails rather than returning success", async t => {
  const directory = mkdtempSync(join(tmpdir(), "dawn-request-cli-down-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, "token");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const server = await startHttpServer({ token, port: 0, handler: async request => statusResponse(request.requestId) });
  const endpoint = `http://127.0.0.1:${server.port}`;
  await server.close();
  await assert.rejects(runRequestCli(["request", "--endpoint", endpoint, "--token-file", tokenFile, "--", "status"], signal()));
});

test("already-cancelled request does not read credentials or connect", async t => {
  const { endpoint } = await fixture(t, request => statusResponse(request.requestId));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runRequestCli(["request", "--endpoint", endpoint, "--token-file", "/missing/private/token", "--", "status"], controller.signal), { name: "AbortError" });
});
