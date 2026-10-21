import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInitialState } from "../src/legacy/state.ts";
import { SqliteStateStore } from "../src/adapters/storage/sqlite.ts";
import { createTokenFile, readTokenFile } from "../src/adapters/transport/token-file.ts";
import { HttpDawnTransport } from "../../pi-extension/src/http-transport.ts";
import { DawnClient } from "../../pi-extension/src/client.ts";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));

test("independent foreground service + actual client controls persistent state across restart", { timeout: 60_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "dawn-service-e2e-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "dawn.sqlite");
  const tokenPath = join(dir, "service.token");
  SqliteStateStore.create(db, createInitialState("same-subject", "曙光", "2026-01-01T00:00:00.000Z"), new AbortController().signal).close();
  createTokenFile(tokenPath);
  const token = readTokenFile(tokenPath);

  async function launch() {
    const child = spawn(process.execPath, [entry, "serve", "--db", db, "--token-file", tokenPath, "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 3000);
      try { await exited; } finally { clearTimeout(force); }
    });
    const ready = await new Promise<{ endpoint: string; instanceId: string }>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Service ready timeout")), 5000);
      child.once("exit", () => clearTimeout(timer));
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Service exited before ready")));
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const newline = output.indexOf("\n");
        if (newline >= 0) {
          clearTimeout(timer);
          try { resolve(JSON.parse(output.slice(0, newline))); } catch { reject(new Error("Invalid ready message")); }
        }
      });
    });
    const transport = new HttpDawnTransport(ready.endpoint, token);
    return { ready, client: new DawnClient(transport), async stop() { child.kill("SIGTERM"); await exited; } };
  }

  const first = await launch();
  const signal = () => AbortSignal.timeout(5000);
  let status = await first.client.command("status", signal());
  assert.equal(status.type, "status");
  if (status.type !== "status") throw new Error("Expected status");
  assert.equal(status.lifecycle, "sleeping");
  assert.equal(status.runtime.instanceId, first.ready.instanceId);
  assert.equal(status.runtime.autonomy, false);
  const woken = await first.client.command("wake 0", signal());
  assert.equal(woken.type, "status");
  const stale = await first.client.command("sleep 0", signal());
  assert.equal(stale.type, "error");
  if (stale.type === "error") assert.equal(stale.code, "CONFLICT");
  const chat = await first.client.command("say 你好", signal());
  assert.equal(chat.type, "error");
  if (chat.type === "error") assert.equal(chat.code, "NOT_IMPLEMENTED");
  await assert.rejects(new DawnClient(new HttpDawnTransport(first.ready.endpoint, "x".repeat(43))).command("sleep 1", signal()));
  await first.stop();

  const reopened = SqliteStateStore.open(db, signal());
  assert.equal((await reopened.read(signal())).lifecycle, "awake");
  assert.equal((await reopened.read(signal())).revision, 1);
  reopened.close();

  const second = await launch();
  assert.notEqual(second.ready.instanceId, first.ready.instanceId);
  status = await second.client.command("status", signal());
  assert.equal(status.type, "status");
  if (status.type !== "status") throw new Error("Expected status");
  assert.equal(status.lifecycle, "awake");
  assert.equal(status.revision, 1);
  await second.client.command("sleep 1", signal());
  await second.stop();
  const final = SqliteStateStore.open(db, signal());
  assert.equal((await final.read(signal())).lifecycle, "sleeping");
  assert.equal((await final.events(0, 10, signal())).length, 2);
  final.close();
});
