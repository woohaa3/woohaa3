/**
 * 扩展声明校验单测
 * （change: 2026-10-15-add-scannable-extension-directories，任务 2.1）。
 *
 * 运行：`node --test scripts/lib/extension-descriptor.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  HOST_ENGINES,
  checkCapabilityDependencies,
  checkEnginesCompatible,
  contentDeclarationCollisions,
  isSemver,
  satisfiesRange,
  validateExtensionDescriptor,
  loadExtensionDescriptor
} from "./extension-descriptor.mjs";

const MINIMAL = { schemaVersion: 1, extensionId: "sample-access" };

function errorsOf(value) {
  const result = validateExtensionDescriptor(value);
  assert.equal(result.ok, false, "期望校验失败");
  return result.errors.join("\n");
}

function complete(overrides = {}) {
  return {
    schemaVersion: 1,
    extensionId: "sample-access",
    site: {
      name: "示例访问控制",
      description: "管理站点权限与画布 ACL。",
      version: "1.0.0",
      configSchema: { schemaId: "sample-access-config", schemaVersion: 1 },
      capabilities: [{ id: "sample-access.me", kind: "handler", description: "当前用户允许的站点 action", auth: "authenticated" }],
      defaultEnabled: true,
      order: 40
    },
    backend: { module: "./backend", factory: "createSampleAccessExtension", optionsType: "SampleAccessExtensionOptions", order: 60 },
    metadata: { module: "./shared", export: "SAMPLE_ACCESS_PLUGIN_METADATA", order: 10 },
    publicRoutes: [
      { publicPath: "/api/extensions/game-furnace/site", route: "game-furnace/site", methods: ["GET"] },
      { publicPathExport: "OAUTH_AGENT_PUBLIC_BASE_PATH", module: "./shared", route: "chatgpt", methods: ["GET", "POST"] }
    ],
    ...overrides
  };
}

test("合法最小声明与完整声明", () => {
  assert.equal(validateExtensionDescriptor(MINIMAL).ok, true);
  const full = validateExtensionDescriptor(complete());
  assert.equal(full.ok, true, full.ok ? "" : full.errors.join("; "));
  assert.equal(full.value.backend.factory, "createSampleAccessExtension");
});

test("executor declarations require an activation owner and unique package-local modules", () => {
  const executor = { id: "sample-agent", module: "./executor", export: "createExecutor" };
  assert.equal(validateExtensionDescriptor(complete({ executors: [executor] })).ok, true);
  assert.match(errorsOf(complete({ executors: [executor, executor] })), /unique/);
  assert.match(errorsOf(complete({ executors: [{ ...executor, module: "./../escape" }] })), /package subpath/);
  assert.match(errorsOf(complete({ executors: [executor], backend: undefined })), /activation owner/);
  assert.match(errorsOf(complete({ executors: [executor], site: undefined })), /site activation/);
  assert.match(errorsOf(complete({ executors: [executor], hostPlugin: { module: "./backend", factory: "createPlugin" } })), /without hostPlugin/);
});

test("extensionId 与 schemaVersion 校验", () => {
  assert.match(errorsOf({ schemaVersion: 1 }), /extensionId 必须是非空 kebab-case/);
  assert.match(errorsOf({ schemaVersion: 1, extensionId: "Sample Access" }), /extensionId/);
  assert.match(errorsOf({ schemaVersion: 2, extensionId: "ok-id" }), /schemaVersion 必须是 1/);
});

test("未知字段被拒绝（顶层与 site）", () => {
  assert.match(errorsOf({ ...MINIMAL, extra: 1 }), /未知字段：extra/);
  const bad = complete();
  bad.site.script = "http://evil.example/x.js";
  assert.match(errorsOf(bad), /site 未知字段：script/);
});

test("icon 接受品牌图形或语义 glyph，至少声明一个", () => {
  assert.equal(validateExtensionDescriptor({ ...MINIMAL, icon: { glyph: "storage" } }).ok, true);
  assert.equal(validateExtensionDescriptor({ ...MINIMAL, icon: { asset: "./assets/icon.png" } }).ok, true);

  assert.match(errorsOf({ ...MINIMAL, icon: {} }), /至少声明 asset 或 glyph/);
  assert.match(errorsOf({ ...MINIMAL, icon: { glyph: "Storage Icon" } }), /icon\.glyph/);
  assert.match(errorsOf({ ...MINIMAL, icon: { glyph: "" } }), /icon\.glyph/);
  assert.match(errorsOf({ ...MINIMAL, icon: { glyph: "storage", extra: 1 } }), /icon 未知字段：extra/);
  assert.match(errorsOf({ ...MINIMAL, icon: { asset: "../outside.png" } }), /icon\.asset 必须是包内相对路径/);
  assert.match(errorsOf({ ...MINIMAL, icon: { asset: "./assets/icon.gif" } }), /icon\.asset 必须是图片文件/);
});

test("backend.optional 只接受布尔值", () => {
  const value = complete();
  value.backend.optional = true;
  assert.equal(validateExtensionDescriptor(value).ok, true);
  const bad = complete();
  bad.backend.optional = "yes";
  assert.match(errorsOf(bad), /backend\.optional 必须是布尔值/);
});

test("backend/metadata 只接受包内相对子路径，拒绝远程与越界路径", () => {
  for (const moduleValue of ["https://evil.example/backend.js", "../outside", "/abs/backend", "backend"]) {
    const value = complete();
    value.backend.module = moduleValue;
    assert.match(errorsOf(value), /backend\.module 必须是包内相对子路径/);
  }
  const value = complete();
  value.metadata.module = "node:fs";
  assert.match(errorsOf(value), /metadata\.module 必须是包内相对子路径/);
});

test("bootstrap 声明：合法形状通过，越界模块与非法导出名被拒绝", () => {
  const ok = validateExtensionDescriptor({ schemaVersion: 1, extensionId: "sqlite-storage", bootstrap: { module: "./bootstrap", export: "createSqliteStorageBootstrap" } });
  assert.equal(ok.ok, true, ok.ok ? "" : ok.errors.join("\n"));

  const defaults = validateExtensionDescriptor({ schemaVersion: 1, extensionId: "fixture-access", bootstrap: { export: "createFixtureAccessBootstrap" } });
  assert.equal(defaults.ok, true, defaults.ok ? "" : defaults.errors.join("\n"));

  for (const moduleValue of ["https://evil.example/bootstrap.js", "../outside", "/abs/bootstrap", "bootstrap", "node:fs"]) {
    assert.match(errorsOf({ schemaVersion: 1, extensionId: "sqlite-storage", bootstrap: { module: moduleValue, export: "createF" } }), /bootstrap\.module 必须是包内相对子路径/);
  }
  assert.match(errorsOf({ schemaVersion: 1, extensionId: "sqlite-storage", bootstrap: { export: "" } }), /bootstrap\.export 必须是导出函数名/);
  assert.match(errorsOf({ schemaVersion: 1, extensionId: "sqlite-storage", bootstrap: { export: "f", script: "./x" } }), /bootstrap 未知字段：script/);
  assert.match(errorsOf({ schemaVersion: 1, extensionId: "sqlite-storage", bootstrap: "bootstrap" }), /bootstrap 必须是对象/);
});

test("site.capabilities 校验 kind / auth / 非空", () => {
  const noCaps = complete();
  noCaps.site.capabilities = [];
  assert.match(errorsOf(noCaps), /site\.capabilities 必须是非空数组/);

  const badKind = complete();
  badKind.site.capabilities = [{ id: "x", kind: "provider", description: "d" }];
  assert.match(errorsOf(badKind), /kind 必须是 capability \/ handler/);

  const badAuth = complete();
  badAuth.site.capabilities = [{ id: "x", kind: "handler", description: "d", auth: "admin" }];
  assert.match(errorsOf(badAuth), /auth 必须是 public \/ authenticated/);
});

test("publicRoutes 校验：路径来源互斥、站内路径、路由名与方法", () => {
  const both = complete();
  both.publicRoutes = [{ publicPath: "/a", publicPathExport: "X", module: "./shared", route: "a", methods: ["GET"] }];
  assert.match(errorsOf(both), /只能提供 publicPath 或 publicPathExport/);

  const neither = complete();
  neither.publicRoutes = [{ route: "a", methods: ["GET"] }];
  assert.match(errorsOf(neither), /只能提供 publicPath 或 publicPathExport/);

  const protocolRelative = complete();
  protocolRelative.publicRoutes = [{ publicPath: "//evil.example/a", route: "a", methods: ["GET"] }];
  assert.match(errorsOf(protocolRelative), /publicPath 必须是站内绝对路径/);

  const leadingSlashRoute = complete();
  leadingSlashRoute.publicRoutes = [{ publicPath: "/a", route: "/a", methods: ["GET"] }];
  assert.match(errorsOf(leadingSlashRoute), /route 必须是不带前导 \//);

  // 公开路由的 route 是基路由，子路径由宿主追加；带通配符会拼成 `x/*/sub` 而永不命中。
  const wildcardRoute = complete();
  wildcardRoute.publicRoutes = [{ publicPath: "/api/a", route: "a/*", methods: ["GET"] }];
  assert.match(errorsOf(wildcardRoute), /route 是公开路径下的基路由，不能含通配符/);

  const badMethod = complete();
  badMethod.publicRoutes = [{ publicPath: "/a", route: "a", methods: ["FETCH"] }];
  assert.match(errorsOf(badMethod), /methods 必须是/);

  const moduleWithoutExport = complete();
  moduleWithoutExport.publicRoutes = [{ publicPath: "/a", module: "./shared", route: "a", methods: ["GET"] }];
  assert.match(errorsOf(moduleWithoutExport), /module 只在 publicPathExport 时有效/);
});

test("loadExtensionDescriptor：无声明返回 null，identity 不一致与非法 JSON 报错", (t) => {
  const base = fs.existsSync("/data/tmp/opencode") ? "/data/tmp/opencode" : os.tmpdir();
  const root = fs.mkdtempSync(path.join(base, "woohaa-descriptor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "ext");
  fs.mkdirSync(dir, { recursive: true });

  const extension = { extensionId: "declared-id", dir, descriptorPath: path.join(dir, "extension.json") };
  assert.equal(loadExtensionDescriptor(extension, { repoRoot: root }), null);

  fs.writeFileSync(extension.descriptorPath, `${JSON.stringify({ schemaVersion: 1, extensionId: "other-id" })}\n`);
  assert.throws(() => loadExtensionDescriptor(extension, { repoRoot: root }), (error) => error.code === "EXTENSION_DESCRIPTOR_IDENTITY_MISMATCH");

  fs.writeFileSync(extension.descriptorPath, "{ broken");
  assert.throws(() => loadExtensionDescriptor(extension, { repoRoot: root }), (error) => error.code === "EXTENSION_DESCRIPTOR_INVALID");

  fs.writeFileSync(extension.descriptorPath, `${JSON.stringify({ schemaVersion: 1, extensionId: "declared-id", backend: { factory: "createThing" } })}\n`);
  const loaded = loadExtensionDescriptor(extension, { repoRoot: root });
  assert.equal(loaded.backend.module, undefined);
  assert.equal(loaded.backend.factory, "createThing");
});

// ---------------------------------------------------------------------------
// 分发字段（change: 2026-10-21-add-extension-marketplace-point，任务 1.3）
// ---------------------------------------------------------------------------

test("分发字段可选：旧扩展声明不受影响", () => {
  assert.equal(validateExtensionDescriptor(MINIMAL).ok, true);
  assert.equal(validateExtensionDescriptor(complete()).ok, true);
});

test("version / engines 合法时通过", () => {
  const result = validateExtensionDescriptor({
    ...MINIMAL,
    version: "1.2.0-beta.1",
    engines: { hostAbi: "^1.0.0", sdkAbi: ">=1 <2", protocolVersion: 1 }
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("permissions 已移除：声明它按未知字段拒绝", () => {
  assert.match(errorsOf({ ...MINIMAL, permissions: { network: ["api.example.com"] } }), /未知字段：permissions/);
});

test("version 非 semver、engines 缺字段或 range 非法：失败并指出字段", () => {
  const text = errorsOf({ ...MINIMAL, version: "1.0", engines: { hostAbi: "^1", sdkAbi: "not a range!", protocolVersion: 0, extra: 1 } });
  assert.match(text, /version 必须是 semver/);
  assert.match(text, /engines\.sdkAbi 不是合法的 semver range/);
  assert.match(text, /engines\.protocolVersion 必须是正整数/);
  assert.match(text, /engines 未知字段：extra/);
});

test("migrate 只做格式校验（是否允许由受管预检决定）", () => {
  assert.equal(validateExtensionDescriptor({ ...MINIMAL, migrate: { module: "./backend", export: "migrateData" } }).ok, true);
  assert.match(errorsOf({ ...MINIMAL, migrate: { module: "https://x", export: "m" } }), /migrate\.module 必须是包内相对子路径/);
});

test("hostPlugin.features 接受 marketplace-source", () => {
  assert.equal(validateExtensionDescriptor({ ...MINIMAL, hostPlugin: { module: "./backend", factory: "createSource", features: ["marketplace-source"] } }).ok, true);
});

test("content 声明校验字段格式，并拒绝跨扩展重名", () => {
  const content = {
    ownedFields: ["sampleContent"],
    ownedWireFields: ["sampleWire"],
    routePrefix: "import",
    mcpTools: ["import_content"],
    targetModes: ["sample-target"],
    eventOwners: ["sample-extension"]
  };
  assert.equal(validateExtensionDescriptor({ ...MINIMAL, content }).ok, true);
  assert.match(errorsOf({ ...MINIMAL, content: { ownedFields: ["bad-field"] } }), /ownedFields/);
  assert.match(errorsOf({ ...MINIMAL, content: { mcpTools: ["Import"] } }), /mcpTools/);
  assert.match(errorsOf({ ...MINIMAL, content: { routePrefix: "/import" } }), /routePrefix/);
  assert.match(errorsOf({ ...MINIMAL, content: { ownedFields: ["title", "title"] } }), /ownedFields 不得重复/);
  assert.match(errorsOf({ ...MINIMAL, content: { extra: true } }), /content 未知字段：extra/);
  const collisions = contentDeclarationCollisions([
    { extensionId: "sample-extension", directory: "a", descriptor: { content } },
    { extensionId: "other-extension", directory: "b", descriptor: { content: { ownedFields: ["sampleContent"], mcpTools: ["other_tool"] } } }
  ]);
  assert.equal(collisions.length, 1);
  assert.match(collisions[0].message, /ownedFields「sampleContent」/);
});

// deprecated-declaration：`hostPlugin.kind` 过渡期用例。删除废弃别名时一并删掉这两条。
test("hostPlugin.kind 仍被接受：归一成 features 并报告废弃", () => {
  const validated = validateExtensionDescriptor({ ...MINIMAL, hostPlugin: { module: "./backend", factory: "createSource", kind: "provider" } });
  assert.equal(validated.ok, true);
  assert.deepEqual(validated.value.hostPlugin.features, ["provider"]);
  assert.equal("kind" in validated.value.hostPlugin, false);
  assert.deepEqual(validated.deprecations, [{ field: "hostPlugin.kind", replacement: "hostPlugin.features" }]);
});

test("hostPlugin.kind 与 features 同时声明：报错（不猜哪个优先）", () => {
  const validated = validateExtensionDescriptor({
    ...MINIMAL,
    hostPlugin: { module: "./backend", factory: "createSource", kind: "provider", features: ["storage"] }
  });
  assert.equal(validated.ok, false);
  assert.ok(validated.errors.some((error) => error.includes("不能与")), validated.errors.join(", "));
});


test("semver 工具：isSemver 与 range 子集", () => {
  assert.equal(isSemver("1.2.3"), true);
  assert.equal(isSemver("1.2"), false);
  const cases = [
    ["1.4.0", "^1.2.0", true], ["2.0.0", "^1.2.0", false], ["0.2.5", "^0.2.1", true], ["0.3.0", "^0.2.1", false],
    ["1.2.9", "~1.2.0", true], ["1.3.0", "~1.2.0", false], ["1.9.0", "1.x", true], ["2.0.0", "1", false],
    ["1.0.0", ">=1.0.0 <2.0.0", true], ["2.0.0", ">=1.0.0 <2.0.0", false], ["3.1.0", "^1 || ^3", true], ["5.0.0", "*", true],
    ["1.0.0-beta.1", "^1.0.0", true]
  ];
  for (const [version, range, expected] of cases) assert.equal(satisfiesRange(version, range), expected, `${version} ∈ ${range}`);
  assert.equal(satisfiesRange("1.0.0", "garbage!"), null);
  assert.equal(satisfiesRange("1.0.0", ""), null);
});

test("engines 兼容：缺省兼容；主版本或协议不符时给出原因", () => {
  assert.deepEqual(checkEnginesCompatible(undefined), { ok: true });
  assert.deepEqual(checkEnginesCompatible({ hostAbi: "^1.0.0", sdkAbi: "^1.0.0", protocolVersion: HOST_ENGINES.protocolVersion }), { ok: true });
  const result = checkEnginesCompatible({ hostAbi: "^2.0.0", sdkAbi: "^1.0.0", protocolVersion: 99 });
  assert.equal(result.ok, false);
  assert.equal(result.reasons.length, 2);
  assert.match(result.reasons.join("\n"), /hostAbi/);
  assert.match(result.reasons.join("\n"), /protocolVersion/);
});

// ---------------------------------------------------------------------------
// 能力依赖：engines.host / engines.capabilities
// （change: 2026-11-13-add-extension-capability-abi）
// ---------------------------------------------------------------------------

test("engines.host / engines.capabilities 接受「名字 → 正整数版本」映射", () => {
  const value = { ...MINIMAL, engines: { hostAbi: "^1.0.0", sdkAbi: "^1.0.0", protocolVersion: 1, host: { generation: 1, storage: 1 }, capabilities: { "adapter:x": 1 } } };
  const result = validateExtensionDescriptor(value);
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
});

test("engines.host 的版本必须是正整数，名字必须非空", () => {
  const bad = errorsOf({ ...MINIMAL, engines: { hostAbi: "^1", sdkAbi: "^1", protocolVersion: 1, host: { generation: 0 } } });
  assert.match(bad, /engines\.host\.generation 必须是正整数/);

  const worse = errorsOf({ ...MINIMAL, engines: { hostAbi: "^1", sdkAbi: "^1", protocolVersion: 1, host: { "": 1 } } });
  assert.match(worse, /必须是对象|键必须是非空字符串/);
});

test("engines.host 不是对象时拒绝", () => {
  assert.match(errorsOf({ ...MINIMAL, engines: { hostAbi: "^1", sdkAbi: "^1", protocolVersion: 1, host: ["generation"] } }), /engines\.host 必须是对象/);
});

test("checkCapabilityDependencies：服务面匹配时通过", () => {
  const result = checkCapabilityDependencies(
    { host: { generation: 1 } },
    { hostServices: { generation: 1 } }
  );
  assert.deepEqual(result, { ok: true });
});

test("checkCapabilityDependencies：版本不符时指出两侧版本", () => {
  const result = checkCapabilityDependencies(
    { host: { generation: 2 } },
    { hostServices: { generation: 1 } }
  );
  assert.equal(result.ok, false);
  assert.match(result.reasons[0], /需要 generation@2，宿主提供 1/);
});

test("checkCapabilityDependencies：未知服务面单独报错", () => {
  const result = checkCapabilityDependencies({ host: { nosuch: 1 } }, { hostServices: { generation: 1 } });
  assert.equal(result.ok, false);
  assert.match(result.reasons[0], /未知服务面 nosuch/);
});

test("checkCapabilityDependencies：capability 解析不到时失败", () => {
  const result = checkCapabilityDependencies(
    { capabilities: { "adapter:x": 1 } },
    { hostServices: {}, resolvableCapabilities: new Map() }
  );
  assert.equal(result.ok, false);
  assert.match(result.reasons[0], /adapter:x@1 在当前宿主解析不到/);
});

test("checkCapabilityDependencies：capability 只有别的版本时列出可用版本", () => {
  const result = checkCapabilityDependencies(
    { capabilities: { "adapter:x": 2 } },
    { hostServices: {}, resolvableCapabilities: new Map([["adapter:x", new Set([1, 3])]]) }
  );
  assert.equal(result.ok, false);
  assert.match(result.reasons[0], /需要 adapter:x@2，当前只有 @1 \/ @3/);
});

test("checkCapabilityDependencies：未声明时视为不依赖", () => {
  assert.deepEqual(checkCapabilityDependencies(undefined, {}), { ok: true });
  assert.deepEqual(checkCapabilityDependencies({}, { hostServices: { generation: 1 } }), { ok: true });
});
