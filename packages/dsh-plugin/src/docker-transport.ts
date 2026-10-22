import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { TextDecoder } from "node:util";
import { assertDawnRequest, assertDawnResponse, CONTROL_TIMEOUT_MS, MAX_WIRE_BYTES, SAY_CLIENT_TIMEOUT_MS } from "../../dawn/src/protocol/index.ts";
import type { DawnRequest, DawnResponse, DawnTransport } from "../../dawn/src/protocol/index.ts";

export interface DockerTransportConfig {
  readonly dockerProjectDir: string;
  /** Explicit Docker context; never silently use DOCKER_HOST/DOCKER_CONTEXT. */
  readonly dockerContext?: string;
  /** Existing Compose project, when its name differs from the directory default. */
  readonly dockerProjectName?: string;
}

/** Minimal process contract permits stream-only fixtures without starting Docker. */
export interface DockerChildProcess extends Pick<EventEmitter, "on" | "once" | "removeListener"> {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(): boolean;
}
export interface DockerSpawnOptions {
  readonly shell: false;
  readonly windowsHide: true;
  readonly stdio: ["pipe", "pipe", "pipe"];
}
export type DockerSpawnRunner = (command: "docker", args: readonly string[], options: DockerSpawnOptions) => DockerChildProcess;
export interface DockerTransportDependencies { readonly spawnRunner?: DockerSpawnRunner }
export type DockerTransportErrorCode = "INVALID_CONFIG" | "INVALID_REQUEST" | "CANCELLED" | "TIMEOUT" | "UNAVAILABLE" | "INVALID_RESPONSE";

const messages: Record<DockerTransportErrorCode, string> = {
  INVALID_CONFIG: "Invalid Dawn Docker transport configuration",
  INVALID_REQUEST: "Invalid Dawn Docker request",
  CANCELLED: "Dawn Docker request cancelled",
  TIMEOUT: "Dawn Docker request timed out",
  UNAVAILABLE: "Dawn Docker transport unavailable",
  INVALID_RESPONSE: "Invalid Dawn Docker response",
};
export class DockerTransportError extends Error {
  readonly code: DockerTransportErrorCode;
  constructor(code: DockerTransportErrorCode) { super(messages[code]); this.name = "DockerTransportError"; this.code = code; }
}

/**
 * No ports, token discovery, shell, startup or daemon inspection. Docker access is
 * a trusted Host capability: use only an explicitly chosen local Docker context.
 * Project/compose existence is left to the explicit request's docker invocation;
 * activation does not stat or read users' Compose files or configuration.
 */
export class DockerDawnTransport implements DawnTransport {
  readonly #projectDir: string;
  readonly #context: string;
  readonly #projectName: string | undefined;
  readonly #spawnRunner: DockerSpawnRunner;

  constructor(config: DockerTransportConfig, dependencies: DockerTransportDependencies = {}) {
    if (!config || typeof config.dockerProjectDir !== "string" ||
        !isAbsolute(config.dockerProjectDir) || config.dockerProjectDir.length > 32_767 ||
        /[\u0000-\u001f\u007f]/.test(config.dockerProjectDir)) throw new DockerTransportError("INVALID_CONFIG");
    const context = config.dockerContext === undefined ? "default" : config.dockerContext;
    if (typeof context !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(context)) {
      throw new DockerTransportError("INVALID_CONFIG");
    }
    if (config.dockerProjectName !== undefined && (typeof config.dockerProjectName !== "string" ||
        !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(config.dockerProjectName))) throw new DockerTransportError("INVALID_CONFIG");
    this.#projectDir = config.dockerProjectDir;
    this.#context = context;
    this.#projectName = config.dockerProjectName;
    this.#spawnRunner = dependencies.spawnRunner ?? ((command, args, options) => spawn(command, [...args], options));
  }

  async request(request: DawnRequest, signal: AbortSignal): Promise<DawnResponse> {
    if (signal.aborted) throw new DockerTransportError("CANCELLED");
    let body: Buffer;
    let requestId: string;
    let requestType: DawnRequest["type"];
    try {
      assertDawnRequest(request);
      body = Buffer.from(JSON.stringify(request), "utf8");
      if (body.byteLength > MAX_WIRE_BYTES) throw new Error("Size");
      requestId = request.requestId;
      requestType = request.type;
    } catch { throw new DockerTransportError("INVALID_REQUEST"); }
    if (signal.aborted) throw new DockerTransportError("CANCELLED");

    const value = await new Promise<DawnResponse>((resolve, reject) => {
      let child: DockerChildProcess | undefined;
      let settled = false;
      let stdoutEnded = false;
      let stdoutSize = 0;
      let stderrSize = 0;
      const chunks: Buffer[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanupChild = () => {
        // EOF/destroy cancels the container bridge; kill targets only this CLI,
        // never the container/service. No raw process/stream errors escape.
        try { child?.stdin.destroy(); } catch {}
        try { child?.kill(); } catch {}
        try { child?.stdout.destroy(); } catch {}
        try { child?.stderr.destroy(); } catch {}
      };
      const finish = (error?: DockerTransportError, response?: DawnResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        chunks.length = 0;
        cleanupChild();
        if (error) reject(error); else resolve(response!);
      };
      const onAbort = () => finish(new DockerTransportError("CANCELLED"));
      const unavailable = () => finish(new DockerTransportError("UNAVAILABLE"));
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish(new DockerTransportError("TIMEOUT")), requestType === "say" ? SAY_CLIENT_TIMEOUT_MS : CONTROL_TIMEOUT_MS);
      if (signal.aborted) { onAbort(); return; }
      try {
        child = this.#spawnRunner("docker", ["--context", this.#context, "compose", "--project-directory", this.#projectDir,
          ...(this.#projectName === undefined ? [] : ["--project-name", this.#projectName]), "-f", join(this.#projectDir, "compose.yaml"), "exec", "-T", "dawn", "dawn-container", "bridge-request"],
        { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        // Error handlers remain safe after settlement, including destroy races.
        child.on("error", unavailable);
        child.stdin.on("error", unavailable);
        child.stdout.on("error", unavailable);
        child.stderr.on("error", unavailable);
        child.stdout.on("data", (chunk: unknown) => {
          if (settled) return;
          if (!(chunk instanceof Uint8Array)) { finish(new DockerTransportError("INVALID_RESPONSE")); return; }
          stdoutSize += chunk.byteLength;
          if (stdoutSize > MAX_WIRE_BYTES) { finish(new DockerTransportError("INVALID_RESPONSE")); return; }
          chunks.push(Buffer.from(chunk));
        });
        child.stderr.on("data", (chunk: unknown) => {
          if (settled) return;
          // Bound activity as well as memory; retain no diagnostic/credential bytes.
          stderrSize += chunk instanceof Uint8Array ? chunk.byteLength : MAX_WIRE_BYTES + 1;
          if (stderrSize > MAX_WIRE_BYTES) unavailable();
        });
        child.stdout.once("end", () => { stdoutEnded = true; });
        child.stdout.once("close", () => { if (!stdoutEnded && !settled) unavailable(); });
        child.once("exit", (code: number | null, exitSignal: string | null) => { if (code !== 0 || exitSignal) unavailable(); });
        child.once("close", (code: number | null, exitSignal: string | null) => {
          if (settled) return;
          if (code !== 0 || exitSignal || !stdoutEnded) { unavailable(); return; }
          try {
            if (signal.aborted) { onAbort(); return; }
            const bytes = Buffer.concat(chunks, stdoutSize);
            // Exactly one LF-terminated JSON line, no logs/extra frames/BOM.
            if (bytes.length < 2 || bytes[bytes.length - 1] !== 10 || bytes.subarray(0, -1).includes(10) || bytes.includes(13)) throw new Error("Framing");
            const response: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, -1)));
            assertDawnResponse(response);
            if (response.requestId !== requestId || (response.type !== "error" &&
                (requestType === "say" ? response.type !== "reply" :
                  ["model-status", "model-list", "model-select", "thinking-select"].includes(requestType) ? response.type !== "model" : response.type !== "status"))) {
              throw new Error("Correlation");
            }
            finish(undefined, response);
          } catch { finish(new DockerTransportError("INVALID_RESPONSE")); }
        });
        if (settled || signal.aborted) { if (!settled) onAbort(); else cleanupChild(); return; }
        // Deliberately do not end stdin: the bridge treats EOF as cancellation.
        child.stdin.write(Buffer.concat([body, Buffer.from("\n")]));
      } catch { unavailable(); }
    });
    if (signal.aborted) throw new DockerTransportError("CANCELLED");
    return value;
  }
}
