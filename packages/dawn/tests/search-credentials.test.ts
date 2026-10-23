import assert from "node:assert/strict";
import fs, { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { storeSearchCredential, verifySearchCredential } from "../../../docker/search-credentials.ts";
import { storeSearchFile } from "../../../docker/search-files.ts";

const signal = () => new AbortController().signal;
const config = { provider: "tavily", credentialEnv: "DAWN_SEARCH_TAVILY_API_KEY", timeoutMs: 1000 };
const grant = { version: 1, id: "synthetic-task", objective: "Synthetic offline research", provider: "tavily",
  disclosure: "approved-queries-only", limit: 1, expiresAt: "2099-01-01T00:00:00.000Z",
  queries: [{ id: "one", query: "approved synthetic query", topics: ["science"] }] };

/** Real file I/O; Windows simulates POSIX stat policy only for these synthetic fixture files.
 * manage.ts uses POSIX ancestor traversal, so only this fixture's corresponding ancestor names
 * are mapped to their Windows paths. This is not evidence of Windows ACL or Linux permissions.
 */
function fixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "dawn-search-credential-"));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (process.platform === "win32") {
    const originalLstat = fs.lstatSync, originalFstat = fs.fstatSync;
    const originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: () => 42 });
    const ancestors = new Map<string, string>();
    let ancestor = dir;
    for (;;) {
      ancestors.set("\\" + ancestor.replace(/\\$/, ""), ancestor);
      const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
    }
    const patch = (stat: fs.Stats): fs.Stats => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat,
      { uid: 42, mode: (stat.mode & ~0o777) | (stat.isDirectory() ? 0o700 : 0o600) });
    t.mock.method(fs, "lstatSync", ((path: fs.PathLike) => {
      const mapped = ancestors.get(String(path));
      const stat = originalLstat(mapped ?? path);
      return mapped || String(path) === dir || String(path).startsWith(dir + "\\") ? patch(stat) : stat;
    }) as typeof fs.lstatSync);
    t.mock.method(fs, "fstatSync", ((fd: number) => {
      const stat = originalFstat(fd);
      const belongs = fs.readdirSync(dir).some(name => {
        const candidate = originalLstat(join(dir, name));
        return candidate.ino === stat.ino && candidate.dev === stat.dev;
      });
      return belongs ? patch(stat) : stat;
    }) as typeof fs.fstatSync);
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      if (originalGetuid) Object.defineProperty(process, "getuid", originalGetuid);
      else Reflect.deleteProperty(process, "getuid");
      syncBuiltinESMExports();
    });
  }
  return dir;
}

test("independent search credential exclusive write, exact env binding, existing bytes preserved", t => {
  const dir = fixture(t), path = join(dir, "search.env");
  storeSearchCredential(dir, "tvly-synthetic_test-only", signal());
  const before = readFileSync(path);
  assert.equal(before.toString("ascii"), "DAWN_SEARCH_TAVILY_API_KEY='tvly-synthetic_test-only'\n");
  verifySearchCredential(dir);
  assert.throws(() => storeSearchCredential(dir, "tvly-other_synthetic", signal()), /EEXIST/);
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(fs.readdirSync(dir), ["search.env"]);
});

test("credential validation rejects invalid keys and aborted writes before file creation", t => {
  const dir = fixture(t), path = join(dir, "search.env");
  for (const key of ["", "not-tavily", "tvly-", "tvly-a'b", "tvly-key\nNODE_OPTIONS=evil", "tvly-" + "x".repeat(501)]) {
    assert.throws(() => storeSearchCredential(dir, key, signal()));
    assert.equal(fs.existsSync(path), false);
  }
  assert.throws(() => storeSearchCredential(dir, "tvly-synthetic", AbortSignal.abort()));
  assert.equal(fs.existsSync(path), false);
});

test("verify credential rejects NODE_OPTIONS extra variables, invalid lines, malformed UTF8 and oversized input", t => {
  const dir = fixture(t), path = join(dir, "search.env");
  const valid = "DAWN_SEARCH_TAVILY_API_KEY='tvly-synthetic'\n";
  for (const raw of [
    valid + "NODE_OPTIONS='--import=evil'\n", "NODE_OPTIONS='evil'\n" + valid,
    valid + "OTHER='synthetic'\n", valid + valid, valid + "\n", valid.trimEnd(),
    "DAWN_SEARCH_TAVILY_API_KEY=tvly-synthetic\n", "DAWN_SEARCH_API_KEY='tvly-synthetic'\n",
    "DAWN_SEARCH_TAVILY_API_KEY='tvly-bad;command'\n", "# comment\n" + valid,
    valid.replace("\n", "\r\n"), "x".repeat(1025), Buffer.from([0xff, 0xfe]),
  ]) {
    writeFileSync(path, raw, { mode: 0o600 });
    assert.throws(() => verifySearchCredential(dir));
  }
  writeFileSync(path, valid, { mode: 0o600 });
  verifySearchCredential(dir);
});

test("search config and exact-task grant writes are validated and exclusive", t => {
  const dir = fixture(t);
  storeSearchFile(dir, "config", undefined, JSON.stringify(config), signal());
  const configPath = join(dir, "search.json"), beforeConfig = readFileSync(configPath);
  assert.deepEqual(JSON.parse(beforeConfig.toString("utf8")), config);
  assert.throws(() => storeSearchFile(dir, "config", undefined, JSON.stringify({ ...config, timeoutMs: 10 }), signal()), /EEXIST/);
  assert.deepEqual(readFileSync(configPath), beforeConfig);
  storeSearchFile(dir, "grant", grant.id, JSON.stringify(grant), signal());
  const grantPath = join(dir, "search-synthetic-task.json"), beforeGrant = readFileSync(grantPath);
  assert.deepEqual(JSON.parse(beforeGrant.toString("utf8")), grant);
  assert.throws(() => storeSearchFile(dir, "grant", grant.id, JSON.stringify({ ...grant, objective: "other" }), signal()), /EEXIST/);
  assert.deepEqual(readFileSync(grantPath), beforeGrant);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["search-synthetic-task.json", "search.json"]);
});

test("search file validation rejects mismatched task, expired grant, duplicate keys and unauthorized config fields", t => {
  const dir = fixture(t);
  const invalid: [string, string | undefined, string][] = [
    ["grant", "different-task", JSON.stringify(grant)],
    ["grant", "../escape", JSON.stringify(grant)],
    ["grant", grant.id, JSON.stringify({ ...grant, expiresAt: "2000-01-01T00:00:00.000Z" })],
    ["grant", grant.id, JSON.stringify({ ...grant, limit: 11 })],
    ["grant", grant.id, JSON.stringify({ ...grant, raw: true })],
    ["grant", undefined, JSON.stringify(grant)],
    ["config", "unexpected-task", JSON.stringify(config)],
    ["config", undefined, JSON.stringify({ ...config, apiKey: "not-a-real-key" })],
    ["config", undefined, JSON.stringify({ ...config, credentialEnv: "OPENAI_API_KEY" })],
    ["config", undefined, '{"provider":"other","provider":"tavily","credentialEnv":"DAWN_SEARCH_TAVILY_API_KEY","timeoutMs":1000}'],
    ["config", undefined, "x".repeat(16001)],
    ["other", undefined, JSON.stringify(config)],
  ];
  for (const [kind, taskId, raw] of invalid) {
    assert.throws(() => storeSearchFile(dir, kind, taskId, raw, signal()));
    assert.deepEqual(fs.readdirSync(dir), []);
  }
  assert.throws(() => storeSearchFile(dir, "config", undefined, JSON.stringify(config), AbortSignal.abort()));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("POSIX search credentials refuse public mode, symlinks, hardlinks and public parent", { skip: process.platform === "win32" }, t => {
  const dir = fixture(t), path = join(dir, "search.env");
  storeSearchCredential(dir, "tvly-synthetic", signal());
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  chmodSync(path, 0o644);
  assert.throws(() => verifySearchCredential(dir));
  chmodSync(path, 0o600);
  const target = join(dir, "synthetic-target.env");
  fs.renameSync(path, target);
  fs.symlinkSync(target, path);
  assert.throws(() => verifySearchCredential(dir));
  fs.unlinkSync(path);
  fs.linkSync(target, path);
  assert.throws(() => verifySearchCredential(dir));
  fs.unlinkSync(path);
  fs.renameSync(target, path);
  chmodSync(dir, 0o755);
  assert.throws(() => verifySearchCredential(dir));
  chmodSync(dir, 0o700);
});
