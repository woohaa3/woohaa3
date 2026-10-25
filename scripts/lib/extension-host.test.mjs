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

import { ExtensionLoadError, hostSummary, loadExtensionHost, resolveModuleFile } from "./extension-host.mjs";
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
  for (const relative of ["scripts/lib/extension-host.mjs", "scripts/lib/extension-release-catalog.mjs", "scripts/lib/extension-descriptor.mjs"]) {
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
