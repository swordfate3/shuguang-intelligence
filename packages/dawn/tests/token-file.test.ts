import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, chmodSync, symlinkSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTokenFile, readTokenFile } from "../src/adapters/transport/token-file.ts";
import { runCli } from "../src/runtime/cli.ts";

test("explicit private token creation never overwrites or prints the secret", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-token-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "service.token");
  const result = await runCli(["token-init", "--token-file", path], new AbortController().signal);
  assert.deepEqual(result, { tokenCreated: true });
  const token = readTokenFile(path);
  assert.equal(token.length, 43);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => createTokenFile(path));
  assert.equal(readTokenFile(path), token);
  const link = join(dir, "link");
  symlinkSync(path, link);
  assert.throws(() => readTokenFile(link));
  chmodSync(path, 0o644);
  assert.throws(() => readTokenFile(path));
});

test("token file rejects absent, non-private, malformed and oversized input", t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-token-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "service.token");
  assert.throws(() => readTokenFile(path));
  assert.equal(existsSync(path), false);
  assert.throws(() => createTokenFile("relative.token"));
  assert.throws(() => readTokenFile(dir));
  for (const value of ["", "short", "x".repeat(130), "x".repeat(42) + "\n", "x".repeat(43) + "\n\n"]) {
    writeFileSync(path, value, { mode: 0o600 });
    assert.throws(() => readTokenFile(path));
  }
});
