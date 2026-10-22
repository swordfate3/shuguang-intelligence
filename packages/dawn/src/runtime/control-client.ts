import { randomUUID } from "node:crypto";
import type { DawnRequest, DawnResponse, DawnTransport } from "../protocol/index.ts";
import { assertDawnRequest, assertDawnResponse } from "../protocol/index.ts";
import { isThinkingLevel, isModelId } from "../protocol/model-controls.ts";

export class TransportUnavailableError extends Error {
  constructor() {
    super("曙光通信尚未接入；本次没有唤醒、休眠或发送消息。");
    this.name = "TransportUnavailableError";
  }
}

/** No sockets, process spawning, Pi model calls or credential discovery. */
export class DawnClient {
  readonly #transport: DawnTransport | undefined;

  constructor(transport?: DawnTransport) { this.#transport = transport; }

  async command(input: string, signal: AbortSignal): Promise<DawnResponse> {
    signal.throwIfAborted();
    const request = parseCommand(input);
    if (!this.#transport) throw new TransportUnavailableError();
    const response = await this.#transport.request(request, signal);
    signal.throwIfAborted();
    assertDawnResponse(response);
    if (response.version !== 1 || response.requestId !== request.requestId || (response.type !== "error" &&
        (request.type === "say" ? response.type !== "reply" :
          ["model-status", "model-list", "model-select", "thinking-select"].includes(request.type) ? response.type !== "model" : response.type !== "status"))) {
      throw new Error("曙光响应版本或请求标识不匹配");
    }
    return response;
  }
}

export function parseCommand(input: string): DawnRequest {
  const text = input.trim();
  const base = { version: 1 as const, requestId: randomUUID() };
  if (text === "status") return { ...base, type: "status" };
  if (text === "model-status") return { ...base, type: "model-status" };
  if (text === "models") return { ...base, type: "model-list" };
  const selection = /^(model|thinking) (0|[1-9]\d*) (.+)$/u.exec(text);
  if (selection && Number.isSafeInteger(Number(selection[2]))) {
    const expectedRevision = Number(selection[2]);
    const value = selection[3]!;
    if (selection[1] === "model" && isModelId(value)) {
      const request = { ...base, type: "model-select" as const, expectedRevision, model: value };
      assertDawnRequest(request); return request;
    }
    if (selection[1] === "thinking" && isThinkingLevel(value)) {
      return { ...base, type: "thinking-select", expectedRevision, thinking: value };
    }
  }
  const control = /^(wake|sleep) (0|[1-9]\d*)$/.exec(text);
  if (control) {
    const revision = Number(control[2]);
    if (Number.isSafeInteger(revision)) {
      return { ...base, type: control[1] as "wake" | "sleep", expectedRevision: revision };
    }
  }
  if (text.startsWith("say ") && text.slice(4).trim() && text.length <= 16_004) {
    return { ...base, type: "say", text: text.slice(4).trim() };
  }
  throw new Error("用法：status | wake <状态版本> | sleep <状态版本> | say <消息> | model-status | models | model <选择版本> <ID> | thinking <选择版本> <等级>。");
}
