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

import { collectPreflightProblems, preflightDirectory, probeDeclaredExports } from "./extensions-preflight.mjs";
import { sha256Hex } from "./lib/extension-release-catalog.mjs";

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

// ---------------------------------------------------------------------------
// preflightDirectory（change: 2026-10-21-add-extension-marketplace-point，任务 2.3）
// ---------------------------------------------------------------------------

const ENGINES = { hostAbi: "^1.0.0", sdkAbi: "^1.0.0", protocolVersion: 1 };

function managedTree({ descriptor = {}, pkg = {}, files = {}, browser = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-managed-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@woohaa3/extension-demo", version: "1.0.0", type: "module", ...pkg }));
  fs.writeFileSync(path.join(dir, "extension.json"), JSON.stringify({ schemaVersion: 1, extensionId: "demo", version: "1.0.0", engines: ENGINES, ...descriptor }));
  for (const [relative, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), contents);
  }
  if (browser) {
    const bytes = Buffer.from("export {};\n");
    fs.mkdirSync(path.join(dir, "browser-dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "browser-dist", "entry.js"), browser.tamper ? Buffer.from("tampered") : bytes);
    fs.writeFileSync(path.join(dir, "browser-dist", "artifact-manifest.json"), JSON.stringify({
      schemaVersion: 1, artifactId: sha256Hex(bytes),
      metadata: { extensionId: browser.extensionId ?? "demo", version: "1.0.0", label: "demo", description: "demo", activation: browser.activation ?? "server-active", configScope: browser.activation === "browser-local" ? "browser-local" : "site", required: browser.required ?? false, sdkAbi: 1 },
      protocolVersion: 1, sdkAbi: 1, reactMajor: 18, entry: "entry.js", styles: [], requiredSdkGroups: ["core"], requiredSdkExports: [], imports: [],
      files: [{ path: "entry.js", bytes: bytes.length, gzipBytes: 0, sha256: sha256Hex(bytes), kind: "entry" }]
    }));
  }
  return dir;
}

const codesOf = (result) => result.errors.map((error) => `${error.code}:${error.field ?? ""}`);

test("preflightDirectory：合法的纯前端受管扩展通过，requiresRestart=false", async () => {
  const result = await preflightDirectory(managedTree({ browser: {} }), { managed: true });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.extensionId, "demo");
  assert.equal(result.version, "1.0.0");
  assert.equal(result.activation, "server-active");
  assert.equal(result.requiresRestart, false);
});

test("preflightDirectory：含后端声明 → requiresRestart=true；只解析模块路径，不执行代码", async () => {
  const marker = path.join(os.tmpdir(), `preflight-executed-${process.pid}-${Date.now()}`);
  const dir = managedTree({
    pkg: { exports: { "./backend-dist/entry": "./backend-dist/entry.mjs" } },
    descriptor: { hostPlugin: { module: "./backend-dist/entry", factory: "createX", kind: "provider" } },
    files: {
      "backend-dist/entry.mjs": `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ran"); export function createX() {}\n`,
    }
  });
  const result = await preflightDirectory(dir, { managed: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.requiresRestart, true);
  assert.equal(fs.existsSync(marker), false, "预检不得执行包内代码");
});

test("preflightDirectory：受管禁止项 bootstrap / canvasContent / 市场来源 / migrate / required / always", async () => {
  const cases = [
    [{ descriptor: { bootstrap: { module: "./bootstrap", export: "b" } } }, "MARKETPLACE_FORBIDDEN_DECLARATION:bootstrap"],
    [{ descriptor: { canvasContent: { module: "./backend", factory: "c" } } }, "MARKETPLACE_FORBIDDEN_DECLARATION:canvasContent"],
    [{ descriptor: { content: { ownedFields: ["filmSetContent"] } } }, "MARKETPLACE_FORBIDDEN_DECLARATION:content"],
    [{ descriptor: { hostPlugin: { module: "./backend", factory: "s", kind: "marketplace-source" } } }, "MARKETPLACE_FORBIDDEN_DECLARATION:hostPlugin.kind"],
    [{ descriptor: { migrate: { module: "./backend", export: "m" } } }, "MARKETPLACE_FORBIDDEN_DECLARATION:migrate"],
    [{ descriptor: { required: true } }, "MARKETPLACE_FORBIDDEN_DECLARATION:required"],
    [{ browser: { activation: "always" } }, "MARKETPLACE_FORBIDDEN_DECLARATION:browser-dist.metadata.activation"],
    [{ browser: { required: true } }, "MARKETPLACE_FORBIDDEN_DECLARATION:browser-dist.metadata.required"]
  ];
  for (const [input, expected] of cases) {
    const result = await preflightDirectory(managedTree(input), { managed: true });
    assert.equal(result.ok, false, expected);
    assert.ok(codesOf(result).includes(expected), `${expected} ∈ ${codesOf(result).join(", ")}`);
  }
});

test("preflightDirectory：engines 不兼容 → MARKETPLACE_ENGINES_INCOMPATIBLE", async () => {
  const result = await preflightDirectory(managedTree({ descriptor: { engines: { ...ENGINES, hostAbi: "^2.0.0" } } }), { managed: true });
  assert.ok(codesOf(result).includes("MARKETPLACE_ENGINES_INCOMPATIBLE:engines"));
});

test("preflightDirectory：受管扩展缺 version / engines、版本不一致、workspace 依赖", async () => {
  const noEngines = managedTree();
  const descriptor = JSON.parse(fs.readFileSync(path.join(noEngines, "extension.json"), "utf8"));
  delete descriptor.engines;
  delete descriptor.version;
  fs.writeFileSync(path.join(noEngines, "extension.json"), JSON.stringify(descriptor));
  assert.deepEqual(codesOf(await preflightDirectory(noEngines, { managed: true })).sort(), ["MARKETPLACE_PREFLIGHT_FAILED:engines", "MARKETPLACE_PREFLIGHT_FAILED:version"]);
  assert.ok(codesOf(await preflightDirectory(managedTree({ pkg: { version: "1.0.1" } }), { managed: true })).includes("MARKETPLACE_PREFLIGHT_FAILED:version"));
  assert.ok(codesOf(await preflightDirectory(managedTree({ pkg: { dependencies: { "@woohaa3/contracts": "workspace:*" } } }), { managed: true })).includes("MARKETPLACE_PREFLIGHT_FAILED:package.json.dependencies"));
});

test("preflightDirectory：模块缺失、browser 产物缺失/被篡改/身份不符", async () => {
  assert.ok(codesOf(await preflightDirectory(managedTree({ descriptor: { hostPlugin: { module: "./backend", factory: "x", kind: "provider" } } }), { managed: true })).includes("MARKETPLACE_PREFLIGHT_FAILED:EXTENSION_MODULE_MISSING"));
  const noArtifact = managedTree({ files: { "browser-dist/entry.js": "x" } });
  assert.ok(codesOf(await preflightDirectory(noArtifact, { managed: true })).includes("MARKETPLACE_PREFLIGHT_FAILED:browser-dist"));
  assert.ok(codesOf(await preflightDirectory(managedTree({ browser: { tamper: true } }), { managed: true })).includes("MARKETPLACE_PREFLIGHT_FAILED:browser-dist"));
  assert.ok(codesOf(await preflightDirectory(managedTree({ browser: { extensionId: "other" } }), { managed: true })).includes("MARKETPLACE_PREFLIGHT_FAILED:browser-dist"));
});

test("preflightDirectory：非受管模式不施加受管规则（内置扩展缺 engines 也通过）", async () => {
  const dir = managedTree({ descriptor: { required: true }, pkg: { dependencies: { "@woohaa3/contracts": "workspace:*" } } });
  const result = await preflightDirectory(dir);
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// 子进程隔离的预检补充（change: 2026-10-21-isolate-extension-host-process，任务 6.3）
// ---------------------------------------------------------------------------

function backendTree({ descriptor = {}, schema = undefined, files = {} } = {}) {
  return managedTree({
    pkg: { exports: { "./backend-dist/entry": "./backend-dist/entry.mjs" } },
    descriptor: { hostPlugin: { module: "./backend-dist/entry", factory: "createX", kind: "provider" }, ...descriptor },
    files: {
      "backend-dist/entry.mjs": "export function createX() {}\n",
      ...files
    }
  });
}

test("preflightDirectory：受管 hostPlugin.kind=storage 被拒绝", async () => {
  const result = await preflightDirectory(backendTree({ descriptor: { hostPlugin: { module: "./backend-dist/entry", factory: "createX", kind: "storage" } } }), { managed: true });
  assert.ok(codesOf(result).includes("MARKETPLACE_FORBIDDEN_DECLARATION:hostPlugin.kind"), codesOf(result).join(", "));
});

test("preflightDirectory：包内 .node 原生模块被拒绝", async () => {
  const result = await preflightDirectory(backendTree({ files: { "backend-dist/vendor/addon.node": "\x7fELF" } }), { managed: true });
  assert.ok(codesOf(result).includes("MARKETPLACE_FORBIDDEN_DECLARATION:native-module"));
  assert.match(result.errors.map((error) => error.message).join("\n"), /backend-dist\/vendor\/addon\.node/);
  // 纯前端包同样不允许夹带原生模块。
  const front = await preflightDirectory(managedTree({ browser: {}, files: { "assets/x.node": "x" } }), { managed: true });
  assert.ok(codesOf(front).includes("MARKETPLACE_FORBIDDEN_DECLARATION:native-module"));
});

test("preflightDirectory：后端入口不在 backend-dist/ 下被拒绝", async () => {
  const dir = managedTree({
    pkg: { exports: { "./backend": "./dist/backend.js" } },
    descriptor: { hostPlugin: { module: "./backend", factory: "createX", kind: "provider" } },
    files: { "dist/backend.js": "export function createX() {}\n" }
  });
  const result = await preflightDirectory(dir, { managed: true });
  assert.ok(codesOf(result).includes("MARKETPLACE_FORBIDDEN_DECLARATION:hostPlugin.module"));
});

test("preflightDirectory：内置根（非受管）不受这些规则影响", async () => {
  const dir = managedTree({
    pkg: { exports: { "./backend": "./dist/backend.js" } },
    descriptor: { hostPlugin: { module: "./backend", factory: "createX", kind: "storage" } },
    files: { "dist/backend.js": "export function createX() {}\n", "native/x.node": "x" }
  });
  assert.deepEqual((await preflightDirectory(dir)).errors, []);
});
