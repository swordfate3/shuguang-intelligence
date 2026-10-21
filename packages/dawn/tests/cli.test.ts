import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/runtime/cli.ts";

const signal = () => new AbortController().signal;

test("help and adapter check never initialize state", async () => {
  assert.match(String(await runCli([], signal())), /有界自主学习/);
  assert.equal(await runCli(["--version"], signal()), "0.1.0");
  const check = await runCli(["--check"], signal());
  assert.deepEqual(check, {
    version: "0.1.0", stage: "bounded-companion", domainSchemaVersion: 2,
    storageFormats: { subject: 2, learning: 3, legacy: 1 }, sqliteAdapterAvailable: true,
    databaseOpened: false, modelConnected: false, transportAvailable: true, serverStarted: false,
    autonomy: false, autonomousLearningAvailable: true,
  });
});

test("invalid commands fail before opening any file", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "state.sqlite");
  for (const args of [
    ["chat-init", "--db", db, "--chat-db", join(dir, "chat.sqlite")],
    ["chat-init", "--db", db, "--chat-db", join(dir, "chat.sqlite"), "--limit", "10001"],
    ["chat-init", "--db", db, "--chat-db", db, "--limit", "1"],
    ["chat-budget", "--db", db, "--chat-db", "relative.sqlite"],
    ["unknown"], ["status"], ["status", "--db", "relative.sqlite"],
    ["init", "--db", db], ["init", "--db", db, "--id", "one"],
    ["wake", "--db", db], ["wake", "--db", db, "--revision", "-1"],
    ["sleep", "--db", db, "--revision", "9007199254740992"],
    ["status", "--db", db, "--db", db], ["status", "--db", db, "--unknown", "value"],
    ["init", "--db", db, "--id", "one", "--name"], ["--help", "extra"],
  ]) await assert.rejects(runCli(args, signal()));
  await assert.rejects(runCli(["init", "--db", db, "--id", "one", "--name", "曙光"], AbortSignal.abort()));
  assert.deepEqual(readdirSync(dir), []);
});
