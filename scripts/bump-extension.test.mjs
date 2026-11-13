/**
 * `pnpm ext:bump` 单测（change: 2026-11-13-add-extension-version-governance）。
 *
 * 覆盖：三种递增、显式版本、等值/降级拒绝、无 metadata 时跳过、当前不一致时拒绝、
 * 目录/extensionId 两种定位、dry-run 不写盘、CHANGELOG 记录。
 *
 * 运行：`node --test scripts/bump-extension.test.mjs`
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BumpError, bumpExtension, parseArgs, resolveExtensionDirectory } from "./bump-extension.mjs";
import { readVersionDeclarations, versionProblems } from "./lib/extension-version.mjs";

function repo({ id = "demo", version = "0.1.0", metadata = true, site = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-bump-"));
  fs.writeFileSync(path.join(root, "extensions.config.json"), JSON.stringify({ schemaVersion: 1, roots: ["extensions"] }));
  const dir = path.join(root, "extensions", id);
  fs.mkdirSync(dir, { recursive: true });
  const descriptor = { schemaVersion: 1, extensionId: id, version };
  if (site) {
    descriptor.site = {
      name: "演示",
      description: "演示扩展",
      version,
      configSchema: { schemaId: "demo", schemaVersion: 1 },
      capabilities: [{ id: "demo.run", kind: "handler", description: "跑一下" }],
      defaultEnabled: true
    };
  }
  fs.writeFileSync(path.join(dir, "extension.json"), `${JSON.stringify(descriptor, null, 2)}\n`);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: `@woohaa3/extension-${id}`, version, type: "module" }, null, 2)}\n`
  );
  if (metadata) {
    fs.mkdirSync(path.join(dir, "src/frontend"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/frontend/metadata.ts"), `export const M = {\n  version: "${version}"\n};\n`);
  }
  return { root, dir, id };
}

test("parseArgs：递增方式与显式版本互斥，缺目标或缺方式都报错", () => {
  assert.deepEqual(parseArgs(["demo", "--patch"]), {
    target: "demo",
    kind: "patch",
    version: null,
    note: null,
    dryRun: false,
    align: false,
    json: false,
    help: false
  });
  assert.equal(parseArgs(["demo", "--version", "1.0.0"]).version, "1.0.0");
  assert.throws(() => parseArgs(["demo"]), /--patch/);
  assert.throws(() => parseArgs(["--patch"]), /extensionId 或目录/);
  assert.throws(() => parseArgs(["demo", "--patch", "--minor"]), /只能指定一种/);
  assert.throws(() => parseArgs(["demo", "--patch", "--version", "1.0.0"]), /不能与/);
});

test("parseArgs：--align 单独使用，不能与递增方式混用", () => {
  assert.equal(parseArgs(["demo", "--align"]).align, true);
  // --align 不需要递增方式（它把分叉收口到最高值）。
  assert.equal(parseArgs(["demo", "--align"]).kind, null);
  assert.throws(() => parseArgs(["demo", "--align", "--patch"]), /--align 不能与/);
  assert.throws(() => parseArgs(["demo", "--align", "--version", "2.0.0"]), /--align 不能与/);
});

test("resolveExtensionDirectory 接受 extensionId 与目录两种写法", () => {
  const { root, dir, id } = repo();
  assert.equal(resolveExtensionDirectory(id, { repoRoot: root }), dir);
  assert.equal(resolveExtensionDirectory(path.join("extensions", id), { repoRoot: root }), dir);
  assert.throws(() => resolveExtensionDirectory("missing", { repoRoot: root }), BumpError);
});

test("bumpExtension patch：四处同时推进并写 CHANGELOG", () => {
  const { root, dir, id } = repo();
  const result = bumpExtension(id, { kind: "patch", note: "修一个崩溃", repoRoot: root });
  assert.equal(result.from, "0.1.0");
  assert.equal(result.to, "0.1.1");

  const after = readVersionDeclarations(dir);
  assert.equal(after.descriptor.version, "0.1.1");
  assert.equal(after.packageJson.version, "0.1.1");
  assert.deepEqual(after.metadataVersions, [{ file: "src/frontend/metadata.ts", value: "0.1.1" }]);
  assert.match(fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"), /修一个崩溃/);
});

test("bumpExtension minor / major 会清零低位并同步 site.version", () => {
  const { root, dir, id } = repo({ version: "1.2.3", site: true });
  const minor = bumpExtension(id, { kind: "minor", repoRoot: root });
  assert.equal(minor.to, "1.3.0");
  assert.equal(readVersionDeclarations(dir).descriptor.site.version, "1.3.0");

  const major = bumpExtension(id, { kind: "major", repoRoot: root });
  assert.equal(major.to, "2.0.0");
  assert.equal(readVersionDeclarations(dir).descriptor.site.version, "2.0.0");
});

test("bumpExtension 显式版本：更高才接受", () => {
  const { root, id } = repo();
  assert.equal(bumpExtension(id, { version: "1.0.0", repoRoot: root }).to, "1.0.0");
  assert.throws(() => bumpExtension(id, { version: "1.0.0", repoRoot: root }), /不高于当前版本/);
  assert.throws(() => bumpExtension(id, { version: "0.0.9", repoRoot: root }), /不高于当前版本/);
});

test("bumpExtension 目标不更高时不写任何文件", () => {
  const { root, dir, id } = repo();
  const before = fs.readFileSync(path.join(dir, "extension.json"), "utf8");
  assert.throws(() => bumpExtension(id, { version: "0.1.0", repoRoot: root }), /不高于当前版本/);
  assert.equal(fs.readFileSync(path.join(dir, "extension.json"), "utf8"), before);
  assert.equal(fs.existsSync(path.join(dir, "CHANGELOG.md")), false);
});

test("bumpExtension 无前端入口时跳过 metadata", () => {
  const { root, dir, id } = repo({ metadata: false });
  const result = bumpExtension(id, { kind: "patch", repoRoot: root });
  assert.equal(result.to, "0.1.1");
  assert.equal(fs.existsSync(path.join(dir, "src")), false);
  assert.equal(readVersionDeclarations(dir).descriptor.version, "0.1.1");
});

test("bumpExtension 当前声明不一致时拒绝，避免把分叉固化", () => {
  const { root, dir, id } = repo();
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ ...pkg, version: "0.1.5" }, null, 2));
  assert.throws(() => bumpExtension(id, { kind: "patch", repoRoot: root }), /版本声明当前不一致/);
  assert.equal(readVersionDeclarations(dir).descriptor.version, "0.1.0");
});

test("bumpExtension dry-run 不写盘", () => {
  const { root, dir, id } = repo();
  const result = bumpExtension(id, { kind: "minor", dryRun: true, repoRoot: root });
  assert.equal(result.to, "0.2.0");
  assert.deepEqual(result.changed, []);
  assert.equal(readVersionDeclarations(dir).descriptor.version, "0.1.0");
  assert.equal(fs.existsSync(path.join(dir, "CHANGELOG.md")), false);
});

test("bumpExtension 连续推进写两条 CHANGELOG", () => {
  const { root, dir, id } = repo();
  bumpExtension(id, { kind: "patch", note: "第一条", repoRoot: root });
  bumpExtension(id, { kind: "patch", note: "第二条", repoRoot: root });
  const text = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
  assert.match(text, /## 0\.1\.1/);
  assert.match(text, /## 0\.1\.2/);
  assert.match(text, /第一条/);
  assert.match(text, /第二条/);
});

test("bumpExtension 不触碰无关字段", () => {
  const { root, dir, id } = repo({ site: true });
  const before = JSON.parse(fs.readFileSync(path.join(dir, "extension.json"), "utf8"));
  bumpExtension(id, { kind: "patch", repoRoot: root });
  const after = JSON.parse(fs.readFileSync(path.join(dir, "extension.json"), "utf8"));
  assert.deepEqual(after.site.capabilities, before.site.capabilities);
  assert.equal(after.site.name, before.site.name);
  assert.equal(after.extensionId, before.extensionId);
});

// ---------------------------------------------------------------------------
// --align：历史分叉收口（runninghub 2.2.0 / remote-server 1.0.0 这类真实状况）
// ---------------------------------------------------------------------------

test("align：把四处刷到最高值，展示版本不变", () => {
  const { root, dir, id } = repo({ metadata: false });
  // 模拟真实分叉：extension.json 补成 0.1.0，后端元数据历史上维护到 2.2.0。
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "shared.ts"),
    'export const DEMO_METADATA = {\n  extensionId: "demo",\n  version: "2.2.0"\n};\n'
  );
  const descriptor = JSON.parse(fs.readFileSync(path.join(dir, "extension.json"), "utf8"));
  fs.writeFileSync(
    path.join(dir, "extension.json"),
    `${JSON.stringify({ ...descriptor, metadata: { module: "./shared", export: "DEMO_METADATA" } }, null, 2)}\n`
  );

  const result = bumpExtension(id, { align: true, repoRoot: root });
  assert.equal(result.aligned, true);
  assert.equal(result.to, "2.2.0");

  const after = readVersionDeclarations(dir);
  assert.equal(after.descriptor.version, "2.2.0");
  assert.equal(after.packageJson.version, "2.2.0");
  assert.deepEqual(after.metadataVersions, [{ file: "src/shared.ts", value: "2.2.0" }]);
  // 对齐后没有分叉。
  assert.deepEqual(versionProblems({ extensionId: id, descriptor: after.descriptor, packageVersion: after.packageJson.version, metadataVersions: after.metadataVersions }), []);
});

test("align：分叉状态下普通 bump 拒绝并提示先 --align", () => {
  const { root, dir, id } = repo({ metadata: false });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "shared.ts"),
    'export const DEMO_METADATA = {\n  version: "2.2.0"\n};\n'
  );
  const descriptor = JSON.parse(fs.readFileSync(path.join(dir, "extension.json"), "utf8"));
  fs.writeFileSync(
    path.join(dir, "extension.json"),
    `${JSON.stringify({ ...descriptor, metadata: { module: "./shared", export: "DEMO_METADATA" } }, null, 2)}\n`
  );
  assert.throws(() => bumpExtension(id, { kind: "patch", repoRoot: root }), /--align/);
  assert.equal(readVersionDeclarations(dir).descriptor.version, "0.1.0");
});

test("align 之后可以正常递增，且从高值继续", () => {
  const { root, id } = repo({ metadata: false });
  const dir = path.join(root, "extensions", id);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "shared.ts"), 'export const DEMO_METADATA = {\n  version: "2.2.0"\n};\n');
  const descriptor = JSON.parse(fs.readFileSync(path.join(dir, "extension.json"), "utf8"));
  fs.writeFileSync(
    path.join(dir, "extension.json"),
    `${JSON.stringify({ ...descriptor, metadata: { module: "./shared", export: "DEMO_METADATA" } }, null, 2)}\n`
  );

  bumpExtension(id, { align: true, repoRoot: root });
  const next = bumpExtension(id, { kind: "patch", repoRoot: root });
  assert.equal(next.from, "2.2.0");
  // 版本推进到 2.2.1：用户视角是升级，不是降级。
  assert.equal(next.to, "2.2.1");
});

test("align：不改元数据对象之外的 version 字面量（sdk-agent 的 engine 版本）", () => {
  const { root, id } = repo({ metadata: false });
  const dir = path.join(root, "extensions", id);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "shared.ts"),
    [
      "export const DEMO_METADATA = {",
      '  version: "1.0.0"',
      "};",
      "export function engineFor(id) {",
      '  return { engine: "x-sdk", version: "0.161.0" };',
      "}",
      ""
    ].join("\n")
  );
  const descriptor = JSON.parse(fs.readFileSync(path.join(dir, "extension.json"), "utf8"));
  fs.writeFileSync(
    path.join(dir, "extension.json"),
    `${JSON.stringify({ ...descriptor, metadata: { module: "./shared", export: "DEMO_METADATA" } }, null, 2)}\n`
  );

  bumpExtension(id, { align: true, repoRoot: root });
  const text = fs.readFileSync(path.join(dir, "src", "shared.ts"), "utf8");
  assert.match(text, /DEMO_METADATA = \{\n {2}version: "1\.0\.0"/);
  // engine 描述符必须原样保留，绝不能被对齐成扩展版本。
  assert.match(text, /engine: "x-sdk", version: "0\.161\.0"/);
});
