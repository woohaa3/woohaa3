/**
 * pack:extension 与 build:backend 端到端（change: 2026-10-21-add-extension-marketplace-point，任务 3.1 / 3.2）。
 *
 * 用 scripts/fixtures/marketplace 下两个 fixture：打包 → 安全解包 → 签名校验 → 受管预检 →
 * 写入受管根 → 扩展宿主按指针装配（含后端产物可 import 并构造插件）。
 *
 * 运行：`node --test scripts/pack-extension.test.mjs`
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { packExtension, packagedPackageJson, rewriteDescriptorForPackage } from "./pack-extension.mjs";
import { preflightDirectory } from "./extensions-preflight.mjs";
import { unpackExtensionPackage, verifyExtensionPackage } from "./lib/extension-package.mjs";
import { MANAGED_DIR_ENV, openInstallations } from "./lib/extension-installations.mjs";
import { loadExtensionHost } from "./lib/extension-host.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const FIXTURES = path.join(HERE, "fixtures", "marketplace");

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-pack-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 复制 fixture 到临时目录再打包，避免 build:browser 在仓库里留下 browser-dist。 */
function copyFixture(t, name) {
  const target = path.join(tmp(t), name);
  fs.cpSync(path.join(FIXTURES, name), target, { recursive: true });
  return target;
}

test("rewriteDescriptorForPackage：后端模块改写到单文件产物，补齐 version / engines", () => {
  const next = rewriteDescriptorForPackage(
    { schemaVersion: 1, extensionId: "x", hostPlugin: { module: "./backend", factory: "f", kind: "provider" }, metadata: { module: "./shared", export: "M" }, publicRoutes: [{ publicPathExport: "P", module: "./shared", route: "x", methods: ["GET"] }] },
    { version: "1.2.3", engines: { hostAbi: "^1.0.0", sdkAbi: "^1.0.0", protocolVersion: 1 }, hasBackend: true }
  );
  assert.equal(next.hostPlugin.module, "./backend-dist/entry");
  assert.equal(next.metadata.module, "./backend-dist/entry");
  assert.equal(next.publicRoutes[0].module, "./backend-dist/entry");
  assert.equal(next.version, "1.2.3");
  assert.deepEqual(packagedPackageJson({ name: "@woohaa3/extension-x", dependencies: { a: "workspace:*" }, scripts: {} }, { version: "1.2.3", hasBackend: true }), {
    name: "@woohaa3/extension-x", version: "1.2.3", private: true, type: "module", exports: { "./backend-dist/entry": "./backend-dist/entry.mjs" }
  });
});

test("打包含后端 fixture：签名包可解包、校验、通过受管预检，并被宿主按指针装配", async (t) => {
  const work = tmp(t);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  const packed = await packExtension({ dir: copyFixture(t, "fixture-echo-provider"), out: path.join(work, "echo.wxt"), privateKey, repoRoot: REPO_ROOT });
  assert.equal(packed.extensionId, "fixture-echo-provider");
  assert.equal(packed.signed, true);
  assert.equal(packed.requiresRestart, true);
  assert.ok(packed.files.some((file) => file.path === "backend-dist/entry.mjs"));
  assert.ok(!packed.files.some((file) => file.path.startsWith("src/")), "源码不进包");

  const managedRoot = path.join(work, "managed");
  const handle = openInstallations({ managedRoot });
  try {
    const stage = path.join(handle.layout.stagingDir, "job-1");
    unpackExtensionPackage({ packagePath: packed.outFile, destDir: stage });
    assert.equal(verifyExtensionPackage({ treeDir: stage, trustedKeys: [{ publicKey: publicPem }] }).trust, `signed:${packed.keyId}`);
    const preflight = await preflightDirectory(stage, { managed: true });
    assert.equal(preflight.ok, true, JSON.stringify(preflight.errors));
    const dest = handle.layout.versionDir("fixture-echo-provider", "1.0.0");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(stage, dest);
    handle.commit((state) => {
      state.extensions["fixture-echo-provider"] = { current: "1.0.0", previous: null, sourceId: "local-file", state: "active", history: [] };
    }, { expectedRevision: 0 });
  } finally {
    handle.release();
  }
  const host = await loadExtensionHost({ repoRoot: REPO_ROOT, env: { [MANAGED_DIR_ENV]: managedRoot }, logger: () => undefined });
  const registration = host.registrations.find((entry) => entry.extensionId === "fixture-echo-provider");
  assert.equal(registration.managed, true);
  assert.deepEqual(host.managedRejected, []);
  // 隔离开启（缺省）：宿主不 import 包内后端，只得到 isolated 静态描述（config-schema.json 来自 build:backend）。
  const plugins = await host.createHostPlugins({});
  assert.equal(plugins.provider.some((entry) => entry.name === "fixture-echo-provider"), false);
  const isolated = plugins.isolated.find((entry) => entry.extensionId === "fixture-echo-provider");
  assert.deepEqual(isolated.origin, { managed: true, rootWritable: false });
  assert.equal(isolated.plugin.configPrefix, "providers.fixture-echo");
  assert.ok(isolated.entry.endsWith(path.join("backend-dist", "entry.mjs")));
  assert.ok(host.metadata.some((entry) => entry.extensionId === "fixture-echo-provider"));
  // 降级开关：隔离关闭时退回 P1 进程内装配。
  const inProcess = await loadExtensionHost({ repoRoot: REPO_ROOT, env: { [MANAGED_DIR_ENV]: managedRoot }, logger: () => undefined, isolation: false });
  const plugin = (await inProcess.createHostPlugins({})).provider.find((entry) => entry.name === "fixture-echo-provider");
  assert.deepEqual(plugin.origin, { managed: true, rootWritable: false });
  assert.equal(plugin.configPrefix, "providers.fixture-echo");
});

test("build:backend 产物自包含：除 node: 外没有外部 import，可直接 import 并构造插件", async (t) => {
  const dir = copyFixture(t, "fixture-echo-provider");
  const { buildExtensionBackend } = await import("../web/scripts/build-extension-backend.mjs");
  const result = await buildExtensionBackend({ cwd: dir });
  assert.deepEqual(result.exports.filter((name) => name !== "FIXTURE_ECHO_CONFIG").sort(), ["FIXTURE_ECHO_PLUGIN_METADATA", "createFixtureEchoProviderPlugin"]);
  // config-schema.json：打包机上求值一次，纯 JSON。
  const schema = JSON.parse(fs.readFileSync(path.join(dir, "backend-dist", "config-schema.json"), "utf8"));
  assert.equal(schema.plugin.name, "fixture-echo-provider");
  assert.equal(schema.metadata.value.extensionId, "fixture-echo-provider");
  const source = fs.readFileSync(result.outFile, "utf8");
  for (const match of source.matchAll(/^import .* from "([^"]+)";$/gm)) assert.match(match[1], /^node:/);
  const mod = await import(pathToFileURL(result.outFile).href);
  const plugin = mod.createFixtureEchoProviderPlugin();
  assert.equal(plugin.name, "fixture-echo-provider");
  assert.equal(mod.FIXTURE_ECHO_PLUGIN_METADATA.extensionId, "fixture-echo-provider");
});

test("build:backend 拒绝宿主/其他扩展运行时依赖与受管禁止声明", async (t) => {
  const dir = copyFixture(t, "fixture-echo-provider");
  fs.writeFileSync(path.join(dir, "src", "backend.ts"), 'import { createApplicationService } from "@woohaa3/application-service";\nexport const createFixtureEchoProviderPlugin = () => createApplicationService;\n');
  const { buildExtensionBackend } = await import("../web/scripts/build-extension-backend.mjs");
  await assert.rejects(() => buildExtensionBackend({ cwd: dir }), /不得依赖宿主/);
  const descriptor = JSON.parse(fs.readFileSync(path.join(dir, "extension.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "extension.json"), JSON.stringify({ ...descriptor, canvasContent: { module: "./backend", factory: "x" } }));
  await assert.rejects(() => buildExtensionBackend({ cwd: dir }), /canvasContent/);
});

test("打包纯前端 fixture：未签名包需显式允许；预检判定可热登记", async (t) => {
  const work = tmp(t);
  const packed = await packExtension({ dir: copyFixture(t, "fixture-panel"), out: path.join(work, "panel.wxt"), repoRoot: REPO_ROOT });
  assert.equal(packed.signed, false);
  assert.equal(packed.requiresRestart, false);
  assert.equal(packed.preflight.activation, "server-active");
  const stage = path.join(work, "stage");
  unpackExtensionPackage({ packagePath: packed.outFile, destDir: stage });
  assert.throws(() => verifyExtensionPackage({ treeDir: stage }), (error) => error.code === "MARKETPLACE_UNSIGNED_REJECTED");
  assert.equal(verifyExtensionPackage({ treeDir: stage, allowUnsigned: true }).trust, "unsigned");
  assert.ok(fs.existsSync(path.join(stage, "browser-dist", "artifact-manifest.json")));
});

test("受管预检不通过时不出包（例如声明 bootstrap）", async (t) => {
  const work = tmp(t);
  const dir = copyFixture(t, "fixture-panel");
  const descriptor = JSON.parse(fs.readFileSync(path.join(dir, "extension.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "extension.json"), JSON.stringify({ ...descriptor, required: true }));
  const out = path.join(work, "bad.wxt");
  await assert.rejects(() => packExtension({ dir, out, repoRoot: REPO_ROOT }), (error) => /受管预检未通过/.test(error.message) && error.issues?.some((issue) => issue.code === "MARKETPLACE_FORBIDDEN_DECLARATION"));
  assert.equal(fs.existsSync(out), false);
});
