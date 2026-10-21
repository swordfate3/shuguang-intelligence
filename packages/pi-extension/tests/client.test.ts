import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DawnClient, TransportUnavailableError, parseCommand } from "../src/client.ts";
import type { DawnTransport } from "../../dawn/src/protocol/index.ts";

const signal = () => new AbortController().signal;

test("commands are explicit; wake/sleep require safe state revisions", () => {
  assert.equal(parseCommand("status").type, "status");
  assert.equal(parseCommand("wake 0").type, "wake");
  assert.equal(parseCommand("sleep 12").type, "sleep");
  assert.equal(parseCommand("say 你好").type, "say");
  for (const input of ["", "wake", "sleep -1", "wake 1.5", "wake 9007199254740992", "say", "say   ", `say ${"a".repeat(16_001)}`]) {
    assert.throws(() => parseCommand(input));
  }
});

test("default client cannot pretend service is available", async () => {
  const client = new DawnClient();
  for (const command of ["status", "wake 0", "sleep 0", "say 你好"]) {
    await assert.rejects(client.command(command, signal()), TransportUnavailableError);
  }
});

test("client forwards typed request without Pi model, preserves error results", async () => {
  const transport: DawnTransport = {
    async request(request, receivedSignal) {
      assert.equal(request.type, "say");
      assert.equal(receivedSignal.aborted, false);
      return { version: 1, requestId: request.requestId, type: "error", code: "NOT_IMPLEMENTED", message: "not implemented" };
    },
  };
  const response = await new DawnClient(transport).command("say 你好", signal());
  assert.equal(response.type, "error");
});

test("mismatched correlation IDs fail", async () => {
  const transport: DawnTransport = {
    async request() { return { version: 1, requestId: "wrong", type: "reply", text: "bad" }; },
  };
  await assert.rejects(new DawnClient(transport).command("say hi", signal()), /不匹配/);
});

test("cancellation prevents dispatch and ignores late success", async () => {
  let dispatched = false;
  const controller = new AbortController();
  const transport: DawnTransport = {
    async request(request) {
      dispatched = true;
      controller.abort();
      return { version: 1, requestId: request.requestId, type: "reply", text: "late" };
    },
  };
  const client = new DawnClient(transport);
  await assert.rejects(client.command("say hi", AbortSignal.abort()));
  assert.equal(dispatched, false);
  await assert.rejects(client.command("say hi", controller.signal));
  assert.equal(dispatched, true);
});

test("package manifest points at real entrypoint and Pi stays a peer", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  const entry = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(entry, /export default function/);
  assert.doesNotMatch(entry, /streamSimple|sendUserMessage|createAgentSession/);
});
