import { runCli } from "./runtime/cli.ts";
import { RevisionConflictError } from "./runtime/state-store.ts";
import { CoreRevisionConflictError } from "./core/cycle.ts";

try {
  const args = process.argv.slice(2);
  if (args[0] === "serve") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const { runServer } = await import("./runtime/serve.ts");
      await runServer(args.slice(1), controller.signal, ready => console.log(JSON.stringify({ ...ready, autonomy: false })));
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } else {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const result = await runCli(args, controller.signal);
      controller.signal.throwIfAborted();
      console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
      if (args[0] === "request" && result && typeof result === "object" && "type" in result && result.type === "error") {
        process.exitCode = 1;
      }
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
} catch (error) {
  // File paths, stored content and raw SQLite errors may be sensitive; do not dump them.
  console.error(error instanceof RevisionConflictError || error instanceof CoreRevisionConflictError
    ? "状态版本冲突：请重新查询状态后再决定是否操作；没有覆盖旧版本。"
    : process.argv[2] === "model-config"
      ? "模型配置未报告成功：请在交互终端运行，检查参数、输入及绝对输出路径；父目录须已存在，已有文件不会覆盖。取消或写入失败后请检查目标文件，不会自动调用模型。使用 --help 查看用法。"
      : "命令失败：请检查参数、数据库路径/权限、格式版本及完整性。未报告成功；已有库不会自动重建。使用 --help 查看用法。");
  process.exitCode = 1;
}
