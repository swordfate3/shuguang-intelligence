import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runCli } from "../src/runtime/cli.ts";
import { runServer } from "../src/runtime/serve.ts";
import { createTokenFile } from "../src/adapters/transport/token-file.ts";
import { SqliteSubjectStore } from "../src/adapters/storage/sqlite-subject.ts";
import { HostHttpClient } from "../src/adapters/transport/host-http-client.ts";
import { readTokenFile } from "../src/adapters/transport/token-file.ts";
import { randomUUID } from "node:crypto";

const root = resolve(import.meta.dirname, "../../..");
const signal = () => new AbortController().signal;
const pack = { version: 1, id: "fixture", title: "Synthetic", goals: [{ id: "one", title: "One", topics: ["one"],
  material: "One", practice: [{ id: "p", prompt: "P?", answer: "A" }], assessment: [{ id: "a", prompt: "A?", answer: "B" }] }] };

test("host-learning-init explicitly creates v4; original learning-init stays v3 and cannot opt into host serve", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-host-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const packFile = join(dir, "pack.json");
  writeFileSync(packFile, JSON.stringify(pack));
  const serviceToken = join(dir, "service.token"), ownerToken = join(dir, "owner.token");
  createTokenFile(serviceToken); createTokenFile(ownerToken);
  const paths: Record<string, string> = {};
  for (const command of ["learning-init", "host-learning-init"]) {
    const db = join(dir, command + ".sqlite"); paths[command] = db;
    const args = [command, "--db", db, "--id", "synthetic", "--name", "Synthetic", "--limit", "8", "--learning-limit", "4", "--pack", packFile];
    await runCli(args, signal());
    await assert.rejects(runCli(args, signal()), "never overwrites existing subject");
    const store = SqliteSubjectStore.open(db, signal());
    try { assert.equal(store.supportsHostImport, command === "host-learning-init"); assert.equal((await store.budget(signal())).reserved, 0); }
    finally { store.close(); }
  }
  const base = ["--subject-db", paths["learning-init"]!, "--token-file", serviceToken, "--port", "0"];
  await assert.rejects(runServer([...base, "--host-token-file", ownerToken], signal(), () => assert.fail("v3 must not listen")), /explicitly created v4/);
  await assert.rejects(runServer([...base, "--host-token-file", serviceToken], signal(), () => assert.fail("same file denied")), /Separate host owner token/);
  const copiedToken = join(dir, "duplicate.token"); writeFileSync(copiedToken, readFileSync(serviceToken), { mode: 0o600 });
  await assert.rejects(runServer([...base, "--host-token-file", copiedToken], signal(), () => assert.fail("same credential denied")), /credentials must differ/);
  const controller = new AbortController();
  let ready!: (endpoint: string) => void;
  const endpoint = new Promise<string>(resolve => { ready = resolve; });
  const serving = runServer(["--subject-db", paths["host-learning-init"]!, "--token-file", serviceToken, "--port", "0", "--host-token-file", ownerToken], controller.signal, status => ready(status.endpoint));
  let client: HostHttpClient | undefined;
  try {
    client = new HostHttpClient(await endpoint, readTokenFile(ownerToken));
    assert.equal((await client.request({ version: 1, requestId: randomUUID(), type: "pair" }, signal())).type, "paired");
    const status = await client.request({ version: 1, requestId: randomUUID(), type: "status" }, signal());
    assert.equal(status.type, "status");
    if (status.type === "status") { assert.equal(status.supported, true); assert.equal(status.lifecycle, "sleeping"); assert.equal(status.revision, 0); }
  } finally { client?.close(); controller.abort(); await serving; }
});

test("host bridge entrypoint uses fixed args without model env or service lifecycle commands", t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-host-entry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const data = join(dir, "data"), bin = join(dir, "bin"); mkdirSync(data); mkdirSync(bin);
  const record = join(dir, "record.json");
  writeFileSync(join(data, "model.env"), "DAWN_MODEL_API_KEY=synthetic-never-loaded\n");
  writeFileSync(join(bin, "node"), `#!/bin/sh\nexec '${process.execPath}' -e 'require("node:fs").writeFileSync(process.env.TEST_RECORD,JSON.stringify({args:process.argv.slice(1),hasKey:!!process.env.DAWN_MODEL_API_KEY}));' -- "$@"\n`, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, DAWN_DATA_DIR: data, PATH: `${bin}:${process.env.PATH}`, TEST_RECORD: record };
  delete env.DAWN_MODEL_API_KEY;
  const entry = join(root, "docker/entrypoint.sh");
  const result = spawnSync("sh", [entry, "host-bridge"], { env, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), { args: [join(root, "packages/dawn/src/host-bridge-main.ts"), "--endpoint", "http://127.0.0.1:7341", "--owner-token-file", join(data, "host-owner.token")], hasKey: false });
  assert.notEqual(spawnSync("sh", [entry, "host-bridge", "extra"], { env }).status, 0);
  assert.deepEqual(readdirSync(data), ["model.env"], "does not create tokens/database or initialize service");
});
