import assert from "node:assert/strict";
import { createServer } from "node:http";
import { inspect } from "node:util";
import test from "node:test";
import { TavilySearch } from "../src/adapters/search/tavily.ts";
import {
  SearchError, isSearchQuery, isPublicSourceUrl, isSearchTimestamp, assertSearchResult,
  type SearchErrorCode, type SearchPort, type SearchResult,
} from "../src/adapters/search/port.ts";

// Synthetic only. Injected implementations never contact Tavily or the public internet.
const apiKey = "synthetic-search-key-DO-NOT-LEAK";
const now = "2026-10-23T01:00:00.000Z";
const source = () => ({ title: "Synthetic title", url: "https://example.org/article", content: "Search excerpt" });
const payload = () => ({ results: [source()] });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const run = (adapter: SearchPort, signal = new AbortController().signal) => adapter.search("synthetic query", signal);
const fake = (implementation: typeof fetch, timeoutMs = 1000) => new TavilySearch({ apiKey, timeoutMs }, { fetch: implementation, now: () => now });
const returned = (value: unknown) => fake(async () => json(value));

function code(expected: SearchErrorCode) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.name, "SearchError");
    assert.equal(error.code, expected);
    assert.equal(error.message, expected);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(inspect(error, { showHidden: true }), /synthetic-search-key|upstream-private|secret-query|https?:\/\//);
    return true;
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

test("generic SearchPort supports a different provider with no Tavily dependency", async () => {
  const alternate: SearchPort = {
    async search(query, signal): Promise<SearchResult> {
      assert.equal(query, "synthetic query");
      assert.equal(signal.aborted, false);
      return { provider: "offline-fixture", retrievedAt: now, sources: [source()] };
    },
  };
  const result = await run(alternate);
  assertSearchResult(result);
  assert.equal(result.provider, "offline-fixture");
  assert.ok(isSearchTimestamp(result.retrievedAt));
});

test("generic result validator rejects unknown fields, unsafe sources and invalid provider IDs", () => {
  const valid = { provider: "fixture-v2", retrievedAt: now, sources: [source()] };
  assertSearchResult(valid);
  for (const value of [null, [], { ...valid, provider: "" }, { ...valid, provider: "Fixture" },
    { ...valid, provider: "a".repeat(65) }, { ...valid, provider: "bad/provider" },
    { ...valid, retrievedAt: "2026-10-23" }, { ...valid, retrievedAt: "2026-02-30T01:00:00.000Z" },
    { ...valid, answer: "private" }, { ...valid, sources: [source(), source(), source(), source()] },
    { ...valid, sources: [{ ...source(), raw_content: "private" }] },
    { ...valid, sources: [{ ...source(), url: "http://127.0.0.1" }] },
    { ...valid, sources: [{ ...source(), title: "x".repeat(257) }] },
    { ...valid, sources: [{ ...source(), content: "x".repeat(2001) }] },
    { ...valid, sources: [{ ...source(), publishedDate: "x".repeat(129) }] },
    { ...valid, sources: [{ ...source(), publishedDate: undefined }] },
    { ...valid, sources: [{ ...source(), title: "\ud800" }] },
    { ...valid, sources: [{ ...source(), content: "\udfff" }] },
  ]) assert.throws(() => assertSearchResult(value), code("SEARCH_INVALID_RESPONSE"));
  assertSearchResult({ provider: "a".repeat(64), retrievedAt: now, sources: [] });
  assert.equal(isSearchQuery("\ud800"), false);
  assert.equal(isPublicSourceUrl("https://example.org/\ud800"), false);
});

test("generic validator rejects accessors before execution, inherited fields and hidden data", () => {
  let calls = 0;
  const valid = { provider: "fixture", retrievedAt: now, sources: [source()] };
  const accessor = { ...valid };
  Object.defineProperty(accessor, "provider", { enumerable: true, get() { calls += 1; return "fixture"; } });
  const sourceAccessor = source();
  Object.defineProperty(sourceAccessor, "content", { enumerable: true, get() { calls += 1; return "secret"; } });
  const arrayAccessor = [source()];
  Object.defineProperty(arrayAccessor, "0", { enumerable: true, get() { calls += 1; return source(); } });
  const hidden = { ...valid };
  Object.defineProperty(hidden, "private", { value: "secret", enumerable: false });
  const symbol = { ...valid, [Symbol("private")]: "secret" };
  const arraySymbol = Object.assign([source()], { [Symbol("private")]: "secret" });
  for (const value of [accessor, { ...valid, sources: [sourceAccessor] }, { ...valid, sources: arrayAccessor },
    hidden, symbol, Object.create(valid), { ...valid, sources: [Object.create(source())] },
    { ...valid, sources: arraySymbol }, { ...valid, sources: new Array(1) }]) {
    assert.throws(() => assertSearchResult(value), code("SEARCH_INVALID_RESPONSE"));
  }
  assert.equal(calls, 0);
});

test("Tavily normalization also enforces generic UTF-8-safe excerpt validation", async () => {
  for (const field of ["title", "content", "published_date"]) {
    await assert.rejects(run(returned({ results: [{ ...source(), [field]: "\ud800" }] })), code("SEARCH_INVALID_RESPONSE"));
  }
});

test("fixed endpoint, POST Bearer, exact bounded request and normalized allowlist", async () => {
  let calls = 0;
  const adapter = fake(async (input, init) => {
    calls += 1;
    assert.equal(input, "https://api.tavily.com/search");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(init?.headers, { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(init!.body as string), {
      query: "synthetic query", search_depth: "basic", topic: "general", max_results: 3,
      chunks_per_source: 1, auto_parameters: false, include_answer: false, include_raw_content: false,
      include_images: false, include_usage: false, include_published_date: true,
    });
    assert.doesNotMatch(init!.body as string, /synthetic-search-key/);
    return json({ ...payload(), answer: "untrusted answer", images: ["private"], usage: { arbitrary: true },
      results: [{ ...source(), published_date: "2026-10-22", raw_content: "not allowed", score: 1, instructions: "execute me" }] });
  });
  assert.deepEqual(await run(adapter), { provider: "tavily", retrievedAt: now,
    sources: [{ ...source(), publishedDate: "2026-10-22" }] });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(adapter), "{}");
  assert.doesNotMatch(inspect(adapter, { showHidden: true }), /synthetic-search-key/);
});

test("constructor validates strict options, key and timeout without dispatch", () => {
  for (const options of [null, {}, { apiKey: "" }, { apiKey: "has space" }, { apiKey: "secret\r\nheader" },
    { apiKey, endpoint: "https://upstream-private.invalid" }, { apiKey, timeoutMs: 0 }, { apiKey, timeoutMs: 15001 },
    { apiKey, timeoutMs: 0.5 }, { apiKey, timeoutMs: NaN }, { apiKey, timeoutMs: Infinity }]) {
    assert.throws(() => new TavilySearch(options as { apiKey: string }), code("SEARCH_INVALID_CONFIG"));
  }
  for (const dependencies of [null, { fetch: 1 }, { now: "invalid" }, { endpoint: "private" }]) {
    assert.throws(() => new TavilySearch({ apiKey }, dependencies as never), code("SEARCH_INVALID_CONFIG"));
  }
  for (const timeoutMs of [undefined, 1, 15000]) {
    assert.ok(new TavilySearch({ apiKey, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, { fetch: async () => json(payload()) }));
  }
});

test("queries reject empty, excessive length and all C0/C1 controls before dispatch", async () => {
  let calls = 0;
  const adapter = fake(async () => { calls += 1; return json(payload()); });
  const invalid: unknown[] = [undefined, null, 1, "", "   ", "a".repeat(401)];
  for (let point = 0; point < 160; point += 1) {
    if (point < 32 || point >= 127) invalid.push(`query${String.fromCharCode(point)}`);
  }
  for (const query of invalid) {
    assert.equal(isSearchQuery(query), false);
    await assert.rejects(adapter.search(query as string, new AbortController().signal), code("SEARCH_INVALID_QUERY"));
  }
  assert.equal(calls, 0);
  await adapter.search("a".repeat(400), new AbortController().signal);
  await adapter.search("合成搜索", new AbortController().signal);
  assert.equal(calls, 2);
});

test("public URL validator rejects credentials, local names, private and unusual IP spellings", () => {
  const rejected = [
    "ftp://example.org", "file:///private", " https://example.org", "https://example.org\\private",
    "https://user:secret@example.org", "https://user@example.org", "https://@example.org",
    "http://localhost", "http://localhost.", "http://sub.localhost", "http://machine", "http://a.local",
    "http://a.internal", "http://a.lan", "http://router.home.arpa", "http://a.test", "http://a.invalid",
    "http://127.0.0.1", "http://127.1", "http://2130706433", "http://0x7f000001", "http://0177.0.0.1",
    "http://0.1.2.3", "http://10.2.3.4", "http://172.16.0.1", "http://172.31.255.255",
    "http://192.168.1.1", "http://169.254.169.254", "http://100.64.0.1", "http://100.127.0.1",
    "http://198.18.0.1", "http://192.0.2.1", "http://198.51.100.1", "http://203.0.113.1",
    "http://224.0.0.1", "http://255.255.255.255", "http://[::]", "http://[::1]", "http://[fc00::1]",
    "http://[fd00::1]", "http://[fe80::1]", "http://[ff02::1]", "http://[::ffff:127.0.0.1]",
    "http://[2001:db8::1]", "http://[2002:7f00:1::]", "http://[2001::1]", "https://a..org", "https://-a.org",
  ];
  for (const url of rejected) assert.equal(isPublicSourceUrl(url), false, url);
  for (const url of ["https://example.org/article", "http://example.com/path?q=x#fragment", "https://8.8.8.8",
    "https://[2606:4700:4700::1111]/", "http://172.32.0.1", "http://100.128.0.1", "https://EXAMPLE.ORG./"]) {
    assert.equal(isPublicSourceUrl(url), true, url);
  }
});

test("unsafe URLs are filtered, not fetched, and zero through three results are allowed", async () => {
  const result = await run(returned({ results: [source(), { ...source(), url: "http://127.0.0.1/private" },
    { ...source(), url: "https://user:secret@example.org" }] }));
  assert.deepEqual(result.sources, [source()]);
  assert.deepEqual((await run(returned({ results: [] }))).sources, []);
  assert.equal((await run(returned({ results: [source(), source(), source()] }))).sources.length, 3);
  assert.deepEqual((await run(returned({ results: [{ ...source(), url: "javascript:alert(1)" }] }))).sources, []);
  const unsafe = await run(returned({ query: "secret-query", answer: "secret-query", results: [
    { ...source(), title: "secret-query", content: "secret-query", url: "http://localhost/secret-query" },
  ] }));
  assert.deepEqual(unsafe.sources, []);
  assert.doesNotMatch(JSON.stringify(unsafe), /secret-query/);
});

test("more than three results and malformed schemas reject rather than silently truncate", async () => {
  for (const value of [null, [], {}, { results: "bad" }, { results: [source(), source(), source(), source()] },
    { results: [null] }, { results: [{ ...source(), title: 1 }] }, { results: [{ ...source(), content: null }] },
    { results: [{ ...source(), url: 1 }] }, { results: [{ ...source(), published_date: {} }] },
    { ...payload(), error: "upstream-private" }]) {
    await assert.rejects(run(returned(value)), code("SEARCH_INVALID_RESPONSE"));
  }
});

test("title/content/date limits reject oversized excerpts and preserve exact boundary values", async () => {
  for (const [field, length] of [["title", 256], ["content", 2000], ["published_date", 128]] as const) {
    const value = "x".repeat(length);
    const result = await run(returned({ results: [{ ...source(), [field]: value }] }));
    const resultField = field === "published_date" ? "publishedDate" : field;
    assert.equal(result.sources[0]![resultField], value);
    await assert.rejects(run(returned({ results: [{ ...source(), [field]: value + "x" }] })), code("SEARCH_INVALID_RESPONSE"));
  }
  assert.deepEqual((await run(returned({ results: [{ ...source(), published_date: null }] }))).sources, [source()]);
});

test("public source URLs have an explicit 2048 character boundary", async () => {
  const prefix = "https://example.org/";
  const atLimit = prefix + "x".repeat(2048 - prefix.length);
  assert.equal(isPublicSourceUrl(atLimit), true);
  assert.equal(isPublicSourceUrl(atLimit + "x"), false);
  assert.equal((await run(returned({ results: [{ ...source(), url: atLimit }] }))).sources[0]!.url, atLimit);
  assert.deepEqual((await run(returned({ results: [{ ...source(), url: atLimit + "x" }] }))).sources, []);
});

test("result objects are frozen and carry no upstream references", async () => {
  const result = await run(returned(payload()));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.sources));
  assert.ok(Object.isFrozen(result.sources[0]));
});

test("HTTP and redirect responses fail without reading or exposing bodies or locations", async () => {
  for (const status of [301, 302, 307, 308, 400, 401, 429, 500]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const adapter = fake(async () => new Response(body, { status, headers: { Location: "https://upstream-private.invalid" } }));
    await assert.rejects(run(adapter), code("SEARCH_HTTP_ERROR"));
    assert.equal(cancelled, true);
  }
  const response = json(payload());
  Object.defineProperty(response, "redirected", { value: true });
  await assert.rejects(run(fake(async () => response)), code("SEARCH_HTTP_ERROR"));
});

test("raw fetch errors and even forged SearchError details are replaced with fixed redacted codes", async () => {
  for (const raw of [new Error(`upstream-private ${apiKey}`), "secret-query", { key: apiKey },
    new TypeError("https://upstream-private.invalid"), Object.assign(new SearchError("SEARCH_FAILED"), { message: apiKey, cause: apiKey })]) {
    let calls = 0;
    await assert.rejects(run(fake(async () => { calls += 1; throw raw; })), code("SEARCH_FAILED"));
    assert.equal(calls, 1);
  }
  assert.equal(new SearchError("upstream-private" as SearchErrorCode).message, "SEARCH_FAILED");
});

test("malformed JSON, missing bodies and fatal UTF-8 errors are fixed invalid-response failures", async () => {
  for (const response of [new Response("{upstream-private"), new Response(null), new Response(new Uint8Array([0xc3, 0x28])),
    new Response(new Uint8Array([...new TextEncoder().encode('{"results":[],"x":"'), 0xff, ...new TextEncoder().encode('"}')]))]) {
    await assert.rejects(run(fake(async () => response)), code("SEARCH_INVALID_RESPONSE"));
  }
});

test("UTF-8 split across chunks is decoded once without replacement characters", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ results: [{ ...source(), content: "你好世界" }] }));
  let index = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (index === bytes.length) controller.close();
    else controller.enqueue(bytes.slice(index, ++index));
  } });
  assert.equal((await run(fake(async () => new Response(body)))).sources[0]!.content, "你好世界");
});

test("declared oversized bodies are cancelled before reads", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await assert.rejects(run(fake(async () => new Response(body, { headers: { "Content-Length": String(256 * 1024 + 1) } }))), code("SEARCH_RESPONSE_TOO_LARGE"));
  assert.equal(cancelled, true);
});

test("streamed wire limit counts bytes and ignores missing or dishonest content-length", async () => {
  const headerCases: HeadersInit[] = [{}, { "Content-Length": "1" }, { "Content-Length": "invalid" }];
  for (const headers of headerCases) {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(64 * 1024));
    }, cancel() { cancelled = true; } });
    await assert.rejects(run(fake(async () => new Response(body, { headers }))), code("SEARCH_RESPONSE_TOO_LARGE"));
    assert.equal(cancelled, true);
    assert.ok(pulls <= 6);
  }
});

test("exact 256 KiB boundary succeeds but one more byte rejects", async () => {
  const text = JSON.stringify(payload());
  const padded = text + " ".repeat(256 * 1024 - new TextEncoder().encode(text).length);
  assert.equal((await run(fake(async () => new Response(padded)))).sources.length, 1);
  await assert.rejects(run(fake(async () => new Response(padded + " "))), code("SEARCH_RESPONSE_TOO_LARGE"));
});

test("body stream errors are redacted with no retry", async () => {
  let calls = 0;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(`upstream-private ${apiKey}`)); } });
  await assert.rejects(run(fake(async () => { calls += 1; return new Response(body); })), code("SEARCH_FAILED"));
  assert.equal(calls, 1);
});

test("already aborted signals reject without dispatch or leaking abort reason", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error(`upstream-private ${apiKey}`));
  await assert.rejects(run(fake(async () => { calls += 1; return json(payload()); }), controller.signal), code("SEARCH_CANCELLED"));
  assert.equal(calls, 0);
});

test("cancellation races a fetch that ignores the signal and cancels its late body", async () => {
  const response = deferred<Response>();
  const controller = new AbortController();
  const cancelledBody = deferred<void>();
  let fetchSignal: AbortSignal | null | undefined;
  const adapter = fake(async (_input, init) => { fetchSignal = init?.signal; return response.promise; });
  const pending = run(adapter, controller.signal);
  controller.abort(`upstream-private ${apiKey}`);
  await assert.rejects(pending, code("SEARCH_CANCELLED"));
  assert.equal(fetchSignal?.aborted, true);
  response.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelledBody.resolve(); } })));
  await cancelledBody.promise;
});

test("timeout races ignored fetch and safely consumes a late rejection", async () => {
  let rejectFetch!: (reason: unknown) => void;
  let fetchSignal: AbortSignal | null | undefined;
  const adapter = fake(async (_input, init) => {
    fetchSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => { rejectFetch = reject; });
  }, 5);
  await assert.rejects(run(adapter), code("SEARCH_TIMEOUT"));
  assert.equal(fetchSignal?.aborted, true);
  rejectFetch(new Error(`upstream-private ${apiKey}`));
  await new Promise<void>(resolve => setImmediate(resolve));
});

test("timeout includes stalled body and never awaits an uncooperative cancel", async () => {
  let cancelCalls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull() { return new Promise<void>(() => undefined); },
    cancel() { cancelCalls += 1; return new Promise<void>(() => undefined); },
  });
  await assert.rejects(run(fake(async () => new Response(body), 5)), code("SEARCH_TIMEOUT"));
  assert.equal(cancelCalls, 1);
});

test("abort while reading cancels the reader and rejects any partial result", async () => {
  const reading = deferred<void>();
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull() { reading.resolve(); }, cancel() { cancelled = true; } });
  const pending = run(fake(async () => new Response(body)), controller.signal);
  await reading.promise;
  controller.abort(apiKey);
  await assert.rejects(pending, code("SEARCH_CANCELLED"));
  assert.equal(cancelled, true);
});

test("clock failures are redacted and cancellation during final normalization wins", async () => {
  for (const getNow of [() => "not-a-date", () => "2026-10-23", () => "2026-10-23T01:00:00Z",
    () => "2026-02-30T01:00:00.000Z", () => { throw new Error(`upstream-private ${apiKey}`); }]) {
    await assert.rejects(run(new TavilySearch({ apiKey }, { fetch: async () => json(payload()), now: getNow })), code("SEARCH_FAILED"));
  }
  const controller = new AbortController();
  const adapter = new TavilySearch({ apiKey }, { fetch: async () => json(payload()), now: () => { controller.abort(apiKey); return now; } });
  await assert.rejects(run(adapter, controller.signal), code("SEARCH_CANCELLED"));
});

test("injected transport may exercise local fake HTTP without changing the fixed API endpoint", async t => {
  let calls = 0;
  const server = createServer((request, response) => {
    calls += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/search");
    assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      assert.equal(JSON.parse(Buffer.concat(chunks).toString()).query, "synthetic query");
      response.end(JSON.stringify(payload()));
    });
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const adapter = fake(async (input, init) => {
    assert.equal(input, "https://api.tavily.com/search");
    return fetch(`http://127.0.0.1:${address.port}/search`, init);
  });
  assert.equal((await run(adapter)).sources.length, 1);
  assert.equal(calls, 1);
});
