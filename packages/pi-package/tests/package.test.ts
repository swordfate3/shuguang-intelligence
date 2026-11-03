import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const own = join(root, "packages/pi-package");
const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8"));
test("both Pi installation roots declare the same extension and skills, without runtime dependencies or install scripts", () => {
  const rootManifest = json(join(root, "package.json"));
  const pkg = json(join(own, "package.json"));
  for (const [base, manifest] of [[root, rootManifest], [own, pkg]] as const) {
    assert.equal(manifest.version, "0.1.0");
    assert.equal(manifest.license, "MIT");
    assert.equal(manifest.private, true);
    assert.equal(manifest.type, "module");
    assert.ok((manifest.keywords as string[]).includes("pi-package"));
    const resources = manifest.pi as { extensions: string[]; skills: string[] };
    assert.equal(resources.extensions.length, 1);
    assert.equal(resources.skills.length, 1);
    assert.equal(resolve(base, resources.extensions[0]!), join(own, "src/index.ts"));
    assert.equal(resolve(base, resources.skills[0]!), join(own, "skills"));
    assert.ok(existsSync(resolve(base, resources.extensions[0]!)));
    assert.ok(existsSync(resolve(base, resources.skills[0]!, "shuguang/SKILL.md")));
    assert.equal(manifest.dependencies, undefined);
    const scripts = manifest.scripts as Record<string, string>;
    for (const name of ["preinstall", "install", "postinstall", "prepare", "prepack"]) assert.equal(scripts[name], undefined);
  }
  assert.equal(readFileSync(join(root, "LICENSE"), "utf8"), readFileSync(join(own, "LICENSE"), "utf8"));
  assert.deepEqual(pkg.files, ["src/", "skills/", "LICENSE"]);
});
test("skill documents source sharing and bounded research without claiming deployment", () => {
  const skill = readFileSync(join(own, "skills/shuguang/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: shuguang\ndescription: [^\n]+\n/);
  assert.match(skill, /license: MIT/);
  for (const marker of ["message", "owner", "来源导入", "/shuguang-research start", "verification_pending", "unknown外呼不重派", "不要自动发送", "不自动重试"]) {
    // Required behavior, without treating a textual instruction as an enforcement boundary.
    assert.ok(skill.includes(marker), marker);
  }
  const docker = readFileSync(join(root, "Dockerfile"), "utf8");
  assert.doesNotMatch(docker, /COPY .*pi-package|pi install|npm install.*pi-coding-agent/);
});

test("skill documents remote HTTPS and independent server ACL, and gates private bridges", () => {
  const skill = readFileSync(join(own, "skills/shuguang/SKILL.md"), "utf8");
  for (const marker of ['"url":"https://host/mcp"', '"credentialEnv":"SHUGUANG_MCP_TOKEN"',
    "Bearer ${SHUGUANG_MCP_TOKEN}", "不是服务器ACL授权", "逐工具hidden/exclude", "不执行Docker",
    "远程连接当前仅支持普通MCP交流与控制；片段共享和研究私有桥尚不支持", "不发现/读取key"]) assert.ok(skill.includes(marker), marker);
});
