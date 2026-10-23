import {
  SearchError, isSearchQuery, isPublicSourceUrl, isSearchTimestamp, assertSearchResult,
  type SearchPort, type SearchResult, type SearchSource, type SearchErrorCode,
} from "./port.ts";
export {
  SearchError, isSearchQuery, isPublicSourceUrl, isSearchTimestamp, assertSearchResult,
  type SearchPort, type SearchResult, type SearchSource, type SearchErrorCode,
} from "./port.ts";

const ENDPOINT = "https://api.tavily.com/search";
const MAX_RESPONSE_BYTES = 256 * 1024;
function fail(code: SearchErrorCode): never { throw new SearchError(code); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value: unknown, retrievedAt: string): SearchResult {
  if (!record(value) || "error" in value || !Array.isArray(value.results) || value.results.length > 3) {
    fail("SEARCH_INVALID_RESPONSE");
  }
  const sources: SearchSource[] = [];
  for (const item of value.results as unknown[]) {
    if (!record(item) || typeof item.title !== "string" || item.title.length > 256 ||
        typeof item.content !== "string" || item.content.length > 2000 || typeof item.url !== "string" ||
        (item.published_date !== undefined && item.published_date !== null &&
          (typeof item.published_date !== "string" || item.published_date.length > 128))) {
      fail("SEARCH_INVALID_RESPONSE");
    }
    if (!isPublicSourceUrl(item.url)) continue;
    // Explicit allowlist: answer, raw_content, images, scores and all other fields are discarded.
    sources.push(Object.freeze({
      title: item.title, url: item.url, content: item.content,
      ...(typeof item.published_date === "string" ? { publishedDate: item.published_date } : {}),
    }));
  }
  const result = Object.freeze({ provider: "tavily", retrievedAt, sources: Object.freeze(sources) });
  assertSearchResult(result);
  return result;
}

function cancelBody(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* Best effort only. */ }
}

/** Independent API adapter: no environment lookup, retries, source fetches or endpoint override. */
export class TavilySearch implements SearchPort {
  #apiKey: string;
  #timeoutMs: number;
  #fetch: typeof fetch;
  #now: () => string;

  constructor(options: { apiKey: string; timeoutMs?: number }, dependencies: {
    fetch?: typeof fetch; now?: () => string;
  } = {}) {
    if (!record(options) || Object.keys(options).some(key => key !== "apiKey" && key !== "timeoutMs") ||
        typeof options.apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(options.apiKey) ||
        !record(dependencies) || Object.keys(dependencies).some(key => key !== "fetch" && key !== "now")) {
      fail("SEARCH_INVALID_CONFIG");
    }
    const timeoutMs = options.timeoutMs === undefined ? 10_000 : options.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000 ||
        (dependencies.fetch !== undefined && typeof dependencies.fetch !== "function") ||
        (dependencies.now !== undefined && typeof dependencies.now !== "function")) fail("SEARCH_INVALID_CONFIG");
    this.#apiKey = options.apiKey;
    this.#timeoutMs = timeoutMs;
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async search(query: string, signal: AbortSignal): Promise<SearchResult> {
    if (!isSearchQuery(query)) fail("SEARCH_INVALID_QUERY");
    if (!(signal instanceof AbortSignal)) fail("SEARCH_INVALID_QUERY");
    if (signal.aborted) fail("SEARCH_CANCELLED");
    const controller = new AbortController();
    let stopCode: "SEARCH_CANCELLED" | "SEARCH_TIMEOUT" | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectStopped!: (reason: SearchError) => void;
    const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
    const stop = (code: "SEARCH_CANCELLED" | "SEARCH_TIMEOUT") => {
      if (stopCode) return;
      stopCode = code;
      rejectStopped(new SearchError(code));
      controller.abort();
      try { void reader?.cancel().catch(() => undefined); } catch { /* Best effort only. */ }
    };
    const cancel = () => stop("SEARCH_CANCELLED");
    const assertActive = () => { if (stopCode) fail(stopCode); };
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => stop("SEARCH_TIMEOUT"), this.#timeoutMs);
    const perform = async (): Promise<SearchResult> => {
      const response = await this.#fetch(ENDPOINT, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query, search_depth: "basic", topic: "general", max_results: 3, chunks_per_source: 1,
          auto_parameters: false, include_answer: false, include_raw_content: false,
          include_images: false, include_usage: false, include_published_date: true,
        }),
      });
      if (stopCode) { cancelBody(response); assertActive(); }
      if (!response.ok || response.redirected) { cancelBody(response); fail("SEARCH_HTTP_ERROR"); }
      const length = response.headers.get("content-length");
      if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
        cancelBody(response); fail("SEARCH_RESPONSE_TOO_LARGE");
      }
      if (!response.body) fail("SEARCH_INVALID_RESPONSE");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          assertActive();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) fail("SEARCH_RESPONSE_TOO_LARGE");
          // Copy: an injected producer must not mutate previously read chunks.
          chunks.push(value.slice());
        }
      } finally {
        try { void reader.cancel().catch(() => undefined); } catch { /* Best effort only. */ }
        reader.releaseLock();
        reader = undefined;
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
      catch { fail("SEARCH_INVALID_RESPONSE"); }
      assertActive();
      const retrievedAt = this.#now();
      if (!isSearchTimestamp(retrievedAt)) {
        fail("SEARCH_FAILED");
      }
      const result = normalize(parsed, retrievedAt);
      assertActive();
      return result;
    };
    try {
      // Race the entire operation, not only fetch headers. Uncooperative fetches
      // cannot delay cancellation/timeout or turn a late response into a result.
      return await Promise.race([perform(), stopped]);
    } catch (error) {
      if (stopCode) fail(stopCode);
      if (error instanceof SearchError) fail(error.code);
      fail("SEARCH_FAILED");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      controller.abort();
    }
  }
}
