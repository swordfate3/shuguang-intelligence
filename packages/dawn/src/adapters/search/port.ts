export interface SearchSource {
  readonly title: string;
  readonly url: string;
  /** An upstream search excerpt, not a claim to contain the full source text. */
  readonly content: string;
  readonly publishedDate?: string;
}

export interface SearchResult {
  readonly provider: string;
  readonly retrievedAt: string;
  readonly sources: readonly SearchSource[];
}

export interface SearchPort {
  search(query: string, signal: AbortSignal): Promise<SearchResult>;
}

const ERROR_CODES = [
  "SEARCH_INVALID_CONFIG", "SEARCH_INVALID_QUERY", "SEARCH_INVALID_RESPONSE",
  "SEARCH_RESPONSE_TOO_LARGE", "SEARCH_HTTP_ERROR", "SEARCH_FAILED",
  "SEARCH_TIMEOUT", "SEARCH_CANCELLED",
] as const;
export type SearchErrorCode = typeof ERROR_CODES[number];

/** Only fixed local codes cross the boundary; no upstream text, URL, key or cause. */
export class SearchError extends Error {
  readonly code: SearchErrorCode;
  constructor(code: SearchErrorCode) {
    const safeCode = ERROR_CODES.includes(code) ? code : "SEARCH_FAILED";
    super(safeCode);
    this.name = "SearchError";
    this.code = safeCode;
  }
}

function fail(code: SearchErrorCode): never { throw new SearchError(code); }
function dataRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (!required.every(key => Object.hasOwn(value, key))) return false;
  return keys.every(key => {
    if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return "value" in descriptor && descriptor.enumerable === true;
  });
}

function sourceArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 3) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
  }
  return keys.every(key => key === "length" || (typeof key === "string" && /^(0|1|2)$/.test(key)));
}

/** Canonical millisecond-resolution UTC timestamp, not a permissive Date.parse input. */
export function isSearchTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function wellFormed(value: string): boolean {
  // ES2023-compatible equivalent of String.isWellFormed (an ES2024 API).
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value;
}

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit && wellFormed(value);
}

/** Validate the normalized provider-neutral contract. Never admits hidden/raw fields.
 * Strings must round-trip through UTF-8 without replacing lone UTF-16 surrogates.
 * This validates excerpts and provenance shape, not factual accuracy or full-text coverage.
 */
export function assertSearchResult(value: unknown): asserts value is SearchResult {
  if (!dataRecord(value, ["provider", "retrievedAt", "sources"]) ||
      typeof value.provider !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.provider) ||
      !isSearchTimestamp(value.retrievedAt) || !sourceArray(value.sources)) {
    fail("SEARCH_INVALID_RESPONSE");
  }
  for (const source of value.sources as unknown[]) {
    if (!dataRecord(source, ["title", "url", "content"], ["publishedDate"]) ||
        !boundedText(source.title, 256) || !boundedText(source.content, 2000) || !isPublicSourceUrl(source.url) ||
        ("publishedDate" in source && !boundedText(source.publishedDate, 128))) {
      fail("SEARCH_INVALID_RESPONSE");
    }
  }
}

export function isSearchQuery(value: unknown): value is string {
  return typeof value === "string" && value.length <= 400 && wellFormed(value) && value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

/** Syntactic public-address policy only: no DNS lookup and no fetching source URLs.
 * Hostnames are not a DNS/rebinding guarantee; callers must never use this as a fetch permit.
 */
export function isPublicSourceUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || !wellFormed(value) || !/^https?:\/\//i.test(value) ||
      /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value)) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) return false;
  // Reject even an empty credentials delimiter, which URL otherwise normalizes away.
  if (value.slice(value.indexOf("://") + 3).split(/[/?#]/, 1)[0]!.includes("@")) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) {
    // Conservatively admit only global-unicast IPv6, excluding special-use,
    // documentation, Teredo and 6to4 ranges (including embedded private IPv4).
    const parts = host.slice(1, -1).split(":");
    const first = Number.parseInt(parts[0]!, 16);
    const second = parts[1] ? Number.parseInt(parts[1], 16) : 0;
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff &&
      !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8));
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    // URL canonicalization also catches integer, octal, hex and shortened IPv4 spellings.
    const [a, b, c] = host.split(".").map(Number) as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (!host.includes(".") || host.length > 253 ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|home\.arpa|test|invalid|onion)$/.test(host)) return false;
  return host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
