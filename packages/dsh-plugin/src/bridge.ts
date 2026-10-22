import { DawnClient, parseCommand } from "../../dawn/src/runtime/control-client.ts";
import { HttpDawnTransport, parseDawnEndpoint } from "../../dawn/src/adapters/transport/http-client.ts";
import { assertServiceToken, readTokenFile } from "../../dawn/src/adapters/transport/token-file.ts";
import type { DawnResponse, DawnTransport } from "../../dawn/src/protocol/index.ts";
import { DockerDawnTransport } from './docker-transport.ts';

export interface BridgeConfig {
  readonly connection?: string;
  readonly dockerProjectDir?: string;
  readonly dockerContext?: string;
  readonly dockerProjectName?: string;
  readonly endpoint?: string;
  readonly tokenFile?: string;
  readonly tokenEnv?: string;
}

/** Explicit seams for synthetic fixtures; defaults read only the configured source. */
export interface BridgeDependencies {
  readonly readToken?: (path: string) => string;
  readonly readEnv?: (name: string) => string | undefined;
  readonly dockerTransport?: (config: { dockerProjectDir: string; dockerContext?: string; dockerProjectName?: string }) => DawnTransport;
}

const messages = {
  CLOSED: "曙光连接已关闭。",
  UNCONFIGURED: "请显式配置 HTTP 连接凭据或 Docker 项目目录。",
  INVALID_CONFIG: "曙光连接配置无效；请选择唯一连接方式及其受限配置。",
  INVALID_COMMAND: "曙光命令无效。",
  INVALID_ENDPOINT: "曙光 endpoint 必须是显式的本机 HTTP 地址。",
  CREDENTIALS: "无法读取有效的曙光服务凭据。",
  CANCELLED: "曙光请求已取消。",
  SATURATED: "曙光连接最多允许 8 个并发请求。",
  UNAVAILABLE: "曙光服务不可用或响应无效。",
} as const;
export type BridgeErrorCode = keyof typeof messages;

/** No underlying cause, input, path, endpoint or credential is retained. */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  constructor(code: BridgeErrorCode) {
    super(messages[code]);
    this.name = "BridgeError";
    this.code = code;
  }
}

interface Pending {
  readonly controller: AbortController;
  readonly done: Promise<DawnResponse>;
}

/** Host-agnostic, explicit-command client. Construction performs no I/O. */
export class DawnBridge {
  readonly #config: BridgeConfig;
  readonly #dockerTransport: (config: { dockerProjectDir: string; dockerContext?: string; dockerProjectName?: string }) => DawnTransport;
  readonly #readToken: (path: string) => string;
  readonly #readEnv: (name: string) => string | undefined;
  readonly #pending = new Set<Pending>();
  #closed = false;
  #disposing: Promise<void> | undefined;

  constructor(config: BridgeConfig, dependencies: BridgeDependencies = {}) {
    this.#config = { ...config };
    this.#dockerTransport = dependencies.dockerTransport ?? (config => new DockerDawnTransport(config));
    this.#readToken = dependencies.readToken ?? readTokenFile;
    this.#readEnv = dependencies.readEnv ?? (name => process.env[name]);
  }

  async command(input: string, signal: AbortSignal): Promise<DawnResponse> {
    if (this.#closed) throw new BridgeError("CLOSED");
    // Validation precedes configuration/credential access, even when unconfigured.
    try { parseCommand(input); } catch { throw new BridgeError("INVALID_COMMAND"); }
    if (signal.aborted) throw new BridgeError("CANCELLED");
    if (this.#pending.size >= 8) throw new BridgeError("SATURATED");

    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    // Defer execution until the reservation is registered (including sync failures).
    const done = Promise.resolve().then(() => this.#execute(input, combined));
    const pending: Pending = { controller, done };
    this.#pending.add(pending);
    try {
      const response = await done;
      if (combined.aborted) throw new BridgeError("CANCELLED");
      return response;
    } finally { this.#pending.delete(pending); }
  }

  /** Cancel this client's work only; never sleep or stop the independent service. */
  dispose(): Promise<void> {
    if (this.#disposing) return this.#disposing;
    this.#closed = true;
    const pending = [...this.#pending];
    // Observe rejections before aborting. Each command still owns its finally cleanup.
    this.#disposing = Promise.allSettled(pending.map(item => item.done)).then(() => undefined);
    for (const item of pending) item.controller.abort();
    return this.#disposing;
  }

  async #execute(input: string, signal: AbortSignal): Promise<DawnResponse> {
    const cancelled = () => {
      if (signal.aborted) throw new BridgeError("CANCELLED");
    };
    cancelled();
    const { endpoint, tokenFile, tokenEnv, connection = 'http', dockerProjectDir, dockerContext, dockerProjectName } = this.#config;
    let transport: DawnTransport;
    if (connection === 'docker') {
      if (endpoint || tokenFile || tokenEnv) throw new BridgeError('INVALID_CONFIG');
      if (!dockerProjectDir) throw new BridgeError('UNCONFIGURED');
      try { transport = this.#dockerTransport({ dockerProjectDir, dockerContext: dockerContext || 'default', dockerProjectName: dockerProjectName || undefined }); }
      catch { throw new BridgeError('INVALID_CONFIG'); }
    } else {
      if (connection !== 'http' || dockerProjectDir || dockerProjectName || (dockerContext && dockerContext !== 'default')) throw new BridgeError('INVALID_CONFIG');
      if (!endpoint || (!tokenFile && !tokenEnv)) throw new BridgeError("UNCONFIGURED");
      if ((tokenFile && tokenEnv) || (tokenEnv &&
          (tokenEnv.length > 128 || !/^SHUGUANG_[A-Z0-9_]+_TOKEN$/.test(tokenEnv)))) {
        throw new BridgeError("INVALID_CONFIG");
      }
      try { parseDawnEndpoint(endpoint); }
      catch { throw new BridgeError("INVALID_ENDPOINT"); }
      try {
        const token = tokenFile ? this.#readToken(tokenFile) : this.#readEnv(tokenEnv!);
        if (typeof token !== "string") throw new BridgeError("CREDENTIALS");
        assertServiceToken(token);
        transport = new HttpDawnTransport(endpoint, token);
      }
      catch {
        cancelled();
        throw new BridgeError("CREDENTIALS");
      }
    }
    cancelled();
    try {
      const response = await new DawnClient(transport).command(input, signal);
      cancelled(); // Caller/dispose cancellation wins over a late successful result.
      // Application envelopes remain typed, but never forward arbitrary error text.
      return response.type === "error"
        ? { ...response, message: `曙光请求失败（${response.code}）。` }
        : response;
    } catch {
      cancelled();
      throw new BridgeError("UNAVAILABLE");
    }
  }
}
