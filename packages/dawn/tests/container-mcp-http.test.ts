import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const entry = join(root, "docker/entrypoint.sh");

test("HTTP gateway container dispatch uses separate access credential and never loads model.env", t => {
  const dir = mkdtempSync(join(tmpdir(), "shuguang-http-entry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = join(dir, "data"), bin = join(dir, "bin"), record = join(dir, "argv.json");
  mkdirSync(data, { mode: 0o700 }); mkdirSync(bin);
  writeFileSync(join(data, "model.env"), "DAWN_MODEL_API_KEY='synthetic-never-load'\n", { mode: 0o600 });
  writeFileSync(join(bin, "node"), `#!/bin/sh\nexec '${process.execPath}' -e 'require("node:fs").writeFileSync(process.env.TEST_ARGV,JSON.stringify(process.argv.slice(1)))' -- "$@"\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DAWN_DATA_DIR: data, TEST_ARGV: record, DAWN_MCP_ALLOW_WRITE: "false" };
  const run = (extra: Record<string, string> = {}) => spawnSync("sh", [entry, "mcp-http", "--public-url", "https://dawn.example/mcp"], { env: { ...env, ...extra }, encoding: "utf8" });
  assert.equal(run().status, 0);
  const expected = [join(root, "packages/mcp/src/http-main.ts"), "--endpoint", "http://127.0.0.1:7341", "--token-file", join(data, "service.token"), "--auth-token-file", join(data, "mcp-access.token"), "--public-url", "https://dawn.example/mcp"];
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), expected);
  assert.equal(run({ DAWN_MCP_ALLOW_WRITE: "true" }).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), [...expected, "--allow-write"]);
  assert.notEqual(run({ DAWN_MCP_ALLOW_WRITE: "yes" }).status, 0);
});

test("remote MCP token initialization is explicit, exclusive and does not initialize a subject", t => {
  const dir = mkdtempSync(join(tmpdir(), "shuguang-http-token-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = join(dir, "data"); mkdirSync(data, { mode: 0o700 });
  const run = (...args: string[]) => spawnSync("sh", [entry, "mcp-token-init", ...args], {
    env: { ...process.env, DAWN_DATA_DIR: data }, encoding: "utf8", timeout: 5000,
  });
  assert.notEqual(run("unexpected").status, 0);
  assert.deepEqual(readdirSync(data), []);
  assert.equal(run().status, 0);
  const path = join(data, "mcp-access.token"), saved = readFileSync(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(data), ["mcp-access.token"]);
  const duplicate = run(); assert.notEqual(duplicate.status, 0);
  assert.deepEqual(readFileSync(path), saved);
  assert.ok(!duplicate.stdout.includes(saved.toString().trim()));
  assert.ok(!duplicate.stderr.includes(saved.toString().trim()));
});

test("HTTP deployment is explicit opt-in with loopback publication, no Docker socket or second database writer", () => {
  const base = readFileSync(join(root, "compose.yaml"), "utf8");
  const overlay = readFileSync(join(root, "compose.mcp.yaml"), "utf8");
  assert.doesNotMatch(base, /^\s*ports:/m);
  assert.match(overlay, /127\.0\.0\.1:\$\{SHUGUANG_MCP_PORT:-7342\}:7342/);
  assert.match(overlay, /network_mode: "service:dawn"/);
  assert.match(overlay, /dawn-data:\/data:ro/);
  assert.match(overlay, /read_only: true/);
  assert.doesNotMatch(overlay, /docker\.sock|privileged:|command: \["serve"/);
  assert.match(overlay, /SHUGUANG_MCP_PUBLIC_URL:\?/);
  assert.match(overlay, /SHUGUANG_MCP_ALLOW_WRITE:-false/);
  assert.equal(spawnSync("sh", ["-n", entry]).status, 0);
});
