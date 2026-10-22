import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeError, DawnBridge } from "../src/bridge.ts";
import type { BridgeErrorCode } from "../src/bridge.ts";
import { assertDawnRequest } from "../../dawn/src/protocol/index.ts";
import type { DawnRequest, DawnResponse } from "../../dawn/src/protocol/index.ts";

const token = "synthetic_dawn_token_" + "a".repeat(43);
const secret = "PRIVATE_PATH_TOKEN_RAW_EXCEPTION";
const signal = () => AbortSignal.timeout(5_000);
const errorCode = (code: BridgeErrorCode) => (error: unknown): boolean => {
  assert.ok(error instanceof BridgeError);
  assert.equal(error.code, code);
  assert.equal(Object.hasOwn(error, "cause"), false);
  assert.equal(String(error).includes(secret), false);
  assert.equal(JSON.stringify(error).includes(secret), false);
  return true;
};
const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const status = (request: DawnRequest, revision = 0, lifecycle: "awake" | "sleeping" = "sleeping"): DawnResponse => ({
  version: 1, requestId: request.requestId, type: "status", lifecycle, revision,
  runtime: { instanceId: "synthetic-instance", startedAt: "2026-01-01T00:00:00.000Z", autonomy: false },
});
function respond(response: ServerResponse, body: DawnResponse): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
interface Received { readonly request: DawnRequest; readonly response: ServerResponse; readonly http: IncomingMessage }
async function fakeServer(t: TestContext, handler: (received: Received) => void) {
  const received: Received[] = [];
  const http = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/request");
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assertDawnRequest(body);
      const value = { request: body, response, http: request };
      received.push(value);
      handler(value);
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  return { endpoint, received };
}
// This seam is intentional: Windows mode 0666 cannot satisfy the unchanged POSIX
// token-file check. HTTP tests use synthetic in-memory credentials, never weaken it.
function injectedBridge(endpoint: string, readToken: (path: string) => string = () => token): DawnBridge {
  return new DawnBridge({ endpoint, tokenFile: join(tmpdir(), "synthetic-only-no-credential-discovery") }, { readToken });
}

test("construction performs no credential I/O; invalid commands precede config/credential checks", async () => {
  let reads = 0;
  const bridge = new DawnBridge({ endpoint: "not-an-endpoint", tokenFile: secret }, {
    readToken: () => { reads++; throw new Error(secret); },
  });
  assert.equal(reads, 0);
  for (const input of ["", "wake", "wake 01", "sleep -1", "wake 9007199254740992", "say ",
    "say " + "x".repeat(16_001), "model 0", "thinking 0 invalid", "init", "status history"]) {
    await assert.rejects(bridge.command(input, signal()), errorCode("INVALID_COMMAND"));
  }
  assert.equal(reads, 0);
  await bridge.dispose();
});

test("absent, partial and empty explicit config fail without reading any credentials", async () => {
  for (const config of [{}, { endpoint: "http://127.0.0.1:7341" }, { tokenFile: secret },
    { endpoint: "", tokenFile: secret }, { endpoint: "http://127.0.0.1:7341", tokenFile: "" }]) {
    const bridge = new DawnBridge(config, { readToken: () => { assert.fail("must not read credentials"); } });
    await assert.rejects(bridge.command("garbage", signal()), errorCode("INVALID_COMMAND"));
    await assert.rejects(bridge.command("status", signal()), errorCode("UNCONFIGURED"));
    await bridge.dispose();
  }
});

test("only canonical explicit loopback endpoints are accepted, before token reads", async () => {
  for (const endpoint of ["http://localhost:7341", "https://127.0.0.1:7341", "http://127.0.0.1", "http://127.0.0.1:0",
    "http://127.0.0.1:65536", "http://127.0.0.1:07341", "http://127.0.0.1:7341/", "http://127.0.0.1:7341?q=x",
    "http://127.0.0.1:7341#x", `http://${secret}@127.0.0.1:7341`, "http://192.168.1.1:7341"]) {
    const bridge = injectedBridge(endpoint, () => { assert.fail("invalid endpoint must not read token"); });
    await assert.rejects(bridge.command("status", signal()), errorCode("INVALID_ENDPOINT"));
    await bridge.dispose();
  }
});

test("credential failures and invalid synthetic tokens expose fixed redacted errors", async () => {
  for (const readToken of [() => { throw new Error(secret); }, () => secret]) {
    const bridge = injectedBridge("http://127.0.0.1:7341", readToken);
    await assert.rejects(bridge.command("status", signal()), errorCode("CREDENTIALS"));
    await bridge.dispose();
  }
});

test("tokenEnv is explicit and exclusive; invalid config and cancelled calls read no credentials", async () => {
  let reads = 0;
  const dependencies = {
    readToken: () => { reads++; return token; },
    readEnv: () => { reads++; return token; },
  };
  for (const tokenEnv of ["DSH_TOKEN", "SHUGUANG_TOKEN", "SHUGUANG_service_TOKEN", "SHUGUANG_SERVICE_KEY",
    " SHUGUANG_SERVICE_TOKEN", "SHUGUANG_SERVICE_TOKEN ", "SHUGUANG_" + "A".repeat(120) + "_TOKEN"]) {
    const bridge = new DawnBridge({ endpoint: "http://127.0.0.1:7341", tokenEnv }, dependencies);
    await assert.rejects(bridge.command("status", signal()), errorCode("INVALID_CONFIG"));
    await bridge.dispose();
  }
  const conflict = new DawnBridge({ endpoint: "http://127.0.0.1:7341", tokenFile: secret, tokenEnv: "SHUGUANG_SERVICE_TOKEN" }, dependencies);
  await assert.rejects(conflict.command("status", signal()), errorCode("INVALID_CONFIG"));
  await conflict.dispose();
  for (const config of [{ tokenEnv: "SHUGUANG_SERVICE_TOKEN" }, { endpoint: "http://127.0.0.1:7341", tokenEnv: "" }]) {
    const bridge = new DawnBridge(config, dependencies);
    await assert.rejects(bridge.command("status", signal()), errorCode("UNCONFIGURED"));
    await bridge.dispose();
  }
  const bridge = new DawnBridge({ endpoint: "http://127.0.0.1:7341", tokenEnv: "SHUGUANG_SERVICE_TOKEN" }, dependencies);
  assert.equal(reads, 0, "construction must not read environment");
  await assert.rejects(bridge.command("invalid", signal()), errorCode("INVALID_COMMAND"));
  await assert.rejects(bridge.command("status", AbortSignal.abort(new Error(secret))), errorCode("CANCELLED"));
  const rejection = assert.rejects(bridge.command("status", signal()), errorCode("CANCELLED"));
  await bridge.dispose();
  await rejection;
  assert.equal(reads, 0);
});

test("explicit environment source does not discover credentials or fall back to token file", async t => {
  const server = await fakeServer(t, value => {
    assert.equal(value.http.headers.authorization, `Bearer ${token}`);
    respond(value.response, status(value.request));
  });
  for (const value of [undefined, "", secret]) {
    const requested: string[] = [];
    const bridge = new DawnBridge({ endpoint: server.endpoint, tokenEnv: "SHUGUANG_SERVICE_TOKEN" }, {
      readEnv: name => { requested.push(name); return value; },
      readToken: () => assert.fail("environment source must never fall back to files"),
    });
    await assert.rejects(bridge.command("status", signal()), errorCode("CREDENTIALS"));
    assert.deepEqual(requested, ["SHUGUANG_SERVICE_TOKEN"]);
    assert.equal(server.received.length, 0);
    await bridge.dispose();
  }
  const bridge = new DawnBridge({ endpoint: server.endpoint, tokenFile: "", tokenEnv: "SHUGUANG_SERVICE_TOKEN" }, {
    readEnv: name => { assert.equal(name, "SHUGUANG_SERVICE_TOKEN"); return token; },
    readToken: () => assert.fail("empty tokenFile does not select a second source"),
  });
  t.after(() => bridge.dispose());
  assert.equal((await bridge.command("status", signal())).type, "status");
  const controller = new AbortController();
  const cancelled = new DawnBridge({ endpoint: server.endpoint, tokenEnv: "SHUGUANG_SERVICE_TOKEN" }, {
    readEnv: () => { controller.abort(new Error(secret)); return token; },
  });
  await assert.rejects(cancelled.command("status", controller.signal), errorCode("CANCELLED"));
  await cancelled.dispose();
  assert.equal(server.received.length, 1);
});

test("default tokenEnv reader reads only the explicitly named synthetic environment value at command time", async t => {
  const name = "SHUGUANG_TEST_SERVICE_TOKEN";
  const original = process.env[name];
  const server = await fakeServer(t, value => {
    assert.equal(value.http.headers.authorization, `Bearer ${token}`);
    respond(value.response, status(value.request));
  });
  const bridge = new DawnBridge({ endpoint: server.endpoint, tokenEnv: name });
  try {
    // Set after construction to prove lazy environment reads, including a later rotation.
    process.env[name] = token;
    assert.equal((await bridge.command("status", signal())).type, "status");
    delete process.env[name];
    await assert.rejects(bridge.command("status", signal()), errorCode("CREDENTIALS"));
    assert.equal(server.received.length, 1);
  } finally {
    await bridge.dispose();
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

test("default reader uses real temporary token file and preserves Windows permission restrictions", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-bridge-token-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "synthetic.token");
  await writeFile(path, token + "\n", { mode: 0o600, flag: "wx" });
  const server = await fakeServer(t, value => {
    assert.equal(value.http.headers.authorization, `Bearer ${token}`);
    respond(value.response, status(value.request));
  });
  const bridge = new DawnBridge({ endpoint: server.endpoint, tokenFile: path });
  t.after(() => bridge.dispose());
  const metadata = await stat(path);
  if (process.platform === "win32" && (metadata.mode & 0o077) !== 0) {
    await assert.rejects(bridge.command("status", signal()), errorCode("CREDENTIALS"));
    assert.equal(server.received.length, 0);
    t.diagnostic(`Windows synthetic fixture mode ${(metadata.mode & 0o777).toString(8)} rejected by unchanged readTokenFile; HTTP tests use explicit injected synthetic reader.`);
  } else {
    assert.equal((await bridge.command("status", signal())).type, "status");
    assert.equal(server.received.length, 1);
  }
});

test("exact status, wake/sleep CAS, say and model controls contain no host history", async t => {
  let revision = 0;
  let lifecycle: "awake" | "sleeping" = "sleeping";
  let selectionRevision = 0;
  let model = "synthetic-model";
  let thinking: "off" | "low" = "off";
  const server = await fakeServer(t, ({ request, response, http }) => {
    assert.equal(http.headers.authorization, `Bearer ${token}`);
    assert.equal(http.headers.host, server.endpoint.slice("http://".length));
    if (request.type === "wake" || request.type === "sleep") {
      if (request.expectedRevision !== revision) {
        respond(response, { version: 1, requestId: request.requestId, type: "error", code: "CONFLICT", message: secret });
        return;
      }
      revision++;
      lifecycle = request.type === "wake" ? "awake" : "sleeping";
    }
    if (request.type === "say") {
      respond(response, { version: 1, requestId: request.requestId, type: "reply", text: "synthetic reply" });
    } else if (["model-status", "model-list", "model-select", "thinking-select"].includes(request.type)) {
      if (request.type === "model-select") {
        assert.equal(request.expectedRevision, selectionRevision++); model = request.model;
      }
      if (request.type === "thinking-select") {
        assert.equal(request.expectedRevision, selectionRevision++); assert.equal(request.thinking, "low"); thinking = "low";
      }
      respond(response, { version: 1, requestId: request.requestId, type: "model", state: {
        selectionRevision, model, thinking, models: ["synthetic-model", "other-model"], levels: ["off", "low"], calls: 0, maxCalls: 4,
      } });
    } else { respond(response, status(request, revision, lifecycle)); }
  });
  const bridge = injectedBridge(server.endpoint);
  t.after(() => bridge.dispose());
  assert.deepEqual(await bridge.command(" status ", signal()), status(server.received[0]!.request));
  assert.deepEqual(await bridge.command("wake 0", signal()), status(server.received[1]!.request, 1, "awake"));
  const conflict = await bridge.command("wake 0", signal());
  assert.equal(conflict.type, "error");
  if (conflict.type === "error") { assert.equal(conflict.code, "CONFLICT"); assert.equal(conflict.message.includes(secret), false); }
  assert.equal((await bridge.command("say hello only this message", signal())).type, "reply");
  for (const input of ["model-status", "models", "model 0 other-model", "thinking 1 low"]) {
    assert.equal((await bridge.command(input, signal())).type, "model");
  }
  assert.deepEqual(await bridge.command("sleep 1", signal()), status(server.received[8]!.request, 2, "sleeping"));
  const bodies = server.received.map(({ request: { requestId, ...rest } }) => {
    assert.match(requestId, /^[A-Za-z0-9_-]+$/); return rest;
  });
  assert.deepEqual(bodies, [
    { version: 1, type: "status" }, { version: 1, type: "wake", expectedRevision: 0 },
    { version: 1, type: "wake", expectedRevision: 0 }, { version: 1, type: "say", text: "hello only this message" },
    { version: 1, type: "model-status" }, { version: 1, type: "model-list" },
    { version: 1, type: "model-select", expectedRevision: 0, model: "other-model" },
    { version: 1, type: "thinking-select", expectedRevision: 1, thinking: "low" },
    { version: 1, type: "sleep", expectedRevision: 1 },
  ]);
  assert.equal(new Set(server.received.map(value => value.request.requestId)).size, 9);
  await bridge.dispose();
  assert.equal(server.received.length, 9, "dispose must not send sleep or service shutdown");
});

test("wrong token is redacted, not retried, and does not poison subsequent requests", async t => {
  const server = await fakeServer(t, ({ request, response, http }) => {
    if (http.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(secret); }
    else { respond(response, status(request)); }
  });
  let reads = 0;
  const bridge = injectedBridge(server.endpoint, () => ++reads === 1 ? "w".repeat(43) : token);
  t.after(() => bridge.dispose());
  await assert.rejects(bridge.command("status", signal()), errorCode("UNAVAILABLE"));
  assert.equal(reads, 1);
  assert.equal(server.received.length, 1);
  assert.equal((await bridge.command("status", signal())).type, "status");
  assert.equal(server.received.length, 2);
});

test("redirects are not followed and do not leak token", async t => {
  const destination = await fakeServer(t, value => respond(value.response, status(value.request)));
  const source = await fakeServer(t, ({ response }) => { response.writeHead(307, { Location: destination.endpoint }); response.end(secret); });
  const bridge = injectedBridge(source.endpoint);
  t.after(() => bridge.dispose());
  await assert.rejects(bridge.command("status", signal()), errorCode("UNAVAILABLE"));
  assert.equal(source.received.length, 1);
  assert.equal(destination.received.length, 0);
});

test("malformed, mismatched and untyped responses fail without retry or raw errors", async t => {
  const server = await fakeServer(t, ({ request, response }) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(server.received.length === 1 ? secret : JSON.stringify({ ...status(request), requestId: "wrong" }));
  });
  const bridge = injectedBridge(server.endpoint);
  t.after(() => bridge.dispose());
  for (let count = 1; count <= 2; count++) {
    await assert.rejects(bridge.command("status", signal()), errorCode("UNAVAILABLE"));
    assert.equal(server.received.length, count);
  }
});

test("pre-abort and abort during token read reject fixed cancellation without dispatch", async t => {
  const server = await fakeServer(t, value => respond(value.response, status(value.request)));
  let reads = 0;
  const controller = new AbortController();
  const bridge = injectedBridge(server.endpoint, () => { reads++; controller.abort(new Error(secret)); return token; });
  t.after(() => bridge.dispose());
  await assert.rejects(bridge.command("status", AbortSignal.abort(new Error(secret))), errorCode("CANCELLED"));
  assert.equal(reads, 0);
  await assert.rejects(bridge.command("status", controller.signal), errorCode("CANCELLED"));
  assert.equal(reads, 1);
  assert.equal(server.received.length, 0);
});

test("caller cancellation rejects a late successful response and releases pending slot", async t => {
  const arrived = deferred<Received>();
  const server = await fakeServer(t, value => {
    if (server.received.length === 1) arrived.resolve(value);
    else respond(value.response, status(value.request));
  });
  const bridge = injectedBridge(server.endpoint);
  t.after(() => bridge.dispose());
  const controller = new AbortController();
  const pending = bridge.command("say synthetic", controller.signal);
  const rejection = assert.rejects(pending, errorCode("CANCELLED"));
  const late = await arrived.promise;
  controller.abort(new Error(secret));
  respond(late.response, { version: 1, requestId: late.request.requestId, type: "reply", text: "late success" });
  await rejection;
  assert.equal((await bridge.command("status", signal())).type, "status");
  assert.equal(server.received.length, 2);
});

test("eight requests including controls saturate; finally frees capacity after cancellation", async t => {
  const allArrived = deferred<void>();
  const server = await fakeServer(t, value => {
    if (server.received.length === 8) allArrived.resolve();
    if (server.received.length > 8) respond(value.response, status(value.request));
  });
  let reads = 0;
  const bridge = injectedBridge(server.endpoint, () => { reads++; return token; });
  t.after(() => bridge.dispose());
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const pending = controllers.map((controller, index) => bridge.command(index === 0 ? "say synthetic" : "status", controller.signal));
  const outcomes = pending.map(promise => assert.rejects(promise, errorCode("CANCELLED")));
  await allArrived.promise;
  await assert.rejects(bridge.command("model-status", signal()), errorCode("SATURATED"));
  assert.equal(reads, 8);
  assert.equal(server.received.length, 8);
  controllers[0]!.abort();
  await outcomes[0];
  assert.equal((await bridge.command("status", signal())).type, "status");
  for (const controller of controllers) controller.abort();
  await Promise.all(outcomes);
  assert.equal(reads, 9);
  assert.equal(server.received.length, 9);
});

test("dispose cancels and waits for all pending, is idempotent, rejects new work and leaves service alive", async t => {
  const arrived = deferred<void>();
  const server = await fakeServer(t, value => {
    if (server.received.length <= 2) { if (server.received.length === 2) arrived.resolve(); }
    else respond(value.response, status(value.request));
  });
  const bridge = injectedBridge(server.endpoint);
  let settled = 0;
  const pending = ["say synthetic", "status"].map(input => assert.rejects(bridge.command(input, signal()), errorCode("CANCELLED"))
    .then(() => { settled++; }));
  await arrived.promise;
  const disposing = bridge.dispose();
  assert.equal(bridge.dispose(), disposing);
  await assert.rejects(bridge.command("status", signal()), errorCode("CLOSED"));
  await disposing;
  await Promise.all(pending);
  assert.equal(settled, 2);
  assert.equal(server.received.length, 2);
  for (const value of server.received) respond(value.response, status(value.request));
  const independent = injectedBridge(server.endpoint);
  t.after(() => independent.dispose());
  assert.equal((await independent.command("status", signal())).type, "status");
  assert.equal(server.received.length, 3);
});

test("dispose before deferred dispatch cancels the reservation without credential I/O", async () => {
  const bridge = injectedBridge("http://127.0.0.1:7341", () => { assert.fail("disposed request must not read token"); });
  const rejection = assert.rejects(bridge.command("status", signal()), errorCode("CANCELLED"));
  await bridge.dispose();
  await rejection;
  await assert.rejects(bridge.command("status", signal()), errorCode("CLOSED"));
});
