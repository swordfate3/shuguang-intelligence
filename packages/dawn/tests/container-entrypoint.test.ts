import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("container packaging is Dawn-only, keeps MCP source allow-listed and preserves the sole data volume", () => {
  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
  const compose = readFileSync(join(root, "compose.yaml"), "utf8");
  const ignore = readFileSync(join(root, ".dockerignore"), "utf8");
  const attributes = readFileSync(join(root, ".gitattributes"), "utf8");
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /COPY config\/learning-pack\.example\.json/);
  assert.match(dockerfile, /COPY packages\/mcp\/package\.json/);
  assert.match(dockerfile, /COPY packages\/mcp\/src\//);
  assert.doesNotMatch(dockerfile, /COPY\s+\.\s|COPY\s+config\/\s/);
  assert.doesNotMatch(dockerfile, /ARG PI_VERSION|packages\/pi-extension|\/opt\/pi|apt-get install[^\n]*\bgit\b|npm install[^\n]*pi-coding-agent|WORKDIR \/work|\/home\/node\/\.pi/);
  assert.doesNotMatch(compose, /^\s*(?:ports|network_mode|privileged):/m);
  assert.match(compose, /init: true/);
  assert.match(compose, /stop_grace_period: 45s/);
  assert.match(compose, /restart: "no"/);
  assert.match(compose, /dawn-data:\/data/);
  assert.doesNotMatch(compose, /pi-home|pi-work|\/home\/node\/\.pi|\/work/);
  assert.deepEqual(compose.match(/^\s+- [^:\n]+:\/[^\n]+$/gm), ["      - dawn-data:/data"]);
  assert.match(ignore, /^\*\*$/m);
  assert.match(ignore, /!packages\/mcp\/package\.json/);
  assert.match(ignore, /!packages\/mcp\/src\/\*\*/);
  assert.doesNotMatch(ignore, /pi-extension/);
  assert.match(ignore, /\*\*\/\*\.env/);
  assert.match(attributes, /docker\/\*\.sh text eol=lf/);
  assert.equal(spawnSync("sh", ["-n", entry]).status, 0);
});

test("container entrypoint refuses implicit initialization, unknown commands and overwrite", t => {
  const f = fixture(t);
  assert.equal(f.command("help").status, 0);
  assert.notEqual(f.command("unknown").status, 0);
  assert.notEqual(f.command("pi").status, 0, "the removed Pi command is not accepted");
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

test("container MCP launches with exact read-only args, no model env-file/key, and clean stdio", t => {
  const f = fixture(t);
  const bin = join(f.dir, "bin"); mkdirSync(bin);
  const record = join(f.dir, "mcp.json");
  writeFileSync(join(f.data, "model.env"), "DAWN_MODEL_API_KEY='synthetic-model-secret'\n", { mode: 0o600 });
  writeFileSync(join(bin, "node"), `#!/bin/sh\nexec '${process.execPath}' -e 'require("node:fs").writeFileSync(process.env.TEST_ARGV,JSON.stringify({args:process.argv.slice(1),hasKey:!!process.env.DAWN_MODEL_API_KEY}));process.stdout.write("MCP-STDOUT\\n")' -- "$@"\n`, { mode: 0o700 });
  const env = { ...f.env, PATH: `${bin}:${process.env.PATH}`, TEST_ARGV: record };
  const readOnly = spawnSync("sh", [entry, "mcp"], { env, encoding: "utf8", timeout: 5_000 });
  assert.equal(readOnly.status, 0, readOnly.stderr);
  assert.equal(readOnly.stdout, "MCP-STDOUT\n");
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), {
    args: [join(root, "packages/mcp/src/main.ts"), "--endpoint", "http://127.0.0.1:7341", "--token-file", join(f.data, "service.token")],
    hasKey: false,
  });

  const writable = spawnSync("sh", [entry, "mcp", "--allow-write"], { env, encoding: "utf8", timeout: 5_000 });
  assert.equal(writable.status, 0, writable.stderr);
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), {
    args: [join(root, "packages/mcp/src/main.ts"), "--endpoint", "http://127.0.0.1:7341", "--token-file", join(f.data, "service.token"), "--allow-write"],
    hasKey: false,
  });
  assert.notEqual(spawnSync("sh", [entry, "mcp", "--endpoint", "elsewhere"], { env, encoding: "utf8" }).status, 0);
  assert.notEqual(spawnSync("sh", [entry, "mcp", "--allow-write", "--allow-write"], { env, encoding: "utf8" }).status, 0);
  assert.match(spawnSync("sh", [entry, "mcp", "bad"], { env, encoding: "utf8" }).stderr, /Usage: dawn-container mcp \[--allow-write\]/);
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
