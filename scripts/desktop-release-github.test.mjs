/**
 * GitHub Release 发布编排单测（不调用 gh、不访问网络）。
 * 运行：node --test scripts/desktop-release-github.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parsePublishArgs,
  assetNameFor,
  releaseAssetPlan,
  ghCommands,
  defaultUploadDir,
  versionFromManifest,
  indexPlatformKeys
} from "./lib/desktop-release-github.mjs";

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-gh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 造一个 <out>/manifest.json + <out>/upload/ 目录树。 */
function fixture(root, { version = "1.2.3", assetName = "latest-darwin-aarch64.json", archive = "WooHaa3.app.tar.gz", withSignature = true } = {}) {
  const out = path.join(root, "artifacts", "standalone-apple-silicon");
  const upload = path.join(out, "upload");
  fs.mkdirSync(path.join(upload, version), { recursive: true });
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ product: { version } }));
  fs.writeFileSync(path.join(upload, version, archive), "archive-bytes");
  if (withSignature) fs.writeFileSync(path.join(upload, version, archive + ".sig"), "signature");
  fs.writeFileSync(path.join(upload, assetName), JSON.stringify({ version, platforms: {} }));
  return upload;
}

test("参数解析支持等号与空格两种写法，--merge 可带值", () => {
  const defaults = parsePublishArgs([]);
  assert.deepEqual(
    { repo: defaults.repo, tag: defaults.tag, merge: defaults.merge, draft: defaults.draft, dryRun: defaults.dryRun },
    { repo: null, tag: null, merge: null, draft: false, dryRun: false }
  );
  const parsed = parsePublishArgs(["--repo", "acme/woohaa", "--tag=v0.1.7", "--dir", "out", "--merge", "--draft", "--dry-run"]);
  assert.deepEqual(
    { repo: parsed.repo, tag: parsed.tag, dir: parsed.dir, merge: parsed.merge, draft: parsed.draft, dryRun: parsed.dryRun },
    { repo: "acme/woohaa", tag: "v0.1.7", dir: "out", merge: "latest.json", draft: true, dryRun: true }
  );
  assert.equal(parsePublishArgs(["--merge=stable.json"]).merge, "stable.json");
  assert.throws(() => parsePublishArgs(["--repo"]), /缺少取值/);
  assert.throws(() => parsePublishArgs(["--unknown"]), /未知参数/);
});

test("索引资产名按平台推导并拒绝路径字符", () => {
  assert.equal(assetNameFor("darwin-aarch64"), "latest-darwin-aarch64.json");
  assert.equal(assetNameFor("windows-x86_64", "beta.json"), "beta.json");
  assert.throws(() => assetNameFor("darwin-aarch64", "../latest.json"), /不合法/);
});

test("资产计划要求索引、归档与配对签名齐全", (t) => {
  const root = tmpDir(t);
  const upload = fixture(root);
  const plan = releaseAssetPlan({ dir: upload, version: "1.2.3", assetName: "latest-darwin-aarch64.json" });
  assert.equal(path.basename(plan.indexPath), "latest-darwin-aarch64.json");
  assert.equal(plan.archives.length, 1);
  assert.equal(plan.signatures.length, 1);

  const broken = fixture(path.join(root, "broken"), { withSignature: false });
  assert.throws(() => releaseAssetPlan({ dir: broken, version: "1.2.3", assetName: "latest-darwin-aarch64.json" }), /签名/);
  assert.throws(() => releaseAssetPlan({ dir: upload, version: "9.9.9", assetName: "latest-darwin-aarch64.json" }), /版本目录/);
  assert.throws(() => releaseAssetPlan({ dir: upload, version: "1.2.3", assetName: "missing.json" }), /索引资产/);
});

test("gh 命令序列固定为 view / create / upload，草稿与合并按需追加", (t) => {
  const root = tmpDir(t);
  const upload = fixture(root);
  const plan = releaseAssetPlan({ dir: upload, version: "1.2.3", assetName: "latest-darwin-aarch64.json" });
  const commands = ghCommands({ repo: "acme/woohaa", tag: "v1.2.3", plan, notes: "notes" });
  assert.deepEqual(commands.view, ["release", "view", "v1.2.3", "--repo", "acme/woohaa", "--json", "tagName"]);
  assert.deepEqual(commands.create.slice(0, 7), ["release", "create", "v1.2.3", "--repo", "acme/woohaa", "--title", "v1.2.3"]);
  assert.equal(commands.create.includes("--draft"), false);
  assert.equal(commands.upload.includes(plan.indexPath), true);
  assert.equal(commands.upload.at(-1), plan.indexPath);
  assert.equal(commands.upload.includes("--clobber"), true);
  assert.equal(commands.download, null);

  const drafted = ghCommands({ repo: "acme/woohaa", tag: "v1.2.3", plan, notes: "notes", draft: true, mergeName: "latest.json" });
  assert.equal(drafted.create.includes("--draft"), true);
  assert.equal(drafted.download.includes("--pattern"), true);
  assert.throws(() => ghCommands({ repo: "acme", tag: "v1.2.3", plan, notes: "n" }), /owner\/name/);
  assert.throws(() => ghCommands({ repo: "acme/woohaa", tag: "v1/2", plan, notes: "n" }), /tag/);
});

test("默认 upload 目录与 manifest 版本读取", (t) => {
  const root = tmpDir(t);
  assert.match(defaultUploadDir(root, "darwin"), /standalone-apple-silicon\/upload$/);
  assert.match(defaultUploadDir(root, "win32"), /standalone-windows-x64\/upload$/);
  const upload = fixture(root);
  assert.equal(versionFromManifest(upload), "1.2.3");
  assert.throws(() => versionFromManifest(path.join(root, "missing", "upload")), /manifest/);
});

test("发布前读取索引平台键，便于发现发错平台", (t) => {
  const root = tmpDir(t);
  const upload = fixture(root);
  assert.throws(() => indexPlatformKeys(path.join(upload, "latest-darwin-aarch64.json")), /platform/);
  fs.writeFileSync(path.join(upload, "latest-darwin-aarch64.json"), JSON.stringify({ version: "1.2.3", platforms: { "darwin-aarch64": { url: "u", signature: "s" } } }));
  assert.deepEqual(indexPlatformKeys(path.join(upload, "latest-darwin-aarch64.json")), ["darwin-aarch64"]);
  assert.throws(() => indexPlatformKeys(path.join(upload, "missing.json")), /ENOENT/);
});
