import { isAbsolute } from "node:path";
import { createInitialState } from "../legacy/state.ts";
import { SqliteStateStore } from "../adapters/storage/sqlite.ts";
import { LifecycleController } from "./lifecycle.ts";
import { createTokenFile } from "../adapters/transport/token-file.ts";
import { SqliteChatStore } from "../adapters/storage/sqlite-chat.ts";
import { APP_VERSION } from "./version.ts";

const HELP = `曙光智慧 ${APP_VERSION} — 六核心独立数字伙伴（显式接入模型，有界自主学习）

只读检查：
  npm start -- --help
  npm start -- --version
  npm run check:capabilities
  npm run verify:acceptance

模型配置向导（交互终端，本机离线生成，不读取Pi密钥/不调用模型）：
  npm start -- model-config --output /private/path/model.json
  选择用途、OpenAI或自定义兼容入口、模型ID与凭据环境变量名，再确认保存。
  仅支持Chat Completions；凭据只填变量名，请勿粘贴密钥；不执行凭据命令、不覆盖文件。
  生成后通过serve或learning-run的--model-config显式使用，不修改主体预算。

独立客户端（连接已有本机服务，不要求Pi，不自动启动）：
  npm start -- request --endpoint http://127.0.0.1:7341 --token-file /private/service.token -- status
  npm start -- request --endpoint http://127.0.0.1:7341 --token-file /private/service.token -- wake 0
  npm start -- request --endpoint http://127.0.0.1:7341 --token-file /private/service.token -- say "你好"
  应用错误返回非零退出码；取消/响应丢失后先查状态，不自动重试。

自主学习（一次授权本地资料与预算；v3新库，不迁移已有库）：
  npm start -- learning-init --db /path/learning.sqlite --id dawn --name 曙光 --limit 100 --learning-limit 4 --pack /path/pack.json
  npm start -- subject-wake --db /path/learning.sqlite --revision 0
  npm start -- learning-run --db /path/learning.sqlite --model-config /path/model.json
  npm start -- learning-status --db /path/learning.sqlite
  npm start -- learning-stop --db /path/learning.sqlite
  npm start -- learning-recover --db /path/learning.sqlite
  run前台自主选题/读/练习/独立测验，停止/完成/额度耗尽即结束；无任意搜索或工具执行。
  SIGINT/SIGTERM取消当前调用、保留费用与已提交进度；stop撤销授权且不可恢复。
  recover仅在确认此库所有旧runner和交流服务已停止后，把v3同库学习/交流pending标失败、不退款、不重发。

显式旧格式数据库操作（父目录必须已存在，--db 必须为绝对路径）：
  npm start -- init --db /path/dawn.sqlite --id dawn --name 曙光
  npm start -- status --db /path/dawn.sqlite
  npm start -- wake --db /path/dawn.sqlite --revision 0
  npm start -- sleep --db /path/dawn.sqlite --revision 1
  npm start -- events --db /path/dawn.sqlite

六核心新格式（独立新库，不自动迁移旧库；推荐用于新主体）：
  npm start -- subject-init --db /path/subject.sqlite --id dawn --name 曙光 --limit 100
  npm start -- subject-status --db /path/subject.sqlite
  npm start -- subject-wake --db /path/subject.sqlite --revision 0
  npm start -- subject-sleep --db /path/subject.sqlite --revision 1
  npm start -- subject-budget --db /path/subject.sqlite
  npm start -- serve --subject-db /path/subject.sqlite --token-file /private/path/service.token --port 7341 --model-config /path/model.json
  新模式统一保存六核心、经历、事件与对话额度；不接受 --db/--chat-db 混用。
  模型须返回候选JSON；不合格输出不提交核心状态，不重试，已预占次数不退款。

显式凭据创建与旧格式前台服务（不自动唤醒）：
  npm start -- token-init --token-file /private/path/service.token
  npm start -- serve --db /path/dawn.sqlite --token-file /private/path/service.token --port 7341
  npm start -- chat-init --db /path/dawn.sqlite --chat-db /path/chat.sqlite --limit 100
  npm start -- chat-budget --db /path/dawn.sqlite --chat-db /path/chat.sqlite
  启用模型须同时附加 --model-config /path/model.json --chat-db /path/chat.sqlite。
  chat-init 显式创建主体绑定的对话库与永久次数额度，不自动续期/重置。
  serve 只监听 127.0.0.1；Ctrl+C / SIGTERM 关闭进程，不隐式休眠。

init 仅创建新文件，不覆盖已有数据库。wake 仅更新持久化生命周期标记，
不启动模型或常驻进程。清醒标记不证明进程存活。events 按版本升序最多返回前 100 条。
`;

export async function runCli(args: readonly string[], signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) return HELP;
  if (args.length === 1 && args[0] === "--version") return APP_VERSION;
  if (args.length === 1 && args[0] === "--check") return {
    version: APP_VERSION, stage: "bounded-companion", domainSchemaVersion: 2,
    storageFormats: { subject: 2, learning: 3, legacy: 1 }, sqliteAdapterAvailable: true,
    databaseOpened: false, modelConnected: false, transportAvailable: true, serverStarted: false,
    autonomy: false, autonomousLearningAvailable: true,
  };
  const command = args[0];
  if (command === "model-config") {
    const { runModelConfigWizard } = await import("./model-config-wizard.ts");
    return runModelConfigWizard(args, signal);
  }
  if (command?.startsWith("learning-")) {
    const { runLearningCli } = await import("./learning-cli.ts");
    return runLearningCli(args, signal);
  }
  if (command === "request") {
    const { runRequestCli } = await import("./request-cli.ts");
    return runRequestCli(args, signal);
  }
  if (command?.startsWith("subject-")) {
    const { runSubjectCli } = await import("./subject-cli.ts");
    return runSubjectCli(args, signal);
  }
  if (command === "token-init") {
    if (args.length !== 3 || args[1] !== "--token-file" || !args[2]) throw new Error("Explicit token file required");
    signal.throwIfAborted();
    createTokenFile(args[2]);
    return { tokenCreated: true }; // Never include the token value in output.
  }
  if (!command || !["init", "status", "wake", "sleep", "events", "chat-init", "chat-budget"].includes(command)) throw new Error("Invalid CLI command");
  const options = new Map<string, string>();
  const allowed = command === "chat-init" ? ["--db", "--chat-db", "--limit"] :
    command === "chat-budget" ? ["--db", "--chat-db"] : command === "init" ? ["--db", "--id", "--name"] :
    command === "wake" || command === "sleep" ? ["--db", "--revision"] : ["--db"];
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key || !allowed.includes(key) || options.has(key) || !value || value.startsWith("--")) {
      throw new Error("Invalid CLI options");
    }
    options.set(key, value);
  }
  const path = options.get("--db");
  if (!path || !isAbsolute(path)) throw new Error("Absolute database path required");
  const chatPath = options.get("--chat-db");
  let chatLimit = 0;
  if (command === "chat-init" || command === "chat-budget") {
    if (!chatPath || !isAbsolute(chatPath) || chatPath === path) throw new Error("Separate absolute chat database required");
    if (command === "chat-init") {
      const raw = options.get("--limit");
      if (!raw || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 10000) {
        throw new Error("Explicit lifetime call limit from 1 to 10000 required");
      }
      chatLimit = Number(raw);
    }
  }
  let revision = 0;
  if (command === "wake" || command === "sleep") {
    const raw = options.get("--revision");
    if (!raw || !/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error("Safe revision required");
    revision = Number(raw);
  }
  let store: SqliteStateStore;
  if (command === "init") {
    const id = options.get("--id");
    const name = options.get("--name");
    if (!id || !name) throw new Error("Explicit identity and name required for initialization");
    store = SqliteStateStore.create(path, createInitialState(id, name, new Date().toISOString()), signal);
  } else {
    store = SqliteStateStore.open(path, signal);
  }
  try {
    if ((command === "chat-init" || command === "chat-budget") && chatPath) {
      const subjectId = (await store.read(signal)).self.identity.id;
      const chat = command === "chat-init"
        ? SqliteChatStore.create(chatPath, subjectId, chatLimit, signal)
        : SqliteChatStore.open(chatPath, subjectId, signal);
      try { return { subjectId, chatCreated: command === "chat-init", budget: await chat.budget(signal) }; }
      finally { chat.close(); }
    }
    if (command === "events") return { events: await store.events(0, 100, signal), limit: 100 };
    const lifecycle = new LifecycleController(store);
    const state = command === "wake" ? await lifecycle.wake(revision, signal) :
      command === "sleep" ? await lifecycle.sleep(revision, signal) : await lifecycle.status(signal);
    // Do not dump personal memories, beliefs or relationships into terminal diagnostics.
    return { subjectId: state.self.identity.id, name: state.self.identity.name, revision: state.revision,
      lifecycle: state.lifecycle, updatedAt: state.updatedAt, autonomousRuntime: false };
  } finally { store.close(); }
}
