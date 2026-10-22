import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { TestContext } from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const entry = join(root, "docker/entrypoint.sh");
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "dawn-container-entry-"));
  const data = join(dir, "data");
  mkdirSync(data, { mode: 0o700 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, DAWN_DATA_DIR: data };
  delete env.DAWN_MODEL_API_KEY;
  const command = (...args: string[]) => spawnSync("sh", [entry, ...args], { env, encoding: "utf8", timeout: 10_000 });
  return { dir, data, env, command };
}

test("container packaging is a private non-root Dawn service with no Pi dependency or extra volumes", () => {
  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
  const compose = readFileSync(join(root, "compose.yaml"), "utf8");
  const ignore = readFileSync(join(root, ".dockerignore"), "utf8");
  const attributes = readFileSync(join(root, ".gitattributes"), "utf8");
  assert.doesNotMatch(dockerfile, /PI_VERSION|\/opt\/pi|pi-extension|npm install|apt-get/);
  assert.match(dockerfile, /WORKDIR \/app/);
  assert.match(dockerfile, /COPY package\.json LICENSE/);
  assert.match(dockerfile, /mkdir -p \/data\s*\\\r?\n\s*&& chown node:node \/data\s*\\\r?\n\s*&& chmod 700 \/data/);
  assert.doesNotMatch(dockerfile, /\/home\/node\/\.pi|\/work/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /COPY config\/learning-pack\.example\.json/);
  assert.doesNotMatch(dockerfile, /COPY\s+\.\s|COPY\s+config\/\s/);
  assert.doesNotMatch(compose, /^\s*(?:ports|network_mode|privileged):/m);
  assert.match(compose, /init: true/);
  assert.match(compose, /stop_grace_period: 45s/);
  assert.match(compose, /restart: "no"/);
  assert.deepEqual([...compose.matchAll(/^\s+- ([-a-z0-9]+):(\/[^\s]+)$/gm)].map(match => [match[1], match[2]]), [["dawn-data", "/data"]]);
  assert.doesNotMatch(compose, /^\s*(?:PI_VERSION|pi-home|pi-work):/m);
  assert.match(compose, /Legacy pi-home\/pi-work volumes.*never delete them automatically/);
  assert.match(compose, /test: \["CMD", "dawn-container", "status"\]/);
  assert.doesNotMatch(ignore, /^!packages\/pi-extension/m);
  assert.match(ignore, /^\*\*$/m);
  assert.match(ignore, /\*\*\/\*\.env/);
  assert.match(attributes, /docker\/\*\.sh text eol=lf/);
});

test("container entrypoint retains valid POSIX shell syntax", () => {
  assert.equal(spawnSync("sh", ["-n", entry]).status, 0);
});

test("container entrypoint refuses implicit initialization, unknown commands and overwrite", t => {
  const f = fixture(t);
  assert.equal(f.command("help").status, 0);
  assert.notEqual(f.command("unknown").status, 0);
  assert.notEqual(f.command("serve").status, 0);
  assert.notEqual(f.command("init").status, 0);
  assert.notEqual(f.command("init", "synthetic", "合成主体", "20", "33").status, 0);
  const created = f.command("init", "synthetic", "合成主体", "20", "4");
  assert.equal(created.status, 0, created.stderr);
  const db = readFileSync(join(f.data, "subject.sqlite"));
  const token = readFileSync(join(f.data, "service.token"));
  assert.notEqual(f.command("init", "replacement", "不得覆盖", "100", "4").status, 0);
  assert.deepEqual(readFileSync(join(f.data, "subject.sqlite")), db);
  assert.deepEqual(readFileSync(join(f.data, "service.token")), token);
  assert.equal(f.command("budget").status, 0);
  assert.equal(f.command("learning-status").status, 0);
  assert.notEqual(f.command("learning-run").status, 0, "missing model/key never silently falls back");
});

test("container setup dispatches to unified wizard and rejects unexpected arguments", t => {
  const f = fixture(t);
  const bin = join(f.dir, "bin"); mkdirSync(bin);
  const record = join(f.dir, "setup.json");
  writeFileSync(join(bin, "node"), `#!/bin/sh\nprintf '%s' "$1" > "$TEST_ARGV"\n`, { mode: 0o700 });
  const env = { ...f.env, PATH: `${bin}:${process.env.PATH}`, TEST_ARGV: record };
  assert.equal(spawnSync("sh", [entry, "setup"], { env }).status, 0);
  assert.equal(readFileSync(record, "utf8"), join(root, "docker/setup.ts"));
  assert.notEqual(spawnSync("sh", [entry, "setup", "extra"], { env }).status, 0);
  assert.match(readFileSync(join(root, ".dockerignore"), "utf8"), /^!docker\/setup\.ts$/m);
});

test("container rejects removed Pi interaction without running tools or initializing data", t => {
  const f = fixture(t);
  const bin = join(f.dir, "bin"); mkdirSync(bin);
  const record = join(f.dir, "unexpected-tool-call");
  for (const command of ["pi", "node"]) writeFileSync(join(bin, command), `#!/bin/sh\nprintf '%s' unexpected > "$TEST_ARGV"\nexit 99\n`, { mode: 0o700 });
  const env = { ...f.env, PATH: `${bin}:${process.env.PATH}`, TEST_ARGV: record };
  const help = spawnSync("sh", [entry, "help"], { env, encoding: "utf8", timeout: 5_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /^\s*pi\s/m);
  assert.match(help.stdout, /bridge-request/);
  for (const args of [["pi"], ["pi", "--offline", "--no-session"]]) {
    const child = spawnSync("sh", [entry, ...args], { env, encoding: "utf8", timeout: 5_000 });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /Unknown container command/);
  }
  assert.equal(existsSync(record), false, "removed Pi path must never dispatch any executable");
  assert.equal(existsSync(join(f.data, "subject.sqlite")), false);
  assert.equal(existsSync(join(f.data, "service.token")), false);
});

test("container serve composes exact Node env-file argv and exec forwards TERM without touching a real service", { timeout: 15_000 }, async t => {
  const f = fixture(t);
  assert.equal(f.command("init", "synthetic", "合成主体", "20", "4").status, 0);
  writeFileSync(join(f.data, "model.json"), JSON.stringify({
    baseUrl: "https://model.example.invalid/v1", model: "synthetic-container-model", credentialEnv: "DAWN_MODEL_API_KEY",
    maxCalls: 4, reasoningEffort: "low", timeoutMs: 30000,
  }), { mode: 0o600 });
  writeFileSync(join(f.data, "model.env"), "DAWN_MODEL_API_KEY='synthetic-container-key'\n", { mode: 0o600 });
  // Never take the fixed production port or connect to its existing owner. Only record final argv.
  // verify-files still runs for real; the final Node process is a synthetic signal-aware stub.
  const bin = join(f.dir, "bin"); mkdirSync(bin);
  const realNode = process.execPath;
  const fakeNode = join(bin, "node");
  const record = join(f.dir, "argv.json");
  writeFileSync(fakeNode, `#!/bin/sh\ncase "$*" in\n  *verify-files*) exec '${realNode}' "$@" ;;\n  *) exec '${realNode}' -e 'require("node:fs").writeFileSync(process.env.TEST_ARGV,JSON.stringify(process.argv.slice(1)));process.on("SIGTERM",()=>process.exit(0));console.log("ready");setInterval(()=>{},1000)' -- "$@" ;;\nesac\n`, { mode: 0o700 });
  const child = spawn("sh", [entry, "serve"], { env: { ...f.env, PATH: `${bin}:${process.env.PATH}`, TEST_ARGV: record }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("synthetic entrypoint not ready")), 5_000);
    let output = "";
    child.stdout.on("data", chunk => {
      output += String(chunk);
      if (output.split("\n").includes("ready")) { clearTimeout(timer); resolve(); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("synthetic entrypoint exited early")); });
  });
  const argv = JSON.parse(readFileSync(record, "utf8")) as string[];
  assert.deepEqual(argv, [`--env-file=${join(f.data, "model.env")}`, join(root, "packages/dawn/src/main.ts"), "serve",
    "--subject-db", join(f.data, "subject.sqlite"), "--token-file", join(f.data, "service.token"), "--port", "7341",
    "--model-config", join(f.data, "model.json")]);
  child.kill("SIGTERM");
  assert.equal(await exited, 0, "exec forwards TERM to the final process");
  const budget = JSON.parse(f.command("budget").stdout) as { budget: { reserved: number } };
  assert.equal(budget.budget.reserved, 0);
});
