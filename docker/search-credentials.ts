import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPrivateDir, readCredentialFromTTY, resolveDataDirectory } from "./manage.ts";

/** A separate secret file, never the model key/config; exclusive create only. */
export function storeSearchCredential(dataPath: string, key: string, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (typeof key !== "string" || !/^tvly-[A-Za-z0-9_-]{1,500}$/.test(key)) throw new Error("Invalid Tavily credential");
  const dir = assertPrivateDir(dataPath);
  const fd = openSync(join(dir, "search.env"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd), uid = process.getuid?.();
    if (!stat.isFile() || uid === undefined || stat.uid !== uid) throw new Error("Private credential file required");
    fchmodSync(fd, 0o600);
    if ((fstatSync(fd).mode & 0o777) !== 0o600) throw new Error("Private credential file required");
    signal.throwIfAborted();
    writeFileSync(fd, `DAWN_SEARCH_TAVILY_API_KEY='${key}'\n`, "ascii"); fsyncSync(fd);
  } finally { closeSync(fd); }
}
/** Validate before Node --env-file: forbid NODE_OPTIONS/extra variables and unsafe files. */
export function verifySearchCredential(dataPath: string): void {
  const dir = assertPrivateDir(dataPath), path = join(dir, "search.env");
  const before = lstatSync(path);
  if (before.isSymbolicLink()) throw new Error("Search credential symlink refused");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd), uid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1 || uid === undefined || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 ||
        stat.size > 1024 || stat.ino !== before.ino || stat.dev !== before.dev) throw new Error("Unsafe search credential file");
    const bytes = Buffer.alloc(1025); const count = readSync(fd, bytes, 0, bytes.length, null);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
    if (!/^DAWN_SEARCH_TAVILY_API_KEY='tvly-[A-Za-z0-9_-]{1,500}'\n$/.test(raw)) throw new Error("Invalid independent search credential file");
  } finally { closeSync(fd); }
}
export async function promptSearchCredential(dataPath: string, signal: AbortSignal): Promise<void> {
  const dir = assertPrivateDir(dataPath);
  try { lstatSync(join(dir, "search.env")); throw new Error("Search credential already exists"); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
  const key = await readCredentialFromTTY(process.stdin, process.stdout, signal);
  storeSearchCredential(dir, key, signal);
  process.stdout.write("独立搜索凭据已排他保存（0600），未发搜索请求。\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "verify") verifySearchCredential(resolveDataDirectory());
    else if (args.length === 0) await promptSearchCredential(resolveDataDirectory(), controller.signal);
    else throw new Error("Unexpected search credential arguments");
  } catch { process.stderr.write("搜索凭据未报告成功；已有文件未覆盖，未输出密钥。\n"); process.exitCode = 1; }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
