import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, McpServerConfig } from "@earendil-works/pi-coding-agent";
import shuguangMcpExtension from "../src/index.ts";

const UI_REQUIRED = "连接曙光 MCP 需要可用的确认界面。";
const ALREADY_REGISTERED = "曙光 MCP 已由本扩展注册；请先运行 /shuguang-mcp disconnect。";
const CONNECT_PENDING = "曙光 MCP 连接确认仍在进行中，请稍后再试。";
const REGISTER_FAILED = "无法注册曙光 MCP；请检查 Pi MCP 扩展支持。";
const UNREGISTER_FAILED = "无法注销本扩展拥有的曙光 MCP 注册。";
const CONFIG_ENV = "SHUGUANG_PI_CONFIG";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type EventHandler = (...args: unknown[]) => unknown;
interface Harness {
  readonly commands: Map<string, CommandHandler>;
  readonly events: Map<string, EventHandler[]>;
  readonly registrations: Array<{ name: string; config: McpServerConfig }>;
  readonly unregistrations: string[];
  readonly confirmations: Array<{ title: string; message: string; signal: AbortSignal | undefined }>;
  readonly notifications: Array<{ message: string; type: string | undefined }>;
  readonly api: ExtensionAPI;
  readonly fire: (event: string) => void;
  readonly command: (name: string, args: string, ctx: ExtensionCommandContext) => Promise<void>;
  registerError: Error | undefined;
  unregisterError: Error | undefined;
}

function makeContext(options: {
  hasUI?: boolean | (() => boolean);
  confirm?: (title: string, message: string, signal: AbortSignal | undefined) => Promise<boolean>;
  signal?: AbortSignal;
  sessionManager?: object;
  waitForIdle?: () => Promise<void>;
} = {}): ExtensionCommandContext {
  const ui = {
    confirm: async (title: string, message: string, opts?: { signal?: AbortSignal }) =>
      options.confirm ? options.confirm(title, message, opts?.signal) : true,
    notify: (message: string, type?: string) => { void message; void type; },
  };
  return {
    get hasUI() { return typeof options.hasUI === "function" ? options.hasUI() : options.hasUI ?? true; },
    signal: options.signal,
    ui,
    waitForIdle: options.waitForIdle ?? (async () => {}),
    get sessionManager(): never {
      if (options.sessionManager) return options.sessionManager as never;
      throw new Error("session history must not be read");
    },
  } as unknown as ExtensionCommandContext;
}

function createHarness(): Harness {
  const commands = new Map<string, CommandHandler>();
  const events = new Map<string, EventHandler[]>();
  const registrations: Array<{ name: string; config: McpServerConfig }> = [];
  const unregistrations: string[] = [];
  const confirmations: Array<{ title: string; message: string; signal: AbortSignal | undefined }> = [];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const state: { registerError: Error | undefined; unregisterError: Error | undefined } = {
    registerError: undefined,
    unregisterError: undefined,
  };
  const fakeApi = {
    registerCommand(name: string, options: { handler: CommandHandler }) {
      assert.equal(commands.has(name), false, `duplicate command ${name}`);
      commands.set(name, options.handler);
    },
    on(name: string, handler: EventHandler) {
      const current = events.get(name) ?? [];
      current.push(handler);
      events.set(name, current);
    },
    registerMcpServer(name: string, config: McpServerConfig) {
      if (state.registerError) throw state.registerError;
      registrations.push({ name, config });
    },
    unregisterMcpServer(name: string) {
      if (state.unregisterError) throw state.unregisterError;
      unregistrations.push(name);
    },
    registerTool() { assert.fail("this extension must not register Pi tools"); },
    sendMessage() { assert.fail("this extension must not send transcript messages"); },
    sendUserMessage() { assert.fail("this extension must not send user messages"); },
    setModel() { assert.fail("this extension must not change the active model"); },
  };
  const api = fakeApi as unknown as ExtensionAPI;
  const fire = (name: string): void => {
    for (const handler of events.get(name) ?? []) handler({}, makeContext());
  };
  const command = async (name: string, args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const handler = commands.get(name);
    assert.ok(handler, `missing command: ${name}`);
    await handler(args, ctx);
  };
  const harness: Harness = {
    commands, events, registrations, unregistrations, confirmations, notifications, api, fire, command,
    get registerError() { return state.registerError; },
    set registerError(value: Error | undefined) { state.registerError = value; },
    get unregisterError() { return state.unregisterError; },
    set unregisterError(value: Error | undefined) { state.unregisterError = value; },
  };
  shuguangMcpExtension(api);
  // Record confirmation and notification calls without adding any host behavior.
  for (const [name, handler] of commands) {
    commands.set(name, async (args, rawCtx) => {
      const originalUi = rawCtx.ui;
      const ctx = Object.create(rawCtx) as ExtensionCommandContext;
      Object.defineProperty(ctx, "ui", {
        value: {
          ...originalUi,
          confirm: async (title: string, message: string, opts?: { signal?: AbortSignal }) => {
            confirmations.push({ title, message, signal: opts?.signal });
            return originalUi.confirm(title, message, opts);
          },
          notify: (message: string, type?: "info" | "warning" | "error") => {
            notifications.push({ message, type });
          },
        },
      });
      await handler(args, ctx);
    });
  }
  return harness;
}

function withConfig(config: Record<string, unknown>, run: (path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "shuguang-pi-extension-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  const previous = process.env[CONFIG_ENV];
  process.env[CONFIG_ENV] = path;
  return run(path).finally(() => {
    if (previous === undefined) delete process.env[CONFIG_ENV];
    else process.env[CONFIG_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

function withFakeDocker<T>(run: (paths: { argv: string; requests: string }) => Promise<T>, authorizeDelayMs = 0, researchState?: object): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "shuguang-fake-docker-"));
  const bin = join(dir, "bin");
  const argv = join(dir, "argv.json");
  const requests = join(dir, "requests.log");
  const script = join(bin, "docker");
  const previousPath = process.env.PATH;
  const previousArgv = process.env.SHUGUANG_FAKE_DOCKER_ARGV;
  const previousRequests = process.env.SHUGUANG_FAKE_DOCKER_REQUESTS;
  const previousDelay = process.env.SHUGUANG_FAKE_DOCKER_AUTHORIZE_DELAY_MS;
  try {
    mkdirSync(bin);
    writeFileSync(script, `#!/usr/bin/env node\nconst researchState=${JSON.stringify(researchState ?? null)};\nconst fs=require('node:fs');\nconst readline=require('node:readline');\nfs.writeFileSync(process.env.SHUGUANG_FAKE_DOCKER_ARGV, JSON.stringify(process.argv.slice(2)));\nconst rl=readline.createInterface({input:process.stdin});\nrl.on('line',line=>{\n const request=JSON.parse(line);\n fs.appendFileSync(process.env.SHUGUANG_FAKE_DOCKER_REQUESTS, JSON.stringify(request)+'\\n');\n const respond=()=>{\n  const base={version:1,requestId:request.requestId};\n  let response;\n  if(request.type==='status') response={...base,type:'status',subjectId:'subject_1',scopeId:'scope_1',revision:3,lifecycle:'awake',supported:true,...(researchState?{researchSupported:true}:{})};\n  else if(request.type==='research-status' && researchState) response={...base,type:'research',status:researchState};\n  else if(request.type==='authorize') response={...base,type:'grant',grant:{grantId:'grant_1',batchId:request.batch.batchId,batchHash:'${"a".repeat(64)}',bindingId:'binding_1',status:'active',expiresAt:request.expiresAt}};\n  else if(request.type==='accept') response={...base,type:'import',result:{batchId:request.batch.batchId,status:'accepted',newSources:1,revision:3}};\n  else if(request.type==='consume') response={...base,type:'import',result:{batchId:request.batchId,status:'consumed',newSources:1,revision:4}};\n  else if(request.type==='revoke') response={...base,type:'revoked'};\n  else response={...base,type:'error',code:'UNSUPPORTED'};\n  process.stdout.write(JSON.stringify(response)+'\\n');\n };\n const delay=Number(process.env.SHUGUANG_FAKE_DOCKER_AUTHORIZE_DELAY_MS||0);\n if(request.type==='authorize'&&delay>0)setTimeout(respond,delay);else respond();\n});\n`, { mode: 0o700 });
    chmodSync(script, 0o700);
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    process.env.SHUGUANG_FAKE_DOCKER_ARGV = argv;
    process.env.SHUGUANG_FAKE_DOCKER_REQUESTS = requests;
    process.env.SHUGUANG_FAKE_DOCKER_AUTHORIZE_DELAY_MS = String(authorizeDelayMs);
    return run({ argv, requests }).finally(() => {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousArgv === undefined) delete process.env.SHUGUANG_FAKE_DOCKER_ARGV; else process.env.SHUGUANG_FAKE_DOCKER_ARGV = previousArgv;
      if (previousRequests === undefined) delete process.env.SHUGUANG_FAKE_DOCKER_REQUESTS; else process.env.SHUGUANG_FAKE_DOCKER_REQUESTS = previousRequests;
      if (previousDelay === undefined) delete process.env.SHUGUANG_FAKE_DOCKER_AUTHORIZE_DELAY_MS; else process.env.SHUGUANG_FAKE_DOCKER_AUTHORIZE_DELAY_MS = previousDelay;
      rmSync(dir, { recursive: true, force: true });
    });
  } catch (error) {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousArgv === undefined) delete process.env.SHUGUANG_FAKE_DOCKER_ARGV; else process.env.SHUGUANG_FAKE_DOCKER_ARGV = previousArgv;
    if (previousRequests === undefined) delete process.env.SHUGUANG_FAKE_DOCKER_REQUESTS; else process.env.SHUGUANG_FAKE_DOCKER_REQUESTS = previousRequests;
    if (previousDelay === undefined) delete process.env.SHUGUANG_FAKE_DOCKER_AUTHORIZE_DELAY_MS; else process.env.SHUGUANG_FAKE_DOCKER_AUTHORIZE_DELAY_MS = previousDelay;
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("synthetic test condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function makeSessionManager(initialText = "synthetic user message"): {
  readonly manager: object;
  readonly reads: () => number;
  readonly setText: (text: string) => void;
  readonly setLeaf: (leaf: string) => void;
} {
  let text = initialText;
  let leaf = "entry_3";
  let reads = 0;
  const branch = [
    { type: "message", id: "entry_1", parentId: null, timestamp: "2026-01-02T03:04:05.000Z", message: { role: "user", content: "earlier text" } },
    { type: "message", id: "entry_2", parentId: "entry_1", timestamp: "2026-01-02T03:04:06.000Z", message: { role: "assistant", content: [{ type: "text", text: "assistant reply" }, { type: "thinking", thinking: "not shared" }] } },
    { type: "message", id: "entry_3", parentId: "entry_2", timestamp: "2026-01-02T03:04:07.000Z", message: { role: "user", get content() { return text; } } },
  ];
  return {
    manager: {
      getSessionId() { reads += 1; return "session_1"; },
      getLeafId() { reads += 1; return leaf; },
      getBranch() { reads += 1; return branch; },
    },
    reads: () => reads,
    setText: value => { text = value; },
    setLeaf: value => { leaf = value; },
  };
}

test("factory is lazy and registers the MCP and explicit share commands plus lifecycle handlers", () => {
  const previous = process.env[CONFIG_ENV];
  delete process.env[CONFIG_ENV];
  try {
    const harness = createHarness();
    assert.deepEqual([...harness.commands.keys()], ["shuguang-research", "shuguang-share", "shuguang-mcp"]);
    assert.deepEqual([...harness.events.keys()].sort(), ["session_shutdown", "session_start"]);
    assert.equal(harness.registrations.length, 0);
    assert.equal(harness.confirmations.length, 0);
  } finally {
    if (previous !== undefined) process.env[CONFIG_ENV] = previous;
  }
});

test("/shuguang-share gates history behind UI, owned MCP registration, and idle synchronization", async () => {
  const harness = createHarness();
  const history = { reads: 0, getSessionId() { this.reads += 1; return "session_1"; }, getLeafId() { this.reads += 1; return "entry_1"; }, getBranch() { this.reads += 1; return []; } };
  await assert.rejects(harness.command("shuguang-share", "", makeContext({ sessionManager: history })), /本扩展已注册/);
  assert.equal(history.reads, 0);
  await assert.rejects(harness.command("shuguang-share", "", makeContext({ hasUI: false, sessionManager: history })), /确认界面/);
  assert.equal(history.reads, 0);
  await withConfig({ version: 1, projectDirectory: "/tmp/fake-share-project" }, async () => {
    await harness.command("shuguang-mcp", "connect", makeContext());
    const entered = deferred<void>();
    const neverIdle = new Promise<void>(() => {});
    const controller = new AbortController();
    const operation = harness.command("shuguang-share", "", makeContext({
      sessionManager: history,
      signal: controller.signal,
      waitForIdle: () => { entered.resolve(); return neverIdle; },
    }));
    await entered.promise;
    controller.abort();
    await assert.rejects(operation, /会话共享已取消/);
    assert.equal(history.reads, 0);
  });
});

test("/shuguang-share runs status, exact preview, 5-minute grant, accept and consume with either MCP write setting", async t => {
  for (const allowWrite of [false, true]) await t.test(`allowWrite=${allowWrite}`, async () => {
  await withFakeDocker(async ({ argv, requests }) => withConfig({ version: 1, projectDirectory: "/tmp/synthetic-compose-project", dockerContext: "local-test", composeProject: "synthetic-project", allowWrite }, async () => {
    const harness = createHarness();
    await harness.command("shuguang-mcp", "connect", makeContext());
    const session = makeSessionManager();
    const idle = deferred<void>();
    const operation = harness.command("shuguang-share", "2", makeContext({ sessionManager: session.manager, waitForIdle: () => idle.promise }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.reads(), 0, "history must not be read before waitForIdle resolves");
    idle.resolve();
    await waitUntil(() => existsSync(argv));
    await operation;
    const dockerArgs = JSON.parse(readFileSync(argv, "utf8")) as string[];
    assert.deepEqual(dockerArgs, ["--context", "local-test", "compose", "--project-directory", "/tmp/synthetic-compose-project",
      "-f", "/tmp/synthetic-compose-project/compose.yaml", "--project-name", "synthetic-project", "exec", "-T", "dawn", "dawn-container", "host-bridge"]);
    assert.ok(!dockerArgs.some(argument => /stop|rm|down|volume|delete/i.test(argument)));
    const sent = readFileSync(requests, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(sent.map(request => request.type), ["status", "authorize", "accept", "consume"]);
    const authorize = sent[1]!;
    assert.deepEqual(Object.keys(authorize).sort(), ["batch", "expiresAt", "requestId", "type", "version"]);
    assert.equal(authorize.type, "authorize");
    const expiresAt = Date.parse(String(authorize.expiresAt));
    assert.ok(expiresAt >= Date.now() + 299_000 && expiresAt <= Date.now() + 300_000);
    const batch = authorize.batch as { batchId: string; fragments: Array<{ text: string; role: string }> };
    assert.equal(batch.fragments.length, 2);
    assert.deepEqual(batch.fragments.map(fragment => [fragment.role, fragment.text]), [
      ["assistant", "assistant reply"], ["user", "synthetic user message"],
    ]);
    assert.doesNotMatch(JSON.stringify(authorize), /not shared|toolCall|executorToken/);
    assert.equal((sent[2]!.batch as { batchId: string }).batchId, batch.batchId);
    assert.equal(sent[3]!.batchId, batch.batchId);
    assert.ok(harness.confirmations.some(({ title, message }) => title === "预览并授权共享会话片段？" &&
      message.includes("synthetic user message") && message.includes("assistant reply")));
    assert.ok(harness.notifications.some(({ message }) => message.includes("已消费 1 条新来源")));
    assert.equal(harness.unregistrations.length, 0);
  }));
  });
});

test("cancel, Pi disconnect, shutdown, and a changed approved entry never start later bridge requests", async t => {
  const scenarios = ["confirm-cancel", "pi-abort", "disconnect", "shutdown", "session-start", "changed-leaf", "edited-text"] as const;
  for (const scenario of scenarios) await t.test(scenario, async () => {
    await withFakeDocker(async ({ requests }) => withConfig({ version: 1, projectDirectory: "/tmp/synthetic-compose-project" }, async () => {
      const harness = createHarness();
      await harness.command("shuguang-mcp", "connect", makeContext());
      const session = makeSessionManager();
      const entered = deferred<void>();
      const approval = deferred<boolean>();
      const controller = new AbortController();
      const operation = harness.command("shuguang-share", "", makeContext({
        sessionManager: session.manager,
        signal: controller.signal,
        confirm: async () => { entered.resolve(); return approval.promise; },
      }));
      await entered.promise;
      if (scenario === "confirm-cancel") approval.resolve(false);
      if (scenario === "pi-abort") { controller.abort(); approval.resolve(true); }
      if (scenario === "disconnect") { await harness.command("shuguang-mcp", "disconnect", makeContext()); approval.resolve(true); }
      if (scenario === "shutdown") { harness.fire("session_shutdown"); approval.resolve(true); }
      if (scenario === "session-start") { harness.fire("session_start"); approval.resolve(true); }
      if (scenario === "changed-leaf") { session.setLeaf("new_branch_leaf"); approval.resolve(true); }
      if (scenario === "edited-text") { session.setText("approved text changed after preview"); approval.resolve(true); }
      if (scenario === "confirm-cancel") await operation;
      else await assert.rejects(operation, /取消|重新|共享/);
      await new Promise(resolve => setTimeout(resolve, 20));
      const types = existsSync(requests) ? readFileSync(requests, "utf8").trim().split("\n").filter(Boolean).map(line => (JSON.parse(line) as { type: string }).type) : [];
      assert.deepEqual(types, ["status"], "cancelled or edited previews must not authorize or import");
      assert.equal(harness.unregistrations.length, scenario === "disconnect" || scenario === "shutdown" ? 1 : 0);
    }));
  });
});

test("connect rejects missing UI before reading either an explicit path or environment configuration", async () => {
  const previous = process.env[CONFIG_ENV];
  const dir = mkdtempSync(join(tmpdir(), "shuguang-no-ui-"));
  const nonexistent = join(dir, "must-not-be-read.json");
  process.env[CONFIG_ENV] = nonexistent;
  try {
    const harness = createHarness();
    await assert.rejects(harness.command("shuguang-mcp", `connect ${nonexistent}`, makeContext({ hasUI: false })),
      (error: Error) => error.message === UI_REQUIRED);
    assert.equal(harness.confirmations.length, 0);
    assert.equal(harness.registrations.length, 0);
    assert.equal(existsSync(nonexistent), false);
  } finally {
    if (previous === undefined) delete process.env[CONFIG_ENV]; else process.env[CONFIG_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("connect displays an escaped, exact readonly registration preview and registers only after approval", async () => {
  await withConfig({ version: 1, projectDirectory: '/tmp/project "quoted" \\\\ ; $(not-shell)', dockerContext: "dev.ctx", composeProject: "dawn-test" }, async (configPath) => {
    const harness = createHarness();
    await harness.command("shuguang-mcp", "connect", makeContext());
    assert.equal(harness.confirmations.length, 1);
    const confirmation = harness.confirmations[0]!;
    assert.equal(confirmation.title, "注册曙光 MCP？");
    const preview = JSON.parse(confirmation.message) as Record<string, unknown>;
    assert.equal(preview.explicitConfigFile, configPath);
    assert.equal(preview.projectDirectory, '/tmp/project "quoted" \\\\ ; $(not-shell)');
    assert.equal(preview.permission, "readonly");
    assert.match(String(preview.dockerAuthority), /强权限/);
    assert.match(String(preview.serviceBehavior), /不会启动\/唤醒/);
    assert.deepEqual(harness.registrations, [{
      name: "shuguang",
      config: {
        command: "docker",
        args: ["--context", "dev.ctx", "compose", "--project-directory", '/tmp/project "quoted" \\\\ ; $(not-shell)',
          "-f", '/tmp/project "quoted" \\\\ ; $(not-shell)/compose.yaml', "--project-name", "dawn-test", "exec", "-T", "dawn", "dawn-container", "mcp"],
        exposure: "codemode",
        timeout: 45,
        description: "曙光独立主体：显式交流与状态工具；不自动采集对话、检索或启动学习。",
      },
    }]);
    assert.ok(harness.notifications.some(({ message }) => message === "本会话已注册，请 /mcp 检查连接。"));
    assert.ok(!harness.notifications.some(({ message }) => /健康|已连接/.test(message)));
  });
});

test("an explicit connect path is one trimmed path value, supports spaces, and takes precedence over env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shuguang explicit config "));
  const path = join(dir, "connection settings.json");
  const previous = process.env[CONFIG_ENV];
  writeFileSync(path, JSON.stringify({ version: 1, projectDirectory: "/tmp/explicit-path" }), { mode: 0o600 });
  process.env[CONFIG_ENV] = join(dir, "env-path-must-not-be-read.json");
  try {
    const harness = createHarness();
    await harness.command("shuguang-mcp", `connect   ${path}  `, makeContext());
    assert.equal(JSON.parse(harness.confirmations[0]!.message).explicitConfigFile, path);
    assert.ok("command" in harness.registrations[0]!.config);
    assert.deepEqual(harness.registrations[0]!.config.args, ["compose", "--project-directory", "/tmp/explicit-path",
      "-f", "/tmp/explicit-path/compose.yaml", "exec", "-T", "dawn", "dawn-container", "mcp"]);
  } finally {
    if (previous === undefined) delete process.env[CONFIG_ENV]; else process.env[CONFIG_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status and disconnect reject extra arguments", async () => {
  const harness = createHarness();
  await assert.rejects(harness.command("shuguang-mcp", "status /extra", makeContext()), /用法：/);
  await assert.rejects(harness.command("shuguang-mcp", "disconnect /extra", makeContext()), /用法：/);
  assert.deepEqual(harness.unregistrations, []);
});

test("write-enabled permission is shown before approval and becomes an explicit argument", async () => {
  await withConfig({ version: 1, projectDirectory: "/tmp/shuguang-write", allowWrite: true }, async () => {
    const harness = createHarness();
    await harness.command("shuguang-mcp", "connect", makeContext());
    assert.equal(JSON.parse(harness.confirmations[0]!.message).permission, "write-enabled");
    assert.ok("command" in harness.registrations[0]!.config);
    assert.equal(harness.registrations[0]!.config.command, "docker");
    assert.deepEqual(harness.registrations[0]!.config.args?.slice(-6),
      ["exec", "-T", "dawn", "dawn-container", "mcp", "--allow-write"]);
  });
});

test("status is local and reports registration state, not MCP health", async () => {
  const previous = process.env[CONFIG_ENV];
  const dir = mkdtempSync(join(tmpdir(), "shuguang-status-"));
  const mcpJson = join(dir, "mcp.json");
  const configPath = join(dir, "connection.json");
  writeFileSync(mcpJson, '{"mcpServers":{"shuguang":{"command":"preserve-me"}}}\n', { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ version: 1, projectDirectory: "/tmp/shuguang-mcp-preserve" }), { mode: 0o600 });
  const before = readFileSync(mcpJson, "utf8");
  process.env[CONFIG_ENV] = join(dir, "missing-config-for-status.json");
  try {
    const harness = createHarness();
    await harness.command("shuguang-mcp", "status", makeContext());
    assert.match(harness.notifications.at(-1)!.message, /unregistered/);
    assert.match(harness.notifications.at(-1)!.message, /mcp\.json.*同名/);
    assert.match(harness.notifications.at(-1)!.message, /registerMcpServer/);
    process.env[CONFIG_ENV] = configPath;
    await harness.command("shuguang-mcp", "connect", makeContext());
    await harness.command("shuguang-mcp", "status", makeContext());
    assert.match(harness.notifications.at(-1)!.message, /registered/);
    assert.match(harness.notifications.at(-1)!.message, /mcp\.json.*同名/);
    await harness.command("shuguang-mcp", "disconnect", makeContext());
    assert.equal(harness.registrations.length, 1);
    assert.equal(readFileSync(mcpJson, "utf8"), before);
  } finally {
    if (previous === undefined) delete process.env[CONFIG_ENV]; else process.env[CONFIG_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancel and reject do not register", async () => {
  await withConfig({ version: 1, projectDirectory: "/tmp/shuguang-cancel" }, async () => {
    const harness = createHarness();
    const cancelled = makeContext({ confirm: async () => false });
    await harness.command("shuguang-mcp", "connect", cancelled);
    assert.equal(harness.registrations.length, 0);
    assert.ok(harness.notifications.some(({ message }) => message.includes("已取消")));
    await assert.rejects(harness.command("shuguang-mcp", "connect", makeContext({
      confirm: async () => { throw new Error("sensitive raw dialog error"); },
    })), (error: Error) => error.message === "无法完成曙光 MCP 确认；未注册。" && !error.message.includes("sensitive"));
    assert.equal(harness.registrations.length, 0);
  });
});

test("aborted Pi context signal prevents a late confirmation approval from registering", async () => {
  await withConfig({ version: 1, projectDirectory: "/tmp/shuguang-abort" }, async () => {
    const harness = createHarness();
    const entered = deferred<void>();
    const approval = deferred<boolean>();
    const controller = new AbortController();
    const operation = harness.command("shuguang-mcp", "connect", makeContext({
      signal: controller.signal,
      confirm: async () => { entered.resolve(); return approval.promise; },
    }));
    await entered.promise;
    controller.abort();
    approval.resolve(true);
    await operation;
    assert.equal(harness.registrations.length, 0);
  });
});

test("shutdown aborts pending confirmation and rejects its late approval", async () => {
  await withConfig({ version: 1, projectDirectory: "/tmp/shuguang-shutdown" }, async () => {
    const harness = createHarness();
    const entered = deferred<void>();
    const approval = deferred<boolean>();
    const operation = harness.command("shuguang-mcp", "connect", makeContext({
      confirm: async (_title, _message, signal) => {
        assert.ok(signal);
        harness.confirmations.push({ title: "observed", message: "", signal });
        entered.resolve();
        return approval.promise;
      },
    }));
    await entered.promise;
    harness.fire("session_shutdown");
    assert.equal(harness.confirmations[0]!.signal?.aborted, true);
    approval.resolve(true);
    await operation;
    assert.equal(harness.registrations.length, 0);
    assert.deepEqual(harness.unregistrations, []);
  });
});

test("disconnect invalidates an in-flight approval so a late yes cannot register", async () => {
  await withConfig({ version: 1, projectDirectory: "/tmp/shuguang-disconnect-pending" }, async () => {
    const harness = createHarness();
    const entered = deferred<void>();
    const approval = deferred<boolean>();
    const operation = harness.command("shuguang-mcp", "connect", makeContext({
      confirm: async () => { entered.resolve(); return approval.promise; },
    }));
    await entered.promise;
    await harness.command("shuguang-mcp", "disconnect", makeContext());
    approval.resolve(true);
    await operation;
    assert.equal(harness.registrations.length, 0);
    assert.deepEqual(harness.unregistrations, []);
  });
});

test("session_start invalidates an old pending approval without clearing the newer connect", async () => {
  await withConfig({ version: 1, projectDirectory: "/tmp/shuguang-session-start-race" }, async () => {
    const harness = createHarness();
    const firstEntered = deferred<void>();
    const firstApproval = deferred<boolean>();
    const secondEntered = deferred<void>();
    const secondApproval = deferred<boolean>();
    let confirmations = 0;
    const makeConfirmContext = (): ExtensionCommandContext => makeContext({
      confirm: async () => {
        confirmations += 1;
        if (confirmations === 1) { firstEntered.resolve(); return firstApproval.promise; }
        if (confirmations === 2) { secondEntered.resolve(); return secondApproval.promise; }
        assert.fail("unexpected confirmation");
      },
    });

    const oldConnect = harness.command("shuguang-mcp", "connect", makeConfirmContext());
    await firstEntered.promise;
    harness.fire("session_start");
    const newConnect = harness.command("shuguang-mcp", "connect", makeConfirmContext());
    await secondEntered.promise;

    firstApproval.resolve(true);
    await oldConnect;
    await harness.command("shuguang-mcp", "status", makeContext());
    assert.match(harness.notifications.at(-1)!.message, /连接确认进行中/);
    assert.equal(harness.registrations.length, 0);

    secondApproval.resolve(true);
    await newConnect;
    assert.equal(harness.registrations.length, 1);
    assert.equal(harness.confirmations.length, 2);
  });
});

test("concurrent connect is serialized and duplicate connect requires disconnect", async () => {
  await withConfig({ version: 1, projectDirectory: "/tmp/shuguang-serial" }, async () => {
    const harness = createHarness();
    const entered = deferred<void>();
    const approval = deferred<boolean>();
    const first = harness.command("shuguang-mcp", "connect", makeContext({
      confirm: async () => { entered.resolve(); return approval.promise; },
    }));
    await entered.promise;
    await assert.rejects(harness.command("shuguang-mcp", "connect", makeContext()),
      (error: Error) => error.message === CONNECT_PENDING);
    approval.resolve(true);
    await first;
    assert.equal(harness.registrations.length, 1);
    await assert.rejects(harness.command("shuguang-mcp", "connect", makeContext()),
      (error: Error) => error.message === ALREADY_REGISTERED);
    assert.equal(harness.confirmations.length, 1);
    assert.equal(harness.registrations.length, 1);
  });
});

test("disconnect only unregisters the registration this extension owns", async () => {
  const harness = createHarness();
  await harness.command("shuguang-mcp", "disconnect", makeContext());
  assert.deepEqual(harness.unregistrations, []);
  await withConfig({ version: 1, projectDirectory: "/tmp/shuguang-disconnect" }, async () => {
    await harness.command("shuguang-mcp", "connect", makeContext());
    await harness.command("shuguang-mcp", "disconnect", makeContext());
    await harness.command("shuguang-mcp", "disconnect", makeContext());
    assert.deepEqual(harness.unregistrations, ["shuguang"]);
    assert.equal(harness.registrations.length, 1);
    assert.ok(harness.notifications.some(({ message }) => message.includes("未停止曙光本体")));
  });
});

test("shutdown unregisters an owned registration and session_start only rearms commands", async () => {
  await withConfig({ version: 1, projectDirectory: "/tmp/shuguang-lifecycle" }, async () => {
    const harness = createHarness();
    await harness.command("shuguang-mcp", "connect", makeContext());
    harness.fire("session_shutdown");
    assert.deepEqual(harness.unregistrations, ["shuguang"]);
    harness.fire("session_start");
    await harness.command("shuguang-mcp", "status", makeContext());
    assert.match(harness.notifications.at(-1)!.message, /unregistered/);
    assert.equal(harness.registrations.length, 1);
    assert.equal(harness.confirmations.length, 1);
  });
});

test("configuration loading errors are fixed and do not echo paths or host errors", async () => {
  const previous = process.env[CONFIG_ENV];
  process.env[CONFIG_ENV] = "/definitely/missing/private-config.json";
  try {
    const harness = createHarness();
    await assert.rejects(harness.command("shuguang-mcp", "connect", makeContext()),
      (error: Error) => error.message === "曙光配置无效或无法读取；请检查显式配置文件。" &&
        !error.message.includes("/definitely") && !error.message.includes("ENOENT"));
    assert.equal(harness.confirmations.length, 0);
    assert.equal(harness.registrations.length, 0);
  } finally {
    if (previous === undefined) delete process.env[CONFIG_ENV]; else process.env[CONFIG_ENV] = previous;
  }
});

test("UI disappearing while confirmation is pending blocks a late approval", async () => {
  await withConfig({ version: 1, projectDirectory: "/tmp/shuguang-ui-disappears" }, async () => {
    const harness = createHarness();
    const entered = deferred<void>();
    const approval = deferred<boolean>();
    let uiAvailable = true;
    const operation = harness.command("shuguang-mcp", "connect", makeContext({
      hasUI: () => uiAvailable,
      confirm: async () => { entered.resolve(); return approval.promise; },
    }));
    await entered.promise;
    uiAvailable = false;
    approval.resolve(true);
    await assert.rejects(operation, (error: Error) => error.message === UI_REQUIRED);
    assert.equal(harness.registrations.length, 0);
  });
});

test("failed owned unregister remains registered and can be disconnected after retry", async () => {
  await withConfig({ version: 1, projectDirectory: "/tmp/shuguang-unregister-retry" }, async () => {
    const harness = createHarness();
    await harness.command("shuguang-mcp", "connect", makeContext());
    harness.unregisterError = new Error("private adapter failure");
    await assert.rejects(harness.command("shuguang-mcp", "disconnect", makeContext()),
      (error: Error) => error.message === UNREGISTER_FAILED);
    await harness.command("shuguang-mcp", "status", makeContext());
    assert.match(harness.notifications.at(-1)!.message, /registered/);

    harness.unregisterError = undefined;
    await harness.command("shuguang-mcp", "disconnect", makeContext());
    await harness.command("shuguang-mcp", "status", makeContext());
    assert.match(harness.notifications.at(-1)!.message, /unregistered/);
    assert.deepEqual(harness.unregistrations, ["shuguang"]);
  });
});

test("registration and unregistration errors are fixed and do not echo host exceptions", async () => {
  await withConfig({ version: 1, projectDirectory: "/tmp/shuguang-errors" }, async () => {
    const failedRegistration = createHarness();
    failedRegistration.registerError = new Error("PRIVATE SECRET /home/user/model.env");
    await assert.rejects(failedRegistration.command("shuguang-mcp", "connect", makeContext()),
      (error: Error) => error.message === REGISTER_FAILED && !error.message.includes("SECRET"));
    assert.equal(failedRegistration.registrations.length, 0);

    const failedUnregister = createHarness();
    await failedUnregister.command("shuguang-mcp", "connect", makeContext());
    failedUnregister.unregisterError = new Error("PRIVATE SECRET");
    await assert.rejects(failedUnregister.command("shuguang-mcp", "disconnect", makeContext()),
      (error: Error) => error.message === UNREGISTER_FAILED && !error.message.includes("SECRET"));
  });
});

test("research start/resume requires this package's current registration before config, provider or history access", async () => {
  const harness = createHarness();
  for (const action of ["start /missing/plan.json", "resume run"]) {
    await assert.rejects(harness.command("shuguang-research", action, makeContext()), /必须先/);
  }
  await assert.rejects(harness.command("shuguang-research", "status run", makeContext({ hasUI: false })), /确认界面/);
  await withConfig({ version: 1, projectDirectory: "/synthetic/repo" }, async () => {
    await harness.command("shuguang-mcp", "connect", makeContext());
    await harness.command("shuguang-mcp", "disconnect", makeContext());
    await assert.rejects(harness.command("shuguang-research", "resume run", makeContext()), /必须先/);
  });
});

test("research idle wait aborts before creating a bridge and releases single-flight for later operations", async () => {
  await withConfig({ version: 1, projectDirectory: "/synthetic/repo" }, async () => {
    const harness = createHarness(); await harness.command("shuguang-mcp", "connect", makeContext());
    const controller = new AbortController(); let entered!: () => void; const waiting = new Promise<void>(r => { entered = r; });
    const work = harness.command("shuguang-research", "start /missing/plan.json", makeContext({ signal: controller.signal, waitForIdle: () => { entered(); return new Promise(() => {}); } }));
    const rejected = assert.rejects(work, /研究已取消/); await waiting; controller.abort(); await rejected;
    const subsequent = harness.command("shuguang-research", "start /missing/plan.json", makeContext());
    await assert.rejects(subsequent, error => error instanceof Error && !error.message.includes("进行中"));
  });
});

test("research stop rechecks UI after a late affirmative confirmation and sends no stop", async () => {
  const researchState = { runId: "run", status: "paused", revision: 1, fence: 1, pendingModel: false, searchReserved: 0, modelReserved: 0, searchesReserved: 0, modelCallsReserved: 0,
    maxSearches: 1, maxModelCalls: 2, completedGoals: 0, totalGoals: 1, allGoalsPassed: false, verification: "verification_pending", tasks: [], goals: [{ goalId: "g0", stage: "unstarted", grade: null, verification: "verification_pending" }] };
  await withConfig({ version: 1, projectDirectory: "/synthetic/repo" }, async () => {
    await withFakeDocker(async ({ requests }) => {
      const harness = createHarness(); await harness.command("shuguang-mcp", "connect", makeContext());
      let available = true;
      const ctx = makeContext({ hasUI: () => available, confirm: async () => { available = false; return true; } });
      await assert.rejects(harness.command("shuguang-research", "stop run", ctx), /确认界面/);
      const recorded = readFileSync(requests, "utf8"); assert.match(recorded, /research-status/); assert.doesNotMatch(recorded, /research-stop/);
    }, 0, researchState);
  });
});

test("research start previews exact public inputs after idle, never history or answers, and refusal makes zero research dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-research-command-")), planFile = join(dir, "plan.json");
  const plan = { version: 1, runId: "run", expiresAt: new Date(Date.now() + 120_000).toISOString(), maxSearches: 1, maxModelCalls: 2,
    goals: [{ id: "g0", question: "Public question", query: "exact approved public input", topics: ["public"], practice: [{ id: "p0", prompt: "Practice", answer: "PRIVATE_PRACTICE" }], assessment: [{ id: "a0", prompt: "Heldout", answer: "PRIVATE_TEST" }] }] };
  writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
  const envName = "SHUGUANG_SYNTHETIC_RESEARCH_KEY", old = process.env[envName]; process.env[envName] = "synthetic-key-never-used";
  try {
    await withConfig({ version: 1, projectDirectory: "/synthetic/repo", search: { provider: "tavily", credentialEnv: envName } }, async () => {
      await withFakeDocker(async ({ requests }) => {
        const harness = createHarness(); await harness.command("shuguang-mcp", "connect", makeContext()); let idle = false;
        await harness.command("shuguang-research", `start ${planFile}`, makeContext({ waitForIdle: async () => { idle = true; }, confirm: async (_title, preview) => {
          assert.equal(idle, true); assert.match(preview, /exact approved public input/); assert.doesNotMatch(preview, /PRIVATE_PRACTICE|PRIVATE_TEST|synthetic-key/); return false;
        } }));
        const log = readFileSync(requests, "utf8"); assert.match(log, /"type":"status"/); assert.doesNotMatch(log, /research-start|research-claim|research-step/);
      }, 0, {});
    });
  } finally { if (old === undefined) delete process.env[envName]; else process.env[envName] = old; rmSync(dir, { recursive: true, force: true }); }
});

const remoteConfig = { version: 1, url: "https://synthetic.example:8443/mcp", credentialEnv: "SHUGUANG_MCP_TOKEN", allowWrite: false };
const REMOTE_GATE = "远程连接当前仅支持普通MCP交流与控制；片段共享和研究私有桥尚不支持";
test("remote preview distinguishes HTTPS/Env/client scope without credentials or Docker; no credential lookup", async () => {
  await withFakeDocker(async ({ argv, requests }) => withConfig(remoteConfig, async path => {
    const harness = createHarness();
    const originalEnv = process.env;
    process.env = new Proxy(originalEnv, { get(target, key) {
      if (key === remoteConfig.credentialEnv) assert.fail("must not look up MCP token");
      return Reflect.get(target, key);
    } });
    try {
      await harness.command("shuguang-mcp", `connect ${path}`, makeContext());
      const preview = JSON.parse(harness.confirmations[0]!.message);
      assert.equal(preview.transport, "remote");
      assert.equal(preview.url, remoteConfig.url);
      assert.equal(preview.httpsOrigin, "https://synthetic.example:8443");
      assert.equal(preview.credentialEnv, remoteConfig.credentialEnv);
      assert.match(preview.authentication, /Bearer \$\{SHUGUANG_MCP_TOKEN\}/);
      assert.match(preview.authorization, /不是服务器ACL/);
      assert.match(preview.serviceBehavior, /不会启动\/唤醒/);
      assert.equal(preview.privateBridge, REMOTE_GATE);
      assert.equal(preview.permission, "readonly");
      assert.doesNotMatch(harness.confirmations[0]!.message, /docker|compose|projectDirectory|owner.token/i);
      assert.equal(harness.registrations[0]!.config.toolExposure?.shuguang_say, "hidden");
      await harness.command("shuguang-mcp", "status", makeContext());
      assert.match(harness.notifications.at(-1)!.message, /remote HTTPS https:\/\/synthetic.example:8443/);
      await harness.command("shuguang-mcp", "disconnect", makeContext());
      assert.deepEqual(harness.unregistrations, ["shuguang"]);
    } finally { process.env = originalEnv; }
    assert.equal(existsSync(argv), false); assert.equal(existsSync(requests), false);
  }));
});

test("remote share and every research action fail closed before idle/history/plan/provider/child, including remembered and env config", async () => {
  for (const allowWrite of [false, true]) await withFakeDocker(async ({ argv, requests }) => withConfig({ ...remoteConfig, allowWrite }, async () => {
    const harness = createHarness();
    await harness.command("shuguang-mcp", "connect", makeContext());
    const history = makeSessionManager();
    const ctx = makeContext({ sessionManager: history.manager, waitForIdle: async () => assert.fail("remote must gate before idle") });
    await assert.rejects(harness.command("shuguang-share", "4", ctx), (e: Error) => e.message === REMOTE_GATE);
    for (const action of ["start /must-not-read/private-plan.json", "resume run", "status run", "stop run"]) {
      await assert.rejects(harness.command("shuguang-research", action, ctx), (e: Error) => e.message === REMOTE_GATE);
    }
    await harness.command("shuguang-mcp", "disconnect", makeContext());
    for (const action of ["status run", "stop run"]) {
      await assert.rejects(harness.command("shuguang-research", action, ctx), (e: Error) => e.message === REMOTE_GATE);
      // A new extension may use explicit config env for owner status/stop, but never a remote bridge.
      await assert.rejects(createHarness().command("shuguang-research", action, ctx), (e: Error) => e.message === REMOTE_GATE);
    }
    assert.equal(history.reads(), 0);
    assert.equal(harness.confirmations.length, 1);
    assert.equal(existsSync(argv), false); assert.equal(existsSync(requests), false);
  }));
});

test("remote cancel, late abort and no UI retain the local confirmation guarantees", async () => {
  await withConfig(remoteConfig, async () => {
    const harness = createHarness();
    await assert.rejects(harness.command("shuguang-mcp", "connect", makeContext({ hasUI: false })), /确认界面/);
    await harness.command("shuguang-mcp", "connect", makeContext({ confirm: async () => false }));
    const controller = new AbortController();
    await harness.command("shuguang-mcp", "connect", makeContext({ signal: controller.signal,
      confirm: async () => { controller.abort(); return true; } }));
    assert.equal(harness.registrations.length, 0);
  });
});
