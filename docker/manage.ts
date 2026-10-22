import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeFileSync, type Stats,
} from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseModelConfig, type ModelFileConfig } from "../packages/dawn/src/adapters/models/config.ts";

const DEFAULT_DATA_DIR = "/data";
const MAX_MODEL_CONFIG_BYTES = 4096;
const REQUIRED_FILES = ["subject.sqlite", "service.token", "model.json", "model.env"] as const;
const HELP = `用法：node docker/manage.ts <命令>
  credentials       在 TTY 中隐藏录入凭据，排他新建 data/model.env
  verify-directory  只验证已有 data 目录为当前用户所有且权限为 0700
  verify-files      本地预检 serve 文件/配置/凭据格式；不打开数据库、不输出密钥、不发请求
  help              显示帮助`;

function fail(message: string): never {
  throw new Error(message);
}

/** Return the configured absolute data directory; never create it or alter its permissions. */
export function resolveDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DAWN_DATA_DIR ?? DEFAULT_DATA_DIR;
  if (!configured || !isAbsolute(configured)) fail("数据目录必须是绝对路径。");
  return resolve(configured);
}

/** Verify all path components are existing non-symlink directories and the final dir is private. */
export function assertPrivateDir(dataPath: string): string {
  if (!isAbsolute(dataPath)) fail("数据目录必须是绝对路径。");
  const absolute = resolve(dataPath);
  const parts = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  let stat: Stats | undefined;
  try {
    for (const part of parts) {
      current = current === sep ? `${current}${part}` : `${current}${sep}${part}`;
      stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail("数据目录路径无效。");
    }
  } catch {
    fail("数据目录不存在或路径无效。");
  }
  const uid = process.getuid?.();
  if (!stat || uid === undefined || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
    fail("数据目录必须由当前用户拥有且权限为 0700。");
  }
  return absolute;
}

function checkedPrivateFile(dataDir: string, name: typeof REQUIRED_FILES[number]): string {
  const filePath = `${dataDir}${sep}${name}`;
  try {
    const stat = lstatSync(filePath);
    const uid = process.getuid?.();
    if (stat.isSymbolicLink() || !stat.isFile() || uid === undefined || stat.uid !== uid ||
        (stat.mode & 0o777) !== 0o600) {
      fail("数据文件必须是当前用户所有、权限为 0600 的普通文件。");
    }
  } catch {
    fail("数据文件缺失或不符合私有文件要求。");
  }
  return filePath;
}

function readBoundedUtf8(fd: number, limit: number): string {
  const chunks: Buffer[] = [];
  let total = 0;
  const chunk = Buffer.alloc(1024);
  while (total <= limit) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, limit + 1 - total), null);
    if (count === 0) break;
    total += count;
    if (total > limit) fail("模型配置无效。");
    chunks.push(Buffer.from(chunk.subarray(0, count)));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function readModelConfig(dataDir: string): ModelFileConfig {
  const filePath = checkedPrivateFile(dataDir, "model.json");
  let fd: number | undefined;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.size > MAX_MODEL_CONFIG_BYTES || uid === undefined || stat.uid !== uid ||
        (stat.mode & 0o777) !== 0o600) fail("模型配置无效。");
    const config = parseModelConfig(JSON.parse(readBoundedUtf8(fd, MAX_MODEL_CONFIG_BYTES)) as unknown);
    // --env-file is processed before main.ts. Never serialize credentials as Node/OS control variables.
    // Keep this deployment restriction local; the general Dawn config format remains unchanged.
    if (!/^[A-Z][A-Z0-9_]*_API_KEY$/.test(config.credentialEnv)) fail("容器凭据变量名必须以 _API_KEY 结尾。");
    return config;
  } catch {
    return fail("模型配置无效。");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Read-only local preflight; reject extra env bindings before Node processes --env-file. */
export function verifyFiles(dataPath: string): void {
  const dataDir = assertPrivateDir(dataPath);
  for (const name of REQUIRED_FILES) checkedPrivateFile(dataDir, name);
  const config = readModelConfig(dataDir);
  const fd = openSync(`${dataDir}${sep}model.env`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4_224 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) fail("凭据文件无效。");
    const content = readBoundedUtf8(fd, 4_224);
    const prefix = `${config.credentialEnv}='`;
    if (!content.startsWith(prefix) || !content.endsWith("'\n")) fail("凭据文件无效。");
    const key = content.slice(prefix.length, -2);
    validateCredential(key);
  } finally { closeSync(fd); }
}

function assertCredentialFileAbsent(dataDir: string): void {
  try {
    lstatSync(`${dataDir}${sep}model.env`);
    fail("凭据文件已存在，拒绝覆盖；请停服务后手动安全轮换。");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    fail("凭据文件已存在或无法安全检查，拒绝覆盖。");
  }
}

function validateCredential(key: string): void {
  // Node --env-file accepts single-quoted values. Excluding quotes, backslash and whitespace
  // keeps the representation unambiguous while allowing the remaining printable ASCII (including #).
  if (key.length < 1 || key.length > 4096 || !/^[\x21-\x7e]+$/.test(key) || /['"\\]/.test(key)) {
    fail("凭据仅接受 1–4096 个可打印 ASCII 字符；不支持空白、引号或反斜杠。");
  }
}

function createCredentialFile(dataDir: string, config: ModelFileConfig, key: string, signal: AbortSignal): void {
  validateCredential(key);
  signal.throwIfAborted();
  const filePath = `${dataDir}${sep}model.env`;
  const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || uid === undefined || stat.uid !== uid) {
      fail("无法安全创建凭据文件。");
    }
    fchmodSync(fd, 0o600);
    if ((fstatSync(fd).mode & 0o777) !== 0o600) fail("无法安全创建凭据文件。");
    signal.throwIfAborted();
    writeFileSync(fd, `${config.credentialEnv}='${key}'\n`, "ascii");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Deliberately do not remove or replace a file if writing fails after exclusive creation.
}

/** Create data/model.env once, using the configured variable name and never replacing evidence. */
export function storeCredential(dataPath: string, key: string, signal: AbortSignal): void {
  const dataDir = assertPrivateDir(dataPath);
  const config = readModelConfig(dataDir);
  assertCredentialFileAbsent(dataDir);
  createCredentialFile(dataDir, config, key, signal);
}

function assertTTY(input: NodeJS.ReadStream, output: NodeJS.WriteStream): void {
  if (input.isTTY !== true || output.isTTY !== true || typeof input.setRawMode !== "function") {
    fail("credentials 需要 stdin/stdout TTY；未读取管道输入。");
  }
}

/** Read one secret without echo, preserving terminal mode and listeners on all exits. */
export function readCredentialFromTTY(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  assertTTY(input, output);
  signal.throwIfAborted();
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  // isPaused() is false for a never-started stream too; preserve readableFlowing so
  // a TTY that was idle before this prompt is paused again and cannot keep Node alive.
  const wasFlowing = input.readableFlowing;
  try {
    input.setRawMode(true);
    input.resume();
    output.write("API key（输入隐藏，Enter 提交，Ctrl+C 取消）： ");
  } catch (error) {
    try { input.setRawMode(wasRaw ?? false); } catch { /* best-effort terminal restoration */ }
    if (wasFlowing !== true) input.pause();
    throw error;
  }

  return new Promise<string>((resolvePromise, rejectPromise) => {
    let settled = false;
    let value = "";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.removeListener("keypress", onKeypress);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      signal.removeEventListener("abort", onAbort);
      try {
        input.setRawMode(wasRaw ?? false);
      } catch { /* keep the original prompt error; cleanup is best-effort */ }
      if (wasFlowing !== true) input.pause();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const onAbort = () => finish(new Error("凭据录入已取消。"));
    const onEnd = () => finish(new Error("凭据录入已取消。"));
    const onKeypress = (str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) {
        finish(new Error("凭据录入已取消。"));
      } else if (key.name === "return" || key.name === "enter") {
        try {
          output.write("\n");
          validateCredential(value);
          finish();
        } catch (error) {
          finish(error instanceof Error ? error : new Error("凭据格式无效。"));
        }
      } else if (key.name === "backspace") {
        if (value.length > 0) value = value.slice(0, -1);
      } else if (key.ctrl) {
        finish(new Error("凭据包含不支持的字符。"));
      } else if (str.length > 0) {
        const next = value + str;
        try {
          validateCredential(next);
          value = next;
        } catch (error) {
          finish(error instanceof Error ? error : new Error("凭据格式无效。"));
        }
      }
    };
    input.on("keypress", onKeypress);
    input.once("end", onEnd);
    input.once("close", onEnd);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function credentials(dataDir: string): Promise<void> {
  assertTTY(process.stdin, process.stdout);
  const config = readModelConfig(dataDir);
  assertCredentialFileAbsent(dataDir);
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const key = await readCredentialFromTTY(process.stdin, process.stdout, controller.signal);
    createCredentialFile(dataDir, config, key, controller.signal);
    process.stdout.write("凭据已排他保存，权限为 0600。\n");
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

async function main(args: string[]): Promise<void> {
  const command = args[0] ?? "help";
  if (args.length > 1 || !["credentials", "verify-directory", "verify-files", "help"].includes(command)) {
    fail("未知管理命令；请使用 help。");
  }
  if (command === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const dataDir = resolveDataDirectory();
  if (command === "verify-directory") {
    assertPrivateDir(dataDir);
    process.stdout.write("私有 data 目录检查通过。\n");
  } else if (command === "verify-files") {
    verifyFiles(dataDir);
    process.stdout.write("serve 文件预检通过；未打开数据库或验证模型可用性。\n");
  } else {
    assertPrivateDir(dataDir);
    await credentials(dataDir);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("管理命令失败；未输出路径或凭据。\n");
    process.exitCode = 1;
  });
}
