import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import {
  assertPrivateDir, readCredentialFromTTY, resolveDataDirectory, storeCredential, verifyFiles,
} from "../../../docker/manage.ts";

const projectRoot = resolve(import.meta.dirname!, "../../..");
const managePath = join(projectRoot, "docker/manage.ts");
const config = {
  baseUrl: "https://example.invalid/v1", model: "synthetic-container-model", credentialEnv: "DAWN_CONTAINER_TEST_API_KEY",
  maxCalls: 2, reasoningEffort: "low",
};

function privateDir(parent: string, name: string): string {
  const path = join(parent, name);
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function modelConfig(dataPath: string): void {
  writeFileSync(join(dataPath, "model.json"), JSON.stringify(config), { mode: 0o600 });
  chmodSync(join(dataPath, "model.json"), 0o600);
}

function completeFixture(dataPath: string, credential = "Synthetic#key=value!~"): void {
  writeFileSync(join(dataPath, "subject.sqlite"), "synthetic placeholder", { mode: 0o600 });
  writeFileSync(join(dataPath, "service.token"), "synthetic token", { mode: 0o600 });
  modelConfig(dataPath);
  writeFileSync(join(dataPath, "model.env"), `${config.credentialEnv}='${credential}'\n`, { mode: 0o600 });
  for (const name of ["subject.sqlite", "service.token", "model.json", "model.env"]) chmodSync(join(dataPath, name), 0o600);
}

test("data directory verifier requires existing absolute current-user 0700 non-symlink directory", t => {
  const parent = mkdtempSync(join(tmpdir(), "dawn-container-directory-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const data = privateDir(parent, "data");
  assert.equal(assertPrivateDir(data), data);
  assert.throws(() => assertPrivateDir("relative-data"));
  assert.throws(() => assertPrivateDir(join(parent, "missing")));
  chmodSync(data, 0o755);
  assert.throws(() => assertPrivateDir(data));
  chmodSync(data, 0o700);
  const link = join(parent, "data-link");
  symlinkSync(data, link);
  assert.throws(() => assertPrivateDir(link));
  assert.equal(resolveDataDirectory({ DAWN_DATA_DIR: data }), data);
  assert.throws(() => resolveDataDirectory({ DAWN_DATA_DIR: "relative" }));
});

test("verify-files is a read-only private-file and model-config preflight", t => {
  const parent = mkdtempSync(join(tmpdir(), "dawn-container-files-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const data = privateDir(parent, "data");
  completeFixture(data);
  const before = ["subject.sqlite", "service.token", "model.json", "model.env"].map(name => lstatSync(join(data, name)).mtimeMs);
  assert.doesNotThrow(() => verifyFiles(data));
  assert.deepEqual(["subject.sqlite", "service.token", "model.json", "model.env"].map(name => lstatSync(join(data, name)).mtimeMs), before);
  assert.equal(readFileSync(join(data, "subject.sqlite"), "utf8"), "synthetic placeholder");

  const badConfigDir = privateDir(parent, "bad-config");
  completeFixture(badConfigDir);
  writeFileSync(join(badConfigDir, "model.json"), "not-json", { mode: 0o600 });
  chmodSync(join(badConfigDir, "model.json"), 0o600);
  assert.throws(() => verifyFiles(badConfigDir));

  const badModeDir = privateDir(parent, "bad-mode");
  completeFixture(badModeDir);
  chmodSync(join(badModeDir, "service.token"), 0o644);
  assert.throws(() => verifyFiles(badModeDir));

  const symlinkDir = privateDir(parent, "symlink");
  completeFixture(symlinkDir);
  rmSync(join(symlinkDir, "model.env"));
  symlinkSync(join(data, "model.env"), join(symlinkDir, "model.env"));
  assert.throws(() => verifyFiles(symlinkDir));

  const injected = privateDir(parent, "injected-env");
  completeFixture(injected);
  for (const content of [
    `${config.credentialEnv}='safe'\nNODE_OPTIONS='--require=synthetic-secret'\n`,
    `NODE_OPTIONS='--require=synthetic-secret'\n`,
    `${config.credentialEnv}='unterminated`,
  ]) {
    writeFileSync(join(injected, "model.env"), content, { mode: 0o600 });
    assert.throws(() => verifyFiles(injected));
  }
});

test("credential store reads only model config, writes exclusive 0600 dotenv and roundtrips through Node env-file", t => {
  const parent = mkdtempSync(join(tmpdir(), "dawn-container-credentials-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const data = privateDir(parent, "data");
  modelConfig(data);
  const key = "Synthetic#key=value!~()[]{}:;,@$%^&*+-./?<>|`";
  storeCredential(data, key, new AbortController().signal);
  assert.equal(lstatSync(join(data, "model.env")).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(data, "model.env"), "ascii"), `${config.credentialEnv}='${key}'\n`);
  const child = spawnSync(process.execPath, ["--env-file", join(data, "model.env"), "-e",
    `process.stdout.write(process.env.${config.credentialEnv} === ${JSON.stringify(key)} ? "roundtrip" : "mismatch")`],
  { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "roundtrip");

  assert.throws(() => storeCredential(data, "replacement", new AbortController().signal));
  assert.equal(readFileSync(join(data, "model.env"), "ascii"), `${config.credentialEnv}='${key}'\n`);
  const rejectedKeys = ["", "has space", "line\nfeed", "single'quote", 'double"quote', "back\\slash", "x".repeat(4097)];
  rejectedKeys.forEach((rejected, index) => {
    const invalidDir = privateDir(parent, `invalid-${index}`);
    modelConfig(invalidDir);
    assert.throws(() => storeCredential(invalidDir, rejected, new AbortController().signal));
    assert.throws(() => lstatSync(join(invalidDir, "model.env")));
  });
  const cancelledDir = privateDir(parent, "cancelled");
  modelConfig(cancelledDir);
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => storeCredential(cancelledDir, "synthetic", controller.signal));
  assert.throws(() => lstatSync(join(cancelledDir, "model.env")));
});

test("container credentials and startup preflight reject runtime-control environment names before storing or loading secrets", t => {
  const parent = mkdtempSync(join(tmpdir(), "dawn-container-reserved-env-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  for (const credentialEnv of ["NODE_OPTIONS", "PATH", "HOME", "LD_PRELOAD", "DAWN_DATA_DIR", "OPENAI_API_KEY_COMMAND"]) {
    const data = privateDir(parent, credentialEnv.toLowerCase());
    completeFixture(data);
    writeFileSync(join(data, "model.json"), JSON.stringify({ ...config, credentialEnv }), { mode: 0o600 });
    rmSync(join(data, "model.env"));
    assert.throws(() => storeCredential(data, "--require=synthetic-secret-must-not-leak", new AbortController().signal));
    assert.throws(() => lstatSync(join(data, "model.env")));
    writeFileSync(join(data, "model.env"), `${credentialEnv}='--require=synthetic-secret-must-not-leak'\n`, { mode: 0o600 });
    assert.throws(() => verifyFiles(data));
    const child = spawnSync(process.execPath, [managePath, "verify-files"], {
      env: { ...process.env, DAWN_DATA_DIR: data }, encoding: "utf8", timeout: 5_000,
    });
    assert.notEqual(child.status, 0);
    assert.doesNotMatch(child.stdout + child.stderr, /synthetic-secret-must-not-leak|--require/);
  }
});

test("credentials command refuses piped stdin without consuming or storing it", t => {
  const parent = mkdtempSync(join(tmpdir(), "dawn-container-pipe-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const data = privateDir(parent, "data");
  modelConfig(data);
  const child = spawnSync(process.execPath, [managePath, "credentials"], {
    cwd: projectRoot, env: { ...process.env, DAWN_DATA_DIR: data }, input: "SyntheticPipeSecret", encoding: "utf8", timeout: 5000,
  });
  assert.notEqual(child.status, 0);
  assert.equal(child.stdout, "");
  assert.doesNotMatch(child.stderr, /SyntheticPipeSecret|DAWN_CONTAINER_TEST_API_KEY/);
  assert.throws(() => lstatSync(join(data, "model.env")));
});

test("TTY credential reader hides input, supports backspace, cancels, and restores mode/listeners", async () => {
  const input = new PassThrough() as PassThrough & NodeJS.ReadStream;
  const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
  let raw = false;
  const rawChanges: boolean[] = [];
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value: boolean) { raw = value; rawChanges.push(value); return input; } });
  Object.assign(output, { isTTY: true });
  let shown = "";
  output.on("data", (chunk: Buffer) => { shown += chunk.toString("utf8"); });
  const listenerCount = input.listenerCount("keypress");
  const entering = readCredentialFromTTY(input, output);
  input.emit("keypress", "S", { name: "s" });
  input.emit("keypress", "e", { name: "e" });
  input.emit("keypress", "c", { name: "c" });
  input.emit("keypress", "x", { name: "x" });
  input.emit("keypress", "", { name: "backspace" });
  input.emit("keypress", "ret", { name: "return" });
  assert.equal(await entering, "Sec");
  assert.equal(shown, "API key（输入隐藏，Enter 提交，Ctrl+C 取消）： \n");
  assert.deepEqual(rawChanges, [true, false]);
  assert.equal(raw, false);
  assert.equal(input.readableFlowing, false);
  assert.equal(input.listenerCount("keypress"), listenerCount);

  const controller = new AbortController();
  const cancelled = readCredentialFromTTY(input, output, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, /取消/);
  assert.equal(raw, false);
  assert.equal(input.listenerCount("keypress"), listenerCount);

  for (const key of [{ name: "c", ctrl: true }, { name: "d", ctrl: true }]) {
    const interrupted = readCredentialFromTTY(input, output);
    input.emit("keypress", "", key);
    await assert.rejects(interrupted, /取消/);
    assert.equal(raw, false);
    assert.equal(input.listenerCount("keypress"), listenerCount);
  }
});

test("TTY reader refuses non-tty streams without reading pipe bytes", async () => {
  const input = new PassThrough() as PassThrough & NodeJS.ReadStream;
  const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
  input.write("synthetic-pipe-data");
  assert.throws(() => readCredentialFromTTY(input, output), /TTY/);
  assert.equal(input.read()?.toString(), "synthetic-pipe-data");
});
