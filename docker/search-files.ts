import { closeSync, constants, fstatSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPrivateDir, resolveDataDirectory } from "./manage.ts";
import { parseSearchConfig, parseSearchJson } from "../packages/dawn/src/runtime/search-config.ts";
import { assertSearchGrant } from "../packages/dawn/src/runtime/search-task.ts";

/** Bounded JSON on stdin, no secrets accepted, no network or subject writes. */
export function storeSearchFile(dataPath: string, kind: string, taskId: string | undefined, raw: string, signal: AbortSignal): void {
  signal.throwIfAborted();
  const value = parseSearchJson(raw);
  let name: string;
  if (kind === "config" && taskId === undefined) { parseSearchConfig(value); name = "search.json"; }
  else if (kind === "grant" && typeof taskId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(taskId)) {
    assertSearchGrant(value);
    if (value.id !== taskId || value.expiresAt <= new Date().toISOString()) throw new Error("Task id mismatch or expired grant");
    name = `search-${taskId}.json`;
  } else throw new Error("Invalid search file operation");
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 16_000) throw new Error("Search file too large");
  const dir = assertPrivateDir(dataPath);
  const fd = openSync(join(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd), uid = process.getuid?.();
    if (!stat.isFile() || uid === undefined || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) throw new Error("Private file required");
    signal.throwIfAborted(); writeFileSync(fd, serialized, "utf8"); fsyncSync(fd);
  } finally { closeSync(fd); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const c = new AbortController(); const stop = () => c.abort(); const timer = setTimeout(stop, 10_000);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const abort = () => process.stdin.destroy(new Error("Input cancelled"));
  c.signal.addEventListener("abort", abort, { once: true });
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const value of process.stdin) { const chunk = Buffer.from(value); size += chunk.length;
      if (size > 16_000) throw new Error("Search input too large"); chunks.push(chunk); }
    const args = process.argv.slice(2);
    if (args.length < 1 || args.length > 2) throw new Error("Invalid search file arguments");
    storeSearchFile(resolveDataDirectory(), args[0]!, args[1], new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), c.signal);
    process.stdout.write("搜索配置/授权文件已排他保存；尚未发出搜索请求。\n");
  } catch { process.stderr.write("搜索配置/授权未报告成功；检查JSON、任务ID和权限，已有文件未覆盖。\n"); process.exitCode = 1; }
  finally { clearTimeout(timer); c.signal.removeEventListener("abort", abort); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
