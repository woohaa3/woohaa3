/**
 * Extension release assembly
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 6.1–6.3/6.8 / design D5/D6）。
 *
 *   node scripts/assemble-extension-release.mjs [--host-dist web/frontend/dist] [--extensions-dir web/extensions]
 *                                              [--no-html] [--allow-missing]
 *
 * 责任边界：
 * - **只组合已编译产物**：读取每个扩展 `browser-dist/artifact-manifest.json` 与宿主 `dist/`，
 *   不隐式重新编译任何源码，也不运行宿主 Vite。
 * - 严格校验：artifact manifest 解码、文件 SHA-256/大小、entry/styles 存在、相对 import 完整、
 *   SDK ABI/React major 与宿主兼容、重复 extensionId/artifactId。任一失败在切换发布指针前报错。
 * - 生成版本化目录 `/extension-releases/<releaseId>.json` 与不可变资源
 *   `/extensions/<id>/<artifactId>/...`，并把 `<link rel="woohaa-extension-release">` 写入 HTML。
 * - 发布发现只登记同时具备约定纯 metadata 与完整 browser artifact 的生产入口；缺 artifact 的
 *   扩展（如仅有后端/测试 fixture）不纳入，允许通过 `--allow-missing` 忽略未构建扩展。
 * - 资源不可变：同名 artifactId 目录已存在且内容一致时复用（不重写 mtime）；旧 release 与旧
 *   artifacts 保留，不在装配时删除历史版本（部署回收窗口由运维显式清理）。
 * - releaseId 由 canonical manifest 内容确定性计算，不含时间/绝对路径。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { browserExtensions, scanExtensions } from "./lib/extension-scan.mjs";
import { loadBuildProfile } from "./lib/build-profile.mjs";
import { applyExtensionDefaults } from "./lib/extension-release-defaults.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const WEB_DIR = path.join(REPO_ROOT, "web");

const RELEASE_LINK_REL = "woohaa-extension-release";
const RELEASE_PREFIX = "/extension-releases";
const ARTIFACTS_PREFIX = "/extensions";

function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const hostDist = path.resolve(REPO_ROOT, readArg("host-dist", "web/frontend/dist"));
const extensionsDir = path.resolve(REPO_ROOT, readArg("extensions-dir", "web/extensions"));
/** 显式传 `--extensions-dir` 时只扫该根；缺省扫 `extensions.config.json` 的全部配置根。 */
const explicitExtensionsDir = process.argv.includes("--extensions-dir");
const writeHtml = !process.argv.includes("--no-html");
const allowMissing = process.argv.includes("--allow-missing");

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** canonical JSON（键排序）；与 builder 的 artifactId 输入口径一致。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function loadContracts() {
  // 直接加载 workspace contracts 的纯 ESM 产物；不能用 createRequire.resolve（exports 只声明 import）。
  const candidates = [
    path.join(WEB_DIR, "contracts", "dist", "index.js"),
    path.join(WEB_DIR, "node_modules", "@woohaa3", "contracts", "dist", "index.js")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return import(pathToFileURL(candidate).href);
  }
  throw new Error("未找到 @woohaa3/contracts 构建产物；先运行 build:contracts");
}

/**
 * 发布发现：扫描 `web/extensions/<dir>/`，同时识别源码扩展与只有 `browser-dist/artifact-manifest.json` 的预构建扩展。
 * 目录名与 extensionId 可以不同——身份一律以 artifact manifest 的 metadata 为准。
 */
function discoverArtifacts() {
  // 缺省按配置根扫描（web/extensions + extensions，`--extensions-dir` 可显式指定单一根）；
  // 身份一律以 artifact manifest 的 metadata 为准。
  const found = explicitExtensionsDir
    ? readSingleRoot()
    : browserExtensions(scanExtensions({ repoRoot: REPO_ROOT })).map((extension) => ({
        directory: extension.directory,
        dir: extension.dir
      }));
  return found
    .map(({ directory, dir }) => {
      const manifestPath = path.join(dir, "browser-dist", "artifact-manifest.json");
      return { directory, dir, manifestPath: existsSync(manifestPath) ? manifestPath : null };
    })
    .sort((a, b) => (a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0));
}

/** 显式 `--extensions-dir` 时的单根读取（识别 metadata 源码约定或 browser artifact）。 */
function readSingleRoot() {
  if (!existsSync(extensionsDir)) return [];
  const found = [];
  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(extensionsDir, entry.name);
    if (entry.name.startsWith('.')) continue;
    if (!existsSync(path.join(dir, "src", "frontend", "metadata.ts")) &&
        !existsSync(path.join(dir, 'browser-dist', 'artifact-manifest.json'))) continue;
    found.push({ directory: entry.name, dir });
  }
  return found;
}

/** 校验 artifact 目录内每个声明文件存在且 SHA-256/大小一致。 */
async function verifyArtifactFiles(artifactDir, manifest) {
  for (const file of manifest.files) {
    const abs = path.join(artifactDir, file.path);
    if (!existsSync(abs)) throw new Error(`artifact 缺文件：${file.path}`);
    const bytes = await fs.readFile(abs);
    if (bytes.length !== file.bytes) {
      throw new Error(`artifact 文件大小不符：${file.path}（${bytes.length} != ${file.bytes}）`);
    }
    if (sha256Hex(bytes) !== file.sha256) {
      throw new Error(`artifact 文件 hash 不符：${file.path}`);
    }
  }
  if (!manifest.files.some((file) => file.path === manifest.entry)) {
    throw new Error(`artifact entry 不在 files 中：${manifest.entry}`);
  }
  for (const style of manifest.styles) {
    if (!manifest.files.some((file) => file.path === style)) {
      throw new Error(`artifact style 不在 files 中：${style}`);
    }
  }
  // 相对 import 完整性：manifest 的依赖图证据必须完整，且不得残留外部依赖。
  const declared = new Set(manifest.files.map((file) => file.path));
  for (const edge of manifest.imports) {
    if (!declared.has(edge.from)) throw new Error(`artifact import 来源不在 files：${edge.from}`);
    if (edge.resolved === null) {
      throw new Error(`artifact 残留外部依赖：${edge.from} -> ${edge.specifier}`);
    }
    if (!declared.has(edge.resolved)) throw new Error(`artifact 相对 import 缺目标：${edge.resolved}`);
  }
}

/**
 * 原子写入：先写同名 `.<name>.<pid>.tmp` 再 rename；同名 immutable 资源内容一致时跳过。
 */
async function writeFileAtomic(target, contents) {
  if (existsSync(target)) {
    const existing = await fs.readFile(target);
    const next = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    if (existing.equals(next)) return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, contents);
  await fs.rename(tmp, target);
}

async function main() {
  const contracts = await loadContracts();
  const {
    decodeExtensionBrowserArtifactManifest,
    decodeExtensionReleaseCatalog,
    isArtifactCompatibleWithHost,
    EXTENSION_BROWSER_PROTOCOL_VERSION,
    EXTENSION_SDK_ABI_VERSION,
    HOST_REACT_MAJOR
  } = contracts;

  if (!existsSync(path.join(hostDist, "index.html"))) {
    throw new Error(`宿主构建产物不存在（${path.relative(REPO_ROOT, hostDist)}）。先构建宿主模板。`);
  }

  const discovered = discoverArtifacts();
  const ready = [];
  const missing = [];
  for (const candidate of discovered) {
    if (!candidate.manifestPath) {
      missing.push(candidate.directory);
      continue;
    }
    ready.push(candidate);
  }
  if (missing.length > 0 && !allowMissing) {
    throw new Error(
      `以下扩展目录有约定 metadata 但缺少 browser artifact（先运行 build:browser，或传 --allow-missing 明确忽略）：\n` +
        missing.map((name) => `  ${name}/browser-dist/artifact-manifest.json`).join("\n")
    );
  }

  const entries = [];
  const seenIds = new Set();
  const seenArtifacts = new Set();
  for (const candidate of ready) {
    const raw = JSON.parse(readFileSync(candidate.manifestPath, "utf8"));
    const decoded = decodeExtensionBrowserArtifactManifest(raw);
    if (!decoded.ok) {
      throw new Error(`artifact manifest 非法（${candidate.directory}）：${decoded.message}`);
    }
    const manifest = decoded.value;
    if (!isArtifactCompatibleWithHost(manifest, { sdkAbi: EXTENSION_SDK_ABI_VERSION, reactMajor: HOST_REACT_MAJOR })) {
      throw new Error(`artifact 与宿主 SDK/React 不兼容（${manifest.metadata.extensionId}）`);
    }
    const artifactDir = path.join(candidate.dir, "browser-dist");
    await verifyArtifactFiles(artifactDir, manifest);
    const extensionId = manifest.metadata.extensionId;
    if (seenIds.has(extensionId)) throw new Error(`发布发现含重复 extensionId：${extensionId}`);
    if (seenArtifacts.has(manifest.artifactId)) throw new Error(`发布发现含重复 artifactId：${manifest.artifactId}`);
    seenIds.add(extensionId);
    seenArtifacts.add(manifest.artifactId);

    // 复制不可变资源到 /extensions/<id>/<artifactId>/...（内容一致则跳过）。
    const targetArtifactDir = path.join(hostDist, ARTIFACTS_PREFIX.replace(/^\//, ""), extensionId, manifest.artifactId);
    for (const file of manifest.files) {
      const source = await fs.readFile(path.join(artifactDir, file.path));
      await writeFileAtomic(path.join(targetArtifactDir, file.path), source);
    }

    const entryBase = `${ARTIFACTS_PREFIX}/${extensionId}/${manifest.artifactId}`;
    entries.push({
      metadata: { ...manifest.metadata, directory: path.resolve(candidate.dir) },
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

  // 发版期的内置扩展启停：profile 的 extensions.defaultEnabled 覆盖 artifact metadata。
  // 只改「首次安装的默认值」；运行期仍由站点控制面的 desiredEnabled 优先。
  const buildProfile = loadBuildProfile({ repoRoot: path.dirname(REPO_ROOT), env: process.env });
  if (!buildProfile.ok) {
    const detail = buildProfile.errors.map((error) => `  ${error.path}: ${error.message}`).join("\n");
    throw new Error(`build profile 校验失败（${buildProfile.path ?? "未知路径"}）：\n${detail}`);
  }
  const appliedDefaults = applyExtensionDefaults(entries, buildProfile.resolved.extensionDefaults, {
    allowMissing,
    onSkip: (extensionId, available) => process.stderr.write(`[assemble] 跳过未发布的扩展启停：${extensionId}（可用：${available}）\n`)
  });

  // releaseId：基于排序后的 canonical entries 计算。
  const canonicalEntries = [...entries].sort((a, b) => (a.metadata.extensionId < b.metadata.extensionId ? -1 : 1));
  const catalog = {
    schemaVersion: EXTENSION_BROWSER_PROTOCOL_VERSION,
    releaseId: "",
    hostSdkAbi: EXTENSION_SDK_ABI_VERSION,
    entries: canonicalEntries
  };
  const releaseId = sha256Hex(Buffer.from(canonicalJson({ ...catalog, releaseId: undefined }), "utf8"));
  catalog.releaseId = releaseId;

  // 自校验：写盘前用同一契约解码，保证发布方产物可被 loader 接受。
  const verified = decodeExtensionReleaseCatalog(catalog);
  if (!verified.ok) throw new Error(`生成的 release 目录未通过自身严格解码：${verified.message}`);

  const catalogPath = path.join(hostDist, RELEASE_PREFIX.replace(/^\//, ""), `${releaseId}.json`);
  await writeFileAtomic(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

  if (writeHtml) {
    await injectReleaseLink(path.join(hostDist, "index.html"), `${RELEASE_PREFIX}/${releaseId}.json`);
  }

  process.stdout.write(
    JSON.stringify(
      {
        event: "extension-release-assembled",
        releaseId,
        hostDist: path.relative(REPO_ROOT, hostDist),
        entries: entries.map((entry) => entry.metadata.extensionId),
        extensionDefaults: appliedDefaults,
        missing,
        catalog: path.relative(REPO_ROOT, catalogPath)
      },
      null,
      2
    ) + "\n"
  );
}

/** 原子替换 HTML 上的发布目录 link（先移除旧 link，再插入新 link）。 */
async function injectReleaseLink(htmlPath, href) {
  const html = await fs.readFile(htmlPath, "utf8");
  const withoutOld = html.replace(
    new RegExp(`\\s*<link\\s+rel="${RELEASE_LINK_REL}"[^>]*>`, "g"),
    ""
  );
  const link = `\t\t<link rel="${RELEASE_LINK_REL}" href="${href}" />`;
  const next = withoutOld.includes("</head>")
    ? withoutOld.replace("</head>", `${link}\n\t</head>`)
    : `${withoutOld}\n${link}\n`;
  await writeFileAtomic(htmlPath, next);
}

main().catch((error) => {
  process.stderr.write(`[release-assemble] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
