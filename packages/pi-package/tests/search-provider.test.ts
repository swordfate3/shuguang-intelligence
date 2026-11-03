import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import {
  createTavilySearchProvider,
  isPublicAddress,
  TAVILY_SEARCH_PROVIDER_ID,
  validatePublicHttpsUrl,
  type SearchRequestFunction,
} from "../src/search-provider.ts";

const API_KEY = "synthetic-tavily-key-not-a-real-secret";
const QUERY = "public example topic";
const NOW = new Date("2026-10-19T12:34:56.789Z");
const VALID_BODY = {
  query: QUERY,
  answer: null,
  images: [],
  response_time: 0.1,
  results: [{ title: "Example", url: "https://www.wikipedia.org/article", content: "Provider-supplied search content." }],
};
const FIXED_ERROR = "Search unavailable.";

interface FakeResponseOptions {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly bytes?: Buffer;
  readonly body?: unknown;
}

class FakeRequest extends EventEmitter {
  body = "";
  destroyed = false;
  private readonly dispatch: (body: string) => void;
  constructor(dispatch: (body: string) => void) { super(); this.dispatch = dispatch; }
  end(body: string): this { this.body = body; this.dispatch(body); return this; }
  destroy(): this { this.destroyed = true; return this; }
}

function fakeProvider(responseOptions: FakeResponseOptions = {}, configure: {
  readonly addresses?: readonly { readonly address: string; readonly family: number }[];
  readonly credentialLookup?: (name: string) => string | undefined;
  readonly onRequest?: (options: RequestOptions, request: FakeRequest, body: string) => void;
  readonly now?: () => Date;
} = {}) {
  const calls = { credentialNames: [] as string[], lookups: [] as string[], requests: [] as RequestOptions[], requestCount: 0 };
  const responseBytes = responseOptions.bytes ?? Buffer.from(JSON.stringify(responseOptions.body ?? VALID_BODY), "utf8");
  const request: SearchRequestFunction = (options, callback) => {
    calls.requests.push(options);
    const fake = new FakeRequest(body => {
      calls.requestCount += 1;
      configure.onRequest?.(options, fake, body);
      queueMicrotask(() => {
        const responseStream = new PassThrough();
        const response = responseStream as unknown as IncomingMessage;
        Object.defineProperties(response, {
          statusCode: { value: responseOptions.status ?? 200 },
          headers: { value: responseOptions.headers ?? { "content-type": "application/json", "content-length": String(responseBytes.byteLength), "content-encoding": "identity" } },
        });
        callback(response);
        if (!fake.destroyed) responseStream.end(responseBytes);
      });
    });
    return fake as never;
  };
  const provider = createTavilySearchProvider({
    credentialEnv: "SHUGUANG_TEST_TAVILY_KEY",
    credentialLookup(name) {
      calls.credentialNames.push(name);
      return configure.credentialLookup ? configure.credentialLookup(name) : API_KEY;
    },
    lookup: async hostname => {
      calls.lookups.push(hostname);
      return configure.addresses ?? [{ address: "93.184.216.34", family: 4 }];
    },
    request,
    now: configure.now ?? (() => new Date(NOW)),
  });
  return { provider, calls };
}

function search(provider: ReturnType<typeof fakeProvider>["provider"], query = QUERY, maxResults = 1) {
  return provider.search({ query, maxResults });
}

test("shape-valid reflected bearer is rejected before material leaves the trusted adapter", async () => {
  const { provider, calls } = fakeProvider({ body: { ...VALID_BODY, results: [{ ...VALID_BODY.results[0]!, content: API_KEY }] } });
  await assert.rejects(search(provider), { message: FIXED_ERROR });
  assert.equal(calls.requestCount, 1);
});

test("JSON-escaped credentials reflected in decoded fields cannot bypass secret scanning", async () => {
  for (const key of ['synthetic"quoted-key', 'synthetic\\backslash-key']) {
    const { provider, calls } = fakeProvider({ body: { ...VALID_BODY, results: [{ ...VALID_BODY.results[0]!, content: key }] } }, { credentialLookup: () => key });
    await assert.rejects(search(provider), { message: FIXED_ERROR }); assert.equal(calls.requestCount, 1);
  }
});

test("fixed Tavily POST pins verified DNS, uses strict options, and labels provider content honestly", async () => {
  const { provider, calls } = fakeProvider({
    body: { ...VALID_BODY, request_id: "synthetic-request-id" },
  });
  const material = await search(provider);
  assert.equal(material.providerId, TAVILY_SEARCH_PROVIDER_ID);
  assert.equal(material.retrievedAt, NOW.toISOString());
  assert.deepEqual(material.results, [{
    url: "https://www.wikipedia.org/article",
    title: "Example",
    text: "Provider-supplied search content.",
    origin: "host_summary",
  }]);
  assert.equal(calls.requestCount, 1);
  assert.deepEqual(calls.lookups, ["api.tavily.com"]);
  assert.deepEqual(calls.credentialNames, ["SHUGUANG_TEST_TAVILY_KEY"]);

  const options = calls.requests[0]!;
  assert.equal(options.hostname, "api.tavily.com");
  assert.equal(options.servername, "api.tavily.com");
  assert.equal(options.port, 443);
  assert.equal(options.path, "/search");
  assert.equal(options.method, "POST");
  assert.equal(options.agent, false);
  assert.equal(options.rejectUnauthorized, undefined);
  const headers = options.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(headers["accept-encoding"], "identity");
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.host, undefined);

});

test("request body contains only fixed Tavily options and exact approved input", async () => {
  let requestBody = "";
  const { provider, calls } = fakeProvider({}, { onRequest: (_options, _request, body) => { requestBody = body; } });
  await search(provider, QUERY, 3);
  assert.deepEqual(JSON.parse(requestBody), {
    query: QUERY,
    search_depth: "basic",
    max_results: 3,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    auto_parameters: false,
  });
  assert.equal(calls.requestCount, 1);
});

test("status is supported but unavailable without the explicitly named credential", async () => {
  const { provider, calls } = fakeProvider({}, { credentialLookup: () => undefined });
  assert.deepEqual(provider.status(), { supported: true, available: false });
  assert.deepEqual(provider.status(), { supported: true, available: false });
  await assert.rejects(search(provider), error => error instanceof Error && error.message === FIXED_ERROR);
  assert.equal(calls.requestCount, 0);
  assert.deepEqual(calls.credentialNames, ["SHUGUANG_TEST_TAVILY_KEY", "SHUGUANG_TEST_TAVILY_KEY", "SHUGUANG_TEST_TAVILY_KEY"]);
});

test("input accepts only exact query, result limit and optional AbortSignal", async t => {
  const { provider, calls } = fakeProvider();
  for (const [name, input] of [
    ["too long", { query: "x".repeat(1001), maxResults: 1 }],
    ["empty", { query: "  ", maxResults: 1 }],
    ["control", { query: "public\nquery", maxResults: 1 }],
    ["format control", { query: "public\u200bquery", maxResults: 1 }],
    ["missing query", { maxResults: 1 }],
    ["extra provider", { query: QUERY, maxResults: 1, endpoint: "https://attacker.invalid" }],
    ["too many", { query: QUERY, maxResults: 4 }],
    ["fractional", { query: QUERY, maxResults: 1.5 }],
    ["boolean", { query: QUERY, maxResults: true }],
    ["wrong signal", { query: QUERY, maxResults: 1, signal: {} }],
  ] as const) await t.test(name, async () => {
    await assert.rejects(provider.search(input as never), error => error instanceof Error && error.message === "Invalid search request.");
  });
  assert.equal(calls.lookups.length, 0);
  assert.equal(calls.requestCount, 0);
});

test("abort before dispatch fails without lookup or external request", async () => {
  const controller = new AbortController();
  controller.abort();
  const { provider, calls } = fakeProvider();
  await assert.rejects(provider.search({ query: QUERY, maxResults: 1, signal: controller.signal }), error => error instanceof Error && error.message === FIXED_ERROR);
  assert.equal(calls.lookups.length, 0);
  assert.equal(calls.requestCount, 0);
});

test("all DNS answers must be public and the request lookup pins a validated address", async () => {
  const { provider, calls } = fakeProvider({}, { addresses: [
    { address: "8.8.8.8", family: 4 },
    { address: "10.0.0.3", family: 4 },
  ] });
  await assert.rejects(search(provider), error => error instanceof Error && error.message === FIXED_ERROR);
  assert.equal(calls.requestCount, 0);

  const publicResult = fakeProvider({}, { addresses: [{ address: "8.8.8.8", family: 4 }] });
  await search(publicResult.provider);
  const lookup = publicResult.calls.requests[0]!.lookup as (...args: unknown[]) => void;
  const callsBack: unknown[][] = [];
  lookup("api.tavily.com", {}, (...args: unknown[]) => callsBack.push(args));
  lookup("attacker.example", {}, (...args: unknown[]) => callsBack.push(args));
  assert.deepEqual(callsBack[0], [null, "8.8.8.8", 4]);
  assert.ok(callsBack[1]?.[0] instanceof Error);
});

test("public-address policy rejects private, mapped, reserved and non-global results", () => {
  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1",
    "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1",
    "::", "::1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "2001:20::1", "2002:0808:0808::1",
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
  assert.equal(isPublicAddress("8.8.8.8", 6), false);
});

test("URL validator accepts only public HTTPS without credentials/query/fragment/custom port", () => {
  assert.equal(validatePublicHttpsUrl("https://www.wikipedia.org/path"), "https://www.wikipedia.org/path");
  assert.equal(validatePublicHttpsUrl("https://www.wikipedia.org:443/path"), "https://www.wikipedia.org/path");
  for (const url of [
    "http://www.wikipedia.org/", "https://user@www.wikipedia.org/", "https://user:pass@www.wikipedia.org/",
    "https://www.wikipedia.org:444/", "https://www.wikipedia.org/?token=x", "https://www.wikipedia.org/#fragment",
    "https://127.0.0.1/", "https://[::1]/", "https://localhost/", "https://service.internal/",
    "https://example.test/", "https://169.254.169.254/latest/meta-data/", "https://www.wikipedia.org/\n",
  ]) assert.throws(() => validatePublicHttpsUrl(url), { message: "Invalid search request." }, url);
});

test("malformed provider results fail fixed-error closed, never truncate or fetch returned URLs", async t => {
  const badBodies: Array<[string, unknown]> = [
    ["too many results", { ...VALID_BODY, results: [VALID_BODY.results[0], VALID_BODY.results[0]] }],
    ["unexpected response field", { ...VALID_BODY, unexpected: true }],
    ["query mismatch", { ...VALID_BODY, query: "different" }],
    ["answer unexpectedly supplied", { ...VALID_BODY, answer: "generated answer" }],
    ["raw content unexpectedly supplied", { ...VALID_BODY, results: [{ ...VALID_BODY.results[0], raw_content: "verbatim-looking page" }] }],
    ["result extra field", { ...VALID_BODY, results: [{ ...VALID_BODY.results[0], image: "unexpected" }] }],
    ["private URL", { ...VALID_BODY, results: [{ ...VALID_BODY.results[0], url: "https://127.0.0.1/" }] }],
    ["query URL", { ...VALID_BODY, results: [{ ...VALID_BODY.results[0], url: "https://www.wikipedia.org/?token=private" }] }],
    ["oversize title", { ...VALID_BODY, results: [{ ...VALID_BODY.results[0], title: "t".repeat(257) }] }],
    ["oversize text", { ...VALID_BODY, results: [{ ...VALID_BODY.results[0], content: "x".repeat(4001) }] }],
    ["empty results", { ...VALID_BODY, results: [] }],
    ["empty text", { ...VALID_BODY, results: [{ ...VALID_BODY.results[0], content: "" }] }],
    ["bad score", { ...VALID_BODY, results: [{ ...VALID_BODY.results[0], score: 1.1 }] }],
  ];
  for (const [name, body] of badBodies) await t.test(name, async () => {
    const { provider, calls } = fakeProvider({ body });
    await assert.rejects(search(provider), error => error instanceof Error && error.message === FIXED_ERROR);
    assert.equal(calls.requestCount, 1);
  });
});

test("rejects non-200, redirects, compression, invalid UTF-8, oversized bodies and abort", async t => {
  const cases: Array<[string, FakeResponseOptions]> = [
    ["provider error", { status: 503 }],
    ["redirect", { status: 302, headers: { location: "https://www.wikipedia.org/" } }],
    ["compressed", { headers: { "content-encoding": "gzip" } }],
    ["invalid utf8", { bytes: Buffer.from([0xff, 0xfe]) }],
    ["response too large", { bytes: Buffer.alloc(128 * 1024 + 1, 0x61) }],
  ];
  for (const [name, options] of cases) await t.test(name, async () => {
    const { provider } = fakeProvider(options);
    await assert.rejects(search(provider), error => error instanceof Error && error.message === FIXED_ERROR);
  });
  await t.test("abort while awaiting DNS", async () => {
    const controller = new AbortController();
    const provider = createTavilySearchProvider({
      credentialEnv: "SYNTHETIC_ONLY",
      credentialLookup: () => API_KEY,
      lookup: () => new Promise(() => {}),
      request: (() => { throw new Error("must not request"); }) as SearchRequestFunction,
    });
    const pending = provider.search({ query: QUERY, maxResults: 1, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, error => error instanceof Error && error.message === FIXED_ERROR);
  });
});

test("credentials are explicit, lazily read and never copied into returned results or errors", async () => {
  let reads = 0;
  const provider = createTavilySearchProvider({
    credentialEnv: "ONLY_THIS_SYNTHETIC_NAME",
    credentialLookup(name) { reads += 1; assert.equal(name, "ONLY_THIS_SYNTHETIC_NAME"); return API_KEY; },
    lookup: async () => [{ address: "8.8.4.4", family: 4 }],
    request(options, callback) {
      assert.equal((options.headers as Record<string, string>).authorization, `Bearer ${API_KEY}`);
      const responseStream = new PassThrough();
      const response = responseStream as unknown as IncomingMessage;
      Object.defineProperties(response, {
        statusCode: { value: 401 },
        headers: { value: {} },
      });
      queueMicrotask(() => callback(response));
      return new FakeRequest(() => {}) as never;
    },
    now: () => new Date(NOW),
  });
  assert.deepEqual(provider.status(), { supported: true, available: true });
  assert.equal(reads, 1);
  await assert.rejects(search(provider), error => error instanceof Error && error.message === FIXED_ERROR && !error.message.includes(API_KEY));
  assert.equal(reads, 2);
});
