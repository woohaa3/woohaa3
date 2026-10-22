/**
 * 游戏结果协议与不可变构建包纯 codec
 * （change: 2026-10-10-add-game-furnace-extension，任务 7.1–7.3 / design D10/D11）。
 *
 * 浏览器与后端共用：解析版本化单文档游戏结果、静态校验（体积/入口/资源引用/禁止依赖）、
 * 派生确定资源路径、编码/解码源码包与 build manifest。**不执行**生成 JavaScript；不访问网络。
 */
import { MAX_BUILD_DEPENDENCIES, MAX_SOURCE_PACKAGE_BYTES, type GameBuild, type GameResource } from "./index.js";
import { fnv1a64Hex } from "@woohaa3/contracts";
import { safeSitePath, type GameSite } from "./site-contract.js";

/** 版本化单文档游戏结果（design D10）。 */
export type GamePackageManifest = {
  schemaVersion: 1;
  buildId: string;
  title: string;
  controlsSummary: string;
  entry: "index.html";
  policyVersion: string;
  inputHash: string;
  sourceHash: string;
  dependencyAssetIds: string[];
  resources: { resourceId: string; path: string; assetId: string; contentType: string; usage: "used" | "reference-only" | "unused"; storageKey?: string }[];
};

export type GameSourcePackage = {
  schemaVersion: 1;
  entry: "index.html";
  html: string;
  manifest: GamePackageManifest;
  site?: GameSite;
};

import { isRecord } from "./record.js";
/** 资源扩展名（确定路径；不使用用户名称/中文标题作为文件名）。 */
export function resourceExtension(resource: GameResource): string {
  const mime = resource.metadata?.mime ?? "";
  const byMime: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/avif": "avif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "text/plain": "txt"
  };
  if (byMime[mime]) return byMime[mime];
  const local = resource.payload.assetIds.find((id) => typeof id === "string" && id.includes("."));
  const match = local ? /\.([a-z0-9]+)$/i.exec(local) : null;
  if (match) return match[1]!.toLowerCase();
  switch (resource.kind) {
    case "image":
      return "png";
    case "video":
      return "mp4";
    case "audio":
      return "mp3";
    case "text":
      return "txt";
    default:
      return "bin";
  }
}

/** 生成代码引用的确定相对路径：`assets/<resourceId>.<ext>`。 */
export function resourceRelativePath(resource: GameResource): string {
  return `assets/${resource.resourceId}.${resourceExtension(resource)}`;
}

/** 所有冻结依赖有独立相对路径，不使用来源文件名或临时 URL。 */
export function resourceDependencyPaths(resource: GameResource): { assetId: string; storageKey: string; mime: string; path: string }[] {
  return (resource.payload.assets ?? []).filter(asset => asset.storageKey !== resource.metadata?.storageKey).map(asset => ({ ...asset,
    path: `assets/dep-${fnv1a64Hex(JSON.stringify([resource.resourceId, asset.assetId]))}.${resourceExtension({ ...resource, metadata: { mime: asset.mime } })}` }));
}

/**
 * 从模型输出解析游戏结果。
 *
 * 支持：纯 JSON（单对象）、单个 ```json 代码块、单个 ```html 代码块（仅含 HTML）。
 * 禁止模糊截取多个候选拼接（design D10）：多个候选/空输出/截断 → 拒绝。
 */
export function encodeSourcePackage(pkg: GameSourcePackage): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(pkg));
  if (bytes.length > MAX_SOURCE_PACKAGE_BYTES) throw new Error("源码包超过体积上限");
  return bytes;
}

export function decodeSourcePackage(bytes: Uint8Array): GameSourcePackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("源码包不是合法 JSON");
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.entry !== "index.html" || typeof parsed.html !== "string") {
    throw new Error("源码包结构非法");
  }
  const manifest = decodeManifest(parsed.manifest);
  let site: GameSite | undefined;
  if (parsed.site !== undefined) {
    const candidate = parsed.site;
    if (!isRecord(candidate) || candidate.schemaVersion !== 1 || candidate.format !== "vite" || !isRecord(candidate.sourceFiles) || !Array.isArray(candidate.files) || candidate.files.length > 512) throw Error("静态站点包非法");
    const seen = new Set<string>();
    for (const file of candidate.files) {
      if (!isRecord(file) || typeof file.path !== "string" || !safeSitePath(file.path) || seen.has(file.path) || typeof file.storageKey !== "string" || typeof file.contentType !== "string" || typeof file.checksum !== "string" || typeof file.size !== "number") throw Error("静态站点文件非法");
      seen.add(file.path);
    }
    if (!seen.has("index.html")) throw Error("静态站点缺少入口");
    site = candidate as unknown as GameSite;
  }
  return { schemaVersion: 1, entry: "index.html", html: parsed.html, manifest, ...(site ? { site } : {}) };
}

export function decodeManifest(value: unknown): GamePackageManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.buildId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.controlsSummary !== "string" ||
    value.entry !== "index.html" ||
    typeof value.policyVersion !== "string" ||
    typeof value.inputHash !== "string" ||
    typeof value.sourceHash !== "string" ||
    !Array.isArray(value.dependencyAssetIds) ||
    !Array.isArray(value.resources)
  ) {
    throw new Error("build manifest 结构非法");
  }
  if (value.dependencyAssetIds.length > MAX_BUILD_DEPENDENCIES) throw new Error("build manifest 依赖超限");
  const resources: GamePackageManifest["resources"] = (value.resources as unknown[]).map((entry) => {
    if (!isRecord(entry) || typeof entry.resourceId !== "string" || typeof entry.path !== "string" || typeof entry.assetId !== "string") {
      throw new Error("build manifest 资源项非法");
    }
    const usage = entry.usage;
    if (usage !== "used" && usage !== "reference-only" && usage !== "unused") throw new Error("build manifest usage 非法");
    return {
      resourceId: entry.resourceId,
      path: entry.path,
      assetId: entry.assetId,
      contentType: typeof entry.contentType === "string" ? entry.contentType : "application/octet-stream",
      usage,
      // 冻结的不可变资源键（任务 7.8）：历史 build 不依赖当前项目是否仍保留该素材。
      ...(typeof entry.storageKey === "string" && entry.storageKey !== "" ? { storageKey: entry.storageKey } : {})
    };
  });
  return {
    schemaVersion: 1,
    buildId: value.buildId,
    title: value.title,
    controlsSummary: value.controlsSummary,
    entry: "index.html",
    policyVersion: value.policyVersion,
    inputHash: value.inputHash,
    sourceHash: value.sourceHash,
    dependencyAssetIds: (value.dependencyAssetIds as unknown[]).filter((id): id is string => typeof id === "string"),
    resources
  };
}

/** 生成 build 记录（节点只保存稳定关联与 hash）。 */
export function buildRecordFromManifest(manifest: GamePackageManifest, input: {
  generationId: string;
  manifestAssetId: string;
  sourceAssetId: string;
  createdAt: string;
}): GameBuild {
  return {
    buildId: manifest.buildId,
    generationId: input.generationId,
    inputHash: manifest.inputHash,
    manifestAssetId: input.manifestAssetId,
    sourceAssetId: input.sourceAssetId,
    dependencyAssetIds: [...manifest.dependencyAssetIds],
    sourceHash: manifest.sourceHash,
    policyVersion: manifest.policyVersion,
    createdAt: input.createdAt,
    title: manifest.title,
    controlsSummary: manifest.controlsSummary,
    resources: manifest.resources.map((entry) => ({ resourceId: entry.resourceId, usage: entry.usage }))
  };
}
