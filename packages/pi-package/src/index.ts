import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildHostBridgeRegistration, buildMcpRegistration, loadCompanionConfig, parseCompanionConfig, REMOTE_BRIDGE_UNSUPPORTED, type CompanionConfig } from "./config.ts";
import { createHostClient, type HostClient, type HostRequestInput, type HostResponse } from "./host-client.ts";
import { buildSharedBatch, MAX_SHARED_FRAGMENTS, type SharedBatch } from "./sharing.ts";
import { createTavilySearchProvider } from "./search-provider.ts";
import { loadResearchPlan, researchPlanPreview, runResearchLoop, summarizeResearchStatus, type ResearchBridge, type ResearchBridgeResult, type ResearchStatus } from "./research.ts";

const SERVER_NAME = "shuguang";
const CONFIG_ENV = "SHUGUANG_PI_CONFIG";
const UI_REQUIRED = "连接曙光 MCP 需要可用的确认界面。";
const ALREADY_REGISTERED = "曙光 MCP 已由本扩展注册；请先运行 /shuguang-mcp disconnect。";
const CONNECT_PENDING = "曙光 MCP 连接确认仍在进行中，请稍后再试。";
const INVALID_CONFIG = "曙光配置无效或无法读取；请检查显式配置文件。";
const CONFIRM_FAILED = "无法完成曙光 MCP 确认；未注册。";
const REGISTER_FAILED = "无法注册曙光 MCP；请检查 Pi MCP 扩展支持。";
const UNREGISTER_FAILED = "无法注销本扩展拥有的曙光 MCP 注册。";
const SESSION_STOPPING = "当前 Pi 会话正在关闭，不能连接曙光 MCP。";
const SHARE_UI_REQUIRED = "共享曙光会话片段需要可用的确认界面。";
const SHARE_NOT_CONNECTED = "只有本扩展已注册的曙光 MCP 会话才能共享片段。";
const SHARE_IN_PROGRESS = "曙光会话共享已在进行中，请稍后再试。";
const SHARE_CANCELLED = "会话共享已取消；未继续导入。";
const SHARE_FAILED = "无法完成曙光会话共享；未能确认导入结果。";
const SHARE_UNAVAILABLE = "曙光主体当前不可接收会话片段。";
const RESEARCH_UI_REQUIRED = "曙光自主研究需要可用的确认界面。";
const RESEARCH_NOT_REGISTERED = "启动或继续研究前，必须先由本扩展注册曙光 MCP。";
const RESEARCH_BUSY = "曙光研究操作已在进行中。";
const RESEARCH_UNSUPPORTED = "当前主体/搜索配置不支持自主研究；未启动研究或外呼。";
const RESEARCH_FAILED = "无法完成曙光自主研究操作；未知任务不会自动重派。";

interface PendingConnect {
  readonly generation: number;
  readonly controller: AbortController;
}
interface PendingShare {
  readonly generation: number;
  readonly controller: AbortController;
  client?: HostClient;
}
interface PendingResearch {
  readonly generation: number;
  readonly controller: AbortController;
  client?: HostClient;
  runId: string;
  pauseOnCancel: boolean;
}

type RequestInput = HostRequestInput;

function isCancelled(operation: PendingConnect, current: PendingConnect | undefined, generation: number,
  shuttingDown: boolean, signal: AbortSignal | undefined): boolean {
  return current !== operation || operation.generation !== generation || shuttingDown ||
    operation.controller.signal.aborted || signal?.aborted === true;
}

function confirmBody(path: string, config: CompanionConfig,
  registration: ReturnType<typeof buildMcpRegistration>): string {
  if (config.url !== undefined && "url" in registration) {
    return JSON.stringify({
      action: "为当前 Pi 会话注册 Shuguang MCP（名称：shuguang）",
      transport: "remote",
      explicitConfigFile: path,
      url: registration.url,
      httpsOrigin: new URL(registration.url).origin,
      credentialEnv: config.credentialEnv,
      authentication: `Authorization: Bearer \${${config.credentialEnv}}（仅Env引用，由宿主解析；本包不读取凭据）`,
      permission: config.allowWrite ? "write-enabled" : "readonly",
      toolExposure: registration.toolExposure ?? {},
      authorization: "allowWrite仅控制客户端工具暴露，不是服务器ACL；远程服务必须独立限制凭据的读写权限。只读会隐藏六个现有写/联网工具，不保证未知服务工具安全。",
      serviceBehavior: "仅连接已运行的HTTPS MCP；不会启动/唤醒曙光本体，也不会自动重连或切换本地连接。",
      privateBridge: REMOTE_BRIDGE_UNSUPPORTED,
      persistence: "只在当前会话注册；不写 mcp.json/settings，不安装或启动其他服务。",
    }, null, 2);
  }
  if (config.url !== undefined || !("command" in registration)) throw new Error(INVALID_CONFIG);
  return JSON.stringify({
    transport: "local",
    action: "为当前 Pi 会话注册 Shuguang MCP（名称：shuguang）",
    explicitConfigFile: path,
    projectDirectory: config.projectDirectory,
    dockerContext: config.dockerContext ?? null,
    composeProject: config.composeProject ?? null,
    permission: config.allowWrite ? "write-enabled" : "readonly",
    command: registration.command,
    args: registration.args,
    dockerAuthority: "强权限：以 Pi 进程身份调用 Docker；可达范围取决于 Docker daemon 配置，可能达到宿主机级权限。不要把 Docker 当作安全沙箱。",
    serviceBehavior: "只对已运行的 dawn 服务执行 compose exec；不会启动/唤醒曙光本体。",
    persistence: "只在当前会话注册；不写 mcp.json/settings，不安装或启动其他服务。",
  }, null, 2);
}

function cancellationNotice(ctx: ExtensionContext): void {
  ctx.ui.notify("连接已取消；曙光 MCP 未注册。", "warning");
}

export default function shuguangMcpExtension(pi: ExtensionAPI): void {
  let registered = false;
  let registeredAllowWrite: boolean | undefined;
  let registeredConfig: CompanionConfig | undefined;
  // A validated connection config remains available for explicit owner status/stop after disconnect.
  let rememberedConfig: CompanionConfig | undefined;
  let pending: PendingConnect | undefined;
  let activeShare: PendingShare | undefined;
  let activeResearch: PendingResearch | undefined;
  const researchOperations = new Set<PendingResearch>();
  let generation = 0;
  let shareGeneration = 0;
  let researchGeneration = 0;
  let shuttingDown = false;

  function cancelPending(): void {
    generation += 1;
    const previous = pending;
    pending = undefined;
    previous?.controller.abort();
  }

  function cancelShare(): void {
    shareGeneration += 1;
    const operation = activeShare;
    activeShare = undefined;
    operation?.controller.abort();
    operation?.client?.close();
  }

  function cancelResearch(): void {
    researchGeneration += 1;
    activeResearch = undefined;
    for (const operation of researchOperations) {
      operation.controller.abort();
      const client = operation.client;
      if (!client) continue;
      if (!operation.pauseOnCancel) { client.close(); continue; }
      // Best effort only: if an HTTP request was already interrupted, EOF fences the binding instead.
      const pauseSignal = new AbortController();
      const timer = setTimeout(() => pauseSignal.abort(), 250);
      timer.unref?.();
      void client.request({ type: "research-pause", runId: operation.runId }, pauseSignal.signal)
        .catch(() => undefined)
        .finally(() => { clearTimeout(timer); pauseSignal.abort(); client.close(); });
    }
    researchOperations.clear();
  }

  function unregisterOwned(): void {
    if (!registered) return;
    try {
      pi.unregisterMcpServer(SERVER_NAME);
    } catch {
      throw new Error(UNREGISTER_FAILED);
    }
    registered = false;
    registeredAllowWrite = undefined;
    registeredConfig = undefined;
  }

  function status(ctx: ExtensionCommandContext): void {
    const state = registered ? "registered" : "unregistered";
    const permission = registered
      ? (registeredAllowWrite ? "write" : "readonly")
      : "未读取配置；下次连接默认 readonly（仅显式 allowWrite=true 才启用写权限）";
    const pendingText = pending ? "；连接确认进行中" : "";
    const connection = registeredConfig?.url !== undefined
      ? `remote HTTPS ${new URL(registeredConfig.url).origin}（Env引用：${registeredConfig.credentialEnv}；客户端工具范围不替代服务器ACL）`
      : registered ? "local Docker" : "未注册";
    ctx.ui.notify(
      `曙光 MCP：${state}${pendingText}；连接：${connection}；权限：${permission}。registered 只表示本扩展提交了注册，不代表服务已连接或健康。\n` +
      "请用 /mcp 检查连接；若 mcp.json 存在同名 shuguang 配置，它优先于本扩展。替代 MCP adapter 必须支持 registerMcpServer。",
      "info",
    );
  }

  async function connect(ctx: ExtensionCommandContext, explicitConfigPath?: string): Promise<void> {
    // Fail before reading the environment or touching the explicit config path.
    if (!ctx.hasUI) throw new Error(UI_REQUIRED);
    if (shuttingDown) throw new Error(SESSION_STOPPING);
    if (registered) throw new Error(ALREADY_REGISTERED);
    if (pending) throw new Error(CONNECT_PENDING);

    const operation: PendingConnect = { generation, controller: new AbortController() };
    pending = operation;
    const externalSignal = ctx.signal;
    const abortFromPi = (): void => operation.controller.abort();
    if (externalSignal?.aborted) abortFromPi();
    else externalSignal?.addEventListener("abort", abortFromPi, { once: true });

    try {
      if (!ctx.hasUI) throw new Error(UI_REQUIRED);
      if (isCancelled(operation, pending, generation, shuttingDown, externalSignal)) {
        if (!shuttingDown) cancellationNotice(ctx);
        return;
      }
      const configPath = explicitConfigPath || process.env[CONFIG_ENV];
      if (!configPath) throw new Error(INVALID_CONFIG);

      let config: CompanionConfig;
      let registration: ReturnType<typeof buildMcpRegistration>;
      try {
        config = loadCompanionConfig(configPath);
        registration = buildMcpRegistration(config);
      } catch {
        throw new Error(INVALID_CONFIG);
      }

      if (isCancelled(operation, pending, generation, shuttingDown, externalSignal)) {
        if (!shuttingDown) cancellationNotice(ctx);
        return;
      }
      // Recheck UI availability immediately before asking for explicit approval.
      if (!ctx.hasUI) throw new Error(UI_REQUIRED);

      let approved: boolean;
      try {
        approved = await ctx.ui.confirm("注册曙光 MCP？", confirmBody(configPath, config, registration), {
          signal: operation.controller.signal,
        });
      } catch {
        if (isCancelled(operation, pending, generation, shuttingDown, externalSignal)) {
          if (!shuttingDown) cancellationNotice(ctx);
          return;
        }
        throw new Error(CONFIRM_FAILED);
      }

      if (isCancelled(operation, pending, generation, shuttingDown, externalSignal)) {
        if (!shuttingDown) cancellationNotice(ctx);
        return;
      }
      if (!ctx.hasUI) throw new Error(UI_REQUIRED);
      if (!approved) {
        cancellationNotice(ctx);
        return;
      }

      // There is no await between the final invalidation check and the synchronous registration.
      if (isCancelled(operation, pending, generation, shuttingDown, externalSignal)) {
        if (!shuttingDown) cancellationNotice(ctx);
        return;
      }
      try {
        pi.registerMcpServer(SERVER_NAME, registration);
      } catch {
        throw new Error(REGISTER_FAILED);
      }
      registered = true;
      registeredAllowWrite = config.allowWrite;
      // Retain a validated plain-data copy only after Pi accepted this registration.
      registeredConfig = parseCompanionConfig({ ...config });
      rememberedConfig = registeredConfig;
      ctx.ui.notify("本会话已注册，请 /mcp 检查连接。", "info");
    } finally {
      externalSignal?.removeEventListener("abort", abortFromPi);
      if (pending === operation) pending = undefined;
    }
  }

  function researchProvider(config: CompanionConfig): ReturnType<typeof createTavilySearchProvider> | undefined {
    if (!config.search || config.search.provider !== "tavily") return undefined;
    try { return createTavilySearchProvider({ credentialEnv: config.search.credentialEnv }); }
    catch { return undefined; }
  }

  function bridgeView(client: HostClient): ResearchBridge {
    return {
      signal: client.signal,
      async request(input, signal) {
        const response = await client.request(input as HostRequestInput, signal);
        if (response.type === "error") return { type: "error", code: response.code };
        if (response.type === "research" || response.type === "research-task" || response.type === "research-claim") return response;
        throw new Error(RESEARCH_FAILED);
      },
      close: () => client.close(),
    };
  }

  async function research(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) throw new Error(RESEARCH_UI_REQUIRED);
    if (shuttingDown) throw new Error(SESSION_STOPPING);
    const match = /^(start|resume|status|stop)\s+(.+)$/u.exec(args.trim());
    if (!match) throw new Error("用法：/shuguang-research start /绝对plan.json|resume <runId>|status <runId>|stop <runId>");
    const action = match[1]!;
    const target = match[2]!.trim();
    if (action === "start" ? !target.startsWith("/") : !/^[A-Za-z0-9_-]{1,128}$/u.test(target)) {
      throw new Error("研究计划必须是绝对路径；其他操作必须提供有效runId。");
    }
    if ((registeredConfig ?? rememberedConfig)?.url !== undefined) throw new Error(REMOTE_BRIDGE_UNSUPPORTED);
    if ((action === "start" || action === "resume") && (!registered || !registeredConfig)) throw new Error(RESEARCH_NOT_REGISTERED);
    if ((action === "start" || action === "resume") && (activeResearch || activeShare)) throw new Error(RESEARCH_BUSY);
    const controller = new AbortController();
    const isLongRunning = action === "start" || action === "resume";
    const operation: PendingResearch = { generation: researchGeneration, controller, runId: action === "start" ? "pending" : target,
      pauseOnCancel: false };
    researchOperations.add(operation);
    if (isLongRunning) activeResearch = operation;
    const externalSignal = ctx.signal;
    const abortFromPi = (): void => controller.abort();
    if (externalSignal?.aborted) abortFromPi();
    else externalSignal?.addEventListener("abort", abortFromPi, { once: true });
    let client: HostClient | undefined;
    const onBridgeClosed = (): void => controller.abort();
    const alive = (): boolean => (!isLongRunning || activeResearch === operation) && operation.generation === researchGeneration &&
      !shuttingDown && !controller.signal.aborted;
    const request = async (input: HostRequestInput): Promise<HostResponse> => {
      if (!alive() || !client) throw new Error(RESEARCH_FAILED);
      return client.request(input, controller.signal);
    };
    try {
      if (isLongRunning) {
        controller.signal.throwIfAborted();
        let onAbort!: () => void;
        const cancelled = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error(RESEARCH_FAILED));
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
        try { await Promise.race([ctx.waitForIdle(), cancelled]); }
        finally { controller.signal.removeEventListener("abort", onAbort); }
        controller.signal.throwIfAborted();
        if (!ctx.hasUI || !alive()) throw new Error(RESEARCH_UI_REQUIRED);
      }
      let config = registeredConfig ?? rememberedConfig;
      if (!config && process.env[CONFIG_ENV]) {
        try { config = loadCompanionConfig(process.env[CONFIG_ENV]!); } catch { throw new Error(INVALID_CONFIG); }
      }
      if (!config) throw new Error(INVALID_CONFIG);
      config = parseCompanionConfig({ ...config });
      if (config.url !== undefined) throw new Error(REMOTE_BRIDGE_UNSUPPORTED);
      const host = buildHostBridgeRegistration(config);
      const hostSessionStartedAt = Date.now();
      client = createHostClient(host.command, host.args ?? [], { signal: controller.signal });
      client.signal.addEventListener("abort", onBridgeClosed, { once: true });
      if (client.signal.aborted) onBridgeClosed();
      // Track only long-running start/resume. status/stop use independent owner-auth bridge sessions.
      operation.client = client;
      const bridge = bridgeView(client);
      const ownerStatus = async (runId: string): Promise<ResearchStatus> => {
        const response = await request({ type: "research-status", runId });
        if (response.type !== "research") throw new Error(RESEARCH_FAILED);
        return response.status;
      };
      const provider = researchProvider(config);
      if (action === "start" || action === "resume") {
        if (!provider || provider.status().supported !== true || provider.status().available !== true) throw new Error(RESEARCH_UNSUPPORTED);
      }

      if (action === "start") {
        if (!ctx.hasUI || shuttingDown || !alive()) throw new Error(RESEARCH_UI_REQUIRED);
        let plan;
        try { plan = loadResearchPlan(target); } catch { throw new Error("研究计划无效、超出安全限制或不可由当前用户读取。"); }
        const now = Date.now();
        const expiry = Date.parse(plan.expiresAt);
        // Host pairing is deliberately a single <=10-minute session. Reject rather than silently edit the approved plan.
        if (expiry <= now || expiry > hostSessionStartedAt + 10 * 60_000) throw new Error("研究计划必须尚未过期，且有效期不得超过私有桥10分钟会话。");
        if (!provider) throw new Error(RESEARCH_UNSUPPORTED);
        const status = await request({ type: "status" });
        if (status.type !== "status" || !status.supported || status.researchSupported !== true || status.lifecycle !== "awake") {
          throw new Error(RESEARCH_UNSUPPORTED);
        }
        if (!ctx.hasUI) throw new Error(RESEARCH_UI_REQUIRED);
        const modelDisclosure = "使用曙光主体已配置的自有模型与共享永久模型额度；Pi不会调用宿主主模型。当前安全状态未提供具体modelId/provider，故Pi无法进一步披露其标识。";
        const preview = researchPlanPreview(plan, "Tavily Web Search（固定接口；API凭据只从显式配置的环境变量读取，不发给曙光模型）", modelDisclosure);
        if (!await ctx.ui.confirm("预览并启动曙光自主研究？", preview, { signal: controller.signal })) {
          ctx.ui.notify("研究已取消；没有启动学习或搜索。", "warning"); return;
        }
        if (!alive() || !ctx.hasUI) throw new Error(RESEARCH_UI_REQUIRED);
        const started = await request({ type: "research-start", plan });
        if (started.type !== "research" || started.status.runId !== plan.runId || started.status.status !== "active") throw new Error(RESEARCH_FAILED);
        operation.runId = plan.runId;
        operation.pauseOnCancel = true;
        const result = await runResearchLoop({ bridge, provider, runId: plan.runId, expiresAt: plan.expiresAt,
          initialStatus: started.status, signal: controller.signal, onStatus: status => { operation.runId = status.runId; } });
        if (alive()) ctx.ui.notify(summarizeResearchStatus(result), "info");
        return;
      }

      const current = await ownerStatus(target);
      if (action === "status") {
        ctx.ui.notify(summarizeResearchStatus(current), "info");
        return;
      }
      if (action === "stop") {
        if (!ctx.hasUI) throw new Error(RESEARCH_UI_REQUIRED);
        const accepted = await ctx.ui.confirm("停止曙光研究？", `${summarizeResearchStatus(current)}\n停止会持久撤销run并拒绝迟到结果；已预占费用不退款。此操作不停止或休眠曙光主体。`, { signal: controller.signal });
        if (!accepted) { ctx.ui.notify("停止已取消。", "warning"); return; }
        if (!alive() || !ctx.hasUI) throw new Error(RESEARCH_UI_REQUIRED);
        const stopped = await request({ type: "research-stop", runId: target });
        if (stopped.type !== "research") throw new Error(RESEARCH_FAILED);
        // Stop the matching local provider immediately too; the durable server fence remains authoritative.
        if (activeResearch?.runId === target) { activeResearch.controller.abort(); activeResearch.client?.close(); }
        ctx.ui.notify(summarizeResearchStatus(stopped.status), "info");
        return;
      }
      if (current.status !== "paused" && current.status !== "paused_restart") throw new Error("只能从paused/paused_restart安全状态显式恢复；未恢复。");
      if (!provider) throw new Error(RESEARCH_UNSUPPORTED);
      const approved = await ctx.ui.confirm("预览并继续曙光研究？", `${summarizeResearchStatus(current)}\n恢复仅继续未派发阶段；claimed/unknown任务不会重派。具体query仅在领取前仍隐藏。`, { signal: controller.signal });
      if (!approved) { ctx.ui.notify("研究恢复已取消。", "warning"); return; }
      if (!alive() || !ctx.hasUI) throw new Error(RESEARCH_UI_REQUIRED);
      const resumed = await request({ type: "research-resume", runId: target });
      if (resumed.type !== "research" || resumed.status.status !== "active") throw new Error(RESEARCH_FAILED);
      operation.runId = target;
      operation.pauseOnCancel = true;
      const result = await runResearchLoop({ bridge, provider, runId: target, expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
        initialStatus: resumed.status, signal: controller.signal, onStatus: status => { operation.runId = status.runId; } });
      if (alive()) ctx.ui.notify(summarizeResearchStatus(result), "info");
    } catch (error) {
      if (controller.signal.aborted || !alive()) throw new Error("研究已取消；桥断开后状态可能未知，不会自动重连或重派。");
      if (error instanceof Error && [RESEARCH_UI_REQUIRED, RESEARCH_NOT_REGISTERED, RESEARCH_BUSY, RESEARCH_UNSUPPORTED, RESEARCH_FAILED, REMOTE_BRIDGE_UNSUPPORTED].includes(error.message)) throw error;
      if (error instanceof Error && error.message.startsWith("研究计划")) throw error;
      if (error instanceof Error && (error.message.includes("只能从paused") || error.message.includes("超时") || error.message.includes("unknown"))) throw error;
      throw new Error(RESEARCH_FAILED);
    } finally {
      externalSignal?.removeEventListener("abort", abortFromPi);
      client?.signal.removeEventListener("abort", onBridgeClosed);
      client?.close();
      if (activeResearch === operation) activeResearch = undefined;
      researchOperations.delete(operation);
    }
  }

  pi.registerCommand("shuguang-research", {
    description: "预览并启动/检查/停止/继续曙光的有界自主研究",
    handler: async (args, ctx) => research(args, ctx),
  });

  async function share(args: string, ctx: ExtensionCommandContext): Promise<void> {
    // UI and registration guards precede even waitForIdle; history remains untouched until later.
    if (!ctx.hasUI) throw new Error(SHARE_UI_REQUIRED);
    if (shuttingDown) throw new Error(SESSION_STOPPING);
    if (!registered || !registeredConfig) throw new Error(SHARE_NOT_CONNECTED);
    if (registeredConfig.url !== undefined) throw new Error(REMOTE_BRIDGE_UNSUPPORTED);
    if (activeShare) throw new Error(SHARE_IN_PROGRESS);
    const input = args.trim();
    if (input && !/^(?:[1-9]|1[0-6])$/u.test(input)) throw new Error("用法：/shuguang-share [最近条数1..16]");
    const count = input ? Number(input) : 4;
    const operation: PendingShare = { generation: shareGeneration, controller: new AbortController() };
    activeShare = operation;
    const externalSignal = ctx.signal;
    const abortFromPi = (): void => operation.controller.abort();
    if (externalSignal?.aborted) abortFromPi();
    else externalSignal?.addEventListener("abort", abortFromPi, { once: true });
    const alive = (): boolean => activeShare === operation && operation.generation === shareGeneration &&
      !shuttingDown && !operation.controller.signal.aborted;
    const checkAlive = (): void => { if (!alive()) throw new Error(SHARE_CANCELLED); };
    const request = async (data: RequestInput): Promise<HostResponse> => {
      checkAlive();
      const client = operation.client;
      if (!client) throw new Error(SHARE_FAILED);
      return client.request(data, operation.controller.signal);
    };
    const waitForIdle = async (): Promise<void> => {
      checkAlive();
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error(SHARE_CANCELLED));
        operation.controller.signal.addEventListener("abort", abort, { once: true });
      });
      try { await Promise.race([ctx.waitForIdle(), cancelled]); }
      finally { operation.controller.signal.removeEventListener("abort", abort); }
    };
    let grantId: string | undefined;
    try {
      await waitForIdle();
      checkAlive();
      if (!ctx.hasUI) throw new Error(SHARE_UI_REQUIRED);
      const config = parseCompanionConfig({ ...registeredConfig });
      const bridge = buildHostBridgeRegistration(config);
      operation.client = createHostClient(bridge.command, bridge.args ?? [], { signal: operation.controller.signal });

      // The very first bridge request is status; it never pairs or exposes pairing credentials to Pi.
      const statusResponse = await request({ type: "status" });
      checkAlive();
      if (statusResponse.type === "error") throw new Error(SHARE_FAILED);
      if (statusResponse.type !== "status" || !statusResponse.supported || statusResponse.lifecycle !== "awake") {
        throw new Error(SHARE_UNAVAILABLE);
      }
      if (!ctx.hasUI) throw new Error(SHARE_UI_REQUIRED);

      // No session manager access occurs before UI checks and idle synchronization above.
      const sessionId = ctx.sessionManager.getSessionId();
      const leafEntryId = ctx.sessionManager.getLeafId();
      const branch = ctx.sessionManager.getBranch();
      if (!leafEntryId || branch.length === 0 || branch.at(-1)?.id !== leafEntryId) throw new Error(SHARE_FAILED);
      const batch = buildSharedBatch(sessionId, leafEntryId, branch, count);
      const snapshotStillExact = (): boolean => {
        try {
          if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leafEntryId) return false;
          const currentBranch = ctx.sessionManager.getBranch();
          if (currentBranch.at(-1)?.id !== leafEntryId) return false;
          const current = buildSharedBatch(sessionId, leafEntryId, currentBranch, count, batch.batchId);
          return JSON.stringify(current) === JSON.stringify(batch);
        } catch { return false; }
      };

      if (!ctx.hasUI) throw new Error(SHARE_UI_REQUIRED);
      const preview = JSON.stringify({
        subjectId: statusResponse.subjectId,
        scopeId: statusResponse.scopeId,
        lifecycle: statusResponse.lifecycle,
        selectedFragments: batch.fragments.map(fragment => ({ role: fragment.role, text: fragment.text })),
        count: batch.fragments.length,
        modelDisclosure: "这些准确片段将导入同一主体的私有来源记录；曙光模型未来可能在该主体范围内读取它们。不会调用模型或联网，也不代表学会。",
        storageDisclosure: "仅由当前已配对主体按本次授权保存；Pi不会接收配对秘密。",
      }, null, 2);
      const approved = await ctx.ui.confirm("预览并授权共享会话片段？", preview, { signal: operation.controller.signal });
      checkAlive();
      if (!ctx.hasUI) throw new Error(SHARE_UI_REQUIRED);
      if (!approved) {
        ctx.ui.notify(SHARE_CANCELLED, "warning");
        return;
      }
      if (!snapshotStillExact()) throw new Error(SHARE_CANCELLED);

      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const grantResponse = await request({ type: "authorize", batch, expiresAt });
      checkAlive();
      if (grantResponse.type !== "grant" || grantResponse.grant.batchId !== batch.batchId ||
          grantResponse.grant.status !== "active" || Date.parse(grantResponse.grant.expiresAt) <= Date.now()) {
        throw new Error(SHARE_FAILED);
      }
      grantId = grantResponse.grant.grantId;
      if (!snapshotStillExact()) {
        await request({ type: "revoke", grantId });
        grantId = undefined;
        throw new Error(SHARE_CANCELLED);
      }

      const accepted = await request({ type: "accept", batch, grantId });
      checkAlive();
      if (accepted.type !== "import" || !accepted.result || accepted.result.batchId !== batch.batchId) throw new Error(SHARE_FAILED);
      if (!snapshotStillExact()) {
        await request({ type: "revoke", grantId });
        grantId = undefined;
        throw new Error(SHARE_CANCELLED);
      }

      const consumed = await request({ type: "consume", batchId: batch.batchId, grantId });
      checkAlive();
      if (consumed.type !== "import" || !consumed.result || consumed.result.batchId !== batch.batchId || consumed.result.status !== "consumed") {
        throw new Error(SHARE_FAILED);
      }
      grantId = undefined;
      ctx.ui.notify(`已消费 ${consumed.result.newSources} 条新来源；主体 ${statusResponse.subjectId} revision ${consumed.result.revision}。未调用模型，不代表学会。`, "info");
    } catch (error) {
      if (!alive()) throw new Error(SHARE_CANCELLED);
      if (grantId && alive()) {
        try { await request({ type: "revoke", grantId }); } catch { /* Do not mask the fixed primary error. */ }
      }
      if (error instanceof Error && [SHARE_UI_REQUIRED, SHARE_CANCELLED, SHARE_UNAVAILABLE, SHARE_NOT_CONNECTED,
        SHARE_IN_PROGRESS, SHARE_FAILED, SESSION_STOPPING].includes(error.message)) throw error;
      if (error instanceof Error && error.message === "empty share selection") throw new Error("当前分支没有可共享的纯文本片段。");
      if (error instanceof Error && error.message === "share fragment too large") throw new Error("所选片段超过单条长度限制；请缩小选择后重试。");
      if (error instanceof Error && error.message === "share batch too large") throw new Error("所选批次超过总长度限制；请缩小选择后重试。");
      throw new Error(SHARE_FAILED);
    } finally {
      externalSignal?.removeEventListener("abort", abortFromPi);
      operation.client?.close();
      if (activeShare === operation) activeShare = undefined;
    }
  }

  pi.registerCommand("shuguang-share", {
    description: "预览并授权将当前 Pi 分支的最近纯文本片段导入曙光",
    handler: async (args, ctx) => share(args, ctx),
  });

  pi.registerCommand("shuguang-mcp", {
    description: "连接、断开或查看曙光 MCP 会话注册状态",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (input === "connect") {
        await connect(ctx);
        return;
      }
      const explicitConnect = /^connect\s+([\s\S]*)$/u.exec(input);
      if (explicitConnect) {
        await connect(ctx, explicitConnect[1]!.trim());
        return;
      }
      if (input === "disconnect") {
        cancelPending();
        cancelShare();
        cancelResearch();
        unregisterOwned();
        ctx.ui.notify("本扩展拥有的曙光 MCP 注册已从当前会话移除；未停止曙光本体。", "info");
        return;
      }
      if (input === "status") {
        status(ctx);
        return;
      }
      throw new Error("用法：/shuguang-mcp connect [绝对配置文件路径]|disconnect|status");
    },
  });

  pi.on("session_start", () => {
    cancelPending();
    cancelShare();
    cancelResearch();
    shuttingDown = false;
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    cancelPending();
    cancelShare();
    cancelResearch();
    unregisterOwned();
  });
}
