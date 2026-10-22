/**
 * 运行期浏览器发布目录
 * （change: 2026-10-15-add-scannable-extension-directories，任务 5.2 / 5.3；design D4、D7）。
 *
 * 取代原来的构建期装配：启动期宿主扫到扩展目录后，
 * 本模块读每个扩展的 `browser-dist/artifact-manifest.json`，**复用既有 canonical 规则**算
 * 64-hex `releaseId` 与 `/extensions/<id>/<artifactId>/...` 路径映射，并把目录与资源在内存中托管。
 *
 * 与旧装配器保持同一口径（不重写规则）：
 * - entries 按 extensionId 排序；`releaseId = sha256(canonicalJson({ ...catalog, releaseId: undefined }))`；
 * - catalog 序列化为 `JSON.stringify(catalog, null, 2) + "\n"`；
 * - artifact manifest 解码、SDK ABI / React major 兼容、文件 SHA-256/大小、entry/styles 存在、
 *   相对 import 完整性、重复 extensionId/artifactId 全部在托管前校验，失败即启动失败。
 *
 * 只读文件、只解码纯数据契约；不复制、不写盘、不重新编译。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { ARTIFACTS_PREFIX, RELEASE_LINK_REL, RELEASE_PREFIX, loadExtensionContracts } from "./extension-release-protocol.mjs";
import { serveFile, sendJson } from "./static-server.mjs";

/** 扩展发布目录加载错误：带稳定 code，便于启动日志与运维处置。 */
export class ExtensionReleaseError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ExtensionReleaseError";
    this.code = code;
    for (const [key, value] of Object.entries(details)) this[key] = value;
  }
}

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** canonical JSON（键排序）；与旧装配器的 artifactId 输入口径一致（含 `undefined` 的字面处理）。 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 校验 artifact 目录内每个声明文件存在且 SHA-256/大小一致（迁移自旧装配器，规则不变）。 */
export async function verifyArtifactFiles(artifactDir, manifest) {
  for (const file of manifest.files) {
    const abs = path.join(artifactDir, file.path);
    if (!existsSync(abs)) {
      throw new ExtensionReleaseError("EXTENSION_ARTIFACT_FILE_MISSING", `artifact 缺文件：${file.path}`, { artifactDir });
    }
    const bytes = await fs.readFile(abs);
    if (bytes.length !== file.bytes) {
      throw new ExtensionReleaseError(
        "EXTENSION_ARTIFACT_FILE_MISMATCH",
        `artifact 文件大小不符：${file.path}（${bytes.length} != ${file.bytes}）`,
        { artifactDir }
      );
    }
    if (sha256Hex(bytes) !== file.sha256) {
      throw new ExtensionReleaseError("EXTENSION_ARTIFACT_FILE_MISMATCH", `artifact 文件 hash 不符：${file.path}`, { artifactDir });
    }
  }
  if (!manifest.files.some((file) => file.path === manifest.entry)) {
    throw new ExtensionReleaseError("EXTENSION_ARTIFACT_INVALID", `artifact entry 不在 files 中：${manifest.entry}`, { artifactDir });
  }
  for (const style of manifest.styles) {
    if (!manifest.files.some((file) => file.path === style)) {
      throw new ExtensionReleaseError("EXTENSION_ARTIFACT_INVALID", `artifact style 不在 files 中：${style}`, { artifactDir });
    }
  }
  // 相对 import 完整性：manifest 的依赖图证据必须完整，且不得残留外部依赖。
  const declared = new Set(manifest.files.map((file) => file.path));
  for (const edge of manifest.imports) {
    if (!declared.has(edge.from)) {
      throw new ExtensionReleaseError("EXTENSION_ARTIFACT_INVALID", `artifact import 来源不在 files：${edge.from}`, { artifactDir });
    }
    if (edge.resolved === null) {
      throw new ExtensionReleaseError(
        "EXTENSION_ARTIFACT_EXTERNAL_DEPENDENCY",
        `artifact 残留外部依赖：${edge.from} -> ${edge.specifier}`,
        { artifactDir }
      );
    }
    if (!declared.has(edge.resolved)) {
      throw new ExtensionReleaseError("EXTENSION_ARTIFACT_INVALID", `artifact 相对 import 缺目标：${edge.resolved}`, { artifactDir });
    }
  }
}

/**
 * 构建运行期发布目录。
 *
 * `artifacts` = `[{ extensionId, directory }]`（启动期宿主扫到的、带 `browser-dist/artifact-manifest.json`
 * 的扩展目录）。缺 artifact 的扩展不登记（`skipped`）；已构建但校验失败的一律抛错，绝不静默跳过。
 */
export async function buildBrowserRelease({ artifacts, repoRoot, contracts = null, logger = () => undefined } = {}) {
  if (!Array.isArray(artifacts)) {
    throw new ExtensionReleaseError("EXTENSION_RELEASE_INPUT_INVALID", "buildBrowserRelease 需要 artifacts 数组");
  }
  const resolved = contracts ?? (await loadExtensionContracts());
  const {
    decodeExtensionBrowserArtifactManifest,
    decodeExtensionReleaseCatalog,
    isArtifactCompatibleWithHost,
    EXTENSION_BROWSER_PROTOCOL_VERSION,
    EXTENSION_SDK_ABI_VERSION,
    HOST_REACT_MAJOR
  } = resolved;

  const candidates = [...artifacts].sort((a, b) =>
    a.extensionId < b.extensionId ? -1 : a.extensionId > b.extensionId ? 1 : 0
  );

  const entries = [];
  const files = new Map();
  const skipped = [];
  const seenIds = new Set();
  const seenArtifacts = new Set();

  for (const candidate of candidates) {
    const manifestPath = path.join(candidate.directory, "browser-dist", "artifact-manifest.json");
    if (!existsSync(manifestPath)) {
      skipped.push({ extensionId: candidate.extensionId, directory: candidate.directory, reason: "no-browser-artifact" });
      continue;
    }
    const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const decoded = decodeExtensionBrowserArtifactManifest(raw);
    if (!decoded.ok) {
      throw new ExtensionReleaseError(
        "EXTENSION_ARTIFACT_INVALID",
        `artifact manifest 非法（${candidate.extensionId}）：${decoded.message}`,
        { extensionId: candidate.extensionId, directory: candidate.directory }
      );
    }
    const manifest = decoded.value;
    if (!isArtifactCompatibleWithHost(manifest, { sdkAbi: EXTENSION_SDK_ABI_VERSION, reactMajor: HOST_REACT_MAJOR })) {
      throw new ExtensionReleaseError(
        "EXTENSION_ARTIFACT_INCOMPATIBLE",
        `artifact 与宿主 SDK/React 不兼容（${manifest.metadata.extensionId}）：sdkAbi=${manifest.sdkAbi} reactMajor=${manifest.reactMajor}`,
        { extensionId: candidate.extensionId, directory: candidate.directory }
      );
    }
    const extensionId = manifest.metadata.extensionId;
    if (seenIds.has(extensionId)) {
      throw new ExtensionReleaseError("EXTENSION_ARTIFACT_DUPLICATE", `发布发现含重复 extensionId：${extensionId}`, { extensionId });
    }
    if (seenArtifacts.has(manifest.artifactId)) {
      throw new ExtensionReleaseError("EXTENSION_ARTIFACT_DUPLICATE", `发布发现含重复 artifactId：${manifest.artifactId}`, { extensionId });
    }
    seenIds.add(extensionId);
    seenArtifacts.add(manifest.artifactId);

    const artifactDir = path.join(candidate.directory, "browser-dist");
    await verifyArtifactFiles(artifactDir, manifest);

    const entryBase = `${ARTIFACTS_PREFIX}/${extensionId}/${manifest.artifactId}`;
    for (const file of manifest.files) {
      files.set(`${entryBase}/${file.path}`, path.join(artifactDir, file.path));
    }
    entries.push({
      metadata: {
        ...manifest.metadata,
        directory: path.resolve(candidate.directory)
      },
      artifactId: manifest.artifactId,
      entryURL: `${entryBase}/${manifest.entry}`,
      styleURLs: manifest.styles.map((style) => `${entryBase}/${style}`),
      protocolVersion: manifest.protocolVersion,
      sdkAbi: manifest.sdkAbi,
      reactMajor: manifest.reactMajor,
      requiredSdkGroups: manifest.requiredSdkGroups,
      requiredSdkExports: manifest.requiredSdkExports
    });
  }

  // releaseId：基于排序后的 canonical entries 计算（与旧装配器同口径）。
  const canonicalEntries = [...entries].sort((a, b) => (a.metadata.extensionId < b.metadata.extensionId ? -1 : 1));
  const catalog = {
    schemaVersion: EXTENSION_BROWSER_PROTOCOL_VERSION,
    releaseId: "",
    hostSdkAbi: EXTENSION_SDK_ABI_VERSION,
    entries: canonicalEntries
  };
  const releaseId = sha256Hex(Buffer.from(canonicalJson({ ...catalog, releaseId: undefined }), "utf8"));
  catalog.releaseId = releaseId;

  // 自校验：托管前用同一契约解码，保证宿主产物可被 loader 接受。
  const verified = decodeExtensionReleaseCatalog(catalog);
  if (!verified.ok) {
    throw new ExtensionReleaseError("EXTENSION_RELEASE_INVALID", `生成的 release 目录未通过自身严格解码：${verified.message}`);
  }

  const catalogJson = `${JSON.stringify(catalog, null, 2)}\n`;
  const href = `${RELEASE_PREFIX}/${releaseId}.json`;
  logger({
    event: "extension-release-built",
    releaseId,
    extensions: entries.map((entry) => entry.metadata.extensionId),
    skipped: skipped.map((entry) => entry.extensionId)
  });
  return { releaseId, catalog, catalogJson, href, files, entries, skipped };
}

/** 运行期发现端点：扩展宿主据此取当前发布目录 href（dev 的 `transformIndexHtml` 用它）。 */
export const RELEASE_DISCOVERY_PATH = `${RELEASE_PREFIX}/current.json`;

/** 原子替换 HTML 上的发布目录 link（先移除旧 link，再插入新 link）。纯字符串变换，不写盘。 */
export function injectReleaseLinkHtml(html, href) {
  const withoutOld = html.replace(new RegExp(`\\s*<link\\s+rel="${RELEASE_LINK_REL}"[^>]*>`, "g"), "");
  const link = `\t\t<link rel="${RELEASE_LINK_REL}" href="${href}" />`;
  return withoutOld.includes("</head>") ? withoutOld.replace("</head>", `${link}\n\t</head>`) : `${withoutOld}\n${link}\n`;
}

/**
 * 返回发布目录请求处理器。命中当前 release 的目录端点与不可变资源时返回 `true`，
 * 其余路径返回 `false`（交给后端/静态资源，旧 release 仍由保留窗口目录回退）。
 */
export function createBrowserReleaseHandler(release) {
  if (!release) return () => false;
  const catalogPath = `${RELEASE_PREFIX}/${release.releaseId}.json`;
  const discoveryBody = `${JSON.stringify({ releaseId: release.releaseId, href: release.href })}\n`;
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      return false;
    }
    if (pathname === RELEASE_DISCOVERY_PATH) {
      sendJson(req, res, discoveryBody);
      return true;
    }
    if (pathname === catalogPath) {
      sendJson(req, res, release.catalogJson, { immutable: true });
      return true;
    }
    const filePath = release.files.get(pathname);
    // 未登记的资源不接管：旧 release/旧 artifact 由下游静态处理器的**保留窗口目录**回退，
    // 完全未知的路径由下游决定（独立后端入口显式 404，见 `web/backend/src/server.ts`）。
    if (filePath === undefined) return false;
    serveFile(req, res, filePath, { immutable: true });
    return true;
  };
}