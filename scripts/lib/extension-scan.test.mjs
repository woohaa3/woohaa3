/**
 * 扩展目录扫描单测
 * （change: 2026-10-15-add-scannable-extension-directories，任务 1.1–1.3）。
 *
 * 运行：`node --test scripts/lib/extension-scan.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ExtensionScanError,
  checkRootsCoveredByWorkspace,
  assertRootsCoveredByWorkspace,
  formatWorkspaceCoverageHint,
  resolveExtensionRoots,
  scanExtensions,
  readWorkspaceGlobs,
  browserExtensions
} from "./extension-scan.mjs";

const TEST_TMP_ROOT = "/data/tmp/opencode";

/**
 * 测试临时根：本机存在 `/data/tmp/opencode` 时沿用它（历史开发环境），否则回退到系统临时目录，
 * 使用例在普通环境（CI / 其它机器）也能跑。与 `makeRepo` 的取法一致。
 */
function tmpRoot() {
  return fs.existsSync(TEST_TMP_ROOT) ? TEST_TMP_ROOT : os.tmpdir();
}

function makeRepo(t) {
  const repoRoot = fs.mkdtempSync(path.join(tmpRoot(), "woohaa-ext-scan-"));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoRoot, "web", "extensions"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "extensions"), { recursive: true });
  return repoRoot;
}

function writeConfig(repoRoot, value) {
  fs.writeFileSync(path.join(repoRoot, "extensions.config.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function addExtension(dir, { name, extensionId = null, browser = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const packageName = name ?? `@woohaa3/extension-${path.basename(dir)}`;
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: packageName, version: "0.1.0" }, null, 2)}\n`);
  if (extensionId) {
    fs.writeFileSync(path.join(dir, "extension.json"), `${JSON.stringify({ schemaVersion: 1, extensionId }, null, 2)}\n`);
  }
  if (browser) {
    fs.mkdirSync(path.join(dir, "src", "frontend"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "frontend", "index.ts"), "export const descriptor = {};\n");
    fs.writeFileSync(path.join(dir, "src", "frontend", "metadata.ts"), `export const metadata = { extensionId: ${JSON.stringify(extensionId ?? path.basename(dir))} };\n`);
  }
  return dir;
}

test("缺省根：无配置与无环境变量时使用 web/extensions 与 extensions", (t) => {
  const repoRoot = makeRepo(t);
  const resolved = resolveExtensionRoots({ repoRoot, env: {} });
  assert.equal(resolved.source, "default");
  assert.deepEqual(resolved.roots, [path.join(repoRoot, "web/extensions"), path.join(repoRoot, "extensions")]);
});

test("配置文件提供根，并支持相对与绝对路径", (t) => {
  const repoRoot = makeRepo(t);
  const absolute = fs.mkdtempSync(path.join(tmpRoot(), "woohaa-ext-abs-"));
  t.after(() => fs.rmSync(absolute, { recursive: true, force: true }));
  writeConfig(repoRoot, { schemaVersion: 1, roots: ["extensions", absolute] });
  const resolved = resolveExtensionRoots({ repoRoot, env: {} });
  assert.equal(resolved.source, "config");
  assert.deepEqual(resolved.roots, [path.join(repoRoot, "extensions"), path.resolve(absolute)]);
});

test("环境变量完全覆盖配置文件", (t) => {
  const repoRoot = makeRepo(t);
  writeConfig(repoRoot, { schemaVersion: 1, roots: ["web/extensions"] });
  const env = { WOOHAA3_EXTENSION_DIRS: " extensions , web/extensions " };
  const resolved = resolveExtensionRoots({ repoRoot, env });
  assert.equal(resolved.source, "env");
  assert.deepEqual(resolved.roots, [path.join(repoRoot, "extensions"), path.join(repoRoot, "web/extensions")]);
});

test("根不存在时报错并指出来源", (t) => {
  const repoRoot = makeRepo(t);
  writeConfig(repoRoot, { schemaVersion: 1, roots: ["web/extensions", "missing-root"] });
  assert.throws(
    () => resolveExtensionRoots({ repoRoot, env: {} }),
    (error) => error instanceof ExtensionScanError && error.code === "EXTENSION_ROOT_MISSING" && error.message.includes("missing-root")
  );
});

test("配置非法时报错（schemaVersion / roots）", (t) => {
  const repoRoot = makeRepo(t);
  writeConfig(repoRoot, { schemaVersion: 2, roots: ["web/extensions"] });
  assert.throws(() => resolveExtensionRoots({ repoRoot, env: {} }), (error) => error.code === "EXTENSION_CONFIG_INVALID");
  writeConfig(repoRoot, { schemaVersion: 1, roots: [] });
  assert.throws(() => resolveExtensionRoots({ repoRoot, env: {} }), (error) => error.code === "EXTENSION_CONFIG_INVALID");
  fs.writeFileSync(path.join(repoRoot, "extensions.config.json"), "{ not json");
  assert.throws(() => resolveExtensionRoots({ repoRoot, env: {} }), (error) => error.code === "EXTENSION_CONFIG_INVALID");
});

test("可写根：配置对象条目与 WOOHAA3_EXTENSION_WRITABLE_DIRS 都生效", (t) => {
  const repoRoot = makeRepo(t);
  writeConfig(repoRoot, { schemaVersion: 1, roots: ["web/extensions", { path: "extensions", writable: true }] });
  const fromConfig = resolveExtensionRoots({ repoRoot, env: {} });
  assert.deepEqual(fromConfig.roots, [path.join(repoRoot, "web/extensions"), path.join(repoRoot, "extensions")]);
  assert.deepEqual(fromConfig.writableRoots, [path.join(repoRoot, "extensions")]);

  writeConfig(repoRoot, { schemaVersion: 1, roots: ["web/extensions", "extensions"] });
  const fromEnv = resolveExtensionRoots({ repoRoot, env: { WOOHAA3_EXTENSION_WRITABLE_DIRS: "extensions" } });
  assert.deepEqual(fromEnv.writableRoots, [path.join(repoRoot, "extensions")]);

  assert.throws(
    () => resolveExtensionRoots({ repoRoot, env: { WOOHAA3_EXTENSION_WRITABLE_DIRS: "somewhere/else" } }),
    (error) => error.code === "EXTENSION_WRITABLE_ROOT_UNKNOWN"
  );

  writeConfig(repoRoot, { schemaVersion: 1, roots: [{ path: "" }] });
  assert.throws(() => resolveExtensionRoots({ repoRoot, env: {} }), (error) => error.code === "EXTENSION_CONFIG_INVALID");
  writeConfig(repoRoot, { schemaVersion: 1, roots: [{ path: "web/extensions", writable: "yes" }] });
  assert.throws(() => resolveExtensionRoots({ repoRoot, env: {} }), (error) => error.code === "EXTENSION_CONFIG_INVALID");
  writeConfig(repoRoot, { schemaVersion: 1, roots: [42] });
  assert.throws(() => resolveExtensionRoots({ repoRoot, env: {} }), (error) => error.code === "EXTENSION_CONFIG_INVALID");
});

test("可写根：扫描结果带 rootWritable，普通根为 false", (t) => {
  const repoRoot = makeRepo(t);
  writeConfig(repoRoot, { schemaVersion: 1, roots: ["web/extensions", { path: "extensions", writable: true }] });
  addExtension(path.join(repoRoot, "web", "extensions", "builtin"), { extensionId: "builtin" });
  addExtension(path.join(repoRoot, "extensions", "dropped-in"), { extensionId: "dropped-in" });

  const scan = scanExtensions({ repoRoot, env: {} });
  assert.equal(scan.extensions.find((entry) => entry.extensionId === "builtin").rootWritable, false);
  assert.equal(scan.extensions.find((entry) => entry.extensionId === "dropped-in").rootWritable, true);
});

test("扫描：多根、稳定排序、第二根成员被包含", (t) => {
  const repoRoot = makeRepo(t);
  addExtension(path.join(repoRoot, "web", "extensions", "zeta"), { extensionId: "zeta" });
  addExtension(path.join(repoRoot, "web", "extensions", "alpha"), { extensionId: "alpha" });
  addExtension(path.join(repoRoot, "extensions", "second-root"), { extensionId: "beta" });

  const scan = scanExtensions({ repoRoot, env: {} });
  assert.deepEqual(
    scan.extensions.map((entry) => entry.extensionId),
    ["alpha", "beta", "zeta"]
  );
  const fromSecondRoot = scan.extensions.find((entry) => entry.extensionId === "beta");
  assert.equal(fromSecondRoot.root, path.join(repoRoot, "extensions"));
  assert.equal(fromSecondRoot.packageName, "@woohaa3/extension-second-root");
});

test("扫描：点前缀目录视为未安装，不进入扩展列表", (t) => {
  const repoRoot = makeRepo(t);
  addExtension(path.join(repoRoot, "web", "extensions", "live"), { extensionId: "live" });
  addExtension(path.join(repoRoot, "web", "extensions", ".disabled-one"), { extensionId: "disabled-one" });

  const scan = scanExtensions({ repoRoot, env: {} });
  assert.deepEqual(scan.extensions.map((entry) => entry.extensionId), ["live"]);
  assert.deepEqual(scan.disabled.map((entry) => entry.directory), [".disabled-one"]);
});

test("扫描：跨根重复 extensionId 报错并给出两个路径", (t) => {
  const repoRoot = makeRepo(t);
  addExtension(path.join(repoRoot, "web", "extensions", "dup-a"), { extensionId: "same-id" });
  addExtension(path.join(repoRoot, "extensions", "dup-b"), { extensionId: "same-id" });

  assert.throws(
    () => scanExtensions({ repoRoot, env: {} }),
    (error) =>
      error.code === "EXTENSION_ID_DUPLICATE" &&
      error.message.includes(path.join("web", "extensions", "dup-a")) &&
      error.message.includes(path.join("extensions", "dup-b"))
  );
});

test("扫描：非扩展目录与非法 package.json", (t) => {
  const repoRoot = makeRepo(t);
  fs.mkdirSync(path.join(repoRoot, "web", "extensions", "no-package"), { recursive: true });
  const other = path.join(repoRoot, "web", "extensions", "tool");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "package.json"), `${JSON.stringify({ name: "@woohaa3/tooling-thing" })}\n`);
  addExtension(path.join(repoRoot, "web", "extensions", "ok"), { extensionId: "ok" });

  const scan = scanExtensions({ repoRoot, env: {} });
  assert.deepEqual(scan.extensions.map((entry) => entry.extensionId), ["ok"]);
  const reasons = Object.fromEntries(scan.skipped.map((entry) => [entry.directory, entry.reason]));
  assert.equal(reasons["no-package"], "no-package-json");
  assert.equal(reasons.tool, "not-extension-package");

  fs.writeFileSync(path.join(other, "package.json"), "{ broken");
  fs.writeFileSync(path.join(other, "package.json"), `${JSON.stringify({ name: "@woohaa3/extension-broken" })}\n{ broken`);
  assert.throws(() => scanExtensions({ repoRoot, env: {} }), (error) => error.code === "EXTENSION_PACKAGE_INVALID");
});

test("扫描：声明缺失时以包名为 identity，声明存在时以声明为准", (t) => {
  const repoRoot = makeRepo(t);
  addExtension(path.join(repoRoot, "web", "extensions", "no-descriptor"));
  addExtension(path.join(repoRoot, "web", "extensions", "with-descriptor"), { extensionId: "declared-id" });

  const scan = scanExtensions({ repoRoot, env: {} });
  const noDescriptor = scan.extensions.find((entry) => entry.directory === "no-descriptor");
  assert.equal(noDescriptor.extensionId, "no-descriptor");
  assert.equal(noDescriptor.declaredId, null);
  const withDescriptor = scan.extensions.find((entry) => entry.directory === "with-descriptor");
  assert.equal(withDescriptor.extensionId, "declared-id");
  assert.equal(withDescriptor.declaredId, "declared-id");
});

test("扫描：browser 入口识别与过滤", (t) => {
  const repoRoot = makeRepo(t);
  addExtension(path.join(repoRoot, "web", "extensions", "browser-ext"), { extensionId: "browser-ext", browser: true });
  addExtension(path.join(repoRoot, "web", "extensions", "backend-only"), { extensionId: "backend-only" });

  const scan = scanExtensions({ repoRoot, env: {} });
  assert.deepEqual(browserExtensions(scan).map((entry) => entry.extensionId), ["browser-ext"]);
});

test("工作区覆盖检查：跨根 glob 覆盖，普通相对 glob 不覆盖", (t) => {
  const repoRoot = makeRepo(t);
  const workspaceFile = path.join(repoRoot, "web", "pnpm-workspace.yaml");
  fs.writeFileSync(
    workspaceFile,
    ["packages:", "  - contracts", "  - extensions/*", "  - ../extensions/*", "", "onlyBuiltDependencies:", "  - esbuild", ""].join("\n")
  );
  assert.deepEqual(readWorkspaceGlobs(workspaceFile), ["contracts", "extensions/*", "../extensions/*"]);

  const ok = checkRootsCoveredByWorkspace({
    repoRoot,
    roots: [path.join(repoRoot, "web", "extensions"), path.join(repoRoot, "extensions")],
    workspaceFile
  });
  assert.equal(ok.ok, true);

  const uncovered = checkRootsCoveredByWorkspace({
    repoRoot,
    roots: [path.join(repoRoot, "web", "extensions")],
    workspaceFile: path.join(repoRoot, "web", "pnpm-workspace-other.yaml")
  });
  assert.equal(uncovered.ok, false);
  assert.equal(uncovered.uncovered.length, 1);

  const hint = formatWorkspaceCoverageHint(uncovered, { repoRoot });
  assert.match(hint, /未被 web\/pnpm-workspace\.yaml 的 packages 覆盖/);
});

test("工作区覆盖检查：strict 时未覆盖根抛错，默认只提示", (t) => {
  const repoRoot = makeRepo(t);
  const workspaceFile = path.join(repoRoot, "web", "pnpm-workspace.yaml");
  fs.writeFileSync(workspaceFile, ["packages:", "  - extensions/*"].join("\n"));
  const roots = [path.join(repoRoot, "extensions")];

  const lenient = assertRootsCoveredByWorkspace({ repoRoot, roots, workspaceFile });
  assert.equal(lenient.ok, false);

  assert.throws(
    () => assertRootsCoveredByWorkspace({ repoRoot, roots, workspaceFile, strict: true }),
    (error) => error.code === "EXTENSION_ROOT_NOT_IN_WORKSPACE" && error.message.includes("extensions")
  );
});
