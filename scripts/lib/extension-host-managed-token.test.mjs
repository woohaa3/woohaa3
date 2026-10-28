/**
 * `loadRuntimePlugin` 的模块身份测试（change: 2026-10-27-add-extension-dev-reload，D6）。
 *
 * 开发者模式的产物始终落在同一目录，版本目录不再变化，因此靠 `token` 制造新的模块 URL：
 * 同 token 复用同一模块实例，不同 token 得到新实例——与「换版本目录」语义一致。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadRuntimePlugin } from "./extension-host-managed.mjs";

const EXTENSION_ID = "dev-token-probe";

/** 写一个最小的可加载扩展目录；`marker` 会出现在插件对象上，用来区分模块实例。 */
function writeExtension(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "extension.json"),
    JSON.stringify({
      schemaVersion: 1,
      extensionId: EXTENSION_ID,
      hostPlugin: { kind: "provider", module: "./backend", factory: "createProbe" }
    })
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: `@woohaa3/extension-${EXTENSION_ID}`, version: "0.0.0", type: "module" })
  );
  fs.writeFileSync(
    path.join(dir, "backend.js"),
    `export function createProbe() {
  return { name: "${EXTENSION_ID}", configPrefix: "${EXTENSION_ID}", apply() {}, marker: "${marker}" };
}
`
  );
}

test("未给 token 时按目录复用同一模块实例", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-dev-token-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeExtension(root, "a");

  const first = await loadRuntimePlugin({ dir: root, extensionId: EXTENSION_ID, version: "v1" });
  const second = await loadRuntimePlugin({ dir: root, extensionId: EXTENSION_ID, version: "v1" });
  assert.equal(first.plugin.marker, "a");
  // 同目录同版本 → 命中 ESM 缓存，复用同一模块求值结果。
  assert.equal(first.plugin.marker, second.plugin.marker);
});

test("同一 token 复用实例，不同 token 得到新实例", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-dev-token-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeExtension(root, "a");

  const firstA = await loadRuntimePlugin({ dir: root, extensionId: EXTENSION_ID, version: "v1", token: "aaa" });
  const secondA = await loadRuntimePlugin({ dir: root, extensionId: EXTENSION_ID, version: "v1", token: "aaa" });
  assert.equal(firstA.plugin.marker, "a", "同 token 应复用同一模块");

  // 改产物并换 token：新 token 是新的模块 URL，因此拿到新代码。
  writeExtension(root, "b");
  const firstB = await loadRuntimePlugin({ dir: root, extensionId: EXTENSION_ID, version: "v1", token: "bbb" });
  assert.equal(firstB.plugin.marker, "b", "不同 token 应求值新产物");

  // 回到旧 token 仍命中旧模块：token 是模块身份，不是「总是重新读取」。
  const backToA = await loadRuntimePlugin({ dir: root, extensionId: EXTENSION_ID, version: "v1", token: "aaa" });
  assert.equal(backToA.plugin.marker, "a");
});

test("token 不影响声明校验与 identity 断言", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-dev-token-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeExtension(root, "a");
  fs.writeFileSync(
    path.join(root, "backend.js"),
    `export function createProbe() {
  return { name: "wrong-name", configPrefix: "x", apply() {} };
}
`
  );
  await assert.rejects(
    () => loadRuntimePlugin({ dir: root, extensionId: EXTENSION_ID, version: "v1", token: "ccc" }),
    (error) => error.code === "EXTENSION_IDENTITY_MISMATCH"
  );
});
