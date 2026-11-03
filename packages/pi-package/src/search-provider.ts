import { lookup as dnsLookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import * as https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
export const TAVILY_SEARCH_PROVIDER_ID = "tavily-search-v1" as const;
const API_HOST = "api.tavily.com";
const API_PATH = "/search";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_MATERIAL_BYTES = 32 * 1024;
const MAX_RESULTS = 3;
const FIXED_ERROR = "Search unavailable.";
const INVALID_INPUT_ERROR = "Invalid search request.";
export interface SearchResultMaterial {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  /** Tavily's `content` is provider-supplied and is not attested verbatim page text. */
  readonly origin: "host_summary";
}
export interface SearchMaterial {
  readonly providerId: typeof TAVILY_SEARCH_PROVIDER_ID;
  readonly retrievedAt: string;
  readonly results: readonly SearchResultMaterial[];
}
/** The caller must ensure this exact query and result budget were owner-approved in the active manifest. */
export interface SearchRequest {
  readonly query: string;
  readonly maxResults: number;
  readonly signal?: AbortSignal;
}
export interface SearchProviderStatus {
  readonly supported: true;
  readonly available: boolean;
}
export interface SearchProviderPort {
  readonly providerId: typeof TAVILY_SEARCH_PROVIDER_ID;
  status(): SearchProviderStatus;
  search(request: SearchRequest): Promise<SearchMaterial>;
}
export interface TavilySearchProviderOptions {
  /** Required explicit environment-variable name. No credential discovery or fallback is performed. */
  readonly credentialEnv: string;
  /** Test-only injection seams; production code should use the fixed defaults. */
  readonly credentialLookup?: (name: string) => string | undefined;
  readonly lookup?: (hostname: string) => Promise<readonly { readonly address: string; readonly family: number }[]>;
  readonly request?: SearchRequestFunction;
  readonly now?: () => Date;
}
export type SearchRequestFunction = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key)) &&
    keys.every(key => required.includes(key) || optional.includes(key));
}
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
function normalizeSearchRequest(value: unknown): SearchRequest {
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(INVALID_INPUT_ERROR);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string") || !exactKeys(value, ["query", "maxResults"], ["signal"])) {
    throw new Error(INVALID_INPUT_ERROR);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const query = descriptors.query;
  const maxResults = descriptors.maxResults;
  const signal = descriptors.signal;
  if (!query?.enumerable || !Object.hasOwn(query, "value") || typeof query.value !== "string" ||
      !maxResults?.enumerable || !Object.hasOwn(maxResults, "value") ||
      (signal !== undefined && (!signal.enumerable || !Object.hasOwn(signal, "value")))) throw new Error(INVALID_INPUT_ERROR);
  if (query.value.length < 1 || query.value.length > 1000 || query.value.trim().length === 0 ||
      /[\p{Cc}\p{Cf}]/u.test(query.value) || hasLoneSurrogate(query.value) ||
      !Number.isSafeInteger(maxResults.value) || (maxResults.value as number) < 1 || (maxResults.value as number) > MAX_RESULTS ||
      (signal !== undefined && !(signal.value instanceof AbortSignal))) throw new Error(INVALID_INPUT_ERROR);
  return {
    query: query.value,
    maxResults: maxResults.value as number,
    ...(signal === undefined ? {} : { signal: signal.value as AbortSignal }),
  };
}
function ipv4In(address: string, network: readonly number[], prefix: number): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const networkValue = network.reduce((acc, octet) => acc * 256 + octet, 0);
  const addressValue = octets.reduce((acc, octet) => acc * 256 + octet, 0);
  const shift = 32 - prefix;
  return Math.floor(addressValue / 2 ** shift) === Math.floor(networkValue / 2 ** shift);
}
function ipv6Value(address: string): bigint | undefined {
  if (!isIPv6(address) || address.includes("%")) return undefined;
  let input = address.toLowerCase();
  const lastColon = input.lastIndexOf(":");
  const tail = input.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIPv4(tail)) return undefined;
    const octets = tail.split(".").map(Number);
    const hi = (octets[0]! * 256 + octets[1]!).toString(16);
    const lo = (octets[2]! * 256 + octets[3]!).toString(16);
    input = `${input.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (words.length !== 8 || words.some(word => !/^[0-9a-f]{1,4}$/u.test(word))) return undefined;
  return words.reduce((acc, word) => (acc << 16n) | BigInt(`0x${word}`), 0n);
}
function ipv6Prefix(address: bigint, network: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return (address >> shift) === (network >> shift);
}
/** Reject special-use, private, mapped, documentation, link-local and non-global IP addresses. */
export function isPublicAddress(address: string, family?: number): boolean {
  if (isIPv4(address) && (family === undefined || family === 4)) {
    const blocked: ReadonlyArray<readonly [readonly number[], number]> = [
      [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8],
      [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12], [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24],
      [[168, 63, 129, 16], 32], // Azure platform/metadata service address
      [[192, 31, 196, 0], 24], [[192, 52, 193, 0], 24], [[192, 88, 99, 0], 24],
      [[192, 168, 0, 0], 16], [[192, 175, 48, 0], 24], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24],
      [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
    ];
    return !blocked.some(([network, prefix]) => ipv4In(address, network, prefix));
  }
  if (!isIPv6(address) || (family !== undefined && family !== 6)) return false;
  const value = ipv6Value(address);
  if (value === undefined) return false;
  // Only global-unicast 2000::/3 is eligible; this excludes unspecified, loopback,
  // mapped/translated, ULA, link-local, multicast, discard-only and transition ranges.
  const globalUnicast = ipv6Prefix(value, 0x20000000000000000000000000000000n, 3);
  if (!globalUnicast) return false;
  const excluded: ReadonlyArray<readonly [bigint, number]> = [
    [0x20010000000000000000000000000000n, 23], // protocol assignments / Teredo / ORCHIDv1
    [0x20010020000000000000000000000000n, 28], // ORCHIDv1
    [0x20010030000000000000000000000000n, 28], // ORCHIDv2
    [0x20010db8000000000000000000000000n, 32], // documentation
    [0x20020000000000000000000000000000n, 16], // 6to4 embeds arbitrary IPv4 destinations
    [0x3ffe0000000000000000000000000000n, 16], // deprecated 6bone
    [0x3fff0000000000000000000000000000n, 20], // documentation
  ];
  return !excluded.some(([network, prefix]) => ipv6Prefix(value, network, prefix));
}
function publicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host || host.endsWith(".") || isIPv4(host) || isIPv6(host) || host.length > 253 || !host.includes(".")) return false;
  if (["localhost", "local", "internal", "test", "invalid", "example", "onion", "arpa", "lan", "home", "corp", "example.com", "example.org", "example.net"]
    .some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return false;
  const labels = host.split(".");
  return labels.every(label => label.length >= 1 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label));
}
/** Validate a returned link only; this function never resolves or fetches the URL. */
export function validatePublicHttpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048 || hasLoneSurrogate(value) ||
      /[\p{Cc}\p{Cf}]/u.test(value) || value.includes("?") || value.includes("#")) throw new Error(INVALID_INPUT_ERROR);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(INVALID_INPUT_ERROR); }
  const authorityMatch = /^https:\/\/([^/?#]*)/iu.exec(value);
  const authority = authorityMatch?.[1] ?? "";
  if (!authorityMatch || value !== value.trim() || value.includes("\\") || authority.includes("@") ||
      url.protocol !== "https:" || url.username || url.password || url.port ||
      !publicHostname(url.hostname) || url.href.length > 2048) {
    throw new Error(INVALID_INPUT_ERROR);
  }
  return url.href;
}
function credentialValue(read: (name: string) => string | undefined, envName: string): string | undefined {
  try {
    const value = read(envName);
    return typeof value === "string" && value.length >= 1 && value.length <= 4096 && /^[\x21-\x7e]+$/u.test(value)
      ? value : undefined;
  } catch { return undefined; }
}
function boundedResponse(response: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const fail = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(new Error(FIXED_ERROR));
    };
    const onAbort = (): void => fail();
    signal.addEventListener("abort", onAbort, { once: true });
    const finish = (buffer?: Buffer): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (buffer) resolve(buffer);
      else reject(new Error(FIXED_ERROR));
    };
    response.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_RESPONSE_BYTES) { fail(); response.destroy(); return; }
      chunks.push(bytes);
    });
    response.once("error", fail);
    response.once("aborted", fail);
    response.once("close", () => { if (!response.readableEnded) fail(); });
    response.once("end", () => finish(Buffer.concat(chunks, size)));
    if (signal.aborted) fail();
  });
}
function pinnedLookup(addresses: readonly { readonly address: string; readonly family: number }[]): NonNullable<RequestOptions["lookup"]> {
  const lookup = (hostname: string, options: unknown, callback: (...args: unknown[]) => void): void => {
    if (hostname.toLowerCase() !== API_HOST) { callback(new Error(FIXED_ERROR)); return; }
    const family = isRecord(options) && (options.family === 4 || options.family === 6) ? options.family :
      typeof options === "number" && (options === 4 || options === 6) ? options : undefined;
    const selected = addresses.find(item => family === undefined || item.family === family);
    if (!selected) { callback(new Error(FIXED_ERROR)); return; }
    if (isRecord(options) && options.all === true) callback(null, [{ address: selected.address, family: selected.family }]);
    else callback(null, selected.address, selected.family);
  };
  return lookup as NonNullable<RequestOptions["lookup"]>;
}
function validateProviderResponse(value: unknown, query: string, maxResults: number, retrievedAt: string): SearchMaterial {
  if (!isRecord(value) || !exactKeys(value, ["results"], ["query", "answer", "images", "response_time", "request_id", "follow_up_questions"])) {
    throw new Error(FIXED_ERROR);
  }
  if ((Object.hasOwn(value, "query") && value.query !== query) ||
      (Object.hasOwn(value, "answer") && value.answer !== null) ||
      (Object.hasOwn(value, "images") && (!Array.isArray(value.images) || value.images.length !== 0)) ||
      (Object.hasOwn(value, "follow_up_questions") && value.follow_up_questions !== null &&
        (!Array.isArray(value.follow_up_questions) || value.follow_up_questions.length !== 0)) ||
      (Object.hasOwn(value, "response_time") && (typeof value.response_time !== "number" || !Number.isFinite(value.response_time) || value.response_time < 0)) ||
      (Object.hasOwn(value, "request_id") && (typeof value.request_id !== "string" || value.request_id.length > 256))) {
    throw new Error(FIXED_ERROR);
  }
  if (!Array.isArray(value.results) || value.results.length === 0 || value.results.length > maxResults || value.results.length > MAX_RESULTS) {
    throw new Error(FIXED_ERROR);
  }
  const results: SearchResultMaterial[] = [];
  for (const item of value.results) {
    if (!isRecord(item) || !exactKeys(item, ["title", "url", "content"], ["score", "raw_content"]) ||
        typeof item.title !== "string" || item.title.length < 1 || item.title.length > 256 || hasLoneSurrogate(item.title) ||
        typeof item.content !== "string" || item.content.length < 1 || item.content.length > 4000 || hasLoneSurrogate(item.content) ||
        (Object.hasOwn(item, "score") && (typeof item.score !== "number" || !Number.isFinite(item.score) || item.score < 0 || item.score > 1)) ||
        (Object.hasOwn(item, "raw_content") && item.raw_content !== null)) throw new Error(FIXED_ERROR);
    let url: string;
    try { url = validatePublicHttpsUrl(item.url); } catch { throw new Error(FIXED_ERROR); }
    results.push({ url, title: item.title, text: item.content, origin: "host_summary" });
  }
  const material: SearchMaterial = { providerId: TAVILY_SEARCH_PROVIDER_ID, retrievedAt, results };
  if (Buffer.byteLength(JSON.stringify(material), "utf8") > MAX_MATERIAL_BYTES) throw new Error(FIXED_ERROR);
  return material;
}
function rejectDuplicateJsonKeys(text: string): void {
  let offset = 0;
  const whitespace = (): void => { while (text[offset] === " " || text[offset] === "\t" || text[offset] === "\r" || text[offset] === "\n") offset += 1; };
  const stringToken = (): string => {
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const char = text[offset]!;
      if (char === "\\") { offset += 2; continue; }
      if (char === "\"") { offset += 1; return text.slice(start, offset); }
      offset += 1;
    }
    throw new Error(FIXED_ERROR);
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new Error(FIXED_ERROR);
    whitespace();
    const char = text[offset];
    if (char === "{") {
      offset += 1;
      whitespace();
      const seen = new Set<string>();
      if (text[offset] === "}") { offset += 1; return; }
      for (;;) {
        whitespace();
        if (text[offset] !== "\"") throw new Error(FIXED_ERROR);
        const key = JSON.parse(stringToken()) as string;
        if (seen.has(key)) throw new Error(FIXED_ERROR);
        seen.add(key);
        whitespace();
        if (text[offset] !== ":") throw new Error(FIXED_ERROR);
        offset += 1;
        value(depth + 1);
        whitespace();
        if (text[offset] === "}") { offset += 1; return; }
        if (text[offset] !== ",") throw new Error(FIXED_ERROR);
        offset += 1;
      }
    }
    if (char === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") { offset += 1; return; }
      for (;;) {
        value(depth + 1);
        whitespace();
        if (text[offset] === "]") { offset += 1; return; }
        if (text[offset] !== ",") throw new Error(FIXED_ERROR);
        offset += 1;
      }
    }
    if (char === "\"") { stringToken(); return; }
    const atomStart = offset;
    while (offset < text.length && !/[\s,\]}]/u.test(text[offset]!)) offset += 1;
    if (offset === atomStart) throw new Error(FIXED_ERROR);
  };
  value(0);
  whitespace();
  if (offset !== text.length) throw new Error(FIXED_ERROR);
}
function canonicalTime(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(FIXED_ERROR);
  return value.toISOString();
}
/**
 * Fixed Tavily API adapter. One dispatch is one host-side HTTP request count; no claim is made
 * about Tavily's internal billing, processing, or any work it performs behind this endpoint.
 */
export function createTavilySearchProvider(options: TavilySearchProviderOptions): SearchProviderPort {
  if (!isRecord(options) || typeof options.credentialEnv !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(options.credentialEnv)) {
    throw new Error("Invalid search provider configuration.");
  }
  const readCredential = options.credentialLookup ?? ((name: string) => process.env[name]);
  const resolve = options.lookup ?? (async (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  const send = options.request ?? https.request;
  const now = options.now ?? (() => new Date());
  const currentKey = (): string | undefined => credentialValue(readCredential, options.credentialEnv);
  return {
    providerId: TAVILY_SEARCH_PROVIDER_ID,
    status: () => ({ supported: true, available: currentKey() !== undefined }),
    async search(request): Promise<SearchMaterial> {
      let input: SearchRequest;
      try { input = normalizeSearchRequest(request); }
      catch { throw new Error(INVALID_INPUT_ERROR); }
      const key = currentKey();
      if (!key) throw new Error(FIXED_ERROR);
      if (input.signal?.aborted) throw new Error(FIXED_ERROR);
      const controller = new AbortController();
      const forwardAbort = (): void => controller.abort();
      input.signal?.addEventListener("abort", forwardAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      timeout.unref?.();
      const aborted = new Promise<never>((_resolve, reject) => {
        const fail = (): void => reject(new Error(FIXED_ERROR));
        controller.signal.addEventListener("abort", fail, { once: true });
        if (controller.signal.aborted) fail();
      });
      try {
        const addresses = await Promise.race([resolve(API_HOST), aborted]);
        if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 32 ||
            addresses.some(item => !isRecord(item) || typeof item.address !== "string" ||
              (item.family !== 4 && item.family !== 6) || !isPublicAddress(item.address, item.family))) throw new Error(FIXED_ERROR);
        const unique = [...new Map(addresses.map(item => [`${item.family}:${item.address}`, item])).values()];
        const body = JSON.stringify({
          query: input.query,
          search_depth: "basic",
          max_results: input.maxResults,
          include_answer: false,
          include_raw_content: false,
          include_images: false,
          auto_parameters: false,
        });
        const response = await Promise.race([
          new Promise<Buffer>((resolveResponse, rejectResponse) => {
            let req: ClientRequest | undefined;
            const fail = (): void => {
              try { req?.destroy(); } catch { /* fixed public failure */ }
              rejectResponse(new Error(FIXED_ERROR));
            };
            try {
              const headers = {
                accept: "application/json",
                "accept-encoding": "identity",
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body, "utf8")),
                authorization: `Bearer ${key}`,
              };
              const requestOptions: RequestOptions & { readonly autoSelectFamily: false } = {
                hostname: API_HOST,
                servername: API_HOST,
                port: 443,
                path: API_PATH,
                method: "POST",
                headers,
                agent: false,
                autoSelectFamily: false,
                maxHeaderSize: 16 * 1024,
                lookup: pinnedLookup(unique),
                signal: controller.signal,
              };
              req = send(requestOptions, responseMessage => {
                if (controller.signal.aborted || responseMessage.statusCode !== 200) { fail(); responseMessage.destroy(); return; }
                const contentType = responseMessage.headers["content-type"];
                if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType.trim())) {
                  fail(); responseMessage.destroy(); return;
                }
                const encoding = responseMessage.headers["content-encoding"];
                if (encoding !== undefined && !(typeof encoding === "string" && encoding.trim().toLowerCase() === "identity")) {
                  fail(); responseMessage.destroy(); return;
                }
                const declaredLength = responseMessage.headers["content-length"];
                if (declaredLength !== undefined &&
                    (typeof declaredLength !== "string" || !/^\d{1,9}$/u.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) {
                  fail(); responseMessage.destroy(); return;
                }
                void boundedResponse(responseMessage, controller.signal).then(bytes => {
                  if (declaredLength !== undefined && Number(declaredLength) !== bytes.byteLength) { fail(); return; }
                  resolveResponse(bytes);
                }, fail);
              });
              req.once("error", fail);
              controller.signal.addEventListener("abort", fail, { once: true });
              req.end(body);
            } catch { rejectResponse(new Error(FIXED_ERROR)); }
          }),
          aborted,
        ]);
        let decoded: unknown;
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(response);
          rejectDuplicateJsonKeys(text);
          decoded = JSON.parse(text);
        } catch { throw new Error(FIXED_ERROR); }
        // A compromised/upstream diagnostic body can reflect a bearer into otherwise valid content.
        // Never persist or send that reflected credential to Dawn's model.
        const reflectsKey = (v: unknown): boolean => typeof v === "string" ? v.includes(key)
          : Array.isArray(v) ? v.some(reflectsKey)
          : v !== null && typeof v === "object" ? Object.entries(v).some(([k, value]) => k.includes(key) || reflectsKey(value)) : false;
        if (reflectsKey(decoded)) throw new Error(FIXED_ERROR);
        const retrievedAt = canonicalTime(now);
        return validateProviderResponse(decoded, input.query, input.maxResults, retrievedAt);
      } catch {
        throw new Error(FIXED_ERROR);
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", forwardAbort);
      }
    },
  };
}
