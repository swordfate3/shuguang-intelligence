import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DawnClient } from "./client.ts";
import { HttpDawnTransport } from "./http-transport.ts";
import { readTokenFile } from "../../dawn/src/adapters/transport/token-file.ts";

export default function dawnExtension(pi: ExtensionAPI) {
  const pending = new Set<AbortController>();

  pi.registerCommand("dawn", {
    description: "曙光本机控制与交流入口（须显式配置并单独启动服务；模型由本体配置）",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new Error("当前骨架只提供带 UI 的命令反馈；未执行任何操作。");
      const controller = new AbortController();
      pending.add(controller);
      // Transport owns the per-request deadline; session shutdown remains an
      // independent cancellation source (a fixed 15s cap would truncate say).
      const signal = controller.signal;
      try {
        // Only explicit command execution may read credentials or access the local service.
        const endpoint = process.env.DAWN_ENDPOINT;
        const tokenFile = process.env.DAWN_TOKEN_FILE;
        if (Boolean(endpoint) !== Boolean(tokenFile)) throw new Error("Incomplete Dawn configuration");
        const client = endpoint && tokenFile
          ? new DawnClient(new HttpDawnTransport(endpoint, readTokenFile(tokenFile)))
          : new DawnClient();
        const response = await client.command(args, signal);
        if (response.type === "error") {
          ctx.ui.notify(`曙光：${response.code}`, "error");
        } else if (response.type === "reply") {
          ctx.ui.notify(response.text, "info");
        } else {
          ctx.ui.notify(`曙光：${response.lifecycle}，状态版本 ${response.revision}，服务实例 ${response.runtime.instanceId}（自主活动未启用）`, "info");
        }
      } catch {
        // Do not expose remote errors, credentials or stack traces in the UI.
        ctx.ui.notify("曙光配置缺失、连接失败或请求已取消；未报告成功，请查询状态确认。用法：status / wake <版本> / sleep <版本> / say <消息>", "error");
      } finally {
        pending.delete(controller);
      }
    },
  });

  pi.on("session_shutdown", async () => {
    for (const controller of pending) controller.abort();
    pending.clear();
    // Disconnecting Pi must not implicitly sleep or terminate Dawn.
  });
}
