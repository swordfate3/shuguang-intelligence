import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { startHttpServer } from "../src/adapters/transport/http-server.ts";
import { createTokenFile, readTokenFile } from "../src/adapters/transport/token-file.ts";
import { fileURLToPath } from "node:url";

function capture(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "", stderr = "";
  child.stdout?.setEncoding("utf8").on("data", data => { stdout += data; });
  child.stderr?.setEncoding("utf8").on("data", data => { stderr += data; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
test("standalone request process distinguishes successful response and application failure exit codes", { timeout: 5000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-request-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, "service.token"); createTokenFile(tokenFile);
  const server = await startHttpServer({ token: readTokenFile(tokenFile), port: 0, handler: async request => request.type === "say"
    ? { version: 1, requestId: request.requestId, type: "error", code: "UNAVAILABLE", message: "synthetic failure" }
    : { version: 1, requestId: request.requestId, type: "status", lifecycle: "sleeping", revision: 0,
      runtime: { instanceId: "test", startedAt: "2026-01-01T00:00:00.000Z", autonomy: false } } });
  t.after(() => server.close());
  const args = [entry, "request", "--endpoint", `http://127.0.0.1:${server.port}`, "--token-file", tokenFile, "--"];
  for (const command of [["status"], ["say", "合成消息"]]) {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ...args, ...command], { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    const result = await capture(child);
    assert.equal(result.code, command[0] === "status" ? 0 : 1);
    assert.equal(JSON.parse(result.stdout).type, command[0] === "status" ? "status" : "error");
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /service\.token|Bearer/);
  }
});

test("standalone request SIGTERM propagates cancellation without reporting a late reply", { timeout: 5000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-request-cancel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, "service.token"); createTokenFile(tokenFile);
  let entered!: () => void, aborted!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const server = await startHttpServer({ token: readTokenFile(tokenFile), port: 0, handler: async (request, signal) => {
    entered();
    await new Promise<void>(resolve => {
      if (signal.aborted) { aborted(); resolve(); return; }
      signal.addEventListener("abort", () => { aborted(); resolve(); }, { once: true });
    });
    return { version: 1, requestId: request.requestId, type: "reply", text: "late reply must not print" };
  } });
  t.after(() => server.close());
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", entry, "request", "--endpoint", `http://127.0.0.1:${server.port}`, "--token-file", tokenFile, "--", "say", "合成取消"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const finished = capture(child);
  await started;
  child.kill("SIGTERM");
  const result = await finished;
  await cancelled;
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /未报告成功/);
  assert.doesNotMatch(result.stderr, /service\.token|Bearer|late reply/);
});

test("model configuration command rejects non-interactive/invalid startup without writes or sensitive output", t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-model-config-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "private-model-config.json");
  for (const args of [["model-config", "--output", path], ["model-config", "--output", "relative.json"],
    ["model-config", "--output", path, "--api-key", "synthetic-key-must-not-print"]]) {
    const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", entry, ...args], {
      encoding: "utf8", input: "must-not-consume-piped-input", timeout: 5000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.match(child.stderr, /模型配置未报告成功/);
    assert.doesNotMatch(child.stderr, /synthetic-key|private-model-config|must-not-consume/);
    assert.deepEqual(readdirSync(dir), []);
  }
});

test("invalid serve startup exits safely without creating resources or disclosing paths", t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missingToken = join(dir, "private-secret-name.token");
  const missingDb = join(dir, "private-subject.sqlite");
  const child = spawnSync(process.execPath, [entry, "serve", "--db", missingDb, "--token-file", missingToken, "--port", "0"], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.doesNotMatch(child.stderr, /private-secret-name|private-subject|ENOENT|at runServer/);
  assert.deepEqual(readdirSync(dir), []);
});
