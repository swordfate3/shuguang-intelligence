import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { APP_VERSION } from "../src/runtime/version.ts";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const versionPaths = [resolve(project, "package.json"), resolve(project, "packages/dawn/package.json"),
  resolve(project, "packages/pi-extension/package.json")];
const WARNING_FLAG = "--disable-warning=ExperimentalWarning";
const script = resolve(project, "scripts/acceptance.ts");

test("0.1.0 offline acceptance release gate", { timeout: 50_000 }, async () => {
  const versions = versionPaths.map(path => (JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version);
  assert.deepEqual(versions, ["0.1.0", "0.1.0", "0.1.0"]);
  assert.equal(APP_VERSION, "0.1.0");

  const syntax = spawn(process.execPath, [WARNING_FLAG, "--check", script], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
  const syntaxResult = await capture(syntax, 5_000);
  assert.equal(syntaxResult.timedOut, false, "acceptance syntax check must finish promptly");
  assert.equal(syntaxResult.code, 0, "acceptance script syntax check must pass");
  assert.equal(syntaxResult.stderr.trim(), "");

  const tempRoot = mkdtempSync(join(tmpdir(), "shuguang-release-acceptance-"));
  let run: ReturnType<typeof spawn> | undefined;
  try {
    run = spawn(process.execPath, [WARNING_FLAG, script], {
      cwd: project, env: { ...process.env, TMPDIR: tempRoot }, stdio: ["ignore", "pipe", "pipe"],
    });
    const runResult = await capture(run, 35_000);
    assert.equal(runResult.timedOut, false, "offline acceptance script exceeded its bounded runtime");
    assert.equal(runResult.code, 0, "offline acceptance script must pass");
    // ExperimentalWarning is silenced with a Node flag; every other stderr remains a failure.
    assert.equal(runResult.stderr.trim(), "");
    const report = JSON.parse(runResult.stdout) as { version: unknown; status: unknown; checks: unknown };
    assert.equal(report.version, "0.1.0");
    assert.equal(report.status, "passed");
    assert.ok(Array.isArray(report.checks) && report.checks.length >= 8 && report.checks.length <= 10);
    const names = new Set<string>();
    for (const item of report.checks) {
      assert.ok(item && typeof item === "object" && !Array.isArray(item));
      const check = item as { name?: unknown; count?: unknown };
      assert.equal(typeof check.name, "string");
      assert.ok(/^[a-z][a-z0-9-]{0,63}$/.test(check.name as string));
      assert.ok(!names.has(check.name as string), "check names must be unique");
      names.add(check.name as string);
      assert.ok(Number.isSafeInteger(check.count) && (check.count as number) > 0);
    }
    assert.deepEqual([...names].sort(), ["authenticated-loopback-http", "budget-cli-privacy", "exact-state-reopen",
      "first-turn-state-provenance", "request-cli-status-and-say", "restart-persistent-call-budget",
      "second-turn-history-memory-belief-affect", "subject-cli-init-wake", "wire-lifecycle-and-sleep-gate"].sort());
    assert.equal(runResult.stdout.trim(), JSON.stringify(report), "report must be one canonical JSON line");
    assert.doesNotMatch(runResult.stdout, /\/tmp\/|service\.token|synthetic-local-acceptance-key|DAWN_ACCEPTANCE_FIXTURE_/);
    assert.deepEqual(readdirSync(tempRoot), [], "acceptance fixture files must be cleaned before exit");
  } finally {
    if (run) await ensureClosed(run);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("acceptance SIGTERM performs cleanup without a passed report", { timeout: 20_000 }, async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "shuguang-release-interrupt-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(process.execPath, [WARNING_FLAG, script], {
      cwd: project, env: { ...process.env, TMPDIR: tempRoot }, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    await waitFixtureReady(child, 10_000);
    child.kill("SIGTERM");
    const result = await capture(child, 10_000);
    assert.equal(result.timedOut, false, "interrupted acceptance should clean up within the grace period");
    assert.notEqual(result.code, 0, "interruption must not report success");
    assert.doesNotMatch(result.stdout, /"status":"passed"/);
    assert.deepEqual(readdirSync(tempRoot), [], "interrupted child must clean all fixture data before exit");
  } finally {
    if (child) await ensureClosed(child);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

interface CapturedProcess {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

async function capture(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<CapturedProcess> {
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  assert.ok(stdoutStream && stderrStream, "spawn must provide captured stdout and stderr");
  stdoutStream.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  stderrStream.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const closed = waitClosed(child);
  let escalation: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), 5_000);
  }, timeoutMs);
  try {
    const code = await closed;
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    await ensureClosed(child);
  }
}

function waitClosed(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise(resolve => child.once("close", resolve));
}

async function ensureClosed(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const closed = waitClosed(child);
    const graceful = await Promise.race([closed.then(() => true), delay(5_000).then(() => false)]);
    if (!graceful) {
      child.kill("SIGKILL");
      await closed;
    }
  }
}

async function waitFixtureReady(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  assert.ok(child.stdout && child.stderr && child.channel, "acceptance child must use captured stdio and IPC");
  const closed = waitClosed(child);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        child.once("message", value => {
          if (value && typeof value === "object" && (value as { type?: unknown }).type === "fixture-ready") resolve();
          else reject(new Error("Unexpected acceptance readiness message"));
        });
        child.once("error", reject);
        child.once("close", () => reject(new Error("Acceptance child exited before readiness")));
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Acceptance child readiness timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // Keep the close observer attached so readiness failure cleanup can await the real child exit.
    void closed.catch(() => undefined);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
