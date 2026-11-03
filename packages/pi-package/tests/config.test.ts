import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseCompanionConfig, loadCompanionConfig, buildHostBridgeRegistration, buildMcpRegistration } from "../src/config.ts";
import { createTools } from "../../mcp/src/tools.ts";

const base = { version: 1, projectDirectory: "/synthetic/repo with spaces" };
test("config exact version/keys/types, explicit absolute paths and safe optional identifiers", () => {
  assert.deepEqual(parseCompanionConfig(base), { ...base, allowWrite: false });
  for (const bad of [null, [], {}, { ...base, version: 2 }, { ...base, allowWrite: "false" },
    { ...base, command: "sh" }, { ...base, tokenFile: "/secret" }, { ...base, projectDirectory: "relative" },
    { ...base, projectDirectory: "/tmp/\nsecret" }, { ...base, projectDirectory: "/tmp/\u202esecret" },
    { ...base, projectDirectory: "/" + "x".repeat(4096) }, { ...base, composeProject: "--bad" },
    { ...base, composeProject: "UpperCase" }, { ...base, dockerContext: "ssh://remote" },
    { ...base, dockerContext: "ctx;command" }, { ...base, dockerContext: "--bad" }]) {
    assert.throws(() => parseCompanionConfig(bad));
  }
});
test("registration has fixed Docker executable/argv and read-only default; no shell, startup or secret environment", () => {
  const config = parseCompanionConfig(base);
  assert.deepEqual(buildMcpRegistration(config), {
    command: "docker", args: ["compose", "--project-directory", base.projectDirectory, "-f",
      `${base.projectDirectory}/compose.yaml`, "exec", "-T", "dawn", "dawn-container", "mcp"],
    exposure: "codemode", timeout: 45,
    description: "曙光独立主体：显式交流与状态工具；不自动采集对话、检索或启动学习。",
  });
  const write = buildMcpRegistration(parseCompanionConfig({ ...base, allowWrite: true, dockerContext: "desktop-linux", composeProject: "existing-project" }));
  assert.ok("command" in write);
  assert.deepEqual(write.args, ["--context", "desktop-linux", "compose", "--project-directory", base.projectDirectory,
    "-f", `${base.projectDirectory}/compose.yaml`, "--project-name", "existing-project", "exec", "-T", "dawn", "dawn-container", "mcp", "--allow-write"]);
  assert.throws(() => buildMcpRegistration({ ...config, allowWrite: "true" } as never));
  assert.deepEqual(buildHostBridgeRegistration(config), {
    command: "docker", args: ["compose", "--project-directory", base.projectDirectory, "-f",
      `${base.projectDirectory}/compose.yaml`, "exec", "-T", "dawn", "dawn-container", "host-bridge"],
    exposure: "codemode", timeout: 45,
    description: "曙光私有会话来源桥；仅由明确的本地命令启动。",
  });
  const writeConfig = parseCompanionConfig({ ...base, allowWrite: true });
  assert.deepEqual(buildHostBridgeRegistration(writeConfig), buildHostBridgeRegistration(config));
});
test("explicit bounded UTF8 file, no-follow final symlink and no group/other writer", () => {
  const root = mkdtempSync(join(tmpdir(), "shuguang-pi-config-"));
  try {
    const path = join(root, "connection.json");
    writeFileSync(path, JSON.stringify(base), { mode: 0o600 });
    assert.deepEqual(loadCompanionConfig(path), { ...base, allowWrite: false });
    assert.throws(() => loadCompanionConfig("relative.json"));
    assert.throws(() => loadCompanionConfig(join(root, "missing")));
    symlinkSync(path, join(root, "link"));
    assert.throws(() => loadCompanionConfig(join(root, "link")));
    mkdirSync(join(root, "dir"));
    assert.throws(() => loadCompanionConfig(join(root, "dir")));
    chmodSync(path, 0o622);
    assert.throws(() => loadCompanionConfig(path));
    chmodSync(path, 0o600);
    for (const bad of ["{" , " ".repeat(8193), Buffer.from([0xff, 0xfe]), JSON.stringify({ ...base, key: "synthetic-secret" })]) {
      writeFileSync(path, bad);
      assert.throws(() => loadCompanionConfig(path));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const remote = { version: 1, url: "https://synthetic.example/mcp", credentialEnv: "SHUGUANG_MCP_TOKEN", allowWrite: false };
test("remote config is exact, HTTPS-only and cannot mix local keys or credentials", () => {
  assert.deepEqual(parseCompanionConfig(remote), remote);
  assert.deepEqual(parseCompanionConfig({ ...remote, allowWrite: true }), { ...remote, allowWrite: true });
  for (const url of ["http://host/mcp", "https://", "not a url", "/mcp", "https:host/mcp", "https:///host/mcp",
    "https://user:pass@host/mcp", "https://user@host/mcp", "https://@host/mcp", "https://host/mcp?", "https://host/mcp#",
    "https://host/mcp?q=1", "https://host/mcp#frag", "https://host:99999/mcp", " https://host/mcp", "https://ho\nst/mcp",
    "https://host\\other/mcp", "https://host/\u202emcp"]) assert.throws(() => parseCompanionConfig({ ...remote, url }));
  for (const credentialEnv of ["", "A-B", "1KEY", "KEY\n", "${KEY}", "!command", "A".repeat(129), 123]) {
    assert.throws(() => parseCompanionConfig({ ...remote, credentialEnv }));
  }
  for (const key of ["projectDirectory", "dockerContext", "composeProject", "search", "headers", "token", "command", "env"]) {
    assert.throws(() => parseCompanionConfig({ ...remote, [key]: undefined }));
  }
  for (const key of Object.keys(remote)) {
    const incomplete: Record<string, unknown> = { ...remote }; delete incomplete[key];
    assert.throws(() => parseCompanionConfig(incomplete));
  }
  assert.throws(() => parseCompanionConfig({ ...remote, allowWrite: "false" }));
  assert.throws(() => parseCompanionConfig({ ...base, credentialEnv: "KEY" }));
});

test("remote registration only references Env, enforces six write-tool exclusions, and refuses private bridge", () => {
  const previous = process.env;
  // No real value is read: trap even attempted credential lookup/enumeration.
  process.env = new Proxy({}, { get() { assert.fail("credential lookup"); }, ownKeys() { assert.fail("credential discovery"); } });
  let readonly, writable;
  try {
    readonly = buildMcpRegistration(parseCompanionConfig(remote));
    writable = buildMcpRegistration(parseCompanionConfig({ ...remote, allowWrite: true }));
    assert.throws(() => buildHostBridgeRegistration(parseCompanionConfig(remote)), /远程连接当前仅支持普通MCP交流与控制；片段共享和研究私有桥尚不支持/);
  } finally { process.env = previous; }
  assert.deepEqual(readonly, {
    url: remote.url, headers: { Authorization: "Bearer ${SHUGUANG_MCP_TOKEN}" }, exposure: "codemode", timeout: 45,
    toolExposure: { shuguang_say: "hidden", shuguang_wake: "hidden", shuguang_sleep: "hidden", shuguang_model_list: "hidden",
      shuguang_model_select: "hidden", shuguang_thinking_select: "hidden" },
    description: "曙光远程主体：普通MCP交流与控制；客户端工具限制不替代服务器ACL，不支持片段共享和研究私有桥。",
  });
  assert.deepEqual(writable, Object.fromEntries(Object.entries(readonly!).filter(([key]) => key !== "toolExposure")));
  assert.ok(!("command" in readonly!));
  // Pin the policy to the actual ordinary MCP catalog, not only a duplicate list in this test.
  const tools = createTools({ allowWrite: true, transport: { request: async () => { throw new Error("no requests in catalog test"); } } }).list();
  for (const tool of tools) {
    assert.equal(readonly!.toolExposure?.[tool.name] === "hidden", !tool.annotations.readOnlyHint, tool.name);
    assert.equal(writable!.toolExposure?.[tool.name], undefined);
  }
});
