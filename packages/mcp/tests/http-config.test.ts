import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { parseHttpMcpOptions, parsePublicUrl } from "../src/http-config.ts";

const args = ["--endpoint", "http://127.0.0.1:7341", "--token-file", "/private/service.token",
  "--auth-token-file", "/private/access.token", "--public-url", "https://test.example/mcp"];
const main = fileURLToPath(new URL("../src/http-main.ts", import.meta.url));

test("HTTP CLI explicit independent credentials, strict loopback internal endpoint and public HTTPS URL", () => {
  assert.deepEqual(parseHttpMcpOptions(args), { endpoint: args[1], tokenFile: args[3], authTokenFile: args[5],
    publicUrl: args[7], host: "127.0.0.1", port: 7342, allowWrite: false });
  const writable = parseHttpMcpOptions([...args, "--host", "0.0.0.0", "--port", "8000", "--allow-write"]);
  assert.equal(writable.host, "0.0.0.0"); assert.equal(writable.allowWrite, true); assert.equal(writable.port, 8000);
  for (const bad of [[], args.slice(0, -2), [...args, "--allow-write", "--allow-write"], [...args, "--other"],
    [...args, "--host", "localhost"], [...args, "--host", "192.168.1.1"], [...args, "--port", "0"],
    [...args, "--port", "65536"], [...args, "--port", "01"], [...args, "--port", "1.2"],
    [...args, "--endpoint", args[1]!]]) assert.throws(() => parseHttpMcpOptions(bad));
  for (const [index, value] of [[1, "http://localhost:7341"], [1, "http://0.0.0.0:7341"], [1, "https://remote.example"],
    [3, "relative"], [5, "/private/service.token"], [5, "relative"], [3, "/private/\nsecret"]] as const) {
    const bad = [...args]; bad[index] = value; assert.throws(() => parseHttpMcpOptions(bad));
  }
  for (const value of ["http://test.example/mcp", "https://test.example/", "https://test.example/mcp/", "https://test.example/mcp?q=1",
    "https://test.example/mcp#x", "https://u:p@test.example/mcp", "https://test.example/a/../mcp", "https://test.example/%6dcp",
    "https://TEST.example/mcp", " https://test.example/mcp", "https://test.example/mcp\n"]) assert.throws(() => parsePublicUrl(value));
  assert.deepEqual(parsePublicUrl("https://test.example:443/mcp"), { host: "test.example:443", origin: "https://test.example" });
  assert.deepEqual(parsePublicUrl("https://test.example:8443/mcp"), { host: "test.example:8443", origin: "https://test.example:8443" });
});

test("CLI help and errors never expose secrets/stdout; invalid args open no credential files", () => {
  const help = spawnSync(process.execPath, [main, "--help"], { encoding: "utf8", timeout: 3000 });
  assert.equal(help.status, 0); assert.equal(help.stdout, ""); assert.match(help.stderr, /Streamable HTTP/);
  const bad = spawnSync(process.execPath, [main, ...args, "--PRIVATE_SECRET"], { encoding: "utf8", timeout: 3000 });
  assert.equal(bad.status, 1); assert.equal(bad.stdout, ""); assert.doesNotMatch(bad.stderr, /PRIVATE_SECRET|ENOENT|\/private/);
  const code = `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const original=fs.openSync; let reads=0;
    fs.openSync=(path,...rest)=>{if(String(path).startsWith('/private/')){reads++;throw Error('PRIVATE_SECRET');}return original(path,...rest)};
    syncBuiltinESMExports();
    process.argv=['node','main',...${JSON.stringify([...args, "--invalid"])}];
    await import(${JSON.stringify(new URL("../src/http-main.ts", import.meta.url).href)});
    process.stderr.write('READS='+reads+'\\n');
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { encoding: "utf8", timeout: 3000 });
  assert.equal(child.status, 1); assert.equal(child.stdout, ""); assert.match(child.stderr, /READS=0/); assert.doesNotMatch(child.stderr, /PRIVATE_SECRET/);
});

test("CLI rejects same-value synthetic token files before listening and exits cleanly on SIGTERM", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "shuguang-http-cli-"));
  const service = join(dir, "service.token"), access = join(dir, "access.token");
  const serviceToken = "S".repeat(43), authToken = "R".repeat(43);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    writeFileSync(service, serviceToken + "\n", { mode: 0o600 }); writeFileSync(access, serviceToken + "\n", { mode: 0o600 });
    const actualArgs = ["--endpoint", "http://127.0.0.1:1", "--token-file", service,
      "--auth-token-file", access, "--public-url", "https://test.example/mcp"];
    const bad = spawnSync(process.execPath, [main, ...actualArgs], { encoding: "utf8", timeout: 3000 });
    assert.equal(bad.status, 1); assert.equal(bad.stdout, ""); assert.ok(!bad.stderr.includes(serviceToken)); assert.ok(!bad.stderr.includes(dir));
    writeFileSync(access, authToken + "\n", { mode: 0o600 });
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const address = reservation.address(); assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    child = spawn(process.execPath, [main, ...actualArgs, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", b => { stdout += b; }); child.stderr!.on("data", b => { stderr += b; });
    const exited = new Promise<number | null>((resolve, reject) => { child!.once("close", resolve); child!.once("error", reject); });
    let connected = false;
    for (let i = 0; i < 100 && !connected; i++) {
      connected = await new Promise<boolean>(resolve => {
        const req = request({ hostname: "127.0.0.1", port, path: "/mcp", method: "GET", agent: false,
          headers: { Host: "test.example", Authorization: `Bearer ${authToken}` } }, res => { res.resume(); resolve(res.statusCode === 405); });
        req.on("error", () => resolve(false)); req.end();
      });
      if (!connected) await delay(20);
    }
    assert.equal(connected, true);
    child.kill("SIGTERM"); assert.equal(await exited, 0); assert.equal(stdout, ""); assert.equal(stderr, "");
  } finally { child?.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});
