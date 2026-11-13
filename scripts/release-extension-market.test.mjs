/**
 * `pnpm ext:release` 前置判定单测（change: 2026-11-13-add-extension-version-governance）。
 *
 * 重点不是发布本身（那由父仓 release:extension 与真实市场负责），而是**发布前就该拒绝**的
 * 三种形态：站点 backend 工厂、bootstrap 槽位、有未发版改动的工作树。
 *
 * 运行：`node --test scripts/release-extension-market.test.mjs`
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkReleaseReady, parseArgs, releaseCommandArgs } from "./release-extension-market.mjs";

/** 建一个含单个扩展的最小仓库；`descriptor` 决定形态。 */
function repo({ id = "demo", descriptor = {}, backendModule = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-release-"));
  fs.writeFileSync(path.join(root, "extensions.config.json"), JSON.stringify({ schemaVersion: 1, roots: ["extensions"] }));
  const dir = path.join(root, "extensions", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "extension.json"),
    `${JSON.stringify({ schemaVersion: 1, extensionId: id, version: "0.1.0", ...descriptor }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: `@woohaa3/extension-${id}`, version: "0.1.0", type: "module" }, null, 2)}\n`
  );
  // 模块按 `./dist/<name>.js` 解析（MODULE_FALLBACKS）：声明写 `./backend`，文件放 `dist/backend.js`。
  for (const field of ["hostPlugin", "backend", "bootstrap"]) {
    if (!descriptor[field] || !backendModule) continue;
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "backend.js"), "export function createDemo() {}\n");
    break;
  }
  const run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "test"]);
  run(["add", "."]);
  run(["commit", "-qm", "init"]);
  return { root, dir, id, run };
}

test("parseArgs：缺目标报错，选项有缺省值", () => {
  assert.throws(() => parseArgs([]), /extensionId 或目录/);
  const parsed = parseArgs(["demo"]);
  assert.equal(parsed.target, "demo");
  assert.equal(parsed.bumpBase, "HEAD");
  assert.equal(parsed.dryRun, false);
  assert.throws(() => parseArgs(["a", "b"]), /只能指定一个/);
  assert.throws(() => parseArgs(["demo", "--nope"]), /未知参数/);
});

test("可发布形态：纯 hostPlugin 扩展通过判定", async () => {
  const { root, dir, id } = repo({ descriptor: { hostPlugin: { module: "./backend", factory: "createDemo", features: ["provider"] } } });
  const ready = await checkReleaseReady(id, { repoRoot: root, bumpBase: "HEAD" });
  assert.equal(ready.extensionId, id);
  assert.equal(ready.version, "0.1.0");
  assert.equal(ready.hotSwappable, true);
});

test("站点 backend 工厂：拒绝并说明只能随客户端发版", async () => {
  const { root, dir, id } = repo({
    descriptor: {
      backend: { module: "./backend", factory: "createDemo" },
      site: {
        name: "演示",
        description: "演示",
        version: "0.1.0",
        configSchema: { schemaId: "s", schemaVersion: 1 },
        capabilities: [{ id: "c", kind: "handler", description: "d" }],
        defaultEnabled: true
      }
    }
  });
  await assert.rejects(checkReleaseReady(id, { repoRoot: root, bumpBase: "HEAD" }), (error) => {
    assert.equal(error.code, "EXTENSION_RELEASE_NOT_DISTRIBUTABLE");
    assert.match(error.message, /backend 工厂|随客户端/);
    return true;
  });
});

test("bootstrap 槽位：拒绝发布", async () => {
  const { root, dir, id } = repo({ descriptor: { bootstrap: { module: "./backend", export: "createDemo" } } });
  await assert.rejects(checkReleaseReady(id, { repoRoot: root, bumpBase: "HEAD" }), (error) => {
    assert.equal(error.code, "EXTENSION_RELEASE_NOT_DISTRIBUTABLE");
    assert.match(error.message, /bootstrap/);
    return true;
  });
});

test("有未发版改动：拒绝并提示先 bump", async () => {
  const { root, dir, id } = repo({ descriptor: { hostPlugin: { module: "./backend", factory: "createDemo", features: ["provider"] } } });
  fs.appendFileSync(path.join(dir, "extension.json"), "\n");
  await assert.rejects(checkReleaseReady(id, { repoRoot: root, bumpBase: "HEAD" }), (error) => {
    assert.equal(error.code, "EXTENSION_VERSION_NOT_BUMPED");
    assert.match(error.message, /ext:bump/);
    return true;
  });
});

test("改动并 bump 之后可以发布", async () => {
  const { root, dir, id } = repo({ descriptor: { hostPlugin: { module: "./backend", factory: "createDemo", features: ["provider"] } } });
  // 改一点内容但不改动版本以外的东西：只推进版本，工作树相对 HEAD 就有改动。
  const file = path.join(dir, "extension.json");
  const descriptor = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, `${JSON.stringify({ ...descriptor, version: "0.1.1" }, null, 2)}\n`);
  const pkgFile = path.join(dir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  fs.writeFileSync(pkgFile, `${JSON.stringify({ ...pkg, version: "0.1.1" }, null, 2)}\n`);

  const ready = await checkReleaseReady(id, { repoRoot: root, bumpBase: "HEAD" });
  assert.equal(ready.version, "0.1.1");
  assert.equal(ready.bumpBaseChecked, true);
});

test("releaseCommandArgs 只透传已指定的选项", () => {
  const ready = { directory: "/abs/ext" };
  assert.deepEqual(releaseCommandArgs(ready, {}), ["/abs/ext"]);
  assert.deepEqual(
    releaseCommandArgs(ready, { key: "k.pem", notes: "修一个 bug", approve: true, certificateChain: null }),
    ["/abs/ext", "--key", "k.pem", "--notes", "修一个 bug", "--approve"]
  );
  assert.deepEqual(releaseCommandArgs(ready, { certificateChain: "c.json" }), ["/abs/ext", "--certificate-chain", "c.json"]);
});
