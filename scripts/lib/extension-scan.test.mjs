/**
 * 扩展目录扫描单测
 * （change: 2026-10-15-add-scannable-extension-directories，任务 1.1–1.3）。
 *
 * 运行：`node --test scripts/lib/extension-scan.test.mjs`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ExtensionScanError,
  checkRootsCoveredByWorkspace,
  assertRootsCoveredByWorkspace,
  compareExtensionVersions,
  formatWorkspaceCoverageHint,
  resolveExtensionRoots,
  scanExtensions,
  readWorkspaceGlobs,
  browserExtensions,
  originOf,
  EXTENSION_DEV_DIRS_ENV,
  EXTENSION_DEV_MODE_ENV
} from "./extension-scan.mjs";
import { MANAGED_DIR_ENV, managedLayout, openInstallations } from "./extension-installations.mjs";

const TEST_TMP_ROOT = "/data/tmp/opencode";

test("compareExtensionVersions：严格 semver 核心三段，非法版本排最前", () => {
  assert.equal(compareExtensionVersions("0.1.1", "0.1.0"), 1);
  assert.equal(compareExtensionVersions("0.1.0", "0.1.1"), -1);
  assert.equal(compareExtensionVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareExtensionVersions("1.0.0-beta.1", "1.0.0"), 0);
  assert.equal(compareExtensionVersions("bad", "0.0.1"), -1);
});

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

test("扫描：预构建 browser 扩展无需源码入口", (t) => {
  const repoRoot = makeRepo(t);
  const dir = path.join(repoRoot, "extensions", "prebuilt");
  addExtension(dir, { extensionId: "prebuilt" });
  fs.mkdirSync(path.join(dir, "browser-dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "browser-dist", "artifact-manifest.json"), "{}");
  const scan = scanExtensions({ repoRoot, env: {} });
  assert.equal(scan.extensions[0].hasBrowserEntry, false);
  assert.deepEqual(browserExtensions(scan).map(entry => entry.extensionId), ["prebuilt"]);
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

// ---------------------------------------------------------------------------
// 受管根（change: 2026-10-21-add-extension-marketplace-point，任务 4.1 / 4.3）
// ---------------------------------------------------------------------------

function writeManagedVersion(managedRoot, extensionId, version, { packageName, descriptorId = extensionId } = {}) {
  const dir = managedLayout(managedRoot).versionDir(extensionId, version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: packageName ?? `@woohaa3/extension-${extensionId}`, version }));
  fs.writeFileSync(path.join(dir, "extension.json"), JSON.stringify({ schemaVersion: 1, extensionId: descriptorId, version }));
  return dir;
}

function commitPointers(managedRoot, pointers) {
  const handle = openInstallations({ managedRoot });
  try {
    const state = handle.read();
    handle.commit((draft) => {
      for (const [id, current] of Object.entries(pointers)) draft.extensions[id] = { current, previous: null, sourceId: "local-file", state: "active", history: [] };
    }, { expectedRevision: state.revision });
  } finally {
    handle.release();
  }
}

test("受管根：缺省位于仓库根 .woohaa3/extensions，不存在时视为空", (t) => {
  const repoRoot = makeRepo(t);
  const scan = scanExtensions({ repoRoot, env: {} });
  assert.equal(scan.managedRoot, path.join(repoRoot, ".woohaa3", "extensions"));
  assert.deepEqual(scan.warnings, []);
  assert.equal(scan.extensions.some((entry) => entry.managed), false);
});

test("受管根：按版本指针加入记录，带 managed / managedVersion，rootWritable=false", (t) => {
  const repoRoot = makeRepo(t);
  const managedRoot = path.join(repoRoot, "data", "managed");
  writeManagedVersion(managedRoot, "foo", "1.0.0");
  const current = writeManagedVersion(managedRoot, "foo", "1.1.0");
  commitPointers(managedRoot, { foo: "1.1.0" });
  const scan = scanExtensions({ repoRoot, env: { [MANAGED_DIR_ENV]: managedRoot } });
  const record = scan.extensions.find((entry) => entry.extensionId === "foo");
  assert.equal(record.dir, current);
  assert.equal(record.managed, true);
  assert.equal(record.managedVersion, "1.1.0");
  assert.equal(record.rootWritable, false);
  assert.equal(record.root, managedRoot);
});

test("受管根：指针目录被删 / 身份不一致 / 包名不符只告警跳过，不让扫描失败", (t) => {
  const repoRoot = makeRepo(t);
  const managedRoot = path.join(repoRoot, "data", "managed");
  writeManagedVersion(managedRoot, "ok", "1.0.0");
  writeManagedVersion(managedRoot, "liar", "1.0.0", { descriptorId: "someone-else" });
  writeManagedVersion(managedRoot, "badpkg", "1.0.0", { packageName: "left-pad" });
  commitPointers(managedRoot, { ok: "1.0.0", gone: "2.0.0", liar: "1.0.0", badpkg: "1.0.0" });
  const scan = scanExtensions({ repoRoot, env: { [MANAGED_DIR_ENV]: managedRoot } });
  assert.deepEqual(scan.extensions.filter((entry) => entry.managed).map((entry) => entry.extensionId), ["ok"]);
  const codes = Object.fromEntries(scan.warnings.map((warning) => [warning.extensionId, warning.code]));
  assert.equal(codes.gone, "EXTENSION_MANAGED_VERSION_MISSING");
  assert.equal(codes.liar, "EXTENSION_MANAGED_IDENTITY_MISMATCH");
  assert.equal(codes.badpkg, "EXTENSION_MANAGED_PACKAGE_INVALID");
});

test("受管根：损坏的 installations.json 只告警，内置扩展照常扫描", (t) => {
  const repoRoot = makeRepo(t);
  addExtension(path.join(repoRoot, "web", "extensions", "alpha"), { extensionId: "alpha" });
  const managedRoot = path.join(repoRoot, "data", "managed");
  fs.mkdirSync(managedRoot, { recursive: true });
  fs.writeFileSync(path.join(managedRoot, "installations.json"), "{");
  const scan = scanExtensions({ repoRoot, env: { [MANAGED_DIR_ENV]: managedRoot } });
  assert.deepEqual(scan.extensions.map((entry) => entry.extensionId), ["alpha"]);
  assert.equal(scan.warnings[0].code, "EXTENSION_MANAGED_INSTALLATIONS_INVALID");
});

test("受管根：同 id 且 semver 更高时受管版本覆盖内置，并保留内置版本/目录", (t) => {
  const repoRoot = makeRepo(t);
  addExtension(path.join(repoRoot, "web", "extensions", "alpha"), { extensionId: "alpha" });
  const managedRoot = path.join(repoRoot, "data", "managed");
  writeManagedVersion(managedRoot, "alpha", "9.0.0");
  commitPointers(managedRoot, { alpha: "9.0.0" });
  const scan = scanExtensions({ repoRoot, env: { [MANAGED_DIR_ENV]: managedRoot } });
  const alpha = scan.extensions.filter((entry) => entry.extensionId === "alpha");
  assert.equal(alpha.length, 1);
  assert.equal(alpha[0].managed, true);
  assert.equal(alpha[0].managedVersion, "9.0.0");
  assert.equal(alpha[0].builtinVersion, "0.1.0");
  assert.equal(scan.warnings[0].code, "EXTENSION_MANAGED_OVERRIDES_BUILTIN");
  assert.deepEqual(
    scan.builtinExtensions.map((entry) => [entry.extensionId, entry.version]),
    [["alpha", "0.1.0"]]
  );
});

test("受管根：同 id 但版本不高于内置（含同版本）时内置优先并告警", (t) => {
  const repoRoot = makeRepo(t);
  addExtension(path.join(repoRoot, "web", "extensions", "alpha"), { extensionId: "alpha" });
  const managedRoot = path.join(repoRoot, "data", "managed");
  writeManagedVersion(managedRoot, "alpha", "0.1.0");
  commitPointers(managedRoot, { alpha: "0.1.0" });
  const scan = scanExtensions({ repoRoot, env: { [MANAGED_DIR_ENV]: managedRoot } });
  const alpha = scan.extensions.filter((entry) => entry.extensionId === "alpha");
  assert.equal(alpha.length, 1);
  assert.equal(alpha[0].managed, undefined);
  assert.equal(scan.warnings[0].code, "EXTENSION_MANAGED_SHADOWED");
});

test("受管根不能与配置根重叠", (t) => {
  const repoRoot = makeRepo(t);
  assert.throws(
    () => resolveExtensionRoots({ repoRoot, env: { [MANAGED_DIR_ENV]: path.join(repoRoot, "web", "extensions", "managed") } }),
    (error) => error instanceof ExtensionScanError && error.code === "EXTENSION_MANAGED_ROOT_OVERLAP"
  );
});


describe("开发者模式 dev-source（change: 2026-10-27-add-extension-dev-reload）", () => {
  test("登记目录后以 dev 来源进入扫描结果", (t) => {
    const repoRoot = makeRepo(t);
    writeConfig(repoRoot, { schemaVersion: 1, roots: ["web/extensions"] });
    const devDir = path.join(repoRoot, "outside", "my-ext");
    addExtension(devDir, { extensionId: "my-ext" });

    const scan = scanExtensions({ repoRoot, env: { [EXTENSION_DEV_DIRS_ENV]: devDir, [EXTENSION_DEV_MODE_ENV]: "1" } });
    const record = scan.extensions.find((entry) => entry.extensionId === "my-ext");
    assert.ok(record, "开发者目录应被扫描到");
    assert.equal(record.origin, "dev");
    assert.equal(record.dev, true);
    assert.equal(originOf(record), "dev");
  });

  test("父目录登记时扫描其中的扩展", (t) => {
    const repoRoot = makeRepo(t);
    writeConfig(repoRoot, { schemaVersion: 1, roots: ["web/extensions"] });
    const parent = path.join(repoRoot, "workspace");
    addExtension(path.join(parent, "alpha"), { extensionId: "alpha" });
    addExtension(path.join(parent, "beta"), { extensionId: "beta" });

    const scan = scanExtensions({ repoRoot, env: { [EXTENSION_DEV_DIRS_ENV]: parent, [EXTENSION_DEV_MODE_ENV]: "1" } });
    assert.deepEqual(
      scan.extensions.filter((entry) => entry.origin === "dev").map((entry) => entry.extensionId),
      ["alpha", "beta"]
    );
  });

  test("优先级 dev > managed > builtin，并记录被覆盖的形态", (t) => {
    const repoRoot = makeRepo(t);
    writeConfig(repoRoot, { schemaVersion: 1, roots: ["web/extensions"] });
    addExtension(path.join(repoRoot, "web", "extensions", "shared"), { extensionId: "shared" });

    // 受管根放一个更高的版本，本该覆盖内置。
    const managedRoot = path.join(repoRoot, ".woohaa3", "extensions");
    writeManagedVersion(managedRoot, "shared", "9.9.9");
    commitPointers(managedRoot, { shared: "9.9.9" });

    const withDev = scanExtensions({
      repoRoot,
      env: { [EXTENSION_DEV_DIRS_ENV]: path.join(repoRoot, "dev", "shared"), [MANAGED_DIR_ENV]: managedRoot, [EXTENSION_DEV_MODE_ENV]: "1" }
    });
    assert.equal(withDev.extensions.find((entry) => entry.extensionId === "shared")?.origin, "managed");

    const devDir = path.join(repoRoot, "dev", "shared");
    addExtension(devDir, { extensionId: "shared" });
    const scan = scanExtensions({ repoRoot, env: { [EXTENSION_DEV_DIRS_ENV]: devDir, [MANAGED_DIR_ENV]: managedRoot, [EXTENSION_DEV_MODE_ENV]: "1" } });
    const record = scan.extensions.find((entry) => entry.extensionId === "shared");
    assert.equal(record.origin, "dev", "dev 应高于 managed");
    assert.equal(record.shadowedOrigin, "managed");
    assert.ok(scan.warnings.some((warning) => warning.code === "EXTENSION_DEV_OVERRIDES_INSTALLED"));
  });

  test("没有开发开关时不提供入口（发布形态）", (t) => {
    const repoRoot = makeRepo(t);
    writeConfig(repoRoot, { schemaVersion: 1, roots: ["web/extensions"] });
    const devDir = path.join(repoRoot, "outside", "prod-ext");
    addExtension(devDir, { extensionId: "prod-ext" });

    // 桌面宿主发布形态同样设 NODE_ENV=production，因此判定只认显式开关：
    // 没有开关时，即便登记了目录也不装配。
    for (const env of [
      { [EXTENSION_DEV_DIRS_ENV]: devDir },
      { [EXTENSION_DEV_DIRS_ENV]: devDir, NODE_ENV: "production" },
      { [EXTENSION_DEV_DIRS_ENV]: devDir, [EXTENSION_DEV_MODE_ENV]: "0" }
    ]) {
      const scan = scanExtensions({ repoRoot, env });
      assert.equal(scan.extensions.find((entry) => entry.extensionId === "prod-ext"), undefined);
      assert.deepEqual(scan.devDirs, []);
    }

    const enabled = scanExtensions({ repoRoot, env: { [EXTENSION_DEV_DIRS_ENV]: devDir, [EXTENSION_DEV_MODE_ENV]: "1" } });
    assert.ok(enabled.extensions.find((entry) => entry.extensionId === "prod-ext"));
  });

  test("非法目录只告警跳过，不影响其它扩展与宿主启动", (t) => {
    const repoRoot = makeRepo(t);
    writeConfig(repoRoot, { schemaVersion: 1, roots: ["web/extensions"] });
    addExtension(path.join(repoRoot, "web", "extensions", "kept"), { extensionId: "kept" });
    const parent = path.join(repoRoot, "devroot");
    fs.mkdirSync(path.join(parent, "not-an-extension"), { recursive: true }); // 既无包名也无声明
    addExtension(path.join(parent, "fine"), { extensionId: "fine" });

    const scan = scanExtensions({ repoRoot, env: { [EXTENSION_DEV_DIRS_ENV]: `${path.join(repoRoot, "missing-dir")},${parent}`, [EXTENSION_DEV_MODE_ENV]: "1" } });
    const ids = scan.extensions.map((entry) => entry.extensionId).sort();
    assert.deepEqual(ids, ["fine", "kept"]);
    assert.ok(scan.warnings.some((warning) => warning.code === "EXTENSION_DEV_DIR_MISSING"));
    assert.ok(scan.warnings.some((warning) => warning.code === "EXTENSION_DEV_REJECTED"));
  });

  test("同一扩展重复登记只保留第一个并告警", (t) => {
    const repoRoot = makeRepo(t);
    writeConfig(repoRoot, { schemaVersion: 1, roots: ["web/extensions"] });
    const first = path.join(repoRoot, "a", "dup");
    const second = path.join(repoRoot, "b", "dup");
    addExtension(first, { extensionId: "dup" });
    addExtension(second, { extensionId: "dup" });

    const scan = scanExtensions({ repoRoot, env: { [EXTENSION_DEV_DIRS_ENV]: `${path.join(repoRoot, "a")},${path.join(repoRoot, "b")}`, [EXTENSION_DEV_MODE_ENV]: "1" } });
    assert.deepEqual(scan.extensions.filter((entry) => entry.extensionId === "dup").map((entry) => entry.dir), [first]);
    assert.ok(scan.warnings.some((warning) => warning.code === "EXTENSION_DEV_DUPLICATE"));
  });

  test("dev-source 不写 installations.json", (t) => {
    const repoRoot = makeRepo(t);
    writeConfig(repoRoot, { schemaVersion: 1, roots: ["web/extensions"] });
    const managedRoot = path.join(repoRoot, ".woohaa3", "extensions");
    fs.mkdirSync(managedRoot, { recursive: true });
    const installationsFile = path.join(managedRoot, "installations.json");
    const before = JSON.stringify({ schemaVersion: 1, revision: 3, extensions: {} });
    fs.writeFileSync(installationsFile, before);

    const devDir = path.join(repoRoot, "dev", "installed-like");
    addExtension(devDir, { extensionId: "installed-like" });
    scanExtensions({ repoRoot, env: { [EXTENSION_DEV_DIRS_ENV]: devDir, [MANAGED_DIR_ENV]: managedRoot, [EXTENSION_DEV_MODE_ENV]: "1" } });

    assert.equal(fs.readFileSync(installationsFile, "utf8"), before, "开发者模式不得改写安装记录");
  });
});
