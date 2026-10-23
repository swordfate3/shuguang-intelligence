import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { storeSearchFile } from "../../../docker/search-files.ts";
import { storeSearchCredential } from "../../../docker/search-credentials.ts";
const root = new URL("../../../", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root), "utf8");
test("container has explicit generic search entrypoints and allowlists new helper files, no automatic search or host credentials", () => {
  const entry = read("docker/entrypoint.sh"), ignore = read(".dockerignore"), compose = read("compose.yaml");
  const dawn = JSON.parse(read("packages/dawn/package.json")) as { exports: Record<string, string> };
  assert.equal(dawn.exports["./search"], "./src/adapters/search/port.ts");
  for (const name of ["search-config", "search-grant", "search-init", "search-run", "search-results", "search-stop", "search-credentials"]) assert(entry.includes(name));
  assert(ignore.includes("!docker/search-credentials.ts")); assert(ignore.includes("!docker/search-files.ts"));
  assert.match(entry, /search-credentials\.ts" verify\s+exec node --env-file="\$DATA\/search.env"/);
  assert.doesNotMatch(compose, /DAWN_SEARCH|search-run|search.env/);
  const serve = entry.slice(entry.indexOf("  serve)"), entry.indexOf("  request)"));
  assert.doesNotMatch(serve, /search.env|search-run|TAVILY/);
});
test("bounded input helper rejects keys/unknown fields/expired mismatched grant before any write", () => {
  const c = new AbortController().signal, absent = fileURLToPath(new URL("does-not-exist/", root));
  for (const raw of ['{"apiKey":"SECRET"}', '{"provider":"tavily","credentialEnv":"DAWN_MODEL_API_KEY","timeoutMs":1000}', '{"provider":"tavily","credentialEnv":"DAWN_SEARCH_TAVILY_API_KEY","timeoutMs":1,"apiKey":"SECRET"}']) {
    assert.throws(() => storeSearchFile(absent, "config", undefined, raw, c));
  }
  assert.throws(() => storeSearchFile(absent, "grant", "../bad", "{}", c));
  assert.throws(() => storeSearchCredential(absent, "bad\nNODE_OPTIONS=x", c));
});
