/**
 * 市场 fixture 自检（change: 2026-10-21-isolate-extension-host-process，任务 10.1）。
 *
 * 每个含后端 fixture：build:backend 产出自包含 entry.mjs 与合法 config-schema.json，受管预检通过；
 * 在**独立 node 子进程**里装上出网守卫后加载插件，验证 fixture 的行为符合端到端的预期
 * （echo 真实走 doGenerate 与 jobs；crashy 的 exit 让进程退出；greedy 的越权探针被拒）。
 * 不启动宿主；完整宿主 + HTTP 的端到端在 web/backend/tests/extension-host-e2e.test.ts。
 *
 * 运行：`node --test scripts/fixtures-marketplace.test.mjs`
 * 导出 `packFixture` 供端到端复用（在临时副本里改版本再打包，不动仓库文件）。
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { packExtension } from "./pack-extension.mjs";
import { preflightDirectory } from "./extensions-preflight.mjs";
import { unpackExtensionPackage } from "./lib/extension-package.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
export const MARKETPLACE_FIXTURES = path.join(HERE, "fixtures", "marketplace");

/**
 * 打包一个 fixture。`version` 给出时在临时副本里同步改 extension.json / package.json / shared.ts 的版本。
 * 返回 packExtension 的结果（含 outFile、packageDigest、keyId）。
 */
export async function packFixture(name, { version, privateKey = null, outDir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-fixture-")) } = {}) {
  const work = path.join(outDir, `${name}-src`);
  fs.cpSync(path.join(MARKETPLACE_FIXTURES, name), work, { recursive: true });
  if (version) {
    for (const file of ["extension.json", "package.json"]) {
      const json = JSON.parse(fs.readFileSync(path.join(work, file), "utf8"));
      json.version = version;
      fs.writeFileSync(path.join(work, file), JSON.stringify(json, null, 2));
    }
    const shared = path.join(work, "src", "shared.ts");
    if (fs.existsSync(shared)) fs.writeFileSync(shared, fs.readFileSync(shared, "utf8").replace(/version: "[^"]+"/, `version: "${version}"`));
  }
  const id = JSON.parse(fs.readFileSync(path.join(work, "extension.json"), "utf8")).extensionId;
  return packExtension({ dir: work, out: path.join(outDir, `${id}-${version ?? "1.0.0"}.wxt`), privateKey, repoRoot: REPO_ROOT });
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-fixtures-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 打包并解包到临时目录，返回解包树。 */
async function unpacked(t, name, options = {}) {
  const work = tmp(t);
  const packed = await packFixture(name, { ...options, outDir: work });
  const tree = path.join(work, "tree");
  unpackExtensionPackage({ packagePath: packed.outFile, destDir: tree });
  return { packed, tree };
}

/** 在子进程脚本里调用 fixture 自己登记的路由处理器（模拟宿主转发），返回 { status, body }。 */
const CALL_ROUTE = `
const callRoute = async (method, url) => {
  for (const handler of routes) {
    let status = 0; let body = "";
    const handled = await handler({ method, url }, { writeHead: (s) => { status = s; }, end: (b) => { body = b; } });
    if (handled) return { status, body: body ? JSON.parse(body) : null };
  }
  return { status: 404, body: null };
};`;

for (const name of ["fixture-echo-provider", "fixture-crashy", "fixture-greedy"]) {
  test(`${name}：build:backend 产出单文件入口，受管预检通过，包内无 src/`, async (t) => {
    const { packed, tree } = await unpacked(t, name);
    assert.equal(packed.requiresRestart, true);
    assert.ok(!fs.existsSync(path.join(tree, "backend-dist", "config-schema.json")));
    assert.ok(!fs.existsSync(path.join(tree, "src")));
    const preflight = await preflightDirectory(tree, { managed: true });
    assert.equal(preflight.ok, true, JSON.stringify(preflight.errors));
    // 产物只 import node: 内置模块。
    const entry = fs.readFileSync(path.join(tree, "backend-dist", "entry.mjs"), "utf8");
    for (const match of entry.matchAll(/^import .* from "([^"]+)";$/gm)) assert.match(match[1], /^node:/);
  });
}

test("fixture-echo-provider：可以升级到新版本（临时副本改版本），config-schema 与包摘要随之变化", async (t) => {
  const work = tmp(t);
  const { privateKey } = generateKeyPairSync("ed25519");
  const v1 = await packFixture("fixture-echo-provider", { outDir: work, privateKey });
  const v2 = await packFixture("fixture-echo-provider", { outDir: work, privateKey, version: "1.1.0" });
  assert.equal(v2.version, "1.1.0");
  assert.notEqual(v1.packageDigest, v2.packageDigest);
  assert.equal(v1.keyId, v2.keyId);
});
