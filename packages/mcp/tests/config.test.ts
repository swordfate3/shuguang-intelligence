import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseMcpOptions } from "../src/config.ts";

const args = ["--endpoint", "http://127.0.0.1:7341", "--token-file", "/private/service.token"];
test("MCP configuration is explicit, local and readonly unless enabled", () => {
  assert.deepEqual(parseMcpOptions(args), { endpoint: args[1], tokenFile: args[3], allowWrite: false });
  assert.equal(parseMcpOptions([...args, "--allow-write"]).allowWrite, true);
  for (const bad of [[], [...args, "--allow-write", "--allow-write"], [...args, "--unknown"],
    [...args, "--endpoint", args[1]!], [...args, "--token-file"],
    ["--endpoint", "http://localhost:7341", "--token-file", "/private/token"],
    ["--endpoint", "http://127.0.0.1:7341/path", "--token-file", "/private/token"],
    ["--endpoint", args[1]!, "--token-file", "relative.token"]]) {
    assert.throws(() => parseMcpOptions(bad));
  }
});

test("MCP CLI help and bad arguments never write protocol output or expose supplied values", () => {
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const help = spawnSync(process.execPath, [main, "--help"], { encoding: "utf8", timeout: 3000 });
  assert.equal(help.status, 0); assert.equal(help.stdout, ""); assert.match(help.stderr, /stdio bridge/);
  const bad = spawnSync(process.execPath, [main, ...args, "--invalid-SyntheticSecret"], { encoding: "utf8", timeout: 3000 });
  assert.equal(bad.status, 1); assert.equal(bad.stdout, ""); assert.doesNotMatch(bad.stderr, /SyntheticSecret|ENOENT|\/private/);
});

test("bad arguments are rejected before observable token open, valid arguments reach exactly one explicit open", () => {
  const main = new URL("../src/main.ts", import.meta.url).href;
  for (const invalid of [true, false]) {
    const supplied = invalid ? [...args, "--invalid"] : args;
    const code = `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      let reads=0; const original=fs.openSync;
      fs.openSync=(path,...rest)=>{
        if(path==='/private/service.token'){reads++;throw new Error('SYNTHETIC_SECRET');}
        return original(path,...rest);
      };
      syncBuiltinESMExports();
      process.argv=['node','main',...${JSON.stringify(supplied)}];
      await import(${JSON.stringify(main)});
      process.stderr.write('TOKEN_OPEN_COUNT='+reads+'\\n');
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { encoding: "utf8", timeout: 3000 });
    assert.equal(child.status, 1); assert.equal(child.stdout, "");
    assert.match(child.stderr, new RegExp(`TOKEN_OPEN_COUNT=${invalid ? 0 : 1}`));
    assert.doesNotMatch(child.stderr, /SYNTHETIC_SECRET|ENOENT/);
  }
});
