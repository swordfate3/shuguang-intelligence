import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ModelConfigUI } from "../../runtime/model-config-wizard.ts";

const TERMINAL_REQUIRED = "模型配置向导需要交互式终端（TTY）；没有读取标准输入中的管道内容。";
const CANCELLED = "模型配置向导已取消；未保存配置。";

export interface ModelConfigTerminal {
  ui: ModelConfigUI;
  close(): void;
}

function isTTY(stream: Readable | Writable): boolean {
  return "isTTY" in stream && stream.isTTY === true;
}

/** Interactive-only readline UI; injectable streams keep EOF/cancel paths testable. */
export function createModelConfigTerminal(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): ModelConfigTerminal {
  if (!isTTY(input) || !isTTY(output)) throw new Error(TERMINAL_REQUIRED);
  const readline = createInterface({ input, output, terminal: true, crlfDelay: Infinity });
  let closed = false;
  let ended = false;
  const pending = new Set<() => void>();

  readline.on("close", () => {
    ended = true;
    for (const reject of pending) reject();
    pending.clear();
  });

  const ui: ModelConfigUI = {
    ask(prompt, signal) {
      if (closed || ended) return Promise.reject(new Error(CANCELLED));
      if (signal.aborted) return Promise.reject(new DOMException(CANCELLED, "AbortError"));
      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: string) => {
          if (settled) return;
          settled = true;
          pending.delete(onEnd);
          signal.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve(value ?? "");
        };
        const onEnd = () => finish(new Error(CANCELLED));
        const onAbort = () => finish(new DOMException(CANCELLED, "AbortError"));
        pending.add(onEnd);
        signal.addEventListener("abort", onAbort, { once: true });
        // An interface closed just before listeners were attached is also EOF.
        if (ended || closed) { onEnd(); return; }
        readline.question(prompt, answer => finish(undefined, answer));
      });
    },
    show(text) {
      if (closed) throw new Error(CANCELLED);
      output.write(`${text}\n`);
    },
  };

  return {
    ui,
    close() {
      if (closed) return;
      closed = true;
      readline.close();
      // On normal close, unresolved asks are EOF, never an empty answer/default.
      for (const reject of pending) reject();
      pending.clear();
    },
  };
}
