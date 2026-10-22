import type { DawnResponse } from "../../dawn/src/protocol/index.ts";

type ModelState = Extract<DawnResponse, { type: "model" }>["state"];

/** Only explicit service commands and transient dialogs; no Pi model/session access. */
export interface ModelPickerUI {
  confirm(title: string, message: string, signal: AbortSignal): Promise<boolean>;
  select(title: string, items: string[], signal: AbortSignal): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning"): void;
}
export interface ModelCommandClient {
  command(input: string, signal: AbortSignal): Promise<DawnResponse>;
}

const THINKING_NOTICE = "off = 省略 reasoning_effort 参数，不保证关闭思考；levels 是可提交档位，不是模型能力认证。";

export function formatModelState(state: ModelState, includeModels = false): string {
  const summary = `曙光：model=${state.model}，thinking=${state.thinking}，selectionRevision=${state.selectionRevision}，calls=${state.calls}，maxCalls=${state.maxCalls}（服务进程内选择，不持久化）`;
  return includeModels
    ? `${summary}\n已发现模型目录：\n${state.models.map((id, i) => `${i + 1}. ${id}`).join("\n") || "（空）"}`
    : summary;
}

/** Preserve exact IDs through a numbered label map, never parse the displayed label. */
async function selectValue(ui: ModelPickerUI, title: string, values: readonly string[], signal: AbortSignal): Promise<string | undefined> {
  if (!values.length) {
    ui.notify("曙光：当前列表为空；未提交选择。可显式运行 /dawn models 刷新目录。", "warning");
    return undefined;
  }
  const labels = new Map(values.map((value, i) => [`${i + 1}. ${value}`, value]));
  const selected = await ui.select(title, [...labels.keys()], signal);
  // A dialog may resolve after reload even when its host ignores cancellation.
  signal.throwIfAborted();
  if (selected === undefined) return undefined;
  const value = labels.get(selected);
  if (value === undefined) throw new Error("Unknown selection label");
  return value;
}

/** Convenience selection owns exactly one status read and at most one CAS write. */
export async function runDawnCommand(client: ModelCommandClient, input: string, ui: ModelPickerUI, signal: AbortSignal): Promise<DawnResponse | undefined> {
  signal.throwIfAborted();
  const text = input.trim();
  const selection = /^(model|thinking)(?:\s+([\s\S]+))?$/.exec(text);
  if (!selection) return client.command(input, signal);

  const kind = selection[1];
  const explicit = selection[2];
  let response = await client.command("model-status", signal);
  signal.throwIfAborted();
  if (response.type === "error") return response;
  if (response.type !== "model") throw new Error("Expected model status");

  let value: string | undefined = explicit;
  if (kind === "model") {
    if (explicit === undefined) {
      const refresh = await ui.confirm("刷新曙光模型目录？", "是否从当前曙光 endpoint 远程 GET 刷新模型目录？不生成内容、不消耗生成次数，也不披露 Pi 或曙光对话历史。选择否使用服务缓存目录。", signal);
      signal.throwIfAborted();
      if (refresh) {
        response = await client.command("models", signal);
        signal.throwIfAborted();
        if (response.type === "error") return response;
        if (response.type !== "model") throw new Error("Expected model directory");
      }
      value = await selectValue(ui, `选择曙光模型（当前 ${response.state.model}）`, response.state.models, signal);
    } else if (!response.state.models.includes(explicit)) {
      ui.notify("曙光：该 ID 不在已发现缓存目录中；未提交选择。请显式运行 /dawn models 后再选择。", "warning");
      return undefined;
    }
  } else {
    ui.notify(THINKING_NOTICE, "info");
    if (explicit === undefined) {
      value = await selectValue(ui, `选择曙光 thinking（当前 ${response.state.thinking}；档位非能力认证）`, response.state.levels, signal);
    } else if (!response.state.levels.some(level => level === explicit)) {
      ui.notify("曙光：该 thinking 档位不在服务 levels 中；未提交选择。", "warning");
      return undefined;
    }
  }
  signal.throwIfAborted();
  if (value === undefined) return undefined;
  // CONFLICT is returned verbatim: never refresh or retry a stale selection.
  return client.command(`${kind} ${response.state.selectionRevision} ${value}`, signal);
}
