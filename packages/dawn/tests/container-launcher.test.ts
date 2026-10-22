import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve(import.meta.dirname, "../../../start.sh");
// A fake Docker executable records argv; no real engine, volumes, model or service is touched.
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "dawn-launcher-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin"); mkdirSync(bin);
  const log = join(dir, "docker.jsonl");
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env node
const fs=require('node:fs');const a=process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='info')process.exit(process.env.TEST_NO_ENGINE==='1'?1:0);
if(a[0]==='image')process.exit(process.env.TEST_IMAGE==='0'?1:0);
if(a[0]!=='compose')process.exit(1);
const c=a[1]==='--project-directory'?a.slice(5):a.slice(1);
if(c[0]==='version')process.exit(0);
if(c[0]==='ps'&&c.includes('--status')){if(process.env.TEST_RUNNING==='1')console.log('synthetic-running');process.exit(0);}
if(c[0]==='config'){console.log('synthetic-dawn-image');process.exit(0);}
if(c[0]==='run')process.exit(process.env.TEST_SETUP_FAIL==='1'?1:0);
if(c[0]==='exec'&&c.at(-1)==='status')process.exit(process.env.TEST_NOT_READY==='1'?1:0);
process.exit(0);
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log };
  const calls = () => {
    try { return readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]); }
    catch { return [] as string[][]; }
  };
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}, tty = false) => {
    const command = tty ? "script" : "bash";
    const argv = tty ? ["-q", "-e", "-c", `bash '${script}' ${args.join(" ")}`, "/dev/null"] : [script, ...args];
    return spawnSync(command, argv, { cwd: dir, env: { ...env, ...extra }, input: "", encoding: "utf8", timeout: 20_000 });
  };
  return { run, calls };
}
function commands(calls: string[][]) { return calls.filter(a => a[0] === "compose" && a[1] === "--project-directory").map(a => a.slice(5)); }

test("Linux launcher help/unknown arguments do not touch Docker", t => {
  const f = fixture(t);
  assert.equal(f.run(["help"]).status, 0);
  assert.notEqual(f.run(["unknown"]).status, 0);
  assert.notEqual(f.run(["stop", "extra"]).status, 0);
  assert.deepEqual(f.calls(), []);
  assert.equal(spawnSync("bash", ["-n", script]).status, 0);
});
test("launcher engine failure and non-TTY startup never configure or start containers", t => {
  const f = fixture(t);
  assert.notEqual(f.run([], { TEST_NO_ENGINE: "1" }).status, 0);
  assert.notEqual(f.run([]).status, 0);
  assert.ok(!commands(f.calls()).some(c => ["run", "build", "up", "exec"].includes(c[0]!)));
});
test("launcher status/stop use only read or normal stop commands and never remove volumes", t => {
  const f = fixture(t);
  assert.equal(f.run(["status"]).status, 0);
  assert.equal(f.run(["stop"]).status, 0);
  assert.deepEqual(commands(f.calls()), [["ps", "-a"], ["stop", "dawn"]]);
});
test("explicit build refuses a running service and never pulls Git or changes data", t => {
  const f = fixture(t);
  assert.notEqual(f.run(["build"], { TEST_RUNNING: "1" }).status, 0);
  assert.equal(f.run(["build"]).status, 0);
  assert.equal(commands(f.calls()).filter(c => c[0] === "build").length, 1);
  assert.ok(!commands(f.calls()).some(c => ["up", "run", "down", "rm"].includes(c[0]!)));
});
test("TTY first start builds missing image, configures before up, checks ready then opens Pi", t => {
  const f = fixture(t);
  const result = f.run([], { TEST_IMAGE: "0" }, true);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(commands(f.calls()), [
    ["ps", "--status", "running", "-q", "dawn"], ["config", "--images"], ["build", "dawn"],
    ["run", "--rm", "--no-deps", "dawn", "setup"], ["up", "-d", "--no-build", "dawn"],
    ["exec", "-T", "dawn", "dawn-container", "status"], ["exec", "dawn", "dawn-container", "pi"],
  ]);
});
test("existing image is reused and failed setup prevents up/Pi without deletion", t => {
  const f = fixture(t);
  assert.notEqual(f.run([], { TEST_SETUP_FAIL: "1" }, true).status, 0);
  assert.ok(commands(f.calls()).some(c => c[0] === "run"));
  assert.ok(!commands(f.calls()).some(c => ["up", "exec", "build", "down", "rm"].includes(c[0]!)));
});
test("stopped configured installation reuses image and running service connects without setup", t => {
  const f = fixture(t);
  assert.equal(f.run([], {}, true).status, 0);
  assert.ok(!commands(f.calls()).some(c => c[0] === "build"));
  const before = f.calls().length;
  assert.equal(f.run([], { TEST_RUNNING: "1" }, true).status, 0);
  assert.deepEqual(commands(f.calls().slice(before)), [
    ["ps", "--status", "running", "-q", "dawn"], ["exec", "-T", "dawn", "dawn-container", "status"],
    ["exec", "dawn", "dawn-container", "pi"],
  ]);
});

test("running service bypasses build/setup and failed readiness is bounded without opening Pi", t => {
  const f = fixture(t);
  assert.notEqual(f.run([], { TEST_RUNNING: "1", TEST_NOT_READY: "1" }, true).status, 0);
  const calls = commands(f.calls());
  assert.equal(calls.filter(c => c[0] === "exec").length, 5);
  assert.ok(!calls.some(c => ["build", "run", "up"].includes(c[0]!) || c.at(-1) === "pi"));
});
