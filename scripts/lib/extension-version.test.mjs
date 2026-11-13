/**
 * 扩展版本治理单测（change: 2026-11-13-add-extension-version-governance）。
 *
 * 覆盖三段：版本比较与递增、一致性判定、四处写回与 CHANGELOG。
 *
 * 运行：`node --test scripts/lib/extension-version.test.mjs`
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXTENSION_VERSION_CODES,
  appendChangelog,
  changedSince,
  compareVersions,
  incrementVersion,
  isStrictVersion,
  metadataObjectRange,
  readVersionDeclarations,
  resolveNextVersion,
  versionProblems,
  writeVersionDeclarations
} from "./extension-version.mjs";

function fixture({
  descriptor = {},
  pkg = {},
  metadata = 'export const M = {\n  version: "0.1.0"\n};\n',
  shared = null
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-version-"));
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
  if (shared !== null) {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/shared.ts"), shared);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// 版本比较与递增
// ---------------------------------------------------------------------------

test("isStrictVersion 只接受三段 semver", () => {
  assert.equal(isStrictVersion("1.2.3"), true);
  assert.equal(isStrictVersion("1.2"), false);
  assert.equal(isStrictVersion("1.2.3-beta.1"), false);
  assert.equal(isStrictVersion("01.2.3"), false);
  assert.equal(isStrictVersion(undefined), false);
});

test("compareVersions 按段比较，非法值返回 null 而不是猜", () => {
  assert.equal(compareVersions("1.2.10", "1.2.9"), 1);
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("2.0.0", "10.0.0"), -1);
  assert.equal(compareVersions("bad", "1.0.0"), null);
  assert.equal(compareVersions("1.0.0", undefined), null);
});

test("incrementVersion 三种递增与清零规则", () => {
  assert.equal(incrementVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(incrementVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(incrementVersion("1.2.3", "major"), "2.0.0");
  assert.equal(incrementVersion("0.1.0", "major"), "1.0.0");
  assert.equal(incrementVersion("bad", "patch"), null);
  assert.equal(incrementVersion("1.0.0", "nonsense"), null);
});

test("resolveNextVersion 拒绝等值与降级，接受显式更高版本", () => {
  assert.equal(resolveNextVersion("0.1.0", { kind: "patch" }), "0.1.1");
  assert.equal(resolveNextVersion("0.1.0", { version: "1.0.0" }), "1.0.0");
  assert.throws(() => resolveNextVersion("0.1.1", { version: "0.1.1" }), /不高于当前版本/);
  assert.throws(() => resolveNextVersion("0.1.1", { version: "0.1.0" }), /不高于当前版本/);
  assert.throws(() => resolveNextVersion("0.1.1", { version: "1.0" }), /严格三段/);
  assert.throws(() => resolveNextVersion("0.1.1", {}), /未指定递增方式/);
  assert.throws(() => resolveNextVersion("nope", { kind: "patch" }), /不是严格三段/);
});

// ---------------------------------------------------------------------------
// 一致性
// ---------------------------------------------------------------------------

test("缺 extension.json.version 只报 MISSING，不叠加其余比对", () => {
  const problems = versionProblems({
    extensionId: "demo",
    descriptor: { site: { version: "1.0.0" } },
    packageVersion: "0.1.0"
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, EXTENSION_VERSION_CODES.missing);
  assert.equal(problems[0].field, "extension.json.version");
});

test("四处一致时无问题", () => {
  const problems = versionProblems({
    extensionId: "demo",
    descriptor: { version: "1.2.3", site: { version: "1.2.3" } },
    packageVersion: "1.2.3",
    metadataVersion: "1.2.3"
  });
  assert.deepEqual(problems, []);
});

test("site / package / metadata 任一分叉都报 MISMATCH 并指字段", () => {
  const base = { version: "1.2.3", site: { version: "1.2.3" } };
  const one = versionProblems({ extensionId: "demo", descriptor: base, packageVersion: "1.2.4", metadataVersion: "1.2.3" });
  assert.deepEqual(one.map((p) => p.field), ["package.json.version"]);

  const two = versionProblems({ extensionId: "demo", descriptor: { version: "1.2.3", site: { version: "9.9.9" } }, packageVersion: "1.2.3" });
  assert.deepEqual(two.map((p) => p.field), ["extension.json.site.version"]);

  const three = versionProblems({ extensionId: "demo", descriptor: base, packageVersion: "1.2.3", metadataVersion: "0.1.0" });
  assert.deepEqual(three.map((p) => p.field), ["metadata.version"]);
  assert.match(three[0].message, /0\.1\.0.*1\.2\.3/);
});

test("无 site 段与无 metadata 时跳过对应比对", () => {
  const problems = versionProblems({ extensionId: "demo", descriptor: { version: "0.1.0" }, packageVersion: "0.1.0" });
  assert.deepEqual(problems, []);
});

test("metadataVersions 字面量逐条比对并指出文件", () => {
  const problems = versionProblems({
    extensionId: "demo",
    descriptor: { version: "0.1.0" },
    packageVersion: "0.1.0",
    metadataVersions: [{ file: "src/shared.ts", value: "1.0.0" }]
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].field, "metadata.version");
  assert.match(problems[0].message, /metadata\.version（src\/shared\.ts）.*1\.0\.0.*0\.1\.0/);
});

test("分发版本非法时只报格式错误", () => {
  const problems = versionProblems({ extensionId: "demo", descriptor: { version: "0.1" }, packageVersion: "0.1" });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, EXTENSION_VERSION_CODES.mismatch);
  assert.match(problems[0].message, /严格三段/);
});

// ---------------------------------------------------------------------------
// 读取与写回
// ---------------------------------------------------------------------------

test("readVersionDeclarations 收集字面量，跳过间接引用", () => {
  const dir = fixture({
    descriptor: { metadata: { module: "./shared", export: "SHARED" } },
    metadata: 'export const M = {\n  version: SHARED.version\n};\n',
    shared: 'export const SHARED = {\n  version: "0.1.0"\n};\n'
  });
  const declarations = readVersionDeclarations(dir);
  assert.equal(declarations.extensionId, "demo");
  assert.equal(declarations.distributionVersion, "0.1.0");
  // metadata.ts 是间接引用，不进字面量列表；shared.ts 的元数据字面量进。
  assert.deepEqual(declarations.metadataVersions, [{ file: "src/shared.ts", value: "0.1.0" }]);
});

test("readVersionDeclarations：未声明 metadata.export 时不读 shared.ts", () => {
  const dir = fixture({
    metadata: null,
    shared: 'export const SHARED = {\n  version: "0.1.0"\n};\n'
  });
  // 没有权威导出名就无从判断哪一处是扩展版本：宁可不读，也不能猜。
  assert.deepEqual(readVersionDeclarations(dir).metadataVersions, []);
});

test("writeVersionDeclarations 一次改全四处", () => {
  const dir = fixture();
  const declarations = readVersionDeclarations(dir);
  const changed = writeVersionDeclarations(declarations, "0.2.0");
  assert.deepEqual(changed.sort(), ["extension.json", "package.json", "src/frontend/metadata.ts"]);

  const after = readVersionDeclarations(dir);
  assert.equal(after.descriptor.version, "0.2.0");
  assert.equal(after.packageJson.version, "0.2.0");
  assert.deepEqual(after.metadataVersions, [{ file: "src/frontend/metadata.ts", value: "0.2.0" }]);
  assert.deepEqual(versionProblems({ extensionId: "demo", descriptor: after.descriptor, packageVersion: after.packageJson.version, metadataVersion: "0.2.0" }), []);
});

test("writeVersionDeclarations 同步 site.version", () => {
  const dir = fixture({ descriptor: { site: { name: "n", description: "d", version: "0.1.0", configSchema: { schemaId: "s", schemaVersion: 1 }, capabilities: [{ id: "c", kind: "handler", description: "d" }], defaultEnabled: true } } });
  writeVersionDeclarations(readVersionDeclarations(dir), "0.1.1");
  const after = readVersionDeclarations(dir);
  assert.equal(after.descriptor.version, "0.1.1");
  assert.equal(after.descriptor.site.version, "0.1.1");
});

test("writeVersionDeclarations 不改无关字段", () => {
  const dir = fixture({ descriptor: { hostPlugin: { module: "./backend", factory: "createDemo" } } });
  const before = JSON.parse(fs.readFileSync(path.join(dir, "extension.json"), "utf8"));
  writeVersionDeclarations(readVersionDeclarations(dir), "0.1.1");
  const after = JSON.parse(fs.readFileSync(path.join(dir, "extension.json"), "utf8"));
  assert.deepEqual(after.hostPlugin, before.hostPlugin);
  assert.equal(after.extensionId, before.extensionId);
});

test("写回后不留临时文件", () => {
  const dir = fixture();
  writeVersionDeclarations(readVersionDeclarations(dir), "0.1.1");
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

// ---------------------------------------------------------------------------
// CHANGELOG
// ---------------------------------------------------------------------------

test("appendChangelog 建文件与追加同版本条目", () => {
  const dir = fixture();
  appendChangelog(dir, { from: "0.1.0", to: "0.2.0", note: "首次发版" });
  let text = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
  assert.match(text, /## 0\.2\.0/);
  assert.match(text, /0\.2\.0.*上一版 `0\.1\.0`.*首次发版/);

  appendChangelog(dir, { from: "0.2.0", to: "0.3.0" });
  text = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
  assert.match(text, /## 0\.3\.0/);
  assert.match(text, /## 0\.2\.0/);
});

// ---------------------------------------------------------------------------
// 改动检测
// ---------------------------------------------------------------------------

function gitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-version-git-"));
  const run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "test"]);
  return { root, run };
}

test("changedSince：改了没 bump 时列出改动文件", () => {
  const { root, run } = gitRepo();
  const dir = path.join(root, "ext");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "extension.json"), '{"schemaVersion":1,"extensionId":"demo","version":"0.1.0"}\n');
  run(["add", "."]);
  run(["commit", "-qm", "init"]);
  fs.appendFileSync(path.join(dir, "extension.json"), "\n");
  const result = changedSince({ repoRoot: root, base: "HEAD", dir });
  assert.equal(result.available, true);
  assert.deepEqual(result.changed, ["ext/extension.json"]);
});

test("changedSince：未改动时为空", () => {
  const { root, run } = gitRepo();
  const dir = path.join(root, "ext");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "extension.json"), "{}\n");
  run(["add", "."]);
  run(["commit", "-qm", "init"]);
  const result = changedSince({ repoRoot: root, base: "HEAD", dir });
  assert.equal(result.available, true);
  assert.deepEqual(result.changed, []);
});

test("changedSince：无基线、非法基线、非 git 都按不可用返回", () => {
  assert.deepEqual(changedSince({ repoRoot: os.tmpdir(), base: undefined, dir: os.tmpdir() }), {
    available: false,
    reason: "未提供 --bump-base"
  });

  const { root } = gitRepo();
  const invalid = changedSince({ repoRoot: root, base: "no-such-rev", dir: root });
  assert.equal(invalid.available, false);
  assert.equal(invalid.invalidBase, true);

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ext-version-nogit-"));
  const noGit = changedSince({ repoRoot: plain, base: "HEAD", dir: plain });
  assert.equal(noGit.available, false);
});

test("unreleasedChanges：改了且版本未变 → bumped=false", async () => {
  const { unreleasedChanges } = await import("./extension-version.mjs");
  const { root, run } = gitRepo();
  const dir = path.join(root, "ext");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "extension.json"), '{"schemaVersion":1,"extensionId":"demo","version":"0.1.0"}\n');
  run(["add", "."]);
  run(["commit", "-qm", "init"]);
  fs.appendFileSync(path.join(dir, "extension.json"), "\n");
  const result = unreleasedChanges({ repoRoot: root, base: "HEAD", dir, currentVersion: "0.1.0" });
  assert.equal(result.available, true);
  assert.equal(result.bumped, false);
  assert.equal(result.previous, "0.1.0");
});

test("unreleasedChanges：改了且版本已推进 → bumped=true", async () => {
  const { unreleasedChanges } = await import("./extension-version.mjs");
  const { root, run } = gitRepo();
  const dir = path.join(root, "ext");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "extension.json"), '{"schemaVersion":1,"extensionId":"demo","version":"0.1.0"}\n');
  run(["add", "."]);
  run(["commit", "-qm", "init"]);
  fs.writeFileSync(path.join(dir, "extension.json"), '{"schemaVersion":1,"extensionId":"demo","version":"0.1.1"}\n');
  const result = unreleasedChanges({ repoRoot: root, base: "HEAD", dir, currentVersion: "0.1.1" });
  assert.equal(result.bumped, true);
  assert.equal(result.previous, "0.1.0");
});

test("unreleasedChanges：新增目录（基线上不存在）视为已 bump", async () => {
  const { unreleasedChanges } = await import("./extension-version.mjs");
  const { root, run } = gitRepo();
  fs.writeFileSync(path.join(root, "seed.txt"), "x\n");
  run(["add", "."]);
  run(["commit", "-qm", "init"]);
  const dir = path.join(root, "ext");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "extension.json"), '{"schemaVersion":1,"extensionId":"demo","version":"0.1.0"}\n');
  const result = unreleasedChanges({ repoRoot: root, base: "HEAD", dir, currentVersion: "0.1.0" });
  assert.equal(result.bumped, true);
  assert.equal(result.previous, null);
});

test("unreleasedChanges：无基线时 available=false", async () => {
  const { unreleasedChanges } = await import("./extension-version.mjs");
  const result = unreleasedChanges({ repoRoot: os.tmpdir(), base: null, dir: os.tmpdir(), currentVersion: "0.1.0" });
  assert.equal(result.available, false);
});

test("resolveNextVersion：version 为 null（CLI 缺省）时按 kind 递增", () => {
  assert.equal(resolveNextVersion("0.1.0", { kind: "patch", version: null }), "0.1.1");
  assert.equal(resolveNextVersion("0.1.0", { kind: "minor", version: null }), "0.2.0");
  assert.throws(() => resolveNextVersion("0.1.0", { kind: null, version: null }), /未指定递增方式/);
});

// ---------------------------------------------------------------------------
// 只改元数据对象内部（真实陷阱：sdk-agent 的 engine 版本描述符）
// ---------------------------------------------------------------------------

test("writeVersionDeclarations 不误改元数据对象之外的 version 字面量", () => {
  const dir = fixture({
    descriptor: { metadata: { module: "./shared", export: "DEMO_METADATA" } },
    metadata: null,
    shared: [
      "export const DEMO_METADATA = {",
      '  extensionId: "demo",',
      '  version: "0.1.0"',
      "};",
      "",
      "export function engineFor(id) {",
      '  if (id === "a") return { engine: "a-sdk", version: "0.1.0" };',
      '  return { engine: "b-sdk", version: "0.1.0" };',
      "}",
      ""
    ].join("\n")
  });
  writeVersionDeclarations(readVersionDeclarations(dir), "0.2.0");
  const text = fs.readFileSync(path.join(dir, "src/shared.ts"), "utf8");
  // 元数据对象内的版本已推进。
  assert.match(text, /DEMO_METADATA = \{\n {2}extensionId: "demo",\n {2}version: "0\.2\.0"/);
  // 函数体内的 engine 版本描述符必须原样保留。
  assert.equal((text.match(/version: "0\.1\.0"/g) ?? []).length, 2);
  assert.equal((text.match(/version: "0\.2\.0"/g) ?? []).length, 1);
});

test("readVersionDeclarations 只收集元数据对象内的版本", () => {
  const dir = fixture({
    descriptor: { metadata: { module: "./shared", export: "DEMO_METADATA" } },
    metadata: null,
    shared: [
      "export const DEMO_METADATA = {",
      '  version: "0.1.0"',
      "};",
      'const other = { engine: "x", version: "9.9.9" };',
      ""
    ].join("\n")
  });
  assert.deepEqual(readVersionDeclarations(dir).metadataVersions, [{ file: "src/shared.ts", value: "0.1.0" }]);
});

test("metadataObjectRange 花括号配对跳过字符串里的括号", () => {
  const source = ['export const M = {', '  description: "a } b { c",', '  version: "0.1.0"', "};", "const after = 1;"].join("\n");
  const range = metadataObjectRange(source, "M");
  assert.ok(range);
  assert.equal(source.slice(range.start, range.end).trim().endsWith("}"), true);
  assert.equal(source.slice(range.start, range.end).includes('version: "0.1.0"'), true);
});

test("metadataObjectRange 找不到导出时返回 null（不猜）", () => {
  assert.equal(metadataObjectRange('export const OTHER = { version: "0.1.0" };', "M"), null);
  assert.equal(metadataObjectRange('export const M = 1;', "M"), null);
  assert.equal(metadataObjectRange("", "M"), null);
});
