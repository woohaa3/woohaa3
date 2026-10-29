/**
 * GitHub Release 发布编排的纯函数：参数解析、资产计划与 gh 命令构造。
 * 真正调用 gh 在 scripts/publish-desktop-github.mjs；这里不发起任何外部调用，便于单测。
 *
 * 发布顺序固定为「先归档、后索引」：索引一旦指向尚未上传的归档，已安装客户端会卡在
 * 强制更新里重试。gh release create --draft 后再 upload 也能避免提前暴露。
 */
import fs from "node:fs";
import path from "node:path";

export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const TAG = /^[A-Za-z0-9_+.-]+$/;

/** 解析发布参数；未知参数直接报错，避免拼错后静默发布到别处。 */
export function parsePublishArgs(argv) {
  const options = { repo: null, tag: null, dir: null, asset: null, notes: null, notesFile: null, merge: null, draft: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    const value = () => {
      if (inline !== null) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(name + " 缺少取值");
      index += 1;
      return next;
    };
    if (name === "--repo") options.repo = value();
    else if (name === "--tag") options.tag = value();
    else if (name === "--dir") options.dir = value();
    else if (name === "--asset") options.asset = value();
    else if (name === "--notes") options.notes = value();
    else if (name === "--notes-file") options.notesFile = value();
    else if (name === "--draft") options.draft = true;
    else if (name === "--dry-run") options.dryRun = true;
    else if (name === "--help") options.help = true;
    else if (name === "--merge") options.merge = inline ?? "latest.json";
    else throw new Error("未知参数：" + arg);
  }
  return options;
}

/** 发布时读取的索引资产名按平台拆分，和运行时解析保持同一约定。 */
export function assetNameFor(platformKey, override = null) {
  const name = override ?? "latest-" + platformKey + ".json";
  if (!/^[A-Za-z0-9_+.-]+$/.test(name) || name.includes("..")) throw new Error("索引资产名不合法：" + name);
  return name;
}

/** 从 upload 目录解析本次要上传的索引与归档，缺件时提前失败。 */
export function releaseAssetPlan({ dir, version, assetName }) {
  if (!version) throw new Error("缺少版本号，无法定位 upload/<版本>/ 目录");
  const indexPath = path.join(dir, assetName);
  if (!fs.existsSync(indexPath)) throw new Error("缺少索引资产：" + indexPath);
  const versionDir = path.join(dir, version);
  if (!fs.existsSync(versionDir)) throw new Error("缺少版本目录：" + versionDir);
  const names = fs.readdirSync(versionDir).sort();
  const archives = names.filter((name) => !name.endsWith(".sig")).map((name) => path.join(versionDir, name));
  const signatures = new Set(names.filter((name) => name.endsWith(".sig")));
  if (archives.length === 0) throw new Error("版本目录没有可上传的归档：" + versionDir);
  for (const archive of archives) {
    if (!signatures.has(path.basename(archive) + ".sig")) throw new Error("归档缺少签名的配对文件：" + path.basename(archive));
  }
  return { indexPath, versionDir, archives, signatures: [...signatures].map((name) => path.join(versionDir, name)) };
}

/** 构造 gh 子命令序列；脚本按 view / create / upload / merge 的顺序执行。 */
export function ghCommands({ repo, tag, plan, notes, draft = false, mergeName = null }) {
  if (!REPO.test(String(repo ?? ""))) throw new Error("GitHub 仓库必须是 owner/name：" + String(repo ?? ""));
  if (!TAG.test(String(tag ?? ""))) throw new Error("发布 tag 不合法：" + String(tag ?? ""));
  const view = ["release", "view", tag, "--repo", repo, "--json", "tagName"];
  const create = ["release", "create", tag, "--repo", repo, "--title", tag, "--notes", notes, ...(draft ? ["--draft"] : [])];
  const upload = ["release", "upload", tag, "--repo", repo, "--clobber", ...plan.archives, ...plan.signatures, plan.indexPath];
  const download = mergeName ? ["release", "download", tag, "--repo", repo, "--pattern", mergeName, "--dir", null, "--clobber"] : null;
  const mergeUpload = mergeName ? ["release", "upload", tag, "--repo", repo, "--clobber", null] : null;
  return { view, create, upload, download, mergeUpload };
}

/** 默认 upload 目录：与打包脚本的输出保持一致。 */
export function defaultUploadDir(root, platform) {
  const releaseId = platform === "win32" ? "standalone-windows-x64" : "standalone-apple-silicon";
  return path.join(root, "artifacts", "desktop", releaseId, "upload");
}

/** 读打包 manifest 的版本号，供 --tag 缺省时推导。 */
export function versionFromManifest(uploadDir) {
  const manifestPath = path.join(path.dirname(uploadDir), "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error("缺少打包 manifest：" + manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const version = manifest?.product?.version;
  if (typeof version !== "string" || version.length === 0) throw new Error("manifest 缺少 product.version：" + manifestPath);
  return version;
}

/** 读取索引里的平台键，用于发布前核对是否发错平台。 */
export function indexPlatformKeys(indexPath) {
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const keys = Object.keys(index?.platforms ?? {});
  if (keys.length === 0) throw new Error("索引没有 platform 条目：" + indexPath);
  return keys;
}
