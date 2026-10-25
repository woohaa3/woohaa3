/**
 * 桌面发行打包的纯函数与有界辅助
 * （change: 2026-10-14-migrate-canvas-to-tauri-native-bevy，任务 6.7 / 6.9 的打包前置）。
 *
 * 本文件只做参数解析、平台判定、图标/资源清单、路径推导、产物哈希与 manifest 组装：
 * 既不启动 cargo/tauri，也不写仓库文件（`hashPath` 只读盘）。编排与执行在
 * `scripts/build-desktop.mjs`，单测在 `scripts/desktop-release.test.mjs`。
 *
 * manifest 通过 hostPackage 区分完整独立包与显式外部服务调试包。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 打包时注入的默认值资源名：Tauri `bundle.resources` 目标名，Rust 侧同名校验。 */
export const DESKTOP_DEFAULTS_RESOURCE = "woohaa-desktop.defaults.json";

/** 打包产物与 manifest 的缺省输出根（`/artifacts/` 已被 .gitignore 忽略）。 */
export const DEFAULT_ARTIFACTS_ROOT = "artifacts/desktop";

/** 支持发行打包的目标平台。与 Rust `supports_desktop_host()` 的取值保持一致。 */
export const SUPPORTED_PLATFORMS = ["darwin", "linux", "win32"];

/** 各平台缺省的 bundle 种类；`--bundles` 只能在其中收窄。 */
export const PLATFORM_BUNDLES = {
  darwin: ["app", "dmg"],
  win32: ["nsis"],
  linux: ["deb", "rpm", "appimage"]
};

/** Tauri `--bundles` 值 → 产物所在子目录（`<target>/<profile>/bundle/<dir>`）。 */
export const BUNDLE_OUTPUT_DIRS = {
  app: "macos",
  nsis: "nsis",
  dmg: "dmg",
  deb: "deb",
  rpm: "rpm",
  appimage: "appimage"
};

/** 各平台 bundle 至少需要的图标文件；由 `tauri icon` 生成。 */
export const REQUIRED_ICONS = {
  win32: ["icon.ico"],
  darwin: ["icon.icns", "128x128.png", "128x128@2x.png"],
  linux: ["32x32.png", "128x128.png", "128x128@2x.png"]
};

/** 图标源最小边长：Tauri 需要足够的像素密度生成 icns/各档 PNG。 */
export const MIN_ICON_SOURCE_SIZE = 1024;

/** Source frontend builds need the canvas WASM bindings, including native desktop UI imports. */
export const FRONTEND_BUILD_STEPS = [
  ["exec", "node", "scripts/build-bevy-wasm.mjs", "--mode", "release"],
  ["run", "assets:sync"],
  ["-C", "web", "run", "build:units"],
  ["-C", "web", "--filter", "@woohaa3/frontend", "run", "build"],
  ["run", "build:browser"],
  ["run", "assemble:extensions"]
];

const VALUE_ARGS = new Set([
  "--ui-url",
  "--backend-url",
  "--bundles",
  "--target",
  "--out",
  "--release-id",
  "--frontend",
  "--identifier",
  "--version",
  "--icon-source"
]);

const FLAG_ARGS = new Set([
  "--build-frontend",
  "--debug",
  "--no-bundle",
  "--copy",
  "--dry-run",
  "--icons",
  "--help"
]);

/**
 * 解析 CLI 参数。未知参数直接失败，避免拼错的开关被静默忽略。
 * `--help` 与 `--icons` 是模式开关，其余用于 `build` 模式。
 */
export function parseDesktopArgs(argv) {
  const raw = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--") continue;
    const [name, inline] = argv[index].split("=", 2);
    if (FLAG_ARGS.has(name)) {
      if (inline !== undefined) throw new Error(`${name} 不接受取值`);
      flags.add(name);
      continue;
    }
    if (VALUE_ARGS.has(name)) {
      const value = inline ?? argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${name} 需要取值`);
      if (inline === undefined) index += 1;
      if (raw[name] !== undefined) throw new Error(`${name} 重复出现`);
      raw[name] = value;
      continue;
    }
    throw new Error(`未知参数：${argv[index]}`);
  }
  const mode = flags.has("--help") ? "help" : flags.has("--icons") ? "icons" : "build";
  const backendUrl = raw["--backend-url"] === undefined ? null : requireHttpUrl(raw["--backend-url"], "--backend-url");
  const uiUrl = raw["--ui-url"] === undefined
    ? (backendUrl === null ? null : new URL("/", backendUrl).href)
    : requireHttpUrl(raw["--ui-url"], "--ui-url");
  return {
    mode,
    uiUrl,
    backendUrl,
    bundles: raw["--bundles"] === undefined ? null : raw["--bundles"],
    target: raw["--target"] ?? null,
    out: raw["--out"] ?? null,
    releaseId: raw["--release-id"] ?? null,
    frontend: raw["--frontend"] ?? null,
    identifier: raw["--identifier"] ?? null,
    version: raw["--version"] ?? null,
    iconSource: raw["--icon-source"] ?? null,
    buildFrontend: flags.has("--build-frontend"),
    debug: flags.has("--debug"),
    bundle: !flags.has("--no-bundle"),
    copy: flags.has("--copy"),
    dryRun: flags.has("--dry-run")
  };
}

/** 校验 http/https URL；其余协议（含 `file:`、`javascript:`）一律拒绝。 */
export function requireHttpUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} 不是合法 URL：${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} 只接受 http/https：${value}`);
  }
  return url.href;
}

/** 平台是否具备发行打包目标；不支持的平台返回可读原因，而不是静默产出错误产物。 */
export function platformSupportError(platform) {
  if (SUPPORTED_PLATFORMS.includes(platform)) return null;
  return `桌面发行打包目前只覆盖 ${SUPPORTED_PLATFORMS.join(" / ")}；当前平台 ${platform} 不在其中。`;
}

/**
 * 解析实际要构建的 bundle 种类：缺省取平台值，显式 `--bundles` 只能收窄。
 * `--no-bundle` 下返回空数组（仍会编译 release 可执行文件）。
 */
export function resolveBundleKinds({ platform, requested, bundle }) {
  if (!bundle) return [];
  const allowed = PLATFORM_BUNDLES[platform];
  if (!allowed) throw new Error(platformSupportError(platform) ?? `平台 ${platform} 没有 bundle 目标`);
  if (requested === null || requested === undefined || requested === "") return [...allowed];
  const kinds = String(requested).split(/[,\s]+/).filter(Boolean);
  if (kinds.length === 0) throw new Error("--bundles 为空");
  const unique = [...new Set(kinds)];
  for (const kind of unique) {
    if (!allowed.includes(kind)) {
      throw new Error(`--bundles ${kind} 不适用于 ${platform}；可用：${allowed.join(" / ")}`);
    }
  }
  return unique;
}

/** 缺失的必需图标文件（相对 icons 目录）。 */
export function missingIcons({ iconsDir, platform, exists = fs.existsSync }) {
  const required = REQUIRED_ICONS[platform] ?? [];
  return required.filter(name => !exists(path.join(iconsDir, name)));
}

/** 读取 PNG 头部尺寸；用于在生成图标前断言源图足够大且为正方形。 */
export function readPngSize(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("图标源不是 PNG 文件");
  }
  if (buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("图标源 PNG 缺少 IHDR 头");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** 校验图标源：正方形且不小于 `MIN_ICON_SOURCE_SIZE`。 */
export function validateIconSource({ buffer, label = "图标源" }) {
  const { width, height } = readPngSize(buffer);
  if (width !== height) throw new Error(`${label} 必须为正方形，实际 ${width}×${height}`);
  if (width < MIN_ICON_SOURCE_SIZE) {
    throw new Error(`${label} 至少需要 ${MIN_ICON_SOURCE_SIZE}×${MIN_ICON_SOURCE_SIZE}，实际 ${width}×${height}`);
  }
  return { width, height };
}

/** 写入 bundle 的默认值文档；Rust 侧（`desktop/src/packaging.rs`）读取 `uiUrl`。 */
export function buildDefaultsDocument({ uiUrl }) {
  return { version: 1, uiUrl: uiUrl ?? null };
}

/**
 * Tauri `--config` 覆盖内容。
 *
 * 只放非路径键与**绝对**资源路径：合并配置里的相对路径归属不明确，图标等相对路径继续留在
 * `desktop/tauri.conf.json`。资源用 map 形式显式指定目标名，避免依赖绝对路径的目录推断。
 */
export function tauriConfigOverride({ identifier = null, version = null, frontendDist = null, defaultsPath = null }) {
  const config = {};
  if (identifier) config.identifier = identifier;
  if (version) config.version = version;
  if (frontendDist) config.build = { frontendDist };
  if (defaultsPath) config.bundle = { resources: { [defaultsPath]: DESKTOP_DEFAULTS_RESOURCE } };
  return config;
}

/** 组装 `tauri build` 参数（不含可执行文件与 cwd）。 */
export function tauriBuildArgs({ options, kinds, config }) {
  const args = ["build"];
  if (options.debug) args.push("--debug");
  if (options.target) args.push("--target", options.target);
  if (kinds.length > 0) args.push("--bundles", kinds.join(","));
  if (!options.bundle) args.push("--no-bundle");
  if (Object.keys(config).length > 0) args.push("--config", JSON.stringify(config));
  return args;
}

/** 发行标识：`desktop-<UTC 时间戳>-<平台>-<架构>`。 */
export function releaseIdFor({ platform, arch, now = new Date() }) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `desktop-${stamp}-${platform}-${arch}`;
}

/** bundle 产物目录：`<desktop>/target[/<triple>]/<profile>/bundle/<kind 目录>`。 */
export function bundleOutputDir({ desktopDir, target = null, debug = false, kind }) {
  const dir = BUNDLE_OUTPUT_DIRS[kind];
  if (!dir) throw new Error(`未知 bundle 种类：${kind}`);
  return path.join(desktopDir, "target", ...(target ? [target] : []), debug ? "debug" : "release", "bundle", dir);
}

/**
 * 列出各 bundle 目录直接子项作为产物。不按产品名写死：`.app` 目录、`.dmg`/`.deb` 文件都取实际条目。
 *
 * 缺目录（该种类没产出）不抛裸 ENOENT：交给调用方按「请求了却没有产物」给出可读错误，
 * 这样 `--bundles app,dmg` 只有 dmg 失败时也能指出具体是哪一项。
 */
export function collectBundleArtifacts({ desktopDir, target = null, debug = false, kinds, listDir = fs.readdirSync }) {
  const artifacts = [];
  for (const kind of kinds) {
    const dir = bundleOutputDir({ desktopDir, target, debug, kind });
    let entries;
    try {
      entries = listDir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      artifacts.push({ kind, path: path.join(dir, entry.name), name: entry.name });
    }
  }
  return artifacts;
}

/** 请求了却完全没有产物的 bundle 种类，附期望目录，便于直接定位 tauri build 的失败点。 */
export function missingBundleKinds({ desktopDir, target = null, debug = false, kinds, artifacts }) {
  const produced = new Set(artifacts.map(entry => entry.kind));
  return kinds
    .filter(kind => !produced.has(kind))
    .map(kind => ({ kind, dir: bundleOutputDir({ desktopDir, target, debug, kind }) }));
}

/**
 * 对文件或目录计算确定性 sha256 与字节数。
 * 目录按相对路径排序后把「路径 + 文件哈希」喂进同一个哈希，保证同一棵树同值、可跨机比对。
 */
export async function hashPath(target) {
  const stat = await fs.promises.stat(target);
  if (stat.isFile()) return { sha256: await hashFile(target), bytes: stat.size };
  if (!stat.isDirectory()) throw new Error(`${target} 既不是文件也不是目录`);
  const files = await listTree(target);
  const digest = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const fileStat = await fs.promises.lstat(file);
    const relative = path.relative(target, file).split(path.sep).join("/");
    digest.update(`file\u0000${relative}\u0000${fileStat.size}\u0000`);
    if (fileStat.isSymbolicLink()) {
      // 符号链接按目标路径计入，不跟随（避免把外部目录卷进产物哈希）。
      digest.update(`link\u0000${await fs.promises.readlink(file)}`);
      continue;
    }
    digest.update(await hashFile(file));
    bytes += fileStat.size;
  }
  return { sha256: digest.digest("hex"), bytes };
}

async function hashFile(file) {
  const digest = createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest("hex");
}

async function listTree(root) {
  const found = [];
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await listTree(full)));
    else found.push(full);
  }
  return found;
}

/**
 * 组装 manifest。字段刻意区分「本次真实产出」与「未做/未验证」：
 * 渲染与合成验收不由打包脚本声称通过，本机宿主也未随包发布。
 */
export function buildDesktopManifest({
  releaseId,
  createdAt,
  product,
  platform,
  toolchain,
  frontend,
  bootstrap,
  artifacts,
  bundles,
  target = null,
  debug = false,
  hostPackage = null,
  notes = []
}) {
  return {
    schema: 1,
    releaseId,
    createdAt,
    product,
    platform: { ...platform, targetTriple: target },
    toolchain,
    frontend,
    bootstrap,
    build: { bundles, debug },
    artifacts,
    hostPackage: hostPackage ?? {
      status: "not-packaged",
      note: "本机宿主（web/backend 的 Node 进程）不随桌面 bundle 发布；桌面壳经同源 HTTP/WS 访问它。"
    },
    verification: {
      rendering: "pending-manual",
      note: "打包不采集渲染/合成/性能结论；未做人工验收前不得声称通过。"
    },
    notes
  };
}

/** 把解析出的参数还原成可读命令，供 `--dry-run` 与日志使用。 */
export function formatCommand(command, args) {
  return [command, ...args].map(quoteArgument).join(" ");
}

function quoteArgument(part) {
  if (!/[\s"'$\\]/.test(part)) return part;
  // 优先单引号（JSON 配置覆盖里必有双引号，用单引号更接近可粘贴的命令）。
  if (!part.includes("'")) return `'${part}'`;
  return JSON.stringify(part);
}

/** Runtime resources are assembled for the native host only. */
export function nativeTargetError({ platform, arch, target = null }) {
  if (platform === "win32" && arch !== "x64") return "Windows desktop packaging requires native Windows x64";
  if (!target) return null;
  const triples = { darwin: {arm64:"aarch64-apple-darwin",x64:"x86_64-apple-darwin"}, win32:{x64:"x86_64-pc-windows-msvc"},linux:{x64:"x86_64-unknown-linux-gnu",arm64:"aarch64-unknown-linux-gnu"} };
  return triples[platform]?.[arch] === target ? null : `Desktop packaging requires the native host target; ${target} does not match ${platform}/${arch}`;
}
