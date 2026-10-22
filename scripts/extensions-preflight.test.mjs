/**
 * 扩展静态预检单测
 * （change: 2026-10-15-add-scannable-extension-directories，任务 3.4）。
 *
 * 重点覆盖本分支的分级口径：**缺必需槽位实现只告警**，同槽位两个实现仍失败。
 *
 * 运行：`node --test scripts/extensions-preflight.test.mjs`
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectPreflightProblems, probeDeclaredExports } from "./extensions-preflight.mjs";

function makeExtensionDir({ browserSources = false, artifact = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
  if (browserSources) {
    fs.mkdirSync(path.join(dir, "src", "frontend"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "frontend", "index.ts"), "export {};\n");
    fs.writeFileSync(path.join(dir, "src", "frontend", "metadata.ts"), "export {};\n");
  }
  if (artifact) {
    fs.mkdirSync(path.join(dir, "browser-dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "browser-dist", "artifact-manifest.json"), "{}\n");
  }
  return dir;
}

test("有 browser 源码但缺产物：告警", () => {
  const dir = makeExtensionDir({ browserSources: true });
  const host = {
    scan: { extensions: [{ extensionId: "alpha", dir }] },
    registrations: [{ extensionId: "alpha", directory: dir, descriptor: { site: {} }, hasBrowserArtifact: false }]
  };
  const { errors, warnings } = collectPreflightProblems(host);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 2);
});

test("产物齐备：无告警", () => {
  const dir = makeExtensionDir({ browserSources: true, artifact: true });
  const host = {
    scan: { extensions: [{ extensionId: "alpha", dir }] },
    registrations: [{ extensionId: "alpha", directory: dir, descriptor: { site: {} }, hasBrowserArtifact: true }]
  };
  const { errors, warnings } = collectPreflightProblems(host);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("纯后端扩展：无告警", () => {
  const dir = makeExtensionDir();
  const host = {
    scan: { extensions: [{ extensionId: "beta", dir }] },
    registrations: [{ extensionId: "beta", directory: dir, descriptor: { backend: {} }, hasBrowserArtifact: false }]
  };
  const { errors, warnings } = collectPreflightProblems(host);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

/**
 * 槽位覆盖分级。`storage` 恒为必需；声明任一访问控制槽位（identity / access）时三者同时必需
 * （contracts `requiredFoundationSlots`）。缺槽位只告警，同槽位两个实现失败。
 */
for (const { slots, errors, warnings } of [
  { slots: [], errors: 0, warnings: 1 },
  { slots: ["storage"], errors: 0, warnings: 0 },
  { slots: ["storage", "identity", "access"], errors: 0, warnings: 0 },
  { slots: ["storage", "identity"], errors: 0, warnings: 1 },
  { slots: ["storage", "access"], errors: 0, warnings: 1 },
  { slots: ["storage", "storage"], errors: 1, warnings: 0 }
]) {
  test(`槽位覆盖：${slots.join("+") || "空集合"}`, () => {
    const host = { scan: { extensions: [] }, registrations: [] };
    const declarations = slots.map((slot, index) => ({ extensionId: `fixture-${index}`, providers: [{ slot }] }));
    const problems = collectPreflightProblems(host, { slotDeclarations: declarations });
    assert.equal(problems.errors.length, errors);
    assert.equal(problems.warnings.length, warnings);
  });
}

/**
 * 死声明探测：`backend.factory` / `hostPlugin.factory` 指向不存在（或非函数）的导出时，预检必须失败。
 *
 * 背景：扫描期只校验"模块文件存在"，所以 7 个 provider 的 `backend` 声明指向被删掉的工厂也能通过
 * 预检——直到有人真按声明构造定义才炸。
 */
test("声明导出探测：死工厂失败、真实工厂通过", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-probe-"));
  const moduleFile = path.join(dir, "backend.js");
  fs.writeFileSync(moduleFile, "export function createReal() { return 1; }\n");
  const host = {
    scan: { extensions: [] },
    registrations: [
      { extensionId: "real", directory: dir, backend: { module: moduleFile, factory: "createReal" }, hostPlugin: null, canvasContent: null },
      { extensionId: "dead-backend", directory: dir, backend: { module: moduleFile, factory: "createGone" }, hostPlugin: null, canvasContent: null },
      { extensionId: "dead-host-plugin", directory: dir, backend: null, hostPlugin: { module: moduleFile, factory: "createAlsoGone" }, canvasContent: null },
      // 画布内容端口声明同样做导出探测（change: 2026-10-17-decouple-film-set-from-canvas-service）。
      { extensionId: "dead-canvas-content", directory: dir, backend: null, hostPlugin: null, canvasContent: { module: moduleFile, factory: "createFrameRuntime" } }
    ]
  };
  const errors = await probeDeclaredExports(host);
  assert.equal(errors.length, 3);
  assert.deepEqual(errors.map((error) => error.extensionId).sort(), ["dead-backend", "dead-canvas-content", "dead-host-plugin"]);
  for (const error of errors) assert.match(error.message, /死声明|不是函数/);
});
