/**
 * 启动期扩展宿主单测
 * （change: 2026-10-15-add-scannable-extension-directories，任务 3.1–3.3 / design D1–D3）。
 *
 * 运行：`node --test scripts/lib/extension-host.test.mjs`
 *
 * 覆盖：正常加载（后端清单/站点目录/公开路由/browser 产物）、optional 语义、导出缺失、
 * identity 不符、`..` 与软链逃逸、非相对子路径、声明非法、跨根重复 identity、不部分注册。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ExtensionLoadError, hostSummary, loadExtensionHost, resolveModuleFile, untrustedRootViolation } from "./extension-host.mjs";
import { MANAGED_DIR_ENV, managedLayout, openInstallations } from "./extension-installations.mjs";
import { sha256Hex } from "./extension-release-catalog.mjs";
import { loadExtensionContracts } from "./extension-release-protocol.mjs";

const contracts = await loadExtensionContracts();

/**
 * 写一份**合法**的已构建 browser artifact（宿主会在启动期构建发布目录并校验，
 * 因此夹具不能只放一个空 manifest）。
 */
function writeValidBrowserArtifact(dir, extensionId, { sdkAbi = contracts.EXTENSION_SDK_ABI_VERSION, reactMajor = contracts.HOST_REACT_MAJOR } = {}) {
  const entryName = "entry.js";
  const bytes = Buffer.from("export default {};\n", "utf8");
  fs.mkdirSync(path.join(dir, "browser-dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "browser-dist", entryName), bytes);
  const manifest = {
    schemaVersion: contracts.EXTENSION_BROWSER_PROTOCOL_VERSION,
    artifactId: sha256Hex(bytes),
    metadata: {
      extensionId,
      version: "1.0.0",
      label: `${extensionId} 标签`,
      description: `${extensionId} 描述`,
      activation: "server-active",
      configScope: "site",
      required: false,
      sdkAbi
    },
    protocolVersion: contracts.EXTENSION_BROWSER_PROTOCOL_VERSION,
    sdkAbi,
    reactMajor,
    entry: entryName,
    styles: [],
    requiredSdkGroups: ["core"],
    requiredSdkExports: ["defineExtensionPlugin"],
    imports: [],
    files: [{ path: entryName, bytes: bytes.length, gzipBytes: 0, sha256: sha256Hex(bytes), kind: "entry" }]
  };
  fs.writeFileSync(path.join(dir, "browser-dist", "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** 建一个临时仓库；两个根默认都存在。 */
function makeRepo({ config = { schemaVersion: 1, roots: ["rootA", "rootB"] } } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "extension-host-"));
  fs.mkdirSync(path.join(repoRoot, "rootA"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "rootB"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "extensions.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  return repoRoot;
}

/** 写一个扩展目录（`root` 相对 repoRoot）。 */
function writeExtension(repoRoot, root, directory, {
  packageName,
  descriptor,
  packageExports,
  backendSource,
  sharedSource,
  browserArtifact = false,
  extraFiles = {}
} = {}) {
  const dir = path.join(repoRoot, root, directory);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  const name = packageName ?? `@woohaa3/extension-${directory}`;
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: "0.1.0",
        type: "module",
        exports: packageExports ?? {
          "./backend": { import: "./dist/backend.js" },
          "./shared": { import: "./dist/shared.js" }
        }
      },
      null,
      2
    )}\n`
  );
  if (descriptor) fs.writeFileSync(path.join(dir, "extension.json"), `${JSON.stringify(descriptor, null, 2)}\n`);
  if (backendSource !== undefined) fs.writeFileSync(path.join(dir, "dist", "backend.js"), backendSource);
  if (sharedSource !== undefined) fs.writeFileSync(path.join(dir, "dist", "shared.js"), sharedSource);
  for (const [relative, contents] of Object.entries(extraFiles)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  if (browserArtifact) {
    writeValidBrowserArtifact(dir, descriptor?.extensionId ?? directory);
  }
  return dir;
}

const backendFactory = (extensionId, { factoryName = `create${extensionId}Extension`, returnedId = extensionId } = {}) =>
  `export function ${factoryName}(options = {}) {\n  return { extensionId: "${returnedId}", options, activate: () => ({}) };\n}\n`;

const metadataExport = (extensionId, exportName) =>
  `export const ${exportName} = { extensionId: "${extensionId}" };\n`;

const siteBlock = (extensionId, order = 10) => ({
  name: `${extensionId} 名称`,
  description: `${extensionId} 描述`,
  version: "1.0.0",
  configSchema: { schemaId: `${extensionId}-config`, schemaVersion: 1 },
  capabilities: [{ id: `${extensionId}.me`, kind: "handler", description: "当前用户", auth: "authenticated" }],
  defaultEnabled: true,
  order
});

test("加载声明：后端清单、站点目录、公开路由与 browser 产物", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "alpha", {
    descriptor: {
      schemaVersion: 1,
      extensionId: "alpha",
      site: siteBlock("alpha", 30),
      backend: { module: "./backend", factory: "createAlphaExtension", order: 50 },
      publicRoutes: [{ publicPath: "/api/extensions/alpha/site", route: "alpha/site", methods: ["GET"] }]
    },
    backendSource: backendFactory("alpha", { factoryName: "createAlphaExtension" }),
    browserArtifact: true
  });
  writeExtension(repoRoot, "rootB", "beta", {
    descriptor: {
      schemaVersion: 1,
      extensionId: "beta",
      backend: { module: "./backend", factory: "createBetaExtension", order: 10 },
      metadata: { module: "./shared", export: "BETA_METADATA", order: 10 }
    },
    backendSource: backendFactory("beta", { factoryName: "createBetaExtension" }),
    sharedSource: metadataExport("beta", "BETA_METADATA")
  });

  const host = await loadExtensionHost({ repoRoot, env: {} });
  assert.deepEqual(host.roots.map((root) => path.relative(repoRoot, root)), ["rootA", "rootB"]);
  assert.deepEqual(host.siteExtensionIds, ["alpha"]);
  assert.deepEqual(host.siteEntries[0].frontendEntry, true);
  // metadata = provider metadata（按声明 order）+ 站点目录条目。
  assert.deepEqual(host.metadata.map((entry) => entry.extensionId), ["beta", "alpha"]);

  const definitions = await host.createDefinitions({});
  // 顺序按声明 order：beta(10) 在 alpha(50) 之前。
  assert.deepEqual(definitions.map((definition) => definition.extensionId), ["beta", "alpha"]);
  assert.deepEqual(host.publicRoutes, [
    { extensionId: "alpha", publicPath: "/api/extensions/alpha/site", route: "alpha/site", methods: ["GET"] }
  ]);
  assert.deepEqual(host.browserArtifacts.map((artifact) => artifact.extensionId), ["alpha"]);
});

test("目录卸载保留当前发布资源，重启后前后端都从装配清单移除", async () => {
  // 目录只表达「装没装」：卸载后当前进程仍托管已发布资源，下一次启动不再扫描到。
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "sample", {
    descriptor: { schemaVersion: 1, extensionId: "sample", site: siteBlock("sample"), backend: { module: "./backend", factory: "createsampleExtension" } },
    backendSource: backendFactory("sample"), browserArtifact: true
  });
  const host = await loadExtensionHost({ repoRoot, env: { WOOHAA3_EXTENSION_WRITABLE_DIRS: path.join(repoRoot, "rootA") } });
  assert.equal((await host.createDefinitions({})).length, 1);
  host.directoryControl.setInstalled("sample", false);
  assert.deepEqual(host.directoryControl.list(), []);
  for (const file of host.browserRelease.files.values()) {
    assert.ok(file.includes(`${path.sep}.sample${path.sep}`));
    assert.ok(fs.existsSync(file));
  }
  const restarted = await loadExtensionHost({ repoRoot, env: {} });
  assert.deepEqual(await restarted.createDefinitions({}), []);
  assert.deepEqual(restarted.browserRelease.entries, []);
  assert.deepEqual(restarted.directoryControl.list(), []);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test("非可写根不允许为扩展安装/卸载改目录", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "sample", {
    descriptor: { schemaVersion: 1, extensionId: "sample", site: siteBlock("sample") }
  });
  const host = await loadExtensionHost({ repoRoot, env: {} });
  assert.throws(() => host.directoryControl.setInstalled("sample", false), (error) => error.code === 'EXTENSION_DIRECTORY_READONLY');
  assert.ok(fs.existsSync(path.join(repoRoot, "rootA", "sample")));
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test("展示目录来自实际扫描位置，移动目录后同步更新且不改变 artifact", async () => {
  const repoRoot = makeRepo();
  const directory = writeExtension(repoRoot, "rootA", "original-folder", {
    descriptor: { schemaVersion: 1, extensionId: "sample", site: siteBlock("sample") },
    browserArtifact: true
  });
  const first = await loadExtensionHost({ repoRoot, env: {} });
  assert.equal(first.siteEntries[0].directory, directory);
  assert.equal(first.browserRelease.entries[0].metadata.directory, directory);
  const moved = path.join(repoRoot, "rootB", "moved-folder");
  fs.renameSync(directory, moved);
  const second = await loadExtensionHost({ repoRoot, env: {} });
  assert.equal(second.siteEntries[0].directory, moved);
  assert.equal(second.browserRelease.entries[0].metadata.directory, moved);
  assert.equal(first.browserRelease.entries[0].artifactId, second.browserRelease.entries[0].artifactId);
  assert.notEqual(first.browserRelease.releaseId, second.browserRelease.releaseId);
  assert.ok(path.isAbsolute(second.siteEntries[0].directory));
  assert.ok(path.isAbsolute(second.browserRelease.entries[0].metadata.directory));
});

test("publicPathExport 从扩展模块读值，非法值失败", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "gamma", {
    descriptor: {
      schemaVersion: 1,
      extensionId: "gamma",
      backend: { module: "./backend", factory: "creategammaExtension", order: 10 },
      publicRoutes: [{ publicPathExport: "GAMMA_BASE", module: "./shared", route: "gamma", methods: ["GET"] }]
    },
    backendSource: backendFactory("gamma"),
    sharedSource: 'export const GAMMA_BASE = "/api/extensions/gamma";\n'
  });
  const host = await loadExtensionHost({ repoRoot, env: {} });
  assert.equal(host.publicRoutes[0].publicPath, "/api/extensions/gamma");
});

test("optional 扩展：宿主未提供依赖时不登记，提供时登记", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "delta", {
    descriptor: {
      schemaVersion: 1,
      extensionId: "delta",
      backend: { module: "./backend", factory: "createdeltaExtension", optional: true, order: 10 }
    },
    backendSource: backendFactory("delta")
  });
  const host = await loadExtensionHost({ repoRoot, env: {} });
  assert.deepEqual(await host.createDefinitions({}), []);
  const withDeps = await host.createDefinitions({ delta: { env: {} } });
  assert.deepEqual(withDeps.map((definition) => definition.extensionId), ["delta"]);
});

test("导出缺失：metadata 导出不存在时失败", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "epsilon", {
    descriptor: {
      schemaVersion: 1,
      extensionId: "epsilon",
      backend: { module: "./backend", factory: "createepsilonExtension", order: 10 },
      metadata: { module: "./shared", export: "MISSING_METADATA", order: 10 }
    },
    backendSource: backendFactory("epsilon"),
    sharedSource: metadataExport("epsilon", "EPSILON_METADATA")
  });
  await assert.rejects(
    () => loadExtensionHost({ repoRoot, env: {} }),
    (error) => error instanceof ExtensionLoadError && error.code === "EXTENSION_EXPORT_MISSING"
  );
});

test("后端工厂导出不是函数：失败", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "zeta", {
    descriptor: { schemaVersion: 1, extensionId: "zeta", backend: { module: "./backend", factory: "createzetaExtension", order: 10 } },
    backendSource: "export const createzetaExtension = 42;\n"
  });
  const host = await loadExtensionHost({ repoRoot, env: {} });
  await assert.rejects(
    () => host.createDefinitions({}),
    (error) => error instanceof ExtensionLoadError && error.code === "EXTENSION_EXPORT_INVALID"
  );
});

test("工厂 identity 与声明不一致：失败", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "eta", {
    descriptor: { schemaVersion: 1, extensionId: "eta", backend: { module: "./backend", factory: "createEtaExtension", order: 10 } },
    backendSource: backendFactory("eta", { factoryName: "createEtaExtension", returnedId: "other-id" })
  });
  const host = await loadExtensionHost({ repoRoot, env: {} });
  await assert.rejects(
    () => host.createDefinitions({}),
    (error) => error instanceof ExtensionLoadError && error.code === "EXTENSION_IDENTITY_MISMATCH"
  );
});

test("metadata identity 与声明不一致：失败", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "theta", {
    descriptor: {
      schemaVersion: 1,
      extensionId: "theta",
      metadata: { module: "./shared", export: "THETA_METADATA", order: 10 }
    },
    sharedSource: metadataExport("other-id", "THETA_METADATA")
  });
  await assert.rejects(
    () => loadExtensionHost({ repoRoot, env: {} }),
    (error) => error instanceof ExtensionLoadError && error.code === "EXTENSION_IDENTITY_MISMATCH"
  );
});

test("exports 目标不是包内相对路径：失败", async () => {
  const repoRoot = makeRepo();
  fs.writeFileSync(path.join(repoRoot, "outside.js"), "export const x = 1;\n");
  writeExtension(repoRoot, "rootA", "iota", {
    descriptor: { schemaVersion: 1, extensionId: "iota", backend: { module: "./backend", factory: "createiotaExtension", order: 10 } },
    packageExports: { "./backend": { import: "../../outside.js" } },
    backendSource: backendFactory("iota")
  });
  await assert.rejects(
    () => loadExtensionHost({ repoRoot, env: {} }),
    (error) => error instanceof ExtensionLoadError && error.code === "EXTENSION_MODULE_INVALID"
  );
});

test("软链逃出扩展目录：失败", async () => {
  const repoRoot = makeRepo();
  const outsideFile = path.join(repoRoot, "outside-target.js");
  fs.writeFileSync(outsideFile, backendFactory("kappa"));
  const dir = writeExtension(repoRoot, "rootA", "kappa", {
    descriptor: { schemaVersion: 1, extensionId: "kappa", backend: { module: "./escaped", factory: "createkappaExtension", order: 10 } },
    packageExports: { "./escaped": { import: "./escaped.js" } }
  });
  fs.symlinkSync(outsideFile, path.join(dir, "escaped.js"));
  await assert.rejects(
    () => loadExtensionHost({ repoRoot, env: {} }),
    (error) => error instanceof ExtensionLoadError && error.code === "EXTENSION_MODULE_ESCAPES_DIR"
  );
});

test("非包内相对子路径：resolveModuleFile 直接拒绝", () => {
  const repoRoot = makeRepo();
  const dir = writeExtension(repoRoot, "rootA", "lambda", { descriptor: null });
  for (const bad of [
    "https://evil.example/x.js",
    "//evil.example/x.js",
    "javascript:alert(1)",
    "data:text/javascript,export default 1",
    "/abs/path.js",
    "../outside.js",
    "backend.js",
    "./a/../../outside.js"
  ]) {
    assert.throws(
      () => resolveModuleFile(dir, bad, { extensionId: "lambda" }),
      (error) => error instanceof ExtensionLoadError && error.code === "EXTENSION_MODULE_INVALID",
      `应拒绝：${bad}`
    );
  }
});

test("加载实现不含 eval / new Function（无动态代码执行面）", async () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  for (const relative of ["scripts/lib/extension-host.mjs", "scripts/lib/extension-host-modules.mjs", "scripts/lib/extension-host-managed.mjs", "scripts/lib/extension-host-safe-mode.mjs", "scripts/lib/extension-host-release.mjs", "scripts/lib/extension-release-catalog.mjs", "scripts/lib/extension-descriptor.mjs"]) {
    const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    assert.doesNotMatch(source, /(^|[^.\w])eval\s*\(/, `${relative} 不得使用 eval`);
    assert.doesNotMatch(source, /new\s+Function\s*\(/, `${relative} 不得使用 new Function`);
    // 也不得接受「非包内相对子路径」以外的加载手段：不允许直接 import 运行时计算出的裸标识符。
    assert.doesNotMatch(source, /require\s*\(/, `${relative} 不得回退到 require 动态解析`);
  }
});

test("声明给出 URL 模块地址：声明校验拒绝", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "mu", {
    descriptor: { schemaVersion: 1, extensionId: "mu", backend: { module: "https://evil.example/x.js", factory: "createmuExtension", order: 10 } },
    backendSource: backendFactory("mu")
  });
  await assert.rejects(
    () => loadExtensionHost({ repoRoot, env: {} }),
    (error) => error.code === "EXTENSION_DESCRIPTOR_INVALID"
  );
});

test("模块文件缺失：提示先构建", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "nu", {
    descriptor: { schemaVersion: 1, extensionId: "nu", backend: { module: "./backend", factory: "createnuExtension", order: 10 } }
  });
  await assert.rejects(
    () => loadExtensionHost({ repoRoot, env: {} }),
    (error) => error instanceof ExtensionLoadError && error.code === "EXTENSION_MODULE_MISSING"
  );
});

test("跨根重复 extensionId：失败并指出两个目录", async () => {
  const repoRoot = makeRepo();
  const descriptor = { schemaVersion: 1, extensionId: "same-id", backend: { module: "./backend", factory: "createSameIdExtension", order: 10 } };
  writeExtension(repoRoot, "rootA", "one", { descriptor, backendSource: backendFactory("same-id", { factoryName: "createSameIdExtension" }) });
  writeExtension(repoRoot, "rootB", "two", { descriptor, backendSource: backendFactory("same-id", { factoryName: "createSameIdExtension" }) });
  await assert.rejects(
    () => loadExtensionHost({ repoRoot, env: {} }),
    (error) => error.code === "EXTENSION_ID_DUPLICATE" && error.message.includes("rootA/one") && error.message.includes("rootB/two")
  );
});

test("站点目录未通过 contracts 校验：失败", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "xi", {
    descriptor: {
      schemaVersion: 1,
      extensionId: "xi",
      site: { ...siteBlock("xi"), capabilities: [] }
    },
    backendSource: backendFactory("xi")
  });
  await assert.rejects(() => loadExtensionHost({ repoRoot, env: {} }));
});

test("`. ` 前缀目录不参与加载", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", ".disabled-ext", {
    descriptor: { schemaVersion: 1, extensionId: "disabled-ext", backend: { module: "./backend", factory: "createDisabledExtExtension", order: 10 } },
    backendSource: backendFactory("disabled-ext", { factoryName: "createDisabledExtExtension" })
  });
  const host = await loadExtensionHost({ repoRoot, env: {} });
  assert.deepEqual(host.registrations, []);
  assert.deepEqual(host.disabled.map((entry) => entry.directory), [".disabled-ext"]);
});

test("hostSummary 只含身份/目录/原因，不含秘密", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "omicron", {
    descriptor: { schemaVersion: 1, extensionId: "omicron", backend: { module: "./backend", factory: "createOmicronExtension", order: 10 } },
    backendSource: backendFactory("omicron", { factoryName: "createOmicronExtension" })
  });
  const host = await loadExtensionHost({ repoRoot, env: {} });
  const { hostSummary } = await import("./extension-host.mjs");
  const summary = hostSummary(host);
  assert.equal(summary.event, "extension-host-loaded");
  assert.deepEqual(summary.loaded.map((entry) => entry.extensionId), ["omicron"]);
  assert.ok(!("rootA/omicron/extension.json" in summary));
});

/**
 * 真实仓库锚点：运行期宿主对当前仓库的产出必须与既有声明一致
 * （definitions 顺序、站点目录顺序、provider metadata 顺序、公开路由）。
 * 这些锚点原由构建期生成物聚合包保证；改为启动期宿主后在此锁定。
 *
 * 集成分支现状（change: 2026-10-06-unify-backend-runtime-with-cordis）：外部 Provider /
 * `tokenhub-provider` / `replicate-provider` / `fal-provider` / `grsai-provider` /
 * `runninghub-provider` / `ark-provider` 已从「`extension.json` 声明后端工厂 + `createDefinitions`」
 * 改为扩展层的 **Cordis 插件**（`web/backend/src/host/extensions/providers.ts` 静态注册）。它们的
 * `extension.json` 仍保留旧的 `backend` 声明（metadata 仍从这里取），但 `dist/backend.js` 不再导出
 * `createLiteLLMExtension` / `createTokenHubExtension` / `createReplicateExtension` / `createFalExtension` /
 * `createGrsaiExtension` / `createRunningHubExtension` / `createArkExtension`。
 *
 * 因此本锚点按**当前真能产出定义的扩展**取期望：先用同一个 `backend.factory` 导出探针筛出候选，
 * 再断言 `createDefinitions` 的产出与候选一致；不复活已废弃的旧工厂。`manifest.ts` 也明写宿主只
 * 消费 `slotEntries` / `createSlotDeclarations`，`createDefinitions` 只服务静态可信清单之外的路径。
 */
test("真实仓库锚点：宿主产出与声明顺序一致", async () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  const host = await loadExtensionHost({ repoRoot, env: {} });
  const allRegistrations = [...host.registrations];
  const installed = id => allRegistrations.some(entry => entry.extensionId === id);
  // 探针：只有 dist 里真的导出了 `backend.factory` 的扩展才可能产出定义。Provider 已是 Cordis
  // 插件（导出 `createXxxProviderPlugin`），旧工厂名不再存在 —— 用它把候选与「已迁走」分开。
  const factoryBacked = [];
  const cordisOnly = [];
  for (const registration of allRegistrations) {
    if (!registration.backend) continue;
    // `optional: true` 的扩展在宿主未提供依赖时不登记（需要部署绑定的可选扩展）。
    if (registration.backend.optional) continue;
    const module = await import(registration.backend.module);
    (typeof module[registration.backend.factory] === "function" ? factoryBacked : cordisOnly).push(registration.extensionId);
  }
  // `createDefinitions` 对仍声明了 `backend` 但导出缺失的扩展会抛 EXTENSION_EXPORT_INVALID。
  // 集成分支里那不是回归：这些扩展已改成 Cordis 插件、不再走 definitions 路径。这里按「当前真能
  // 产出定义的扩展」构造输入，断言产出与候选完全一致（仍会校验 identity/顺序）。
  host.registrations.splice(0, host.registrations.length, ...allRegistrations.filter(entry => factoryBacked.includes(entry.extensionId)));
  const definitions = await host.createDefinitions({});
  assert.deepEqual(definitions.map((definition) => definition.extensionId), factoryBacked, "createDefinitions 产出应与带可调用 backend 工厂的扩展一致");
  assert.ok(cordisOnly.every(id => !definitions.some(definition => definition.extensionId === id)), "已改为 Cordis 插件的扩展不得再产出后端定义");
  assert.ok(host.siteExtensionIds.every(installed), "站点扩展必须来自扫描登记");
  assert.ok(host.metadata.every(entry => installed(entry.extensionId)), "公开元数据必须来自扫描登记");
  assert.ok(host.publicRoutes.every(route => installed(route.extensionId)), "公开路由必须来自扫描登记");
  // 两个配置根都参与了扫描。开源检出里 `extensions/` 只带 README（私有扩展不随公开仓发布），
  // 此时不能强求第二个根产出登记；存在已安装扩展目录时才校验登记归属。
  const secondRoot = path.join(repoRoot, "extensions");
  const hasSecondRootExtensions = fs.existsSync(secondRoot) && fs.readdirSync(secondRoot, { withFileTypes: true })
    .some((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  if (hasSecondRootExtensions) {
    assert.ok(allRegistrations.some((registration) => path.dirname(registration.directory) === secondRoot));
  }
  assert.ok(host.roots.length >= 2);
});

// ---------------------------------------------------------------------------
// 槽位实现声明（change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，
// 任务 2.2、2.3、5.2 / design D2、D5）
// ---------------------------------------------------------------------------

/** 声明一个槽位实现扩展：`factoryBody` 是工厂函数体（返回值即声明）。 */
function writeSlotExtension(repoRoot, root, extensionId, { factoryName = "createBootstrap", factoryBody, module = "./bootstrap" } = {}) {
  return writeExtension(repoRoot, root, extensionId, {
    descriptor: { schemaVersion: 1, extensionId, bootstrap: { module, export: factoryName } },
    packageExports: { [module]: { import: "./dist/bootstrap.js" } },
    extraFiles: { "dist/bootstrap.js": `export function ${factoryName}(input = {}) {\n${factoryBody}\n}\n` }
  });
}

const slotDeclaration = (extensionId, slot, { requires = [] } = {}) =>
  `  return { extensionId: "${extensionId}", providers: [{ slot: "${slot}", requires: ${JSON.stringify(requires)}, create: async () => ({ value: { ${extensionId.replace(/-/g, "_")}: true } }) }] };`;

test("槽位声明：扫描收集入口，调用工厂返回声明，并透传宿主注入的选项", async () => {
  const repoRoot = makeRepo();
  writeSlotExtension(repoRoot, "rootA", "sqlite-storage", { factoryBody: slotDeclaration("sqlite-storage", "storage") });
  writeSlotExtension(repoRoot, "rootB", "fixture-access", {
    factoryBody: `  return { extensionId: "fixture-access", providers: [\n    { slot: "identity", requires: [], create: async () => ({ value: {} }) },\n    { slot: "access", requires: ["identity"], create: async () => ({ value: { options: input.options, extensionIds: input.extensionIds } }) }\n  ] };`
  });

  const host = await loadExtensionHost({ repoRoot, env: {}, logger: () => undefined });
  assert.deepEqual(host.slotEntries.map((entry) => entry.extensionId), ["fixture-access", "sqlite-storage"]);
  assert.deepEqual(host.slotEntries.map((entry) => entry.rootWritable), [false, false]);

  const declarations = await host.createSlotDeclarations({ "fixture-access": { mode: "local" } });
  assert.deepEqual(declarations.map((entry) => entry.extensionId), ["fixture-access", "sqlite-storage"]);
  assert.deepEqual(declarations[0].providers.map((provider) => provider.slot), ["identity", "access"]);
  // 工厂拿到的 options 就是宿主按 extensionId 注入的对象。
  const access = await declarations[0].providers[1].create();
  assert.deepEqual(access.value.options, { mode: "local" });
  assert.deepEqual(new Set(access.value.extensionIds), new Set(["sqlite-storage", "fixture-access"]));

  // 诊断摘要只含 extensionId/目录/根/工厂，可用于 `extensions:check` 输出。
  const summary = hostSummary(host);
  assert.deepEqual(summary.slots.map((slot) => [slot.extensionId, slot.export, slot.rootWritable]), [
    ["fixture-access", "createBootstrap", false],
    ["sqlite-storage", "createBootstrap", false]
  ]);
});

test("槽位声明：可写根里的 bootstrap 声明被拒绝（EXTENSION_SLOT_WRITABLE_ROOT）", async () => {
  const repoRoot = makeRepo({ config: { schemaVersion: 1, roots: ["rootA", { path: "rootB", writable: true }] } });
  writeSlotExtension(repoRoot, "rootB", "sqlite-storage", { factoryBody: slotDeclaration("sqlite-storage", "storage") });
  await assert.rejects(
    () => loadExtensionHost({ repoRoot, env: {}, logger: () => undefined }),
    (error) => error instanceof ExtensionLoadError && error.code === "EXTENSION_SLOT_WRITABLE_ROOT" && /可写扩展根/.test(error.message)
  );
});

test("槽位声明：普通根里的其它扩展仍可加载（可写根限制只针对 slot）", async () => {
  const repoRoot = makeRepo({ config: { schemaVersion: 1, roots: ["rootA", { path: "rootB", writable: true }] } });
  writeExtension(repoRoot, "rootB", "dropped-in", {
    descriptor: { schemaVersion: 1, extensionId: "dropped-in" },
    sharedSource: metadataExport("dropped-in", "DROPPED_IN_METADATA")
  });
  const host = await loadExtensionHost({ repoRoot, env: {}, logger: () => undefined });
  assert.deepEqual(host.slotEntries, []);
  assert.deepEqual(host.registrations.map((entry) => entry.extensionId), ["dropped-in"]);
});

test("槽位声明：工厂导出缺失、identity 不符、槽位名未知、声明缺字段、重复实现、未知依赖、依赖成环都 fail-fast", async () => {
  const cases = [
    {
      name: "导出缺失",
      code: "EXTENSION_EXPORT_MISSING",
      setup: (repoRoot) => writeExtension(repoRoot, "rootA", "sqlite-storage", {
        descriptor: { schemaVersion: 1, extensionId: "sqlite-storage", bootstrap: { module: "./bootstrap", export: "createMissing" } },
        packageExports: { "./bootstrap": { import: "./dist/bootstrap.js" } },
        extraFiles: { "dist/bootstrap.js": "export const CREATE_OTHER = () => ({ extensionId: \"sqlite-storage\", providers: [] });\n" }
      })
    },
    {
      name: "identity 不符",
      code: "EXTENSION_IDENTITY_MISMATCH",
      setup: (repoRoot) => writeSlotExtension(repoRoot, "rootA", "sqlite-storage", { factoryBody: slotDeclaration("other-extension", "storage") })
    },
    {
      name: "槽位名未知",
      code: "EXTENSION_SLOT_UNKNOWN",
      setup: (repoRoot) => writeSlotExtension(repoRoot, "rootA", "sqlite-storage", { factoryBody: slotDeclaration("sqlite-storage", "cache") })
    },
    {
      name: "声明缺 create",
      code: "EXTENSION_SLOT_DECLARATION_INVALID",
      setup: (repoRoot) => writeSlotExtension(repoRoot, "rootA", "sqlite-storage", {
        factoryBody: `  return { extensionId: "sqlite-storage", providers: [{ slot: "storage", requires: [] }] };`
      })
    },
    // 槽位图（任务 2.3）：重复实现、未知依赖、依赖成环都由宿主给出稳定码；`bootstrapProviders`
    // 保留同样的校验作为纵深防御。
    {
      name: "同槽位两个启用实现",
      code: "EXTENSION_SLOT_DUPLICATE",
      setup: (repoRoot) => {
        writeSlotExtension(repoRoot, "rootA", "sqlite-storage", { factoryBody: slotDeclaration("sqlite-storage", "storage") });
        writeSlotExtension(repoRoot, "rootB", "mongo-storage", { factoryBody: slotDeclaration("mongo-storage", "storage") });
      }
    },
    {
      name: "requires 指向未知槽位",
      code: "EXTENSION_REQUIRES_UNKNOWN",
      setup: (repoRoot) => writeSlotExtension(repoRoot, "rootA", "sqlite-storage", {
        factoryBody: slotDeclaration("sqlite-storage", "storage", { requires: ["queue"] })
      })
    },
    {
      name: "requires 成环",
      code: "EXTENSION_REQUIRES_CYCLE",
      setup: (repoRoot) => writeSlotExtension(repoRoot, "rootA", "fixture-access", {
        factoryBody: `  return { extensionId: "fixture-access", providers: [\n    { slot: "identity", requires: ["access"], create: async () => ({ value: {} }) },\n    { slot: "access", requires: ["identity"], create: async () => ({ value: {} }) }\n  ] };`
      })
    }
  ];
  for (const testCase of cases) {
    const repoRoot = makeRepo();
    testCase.setup(repoRoot);
    const host = await loadExtensionHost({ repoRoot, env: {}, logger: () => undefined });
    await assert.rejects(
      () => host.createSlotDeclarations({}),
      (error) => error instanceof ExtensionLoadError && error.code === testCase.code
        // 错误信息必须能定位目录（任务 2.3）：fixture 的两个根是 rootA / rootB。
        && /rootA|rootB/.test(error.message),
      `${testCase.name} 期望 ${testCase.code} 且信息含目录`
    );
  }
});

test("槽位声明：bootstrap.module 越界（..）在加载阶段就失败", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "sqlite-storage", {
    descriptor: { schemaVersion: 1, extensionId: "sqlite-storage", bootstrap: { module: "./../outside", export: "createBootstrap" } },
    extraFiles: { "dist/bootstrap.js": "export const createBootstrap = () => ({ extensionId: \"sqlite-storage\", providers: [] });\n" }
  });
  await assert.rejects(
    () => loadExtensionHost({ repoRoot, env: {}, logger: () => undefined }),
    (error) => error instanceof ExtensionLoadError && error.code === "EXTENSION_MODULE_INVALID"
  );
});

for (const slot of ["identity", "access"]) {
  test(`槽位声明：只有 ${slot} 时不接受半套鉴权`, async () => {
    const repoRoot = makeRepo();
    writeSlotExtension(repoRoot, "rootA", "storage-fixture", { factoryBody: slotDeclaration("storage-fixture", "storage") });
    writeSlotExtension(repoRoot, "rootB", "controlled-fixture", { factoryBody: slotDeclaration("controlled-fixture", slot) });
    const host = await loadExtensionHost({ repoRoot, env: {}, logger: () => undefined });
    await assert.rejects(() => host.createSlotDeclarations({}), error => error.code === "EXTENSION_SLOT_MISSING");
  });
}

test("槽位声明：Storage 单独装配，仍拒绝缺失的声明依赖", async () => {
  const repoRoot = makeRepo();
  writeSlotExtension(repoRoot, "rootA", "storage-fixture", { factoryBody: slotDeclaration("storage-fixture", "storage") });
  const host = await loadExtensionHost({ repoRoot, env: {}, logger: () => undefined });
  assert.deepEqual((await host.createSlotDeclarations({})).map(entry => entry.extensionId), ["storage-fixture"]);
  const invalidRoot = makeRepo();
  writeSlotExtension(invalidRoot, "rootA", "storage-fixture", { factoryBody: slotDeclaration("storage-fixture", "storage", { requires: ["identity"] }) });
  const invalid = await loadExtensionHost({ repoRoot: invalidRoot, env: {}, logger: () => undefined });
  await assert.rejects(() => invalid.createSlotDeclarations({}), error => error.code === "EXTENSION_REQUIRES_MISSING");
});

test("槽位声明：受控声明工厂失败不能变成无鉴权结果", async () => {
  const repoRoot = makeRepo();
  writeSlotExtension(repoRoot, "rootA", "storage-fixture", { factoryBody: slotDeclaration("storage-fixture", "storage") });
  writeSlotExtension(repoRoot, "rootB", "controlled-fixture", { factoryBody: 'throw new Error("configuration failed");' });
  const host = await loadExtensionHost({ repoRoot, env: {}, logger: () => undefined });
  await assert.rejects(() => host.createSlotDeclarations({}), error => error.code === "EXTENSION_BOOTSTRAP_FACTORY_FAILED" && error.extensionId === "controlled-fixture");
});

/**
 * 回归（scripts/lib/extension-host.mjs 曾写成 `requireFoundationCoverage && ownerBySlot.size`）：
 * 零实现时短路会让「一个槽位实现都没有」的部署静默启动成无存储/无身份，
 * 与文档承诺的启动期 fail-fast 相反。缺省真值必须对必需槽位照常抛错。
 */
test("槽位声明：零实现时必需槽位仍然 fail-fast", async () => {
  const emptyRoot = makeRepo();
  const empty = await loadExtensionHost({ repoRoot: emptyRoot, env: {}, logger: () => undefined });
  await assert.rejects(
    () => empty.createSlotDeclarations({}),
    (error) => error instanceof ExtensionLoadError && error.code === "EXTENSION_SLOT_MISSING" && error.slot === "storage",
    "零槽位实现必须拒绝装配"
  );
  // 预检/只读工具路径按 `requireFoundationCoverage: false` 取声明，缺槽位由调用方按告警分级。
  assert.deepEqual(await empty.createSlotDeclarations({}, undefined, { requireFoundationCoverage: false }), []);

  // 有扩展但都不实现槽位（undeclared）：与零实现同一结果。
  const nonSlotRoot = makeRepo();
  writeExtension(nonSlotRoot, "rootA", "plain", { descriptor: null });
  const nonSlot = await loadExtensionHost({ repoRoot: nonSlotRoot, env: {}, logger: () => undefined });
  await assert.rejects(
    () => nonSlot.createSlotDeclarations({}),
    (error) => error instanceof ExtensionLoadError && error.code === "EXTENSION_SLOT_MISSING" && error.slot === "storage"
  );
});

/**
 * 画布内容扩展（`canvasContent` 声明，change: 2026-10-17-decouple-film-set-from-canvas-service）：
 * 工厂返回预览/历史帧端口；宿主只做形状校验，不认识具体内容领域。
 */
const contentRuntimeSource = `export function createContentRuntime() {
  return {
    frames: {
      matches: () => true,
      preparePreviewFrame: async () => ({ ok: false, code: "x", message: "x" }),
      prepareHistoryFrame: () => { throw new Error("x"); },
      identityMatches: () => true
    },
    conversion: {
      createService: () => ({ submit: async () => ({ ok: false, code: "x", message: "x" }) }),
      createMediaReader: () => ({ readAsset: async () => ({ bytes: new Uint8Array(), contentType: "x" }) }),
      createInMemoryRegistry: () => ({ get: async () => undefined, put: async () => undefined })
    },
    mcp: {
      createNodeService: () => ({ createNode: async () => ({ ok: false, code: "x", message: "x" }) }),
      createImportService: () => ({ importContent: async () => ({ ok: false, code: "x", message: "x" }) }),
      createItemService: () => ({ mutateItem: async () => ({ ok: false, code: "x", message: "x" }) })
    }
  };
}
`;

test("画布内容端口：按 canvasContent 声明加载并校验形状", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "content-fixture", {
    descriptor: {
      schemaVersion: 1,
      extensionId: "content-fixture",
      canvasContent: { module: "./backend", factory: "createContentRuntime" }
    },
    backendSource: contentRuntimeSource
  });
  const host = await loadExtensionHost({ repoRoot, env: {}, logger: () => undefined });
  const loaded = await host.createCanvasContent({});
  assert.deepEqual(loaded.map((entry) => entry.extensionId), ["content-fixture"]);
  const runtime = loaded[0].runtime;
  for (const method of ["matches", "preparePreviewFrame", "prepareHistoryFrame", "identityMatches"]) {
    assert.equal(typeof runtime.frames[method], "function", `frames.${method} 必须是函数`);
  }
  for (const method of ["createService", "createMediaReader", "createInMemoryRegistry"]) {
    assert.equal(typeof runtime.conversion[method], "function", `conversion.${method} 必须是函数`);
  }
  for (const method of ["createNodeService", "createImportService", "createItemService"]) {
    assert.equal(typeof runtime.mcp[method], "function", `mcp.${method} 必须是函数`);
  }
  // 宿主摘要暴露声明，便于诊断。
  const summary = hostSummary(host);
  assert.equal(summary.loaded.find((entry) => entry.extensionId === "content-fixture").canvasContent.factory, "createContentRuntime");
});

test("画布内容端口：导出缺失或返回值形状不对时启动期失败", async () => {
  const missingRepo = makeRepo();
  writeExtension(missingRepo, "rootA", "content-fixture", {
    descriptor: { schemaVersion: 1, extensionId: "content-fixture", canvasContent: { module: "./backend", factory: "createMissing" } },
    backendSource: "export const other = 1;\n"
  });
  const missing = await loadExtensionHost({ repoRoot: missingRepo, env: {}, logger: () => undefined });
  await assert.rejects(() => missing.createCanvasContent({}), (error) => error instanceof ExtensionLoadError && error.code === "EXTENSION_EXPORT_INVALID");

  const badShapeRepo = makeRepo();
  writeExtension(badShapeRepo, "rootA", "content-fixture", {
    descriptor: { schemaVersion: 1, extensionId: "content-fixture", canvasContent: { module: "./backend", factory: "createFrameRuntime" } },
    backendSource: "export function createContentRuntime() { return { frames: { matches: true } }; }\n"
  });
  const badShape = await loadExtensionHost({ repoRoot: badShapeRepo, env: {}, logger: () => undefined });
  await assert.rejects(() => badShape.createCanvasContent({}), (error) => error instanceof ExtensionLoadError && error.code === "EXTENSION_EXPORT_INVALID");
});

test("安全模式（D7）：只装配 required 与 bootstrap 扩展；可写根与可选扩展暂停，站点条目保留", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "essential", {
    descriptor: { schemaVersion: 1, extensionId: "essential", required: true, site: siteBlock("essential"), backend: { module: "./backend", factory: "createessentialExtension" } },
    backendSource: backendFactory("essential"),
    browserArtifact: true
  });
  writeExtension(repoRoot, "rootA", "optional", {
    descriptor: { schemaVersion: 1, extensionId: "optional", site: siteBlock("optional", 20), backend: { module: "./backend", factory: "createoptionalExtension" } },
    // 安全模式下不得导入任何扩展模块：这里放一个导入即抛错的后端。
    backendSource: `throw new Error("安全模式不应导入 optional");\n`,
    browserArtifact: true
  });
  writeExtension(repoRoot, "rootB", "writable", {
    descriptor: { schemaVersion: 1, extensionId: "writable", required: true, backend: { module: "./backend", factory: "createwritableExtension" } },
    backendSource: `throw new Error("安全模式不应导入可写根扩展");\n`
  });
  const host = await loadExtensionHost({ repoRoot, env: { WOOHAA3_EXTENSION_WRITABLE_DIRS: path.join(repoRoot, "rootB") }, safeMode: true });
  assert.deepEqual([...host.safeMode.suspended].sort(), ["optional", "writable"]);
  assert.deepEqual((await host.createDefinitions({})).map((definition) => definition.extensionId), ["essential"]);
  // 站点目录仍含 optional，供控制面投影 suspended；发布目录只含 required artifact。
  assert.deepEqual(host.siteExtensionIds.sort(), ["essential", "optional"]);
  assert.deepEqual(host.browserRelease.entries.map((entry) => entry.metadata.extensionId), ["essential"]);

  // 正常启动下没有 safeMode 视图。
  const plainRoot = makeRepo();
  writeExtension(plainRoot, "rootA", "plain", { descriptor: { schemaVersion: 1, extensionId: "plain", site: siteBlock("plain") } });
  assert.equal((await loadExtensionHost({ repoRoot: plainRoot, env: {} })).safeMode, null);
  fs.rmSync(plainRoot, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 受管根 / 可写根的信任边界（change: 2026-10-21-add-extension-marketplace-point，任务 2.2）
// ---------------------------------------------------------------------------

const hostPluginSource = (extensionId, factoryName) =>
  `export function ${factoryName}() {\n  return { name: "${extensionId}", label: "${extensionId}", configPrefix: "x.${extensionId}", inject: [], Config: { fields: {} }, apply() {} };\n}\n`;

/** 在受管根写一个版本目录并提交指针（布局与安装后一致：模块在 dist/ 下，经 exports 映射）。 */
function writeManagedExtension(managedRoot, extensionId, { descriptor, backendSource, sharedSource, version = "1.0.0" } = {}) {
  const dir = managedLayout(managedRoot).versionDir(extensionId, version);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: `@woohaa3/extension-${extensionId}`, version, type: "module", exports: { "./backend": { import: "./dist/backend.js" }, "./shared": { import: "./dist/shared.js" }, "./bootstrap": { import: "./dist/backend.js" } } })
  );
  fs.writeFileSync(path.join(dir, "extension.json"), JSON.stringify({ schemaVersion: 1, extensionId, version, ...descriptor }));
  if (backendSource !== undefined) fs.writeFileSync(path.join(dir, "dist", "backend.js"), backendSource);
  if (sharedSource !== undefined) fs.writeFileSync(path.join(dir, "dist", "shared.js"), sharedSource);
  const handle = openInstallations({ managedRoot });
  try {
    const state = handle.read();
    handle.commit((draft) => {
      draft.extensions[extensionId] = { current: version, previous: null, sourceId: "local-file", state: "active", history: [] };
    }, { expectedRevision: state.revision });
  } finally {
    handle.release();
  }
  return dir;
}

test("untrustedRootViolation：内置根放行；受管根拒绝来源 / bootstrap / canvasContent；可写根只拒绝来源", () => {
  const source = { hostPlugin: { kind: "marketplace-source", factory: "f" } };
  assert.equal(untrustedRootViolation({ extensionId: "a", dir: "/a" }, source), null);
  assert.equal(untrustedRootViolation({ extensionId: "a", dir: "/a", managed: true }, source).code, "EXTENSION_MARKETPLACE_SOURCE_UNTRUSTED_ROOT");
  assert.equal(untrustedRootViolation({ extensionId: "a", dir: "/a", rootWritable: true }, source).code, "EXTENSION_MARKETPLACE_SOURCE_UNTRUSTED_ROOT");
  assert.equal(untrustedRootViolation({ extensionId: "a", dir: "/a", managed: true }, { bootstrap: { export: "x" } }).field, "bootstrap");
  assert.equal(untrustedRootViolation({ extensionId: "a", dir: "/a", managed: true }, { canvasContent: { factory: "x" } }).field, "canvasContent");
  assert.equal(untrustedRootViolation({ extensionId: "a", dir: "/a", rootWritable: true }, { canvasContent: { factory: "x" } }), null);
  assert.equal(untrustedRootViolation({ extensionId: "a", dir: "/a", managed: true }, { hostPlugin: { kind: "provider" } }), null);
});

test("可写根里的市场来源：启动 fail-fast（EXTENSION_MARKETPLACE_SOURCE_UNTRUSTED_ROOT）", async () => {
  const repoRoot = makeRepo({ config: { schemaVersion: 1, roots: ["rootA", { path: "rootB", writable: true }] } });
  writeExtension(repoRoot, "rootB", "rogue-source", {
    descriptor: { schemaVersion: 1, extensionId: "rogue-source", hostPlugin: { module: "./backend", factory: "createSource", kind: "marketplace-source" } },
    backendSource: hostPluginSource("rogue-source", "createSource")
  });
  await assert.rejects(
    () => loadExtensionHost({ repoRoot, env: {}, logger: () => undefined }),
    (error) => error instanceof ExtensionLoadError && error.code === "EXTENSION_MARKETPLACE_SOURCE_UNTRUSTED_ROOT"
  );
});

test("内置根里的市场来源：正常装配到 marketplace-source 分组，origin 为内置", async () => {
  const repoRoot = makeRepo();
  writeExtension(repoRoot, "rootA", "builtin-source", {
    descriptor: { schemaVersion: 1, extensionId: "builtin-source", hostPlugin: { module: "./backend", factory: "createSource", kind: "marketplace-source" } },
    backendSource: hostPluginSource("builtin-source", "createSource")
  });
  const host = await loadExtensionHost({ repoRoot, env: { [MANAGED_DIR_ENV]: path.join(repoRoot, "managed") }, logger: () => undefined });
  const plugins = await host.createHostPlugins({});
  assert.deepEqual(plugins["marketplace-source"].map((plugin) => plugin.name), ["builtin-source"]);
  assert.deepEqual(plugins["marketplace-source"][0].origin, { managed: false, rootWritable: false });
});

test("受管根：bootstrap / canvasContent / 来源 / 模块缺失只拒绝该扩展，其他扩展照常装配", async () => {
  const repoRoot = makeRepo();
  const managedRoot = path.join(repoRoot, "managed");
  writeExtension(repoRoot, "rootA", "builtin-ok", {
    descriptor: { schemaVersion: 1, extensionId: "builtin-ok", metadata: { module: "./shared", export: "BUILTIN_OK" } },
    sharedSource: metadataExport("builtin-ok", "BUILTIN_OK")
  });
  writeManagedExtension(managedRoot, "managed-ok", {
    descriptor: { hostPlugin: { module: "./backend", factory: "createOk", kind: "provider" } },
    backendSource: hostPluginSource("managed-ok", "createOk")
  });
  writeManagedExtension(managedRoot, "managed-slot", { descriptor: { bootstrap: { module: "./bootstrap", export: "createBootstrap" } }, backendSource: "export function createBootstrap() {}\n" });
  writeManagedExtension(managedRoot, "managed-canvas", { descriptor: { canvasContent: { module: "./backend", factory: "createContent" } }, backendSource: "export function createContent() {}\n" });
  writeManagedExtension(managedRoot, "managed-source", {
    descriptor: { hostPlugin: { module: "./backend", factory: "createSource", kind: "marketplace-source" } },
    backendSource: hostPluginSource("managed-source", "createSource")
  });
  writeManagedExtension(managedRoot, "managed-missing", { descriptor: { hostPlugin: { module: "./backend", factory: "createX", kind: "provider" } } });
  const events = [];
  // P1 进程内语义（隔离关闭的降级路径）；隔离开启时的行为见下方 isolated 用例。
  const host = await loadExtensionHost({ repoRoot, env: { [MANAGED_DIR_ENV]: managedRoot }, logger: (event) => events.push(event), isolation: false });
  assert.deepEqual(host.registrations.map((entry) => entry.extensionId).sort(), ["builtin-ok", "managed-ok"]);
  const rejected = Object.fromEntries(host.managedRejected.map((entry) => [entry.extensionId, entry.code]));
  assert.deepEqual(rejected, {
    "managed-canvas": "EXTENSION_MANAGED_FORBIDDEN_DECLARATION",
    "managed-missing": "EXTENSION_MODULE_MISSING",
    "managed-slot": "EXTENSION_MANAGED_FORBIDDEN_DECLARATION",
    "managed-source": "EXTENSION_MARKETPLACE_SOURCE_UNTRUSTED_ROOT"
  });
  assert.equal(events.filter((event) => event.event === "extension-managed-rejected").length, 4);
  // 受管 Provider 正常装配，并带 origin 供运行期 ctx.marketplace.register 断言。
  const plugins = await host.createHostPlugins({});
  assert.deepEqual(plugins.provider.find((plugin) => plugin.name === "managed-ok").origin, { managed: true, rootWritable: false });
  assert.equal(host.registrations.find((entry) => entry.extensionId === "managed-ok").managedVersion, "1.0.0");
  assert.equal(host.managedRoot, managedRoot);
});

test("受管根：安全模式下受管扩展一律暂停", async () => {
  const repoRoot = makeRepo();
  const managedRoot = path.join(repoRoot, "managed");
  writeManagedExtension(managedRoot, "managed-req", {
    descriptor: { required: true, hostPlugin: { module: "./backend", factory: "createOk", kind: "provider" } },
    backendSource: hostPluginSource("managed-req", "createOk")
  });
  const host = await loadExtensionHost({ repoRoot, env: { [MANAGED_DIR_ENV]: managedRoot }, logger: () => undefined, safeMode: true, isolation: false });
  assert.deepEqual(host.safeMode.suspended, ["managed-req"]);
  assert.deepEqual(host.registrations.filter((entry) => entry.hostPlugin), []);
});

// ---------------------------------------------------------------------------
// 受管后端隔离：扫描不 import 受管模块（change: 2026-10-21-isolate-extension-host-process，任务 6.2 / 6.4）
// ---------------------------------------------------------------------------

/** 在受管根写一个**打包后形态**的后端扩展：入口在 backend-dist/，带 config-schema.json。 */
function writeIsolatedManaged(managedRoot, extensionId, { entrySource, schema, descriptor = {}, version = "1.0.0" } = {}) {
  const dir = managedLayout(managedRoot).versionDir(extensionId, version);
  fs.mkdirSync(path.join(dir, "backend-dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `@woohaa3/extension-${extensionId}`, version, type: "module", exports: { "./backend-dist/entry": "./backend-dist/entry.mjs" } }));
  fs.writeFileSync(
    path.join(dir, "extension.json"),
    JSON.stringify({
      schemaVersion: 1,
      extensionId,
      version,
      permissions: { network: ["api.example.com"] },
      hostPlugin: { module: "./backend-dist/entry", factory: "createPlugin", kind: "provider", order: 7 },
      metadata: { module: "./backend-dist/entry", export: "META" },
      ...descriptor
    })
  );
  fs.writeFileSync(path.join(dir, "backend-dist", "entry.mjs"), entrySource);
  if (schema !== null) {
    fs.writeFileSync(
      path.join(dir, "backend-dist", "config-schema.json"),
      JSON.stringify(schema ?? {
        schemaVersion: 1,
        extensionId,
        kind: "provider",
        factory: "createPlugin",
        plugin: { name: extensionId, label: "隔离样例", configPrefix: `providers.${extensionId}`, fields: { apiKey: { kind: "string", label: "Key", description: "d", reload: "hot", secret: true } }, health: true, modelRefresh: { path: `/api/extensions/${extensionId}/models`, hint: "h" } },
        metadata: { export: "META", value: { extensionId, name: "隔离样例" } },
        publicPaths: {}
      })
    );
  }
  const handle = openInstallations({ managedRoot });
  try {
    const state = handle.read();
    handle.commit((draft) => {
      draft.extensions[extensionId] = { current: version, previous: null, sourceId: "local-file", state: "active", history: [] };
    }, { expectedRevision: state.revision });
  } finally {
    handle.release();
  }
  return dir;
}

test("隔离开启：受管 Provider 的包内模块一个都不被 import（顶层抛错的入口），产出 isolated 描述", async () => {
  const repoRoot = makeRepo();
  const managedRoot = path.join(repoRoot, "managed");
  writeExtension(repoRoot, "rootA", "builtin-provider", {
    descriptor: { schemaVersion: 1, extensionId: "builtin-provider", hostPlugin: { module: "./backend", factory: "createBuiltin", kind: "provider" } },
    backendSource: hostPluginSource("builtin-provider", "createBuiltin")
  });
  const dir = writeIsolatedManaged(managedRoot, "iso-provider", { entrySource: 'throw new Error("受管模块被宿主 import 了");\n' });
  const host = await loadExtensionHost({ repoRoot, env: { [MANAGED_DIR_ENV]: managedRoot }, logger: () => undefined });
  assert.deepEqual(host.managedRejected, []);
  const plugins = await host.createHostPlugins({});
  // 内置根行为不变：进程内插件对象。
  assert.deepEqual(plugins.provider.map((plugin) => plugin.name), ["builtin-provider"]);
  assert.equal(plugins.isolated.length, 1);
  const isolated = plugins.isolated[0];
  assert.equal(isolated.isolated, true);
  assert.equal(isolated.extensionId, "iso-provider");
  assert.equal(isolated.version, "1.0.0");
  assert.equal(isolated.entry, fs.realpathSync(path.join(dir, "backend-dist", "entry.mjs")));
  assert.equal(isolated.factory, "createPlugin");
  assert.equal(isolated.kind, "provider");
  assert.equal(isolated.order, 7);
  assert.deepEqual(isolated.permissions, { network: ["api.example.com"] });
  assert.equal(isolated.plugin.configPrefix, "providers.iso-provider");
  assert.equal(isolated.plugin.fields.apiKey.secret, true);
  assert.equal(isolated.plugin.health, true);
  assert.deepEqual(isolated.origin, { managed: true, rootWritable: false });
  assert.doesNotThrow(() => JSON.stringify(isolated), "isolated 描述可序列化");
  // metadata 取自静态描述，仍进入设置面元数据。
  assert.ok(host.metadata.some((entry) => entry.extensionId === "iso-provider" && entry.name === "隔离样例"));
});

test("隔离开启：缺 config-schema.json 的旧包只拒绝该扩展（MARKETPLACE_PACKAGE_INVALID）", async () => {
  const repoRoot = makeRepo();
  const managedRoot = path.join(repoRoot, "managed");
  writeIsolatedManaged(managedRoot, "legacy-pkg", { entrySource: "export function createPlugin() {}\nexport const META = {};\n", schema: null });
  writeIsolatedManaged(managedRoot, "bad-schema", {
    entrySource: "export {};\n",
    schema: { schemaVersion: 1, extensionId: "bad-schema", kind: "provider", factory: "createPlugin", plugin: { name: "bad-schema", label: "x", configPrefix: "storage.primary", fields: {}, health: false }, metadata: { export: "META", value: { extensionId: "bad-schema" } }, publicPaths: {} }
  });
  const host = await loadExtensionHost({ repoRoot, env: { [MANAGED_DIR_ENV]: managedRoot }, logger: () => undefined });
  assert.deepEqual(Object.fromEntries(host.managedRejected.map((entry) => [entry.extensionId, entry.code])), { "bad-schema": "MARKETPLACE_PACKAGE_INVALID", "legacy-pkg": "MARKETPLACE_PACKAGE_INVALID" });
  assert.deepEqual((await host.createHostPlugins({})).isolated, []);
});

test("隔离开启：受管 storage 插件被拒绝（与可写根同一闸门）", async () => {
  const repoRoot = makeRepo();
  const managedRoot = path.join(repoRoot, "managed");
  writeIsolatedManaged(managedRoot, "managed-store", {
    entrySource: "export {};\n",
    descriptor: { hostPlugin: { module: "./backend-dist/entry", factory: "createPlugin", kind: "storage" } }
  });
  const host = await loadExtensionHost({ repoRoot, env: { [MANAGED_DIR_ENV]: managedRoot }, logger: () => undefined });
  assert.equal(host.managedRejected[0].code, "EXTENSION_MANAGED_FORBIDDEN_DECLARATION");
  assert.equal(host.managedRejected[0].field, "hostPlugin.kind");
});

test("降级开关：isolation=false 或 WOOHAA3_EXTENSION_HOST_ISOLATION=0 时退回进程内导入", async () => {
  const repoRoot = makeRepo();
  const managedRoot = path.join(repoRoot, "managed");
  writeIsolatedManaged(managedRoot, "iso-provider", {
    entrySource: 'export function createPlugin() { return { name: "iso-provider", label: "x", configPrefix: "providers.iso-provider", inject: [], Config: { fields: {} }, apply() {} }; }\nexport const META = { extensionId: "iso-provider" };\n'
  });
  for (const options of [{ isolation: false }, { env: { WOOHAA3_EXTENSION_HOST_ISOLATION: "0" } }]) {
    const host = await loadExtensionHost({ repoRoot, env: { [MANAGED_DIR_ENV]: managedRoot, ...(options.env ?? {}) }, logger: () => undefined, ...(options.isolation === false ? { isolation: false } : {}) });
    const plugins = await host.createHostPlugins({});
    assert.deepEqual(plugins.isolated, []);
    assert.deepEqual(plugins.provider.map((plugin) => [plugin.name, plugin.origin.managed]), [["iso-provider", true]]);
  }
});
