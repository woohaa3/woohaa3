#!/usr/bin/env node
/**
 * 把已构建的签名发行物发布到 GitHub Release。
 *
 *   node scripts/publish-desktop-github.mjs --repo owner/name [--tag v0.1.7] [--dir <upload>]
 *        [--asset latest-darwin-aarch64.json] [--notes "..." | --notes-file <path>]
 *        [--draft] [--merge latest.json] [--dry-run]
 *
 * 顺序固定：release（必要时创建）→ 上传归档与签名 → 上传平台索引 → 可选合并聚合索引。
 * 索引最后上传；--draft 时用户端看不到，需要手动发布 release 才生效。
 * 私钥与 token 都不进仓库：gh 使用本机登录态或 GH_TOKEN。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parsePublishArgs,
  assetNameFor,
  releaseAssetPlan,
  ghCommands,
  defaultUploadDir,
  versionFromManifest,
  indexPlatformKeys
} from "./lib/desktop-release-github.mjs";
import { platformKeyFor, mergeReleaseIndex } from "./lib/desktop-release-index.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const usage = [
  "把签名桌面产物发布到 GitHub Release",
  "",
  "  --repo <owner/name>   目标仓库（必填）",
  "  --tag <tag>           发布 tag，缺省 v<manifest 版本>",
  "  --dir <dir>           upload 目录，缺省 artifacts/desktop/<release-id>/upload",
  "  --asset <name>        平台索引资产名，缺省 latest-<平台键>.json",
  "  --notes <text>        release 说明（缺省取 WOOHAA_DESKTOP_RELEASE_NOTES 或 tag）",
  "  --notes-file <path>   从文件读取 release 说明",
  "  --draft               先建草稿 release（确认后再手动发布）",
  "  --merge [name]        同时维护聚合索引，缺省 latest.json",
  "  --dry-run             只打印 gh 命令",
  "  --help                显示帮助"
].join("\n");

function fail(message) {
  console.error("[desktop-publish] " + message);
  process.exit(1);
}

function run(args, { allowFailure = false } = {}) {
  console.log("[desktop-publish] gh " + args.join(" "));
  const result = spawnSync("gh", args, { stdio: "inherit", env: process.env });
  if (result.error) fail("无法执行 gh：" + result.error.message + "（先安装 GitHub CLI 并登录）");
  if (result.status !== 0 && !allowFailure) fail("gh 退出码 " + (result.status ?? "null"));
  return result.status === 0;
}

function mergeAggregate({ uploadDir, assetName, aggregateName, repo, tag, commands }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-gh-index-"));
  const download = commands.download.slice();
  download[download.indexOf(null)] = temp;
  run(download, { allowFailure: true });
  const existingPath = path.join(temp, aggregateName);
  const incoming = JSON.parse(fs.readFileSync(path.join(uploadDir, assetName), "utf8"));
  if (!fs.existsSync(existingPath)) {
    // 首次发布：聚合索引就是本平台的索引。
    fs.writeFileSync(existingPath, JSON.stringify(incoming, null, 2) + "\n");
  } else {
    const existing = JSON.parse(fs.readFileSync(existingPath, "utf8"));
    const merged = mergeReleaseIndex({ existing, incoming });
    fs.writeFileSync(existingPath, JSON.stringify(merged, null, 2) + "\n");
  }
  const upload = commands.mergeUpload.slice();
  upload[upload.indexOf(null)] = existingPath;
  run(upload);
  fs.rmSync(temp, { recursive: true, force: true });
}

const options = parsePublishArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage);
  process.exit(0);
}
if (!options.repo) fail("缺少 --repo owner/name\n\n" + usage);

const uploadDir = path.resolve(root, options.dir ?? defaultUploadDir(root, process.platform));
const version = versionFromManifest(uploadDir);
const tag = options.tag ?? "v" + version;
const platformKey = platformKeyFor({ platform: process.platform, arch: process.arch });
const assetName = assetNameFor(platformKey, options.asset);
const plan = releaseAssetPlan({ dir: uploadDir, version, assetName });
const keys = indexPlatformKeys(plan.indexPath);
if (!keys.includes(platformKey)) {
  console.warn("[desktop-publish] 警告：索引平台键 " + keys.join(",") + " 与当前平台 " + platformKey + " 不一致，确认不是发错平台。");
}
const notes = options.notesFile
  ? fs.readFileSync(path.resolve(root, options.notesFile), "utf8").trim()
  : options.notes ?? process.env.WOOHAA_DESKTOP_RELEASE_NOTES ?? tag;
const commands = ghCommands({ repo: options.repo, tag, plan, notes, draft: options.draft, mergeName: options.merge });

if (options.dryRun) {
  console.log("[desktop-publish] dry-run：以下命令不会执行");
  for (const args of [commands.view, commands.create, commands.upload]) {
    if (args) console.log("  gh " + args.join(" "));
  }
  if (commands.download) {
    console.log("  gh " + commands.download.map((value) => (value === null ? "<tmp>" : value)).join(" "));
    console.log("  gh " + commands.mergeUpload.map((value) => (value === null ? "<tmp>/" + options.merge : value)).join(" "));
  }
  process.exit(0);
}

const exists = run(commands.view, { allowFailure: true });
if (!exists) run(commands.create);
run(commands.upload);
if (options.merge) mergeAggregate({ uploadDir, assetName, aggregateName: options.merge, repo: options.repo, tag, commands });
console.log("[desktop-publish] 完成：" + options.repo + " " + tag + "（索引 " + assetName + "）");
