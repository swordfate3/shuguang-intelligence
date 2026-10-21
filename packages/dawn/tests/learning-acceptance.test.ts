import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = resolve(project, "scripts/learning-acceptance.ts");
const WARNING_FLAG = "--disable-warning=ExperimentalWarning";
const PARENT_DEADLINE_MS = 35_000;
const CHILD_GRACE_MS = 5_000;

test("offline learning acceptance runs as a safe CLI and cleans all temporary data before reporting passed", { timeout: 55_000 }, async () => {
  const ownedTmpRoot = mkdtempSync(resolve(tmpdir(), "dawn-learning-acceptance-test-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(process.execPath, [WARNING_FLAG, script], {
      cwd: project, env: { ...process.env, TMPDIR: ownedTmpRoot }, stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await capture(child, PARENT_DEADLINE_MS);
    assert.equal(result.timedOut, false, "offline learning acceptance exceeded its parent deadline");
    assert.equal(result.code, 0, "offline learning acceptance CLI must pass");
    assert.equal(result.stderr.trim(), "", "ExperimentalWarning is silenced; other stderr indicates a failure");
    assert.equal(result.stdout.trim(), JSON.stringify(JSON.parse(result.stdout.trim())), "CLI must emit one JSON summary line");
    const report = JSON.parse(result.stdout.trim()) as {
      mode: unknown; upstream: unknown; dryrun: unknown; status: unknown; calls: unknown; goals: unknown;
      checks: { name: string; stage: string; status: string; count: number }[];
      stages: { stage: string; status: string }[];
      cleanup: { temporaryFilesRemoved: boolean; environmentChanged: boolean; completedBeforeReport: boolean };
      claim: string;
    };
    assert.equal(report.mode, "offline");
    assert.equal(report.upstream, "fake");
    assert.equal(report.dryrun, true);
    assert.equal(report.status, "passed");
    assert.equal(report.calls, 4);
    assert.equal(report.goals, 2);
    assert.match(report.claim, /not evidence of real learning effectiveness/u);
    assert.deepEqual(report.stages.map(stage => stage.stage), ["setup", "model-boundary", "learning-persistence", "restart-and-stop", "rerun-and-stop"]);
    assert.ok(report.stages.every(stage => stage.status === "passed"));
    assert.ok(report.checks.length >= 10);
    assert.ok(report.checks.every(check => check.status === "passed" && Number.isSafeInteger(check.count) && check.count > 0));
    assert.deepEqual(report.cleanup, { temporaryFilesRemoved: true, environmentChanged: false, completedBeforeReport: true });
    assert.doesNotMatch(result.stdout, /PRIVATE_ANSWER_KEY_|synthetic-offline-token|MOVE|WAIT|LUMI|VELA|\/tmp\//u);
    assert.deepEqual(readdirSync(ownedTmpRoot), [], "script must remove its fixture directory before passing");
  } finally {
    if (child) await ensureClosed(child);
    rmSync(ownedTmpRoot, { recursive: true, force: true });
  }
});

test("fake upstream failure and abort paths clean SQLite and server fixtures", { timeout: 55_000 }, async () => {
  const ownedTmpRoot = mkdtempSync(resolve(tmpdir(), "dawn-learning-failure-test-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const moduleUrl = pathToFileURL(script).href;
    const program = `
      import { readdirSync } from "node:fs";
      import { runLearningAcceptance } from ${JSON.stringify(moduleUrl)};
      const root = ${JSON.stringify(ownedTmpRoot)};
      for (const options of [{ failFakeCall: 2 }, { abortFakeCall: 1 }]) {
        let rejected = false;
        try { await runLearningAcceptance({ temporaryRoot: root, ...options }); }
        catch (error) {
          rejected = true;
          if (!(error instanceof Error) || error.message !== "Offline learning acceptance failed.") process.exitCode = 2;
        }
        if (!rejected || readdirSync(root).length !== 0) process.exitCode = 3;
      }
      if (process.exitCode === undefined) console.log("failure-path-cleanup-ok");
    `;
    child = spawn(process.execPath, [WARNING_FLAG, "--input-type=module", "-e", program], {
      cwd: project, stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await capture(child, PARENT_DEADLINE_MS);
    assert.equal(result.timedOut, false, "failure/abort subprocess exceeded the parent deadline");
    assert.equal(result.code, 0, "fake failure and abort both reject safely and clean up");
    assert.equal(result.stdout.trim(), "failure-path-cleanup-ok");
    assert.equal(result.stderr.trim(), "");
    assert.deepEqual(readdirSync(ownedTmpRoot), [], "no child fixture may remain after failure/abort");
  } finally {
    if (child) await ensureClosed(child);
    rmSync(ownedTmpRoot, { recursive: true, force: true });
  }
});

test("CLI cancellation after delayed readiness handling exits without a late success and removes its owned files", { timeout: 55_000 }, async () => {
  const root = mkdtempSync(resolve(tmpdir(), "dawn-learning-signal-test-"));
  let child: ReturnType<typeof spawn> | undefined;
  let delayedSignal: ReturnType<typeof setTimeout> | undefined;
  try {
    child = spawn(process.execPath, [WARNING_FLAG, script], {
      cwd: project, env: { ...process.env, TMPDIR: root }, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let ready = false;
    child.on("message", message => {
      if (message && typeof message === "object" && "type" in message && message.type === "fixture-ready") {
        ready = true;
        // Deliberately delay the parent: the IPC barrier, not this timing, must
        // prevent the child from finishing and printing success before SIGTERM.
        delayedSignal = setTimeout(() => child!.kill("SIGTERM"), 500);
      }
    });
    const result = await capture(child, PARENT_DEADLINE_MS);
    assert.equal(ready, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.trim(), "");
    assert.equal(result.stderr.trim(), "Offline learning acceptance failed.");
    assert.deepEqual(readdirSync(root), []);
  } finally {
    clearTimeout(delayedSignal);
    if (child) await ensureClosed(child);
    rmSync(root, { recursive: true, force: true });
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
  assert.ok(child.stdout && child.stderr);
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const closed = waitClosed(child);
  let escalation: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), CHILD_GRACE_MS);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const graceful = await Promise.race([closed.then(() => true), new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), CHILD_GRACE_MS);
      })]);
      if (!graceful) { child.kill("SIGKILL"); await closed; }
    } finally { clearTimeout(timer); }
  }
}
