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

import { validateExtensionDescriptor, loadExtensionDescriptor } from "./extension-descriptor.mjs";

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
