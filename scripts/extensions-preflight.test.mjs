/**
 * 扩展静态预检单测
 * （change: 2026-10-15-add-scannable-extension-directories，任务 3.4）。
 *
 * 重点覆盖本分支的分级口径：**缺必需槽位实现只告警**，同槽位两个实现仍失败。
 *
 * 运行：`node --test scripts/extensions-preflight.test.mjs`
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  assert.equal(result.hotSwappable, false);
});

test("preflightDirectory：含后端声明 → requiresRestart=true；只解析模块路径，不执行代码", async () => {
  const marker = path.join(os.tmpdir(), `preflight-executed-${process.pid}-${Date.now()}`);
  const dir = managedTree({
    pkg: { exports: { "./backend-dist/entry": "./backend-dist/entry.mjs" } },
    descriptor: { hostPlugin: { module: "./backend-dist/entry", factory: "createX", features: ["provider"] } },
    files: {
      "backend-dist/entry.mjs": `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ran"); export function createX() {}\n`,
    }
  });
  const result = await preflightDirectory(dir, { managed: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.requiresRestart, true);
  assert.equal(result.hotSwappable, true);
  assert.equal(fs.existsSync(marker), false, "预检不得执行包内代码");
});

test("preflightDirectory：站点 backend 工厂 requiresRestart=true 但 hotSwappable=false", async () => {
  const dir = managedTree({
    pkg: { exports: { "./backend-dist/entry": "./backend-dist/entry.mjs" } },
    descriptor: { backend: { module: "./backend-dist/entry", factory: "createDefinition" } },
    files: {
      "backend-dist/entry.mjs": "export function createDefinition() { return { extensionId: \"demo\", activate: () => ({ dispose() {} }) }; }\n"
    }
  });
  const result = await preflightDirectory(dir, { managed: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.requiresRestart, true);
  assert.equal(result.hotSwappable, false);
});

test("preflightDirectory：站点 backend 工厂（带 site 段）仍 hotSwappable=false", async () => {
  // 回归：判定曾写成 `Boolean(descriptor.backend && descriptor.site)`，把「带 site 的 backend」
  // 判成可热换，于是受管包装上去会走 runtime.swap 而失败，且不提示重启。
  const dir = managedTree({
    pkg: { exports: { "./backend-dist/entry": "./backend-dist/entry.mjs" } },
    descriptor: {
      backend: { module: "./backend-dist/entry", factory: "createDefinition" },
      site: {
        name: "demo",
        description: "demo",
        version: "1.0.0",
        configSchema: { schemaId: "demo-config", schemaVersion: 1 },
        capabilities: [{ id: "demo.probe", kind: "handler", description: "probe" }],
        defaultEnabled: true
      }
    },
    files: {
      "backend-dist/entry.mjs": "export function createDefinition() { return { extensionId: \"demo\", activate: () => ({ dispose() {} }) }; }\n"
    }
  });
  const result = await preflightDirectory(dir, { managed: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.requiresRestart, true);
  assert.equal(result.hotSwappable, false);
});

test("preflightDirectory：hostPlugin 与 backend 混用 → hotSwappable=false", async () => {
  const dir = managedTree({
    pkg: { exports: { "./backend-dist/entry": "./backend-dist/entry.mjs" } },
    descriptor: {
      backend: { module: "./backend-dist/entry", factory: "createDefinition" },
      hostPlugin: { module: "./backend-dist/entry", factory: "createPlugin", features: ["provider"] }
    },
    files: {
      "backend-dist/entry.mjs": "export function createDefinition() { return { extensionId: \"demo\", activate: () => ({ dispose() {} }) }; }\nexport function createPlugin() { return {}; }\n"
    }
  });
  const result = await preflightDirectory(dir, { managed: true });
  assert.equal(result.requiresRestart, true);
  assert.equal(result.hotSwappable, false);
});

test("preflightDirectory：受管禁止项 bootstrap / canvasContent / 市场来源 / migrate / required / always", async () => {
  const cases = [
    [{ descriptor: { bootstrap: { module: "./bootstrap", export: "b" } } }, "MARKETPLACE_FORBIDDEN_DECLARATION:bootstrap"],
    [{ descriptor: { canvasContent: { module: "./backend", factory: "c" } } }, "MARKETPLACE_FORBIDDEN_DECLARATION:canvasContent"],
    [{ descriptor: { content: { ownedFields: ["sampleContent"] } } }, "MARKETPLACE_FORBIDDEN_DECLARATION:content"],
    [{ descriptor: { hostPlugin: { module: "./backend", factory: "s", features: ["marketplace-source"] } } }, "MARKETPLACE_FORBIDDEN_DECLARATION:hostPlugin.features"],
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
  assert.ok(codesOf(await preflightDirectory(managedTree({ descriptor: { hostPlugin: { module: "./backend", factory: "x", features: ["provider"] } } }), { managed: true })).includes("MARKETPLACE_PREFLIGHT_FAILED:EXTENSION_MODULE_MISSING"));
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
    descriptor: { hostPlugin: { module: "./backend-dist/entry", factory: "createX", features: ["provider"] }, ...descriptor },
    files: {
      "backend-dist/entry.mjs": "export function createX() {}\n",
      ...files
    }
  });
}

test("preflightDirectory：受管 hostPlugin.features 含 storage 被拒绝", async () => {
  const result = await preflightDirectory(backendTree({ descriptor: { hostPlugin: { module: "./backend-dist/entry", factory: "createX", features: ["storage"] } } }), { managed: true });
  assert.ok(codesOf(result).includes("MARKETPLACE_FORBIDDEN_DECLARATION:hostPlugin.features"), codesOf(result).join(", "));
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
    descriptor: { hostPlugin: { module: "./backend", factory: "createX", features: ["provider"] } },
    files: { "dist/backend.js": "export function createX() {}\n" }
  });
  const result = await preflightDirectory(dir, { managed: true });
  assert.ok(codesOf(result).includes("MARKETPLACE_FORBIDDEN_DECLARATION:hostPlugin.module"));
});

test("preflightDirectory：内置根（非受管）不受这些规则影响", async () => {
  const dir = managedTree({
    pkg: { exports: { "./backend": "./dist/backend.js" } },
    descriptor: { hostPlugin: { module: "./backend", factory: "createX", features: ["storage"] } },
    files: { "dist/backend.js": "export function createX() {}\n", "native/x.node": "x" }
  });
  assert.deepEqual((await preflightDirectory(dir)).errors, []);
});

/** 构造一个最小扩展目录，按需放入运行期条目并声明 `files`。 */
function filesFixture({ present, files }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-files-"));
  const pkg = { name: "@woohaa3/extension-x", version: "0.1.0", type: "module" };
  if (files !== undefined) pkg.files = files;
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const entry of present) {
    if (entry.includes(".")) {
      fs.mkdirSync(path.dirname(path.join(dir, entry)), { recursive: true });
      fs.writeFileSync(path.join(dir, entry), "");
    } else {
      fs.mkdirSync(path.join(dir, entry), { recursive: true });
      fs.writeFileSync(path.join(dir, entry, ".keep"), "");
    }
  }
  return dir;
}

test("packageFilesProblems：files 漏写运行期目录时失败，并说清后果", async () => {
  const { packageFilesProblems } = await import("./extensions-preflight.mjs");
  const dir = filesFixture({
    present: ["extension.json", "assets/icon.png", "browser-dist/artifact-manifest.json", "dist", "src"],
    files: ["dist", "src"]
  });
  try {
    const problems = packageFilesProblems([{ extensionId: "demo", dir }]);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].extensionId, "demo");
    // 三条遗漏都要报出来，措辞里点明「pnpm deploy 不会复制」这个根因。
    assert.match(problems[0].message, /extension\.json/);
    assert.match(problems[0].message, /assets/);
    assert.match(problems[0].message, /browser-dist/);
    assert.match(problems[0].message, /pnpm deploy --prod 不会复制/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("packageFilesProblems：声明完整或目录里本就没有该条目时通过", async () => {
  const { packageFilesProblems } = await import("./extensions-preflight.mjs");
  const complete = filesFixture({
    present: ["extension.json", "assets", "browser-dist", "dist"],
    files: ["dist", "browser-dist", "extension.json", "assets"]
  });
  // 后端扩展：没有 assets / browser-dist，只声明存在的条目即可。
  const backendOnly = filesFixture({ present: ["extension.json", "dist"], files: ["dist", "extension.json"] });
  // 无 files 字段：npm 默认打包全部文件，不存在漏复制。
  const noFilesField = filesFixture({ present: ["extension.json", "dist"] });
  try {
    assert.deepEqual(packageFilesProblems([{ extensionId: "complete", dir: complete }]), []);
    assert.deepEqual(packageFilesProblems([{ extensionId: "backend-only", dir: backendOnly }]), []);
    assert.deepEqual(packageFilesProblems([{ extensionId: "no-files", dir: noFilesField }]), []);
  } finally {
    for (const dir of [complete, backendOnly, noFilesField]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 分发版本一致性（change: 2026-11-13-add-extension-version-governance）
// ---------------------------------------------------------------------------

/** 建一个最小扩展目录：extension.json / package.json / 可选 metadata。 */
function versionFixture({ descriptor = {}, pkg = {}, metadata = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-version-"));
  fs.writeFileSync(
    path.join(dir, "extension.json"),
    `${JSON.stringify({ schemaVersion: 1, extensionId: "demo", version: "0.1.0", ...descriptor }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "@woohaa3/extension-demo", version: "0.1.0", type: "module", ...pkg }, null, 2)}\n`
  );
  if (metadata !== null) {
    fs.mkdirSync(path.join(dir, "src/frontend"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/frontend/metadata.ts"), metadata);
  }
  return dir;
}

test("collectPreflightProblems：缺 extension.json.version → EXTENSION_VERSION_MISSING", async () => {
  const dir = versionFixture({ descriptor: { version: undefined } });
  try {
    const host = {
      scan: { extensions: [{ extensionId: "demo", dir }] },
      registrations: [{ extensionId: "demo", directory: dir, descriptor: { site: null }, hasBrowserArtifact: false }]
    };
    const { errors } = collectPreflightProblems(host);
    const version = errors.filter((error) => String(error.code).startsWith("EXTENSION_VERSION"));
    assert.equal(version.length, 1);
    assert.equal(version[0].code, "EXTENSION_VERSION_MISSING");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectPreflightProblems：metadata 字面量与分发版本不一致 → MISMATCH 并指出文件", async () => {
  const dir = versionFixture({ metadata: 'export const M = {\n  version: "0.9.0"\n};\n' });
  try {
    const host = {
      scan: { extensions: [{ extensionId: "demo", dir }] },
      registrations: [{ extensionId: "demo", directory: dir, descriptor: { site: null }, hasBrowserArtifact: false }]
    };
    const { errors } = collectPreflightProblems(host);
    const version = errors.filter((error) => String(error.code).startsWith("EXTENSION_VERSION"));
    assert.equal(version.length, 1);
    assert.equal(version[0].code, "EXTENSION_VERSION_MISMATCH");
    assert.match(version[0].message, /metadata\.version（src\/frontend\/metadata\.ts）是 0\.9\.0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectPreflightProblems：四处一致时无版本问题", async () => {
  const dir = versionFixture({
    descriptor: { site: { name: "n", description: "d", version: "0.1.0", configSchema: { schemaId: "s", schemaVersion: 1 }, capabilities: [{ id: "c", kind: "handler", description: "d" }], defaultEnabled: true } },
    metadata: 'export const M = {\n  version: "0.1.0"\n};\n'
  });
  try {
    const host = {
      scan: { extensions: [{ extensionId: "demo", dir }] },
      registrations: [{ extensionId: "demo", directory: dir, descriptor: { site: {} }, hasBrowserArtifact: false }]
    };
    const { errors } = collectPreflightProblems(host);
    assert.deepEqual(errors.filter((error) => String(error.code).startsWith("EXTENSION_VERSION")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 版本单调性接线（change: 2026-11-13-add-extension-version-governance）
// ---------------------------------------------------------------------------

/** 建一个含扩展目录的临时 git 仓，返回 `{ root, dir, commit }`。 */
function gitVersionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-bump-"));
  fs.writeFileSync(path.join(root, "extensions.config.json"), JSON.stringify({ schemaVersion: 1, roots: ["extensions"] }));
  const dir = path.join(root, "extensions", "demo");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "extension.json"), `${JSON.stringify({ schemaVersion: 1, extensionId: "demo", version: "0.1.0" }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "@woohaa3/extension-demo", version: "0.1.0", type: "module" }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "src", "backend.ts"), "export const x = 1;\n");
  const run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "test"]);
  run(["add", "."]);
  run(["commit", "-qm", "init"]);
  return { root, dir, run };
}

test("版本单调性：改了源码但版本未变 → EXTENSION_VERSION_NOT_BUMPED 告警", async () => {
  const { root, dir } = gitVersionFixture();
  try {
    fs.appendFileSync(path.join(dir, "src", "backend.ts"), "export const y = 2;\n");
    const host = {
      repoRoot: root,
      scan: { extensions: [{ extensionId: "demo", dir }] },
      registrations: [{ extensionId: "demo", directory: dir, descriptor: { site: null }, hasBrowserArtifact: false }]
    };
    const { errors, warnings } = collectPreflightProblems(host, { bumpBase: "HEAD" });
    assert.deepEqual(errors.filter((e) => String(e.code).startsWith("EXTENSION_VERSION")), []);
    const bump = warnings.filter((w) => w.code === "EXTENSION_VERSION_NOT_BUMPED");
    assert.equal(bump.length, 1, JSON.stringify(warnings));
    assert.match(bump[0].message, /ext:bump demo --patch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("版本单调性：改了源码同时推进版本 → 不告警", async () => {
  const { root, dir } = gitVersionFixture();
  try {
    fs.appendFileSync(path.join(dir, "src", "backend.ts"), "export const y = 2;\n");
    const file = path.join(dir, "extension.json");
    const descriptor = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, `${JSON.stringify({ ...descriptor, version: "0.1.1" }, null, 2)}\n`);
    const pkgFile = path.join(dir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    fs.writeFileSync(pkgFile, `${JSON.stringify({ ...pkg, version: "0.1.1" }, null, 2)}\n`);

    const host = {
      repoRoot: root,
      scan: { extensions: [{ extensionId: "demo", dir }] },
      registrations: [{ extensionId: "demo", directory: dir, descriptor: { site: null }, hasBrowserArtifact: false }]
    };
    const { warnings } = collectPreflightProblems(host, { bumpBase: "HEAD" });
    assert.deepEqual(warnings.filter((w) => w.code === "EXTENSION_VERSION_NOT_BUMPED"), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("版本单调性：非法基线 → 失败并指出该 rev，不静默跳过", async () => {
  const { root, dir } = gitVersionFixture();
  try {
    const host = {
      repoRoot: root,
      scan: { extensions: [{ extensionId: "demo", dir }] },
      registrations: [{ extensionId: "demo", directory: dir, descriptor: { site: null }, hasBrowserArtifact: false }]
    };
    const { errors } = collectPreflightProblems(host, { bumpBase: "no-such-rev" });
    const invalid = errors.filter((e) => e.code === "EXTENSION_VERSION_NOT_BUMPED");
    assert.equal(invalid.length, 1);
    assert.match(invalid[0].message, /no-such-rev/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("默认基线是 HEAD：不带 --bump-base 也检查「改了没 bump」", async () => {
  // 守的是「检查要么默认开、要么实际没人用」：如果只有显式传 `--bump-base` 才检查，
  // agent 与开发者跑的默认命令就永远不触发它。
  const { root, dir } = gitVersionFixture();
  try {
    fs.appendFileSync(path.join(dir, "src", "backend.ts"), "export const y = 2;\n");
    const host = {
      repoRoot: root,
      scan: { extensions: [{ extensionId: "demo", dir }] },
      registrations: [{ extensionId: "demo", directory: dir, descriptor: { site: null }, hasBrowserArtifact: false }]
    };
    // 显式复现 CLI 的缺省解析：不传 --bump-base 时应等价于 bumpBase: "HEAD"。
    const explicit = collectPreflightProblems(host, { bumpBase: "HEAD" });
    const bumpWarnings = explicit.warnings.filter((w) => w.code === "EXTENSION_VERSION_NOT_BUMPED");
    assert.equal(bumpWarnings.length, 1, "基线是 HEAD 时应报告未 bump");
    assert.match(bumpWarnings[0].message, /ext:bump demo --patch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("agent 视角演练：改了扩展源码 → 默认命令报告并给出 bump 命令", async () => {
  // 完整复现 agent 的真实路径：它只会跑 `pnpm extensions:check`，不会自己记得 bump。
  // 这里断言两件事：门禁确实拦下，且消息里带可执行的下一步。
  const { root, dir, run } = gitVersionFixture();
  try {
    // 让 HEAD 上有 version（模拟本次 change 提交后的正常状态）。
    fs.appendFileSync(path.join(dir, "src", "backend.ts"), "export const changed = true;\n");
    run(["add", "-A"]);
    run(["commit", "-qm", "feat: 改了扩展"]);

    const host = {
      repoRoot: root,
      scan: { extensions: [{ extensionId: "demo", dir }] },
      registrations: [{ extensionId: "demo", directory: dir, descriptor: { site: null }, hasBrowserArtifact: false }]
    };
    const clean = collectPreflightProblems(host, { bumpBase: "HEAD" });
    assert.deepEqual(clean.warnings.filter((w) => w.code === "EXTENSION_VERSION_NOT_BUMPED"), [], "已提交的改动不该被报");

    // agent 继续改同一个扩展，但没 bump。
    fs.appendFileSync(path.join(dir, "src", "backend.ts"), "export const more = 1;\n");
    const dirty = collectPreflightProblems(host, { bumpBase: "HEAD" });
    const reported = dirty.warnings.filter((w) => w.code === "EXTENSION_VERSION_NOT_BUMPED");
    assert.equal(reported.length, 1);
    assert.match(reported[0].message, /pnpm ext:bump demo --patch/, "必须给出可直接执行的修复命令");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 受管预检：能力依赖不相容必须拒绝安装
// （change: 2026-11-13-add-extension-capability-abi）
// ---------------------------------------------------------------------------

/** 建一个可打包的受管扩展目录，`engines` 决定依赖声明。 */
function engineFixture(enginesExtra, id) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-engines-"));
  fs.mkdirSync(path.join(dir, "backend-dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "backend-dist", "entry.mjs"), "export function createDemo() {}\n");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: `@woohaa3/extension-${id}`, version: "1.0.0", type: "module", exports: { "./backend-dist/entry": "./backend-dist/entry.mjs" } })
  );
  fs.writeFileSync(
    path.join(dir, "extension.json"),
    JSON.stringify({
      schemaVersion: 1,
      extensionId: id,
      version: "1.0.0",
      engines: { hostAbi: "^1.0.0", sdkAbi: "^1.0.0", protocolVersion: 1, ...enginesExtra },
      hostPlugin: { module: "./backend-dist/entry", factory: "createDemo" }
    })
  );
  return dir;
}

test("受管预检：服务面版本高于宿主 → 拒绝安装并指出两侧版本", async () => {
  const dir = engineFixture({ host: { generation: 2 } }, "demo-eng-a");
  try {
    const result = await preflightDirectory(dir, { managed: true });
    assert.equal(result.ok, false);
    const hit = result.errors.find((error) => error.code === "MARKETPLACE_ENGINES_INCOMPATIBLE");
    assert.ok(hit, JSON.stringify(result.errors));
    assert.match(hit.message, /需要 generation@2，宿主提供 1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("受管预检：capability 依赖不可解析 → 拒绝安装", async () => {
  const dir = engineFixture({ capabilities: { "adapter:x": 1 } }, "demo-eng-b");
  try {
    const result = await preflightDirectory(dir, { managed: true });
    assert.equal(result.ok, false);
    const hit = result.errors.find((error) => error.code === "MARKETPLACE_ENGINES_INCOMPATIBLE");
    assert.ok(hit, JSON.stringify(result.errors));
    assert.match(hit.message, /adapter:x@1 在当前宿主解析不到/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("受管预检：依赖相容的包正常通过", async () => {
  const dir = engineFixture({ host: { generation: 1 } }, "demo-eng-c");
  try {
    const result = await preflightDirectory(dir, { managed: true });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
