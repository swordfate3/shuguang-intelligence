import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { assertData, integer, object } from "../core/guards.ts";
import { assertSearchGrant, type SearchGrant } from "./search-task.ts";

/** Detect duplicate and escaped-equivalent keys before JSON.parse discards them. */
export function parseSearchJson(source: string, maxBytes = 16_000): unknown {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > maxBytes) throw new Error("Search JSON too large");
  let i = 0, depth = 0;
  const space = () => { while (/\s/u.test(source[i] ?? "")) i++; };
  const string = (): string => {
    const start = i++;
    while (i < source.length) { const c = source[i++]; if (c === "\\") i++; else if (c === '"') return JSON.parse(source.slice(start, i)); }
    throw new Error("Invalid search JSON string");
  };
  const value = (): void => {
    if (++depth > 24) throw new Error("Search JSON too deep");
    space(); const c = source[i];
    if (c === '"') string();
    else if (c === "{") {
      i++; space(); const keys = new Set<string>();
      if (source[i] === "}") i++;
      else for (;;) {
        if (source[i] !== '"') throw new Error("Invalid search JSON key");
        const key = string(); if (keys.has(key)) throw new Error("Duplicate search JSON key"); keys.add(key);
        space(); if (source[i++] !== ":") throw new Error("Invalid search JSON separator"); value(); space();
        const end = source[i++]; if (end === "}") break; if (end !== ",") throw new Error("Invalid search JSON object"); space();
      }
    } else if (c === "[") {
      i++; space(); if (source[i] === "]") i++;
      else for (;;) { value(); space(); const end = source[i++]; if (end === "]") break; if (end !== ",") throw new Error("Invalid search JSON array"); }
    } else {
      const start = i; while (i < source.length && !/[\s,\]}]/u.test(source[i]!)) i++;
      if (i === start) throw new Error("Invalid search JSON value");
    }
    depth--;
  };
  value(); space(); if (i !== source.length) throw new Error("Extra search JSON data");
  const result: unknown = JSON.parse(source); assertData(result); return result;
}
/** Grant/config contain no API key but can disclose private queries. Linux owner-only, bounded, no symlink. */
export function readSearchJson(path: string, maxBytes = 16_000): unknown {
  if (!isAbsolute(path)) throw new Error("Absolute search JSON path required");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd), uid = process.getuid?.();
    if (!stat.isFile() || stat.size > maxBytes || uid === undefined || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
      throw new Error("Private owner-only search JSON file required");
    }
    const bytes = Buffer.alloc(maxBytes + 1); let size = 0;
    while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, null); if (!n) break; size += n; }
    if (size > maxBytes) throw new Error("Search JSON too large");
    return parseSearchJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)), maxBytes);
  } finally { closeSync(fd); }
}
export interface SearchFileConfig { readonly provider: string; readonly credentialEnv: string; readonly timeoutMs: number }
export function parseSearchConfig(value: unknown): SearchFileConfig {
  assertData(value); const c = object(value, ["provider", "credentialEnv", "timeoutMs"]);
  if (typeof c.provider !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(c.provider) ||
      typeof c.credentialEnv !== "string" || !/^DAWN_SEARCH_[A-Z0-9_]{1,64}_API_KEY$/.test(c.credentialEnv)) {
    throw new Error("Explicit independent search provider and credential reference required");
  }
  integer(c.timeoutMs, 1, 15_000); return structuredClone(value) as SearchFileConfig;
}
export function readSearchGrant(path: string): SearchGrant {
  const grant = readSearchJson(path); assertSearchGrant(grant); return grant;
}
