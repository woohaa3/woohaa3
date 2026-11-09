#!/usr/bin/env node
/**
 * Tauri 桌面发行打包
 * （change: 2026-10-14-migrate-canvas-to-tauri-native-bevy，任务 6.7 / 6.9）。
 *
 *   pnpm desktop:bundle                       # 本机平台 bundle + manifest
 *   pnpm desktop:bundle --ui-url http://127.0.0.1:5180/
 *   pnpm desktop:bundle --bundles app --debug --dry-run
 *   pnpm desktop:icons                        # 由 desktop/icons/source.png 重建图标集
 *
 * macOS 签名/公证：
 * - `APPLE_SIGNING_IDENTITY` 给 40 位 SHA-1 指纹（同名证书会歧义）即用 Developer ID 签名；
 *   不给或给 `-` 是 ad-hoc。
 * - App 公证由 tauri 驱动，DMG 随后独立提交 `notarytool` 并装订，需要 `APPLE_API_KEY`/`APPLE_API_ISSUER`/`APPLE_API_KEY_PATH`
 *   或 `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`。
 * - 宿主动作树里的 Mach-O 在 bundle 之外，由本脚本在打归档前用同一身份签掉。
 *
 * 边界（不夸大）：
 * - Windows 仍不产出 Authenticode、Linux 仍不产出 apt/rpm 仓库。更新源由 build profile 决定。
 * - Apple Silicon 默认装配 Node、本机宿主、扩展与工具；显式 --ui-url 保留外部服务调试。
 * - 不采集渲染/合成/性能结论：打包过程不验收画面，这些项保持「待人工验证」。
 * - 不启用 `gpu-debug`（design D8 要求发行构建不携带 Bevy pass 名称）。
 */
import { readSourceIdentity } from "./lib/source-identity.mjs";
import { prepareDesktopHost } from "./prepare-desktop-host.mjs";
import { standaloneBundleConfig, createHostArchive, nodeArtifact, prepareStartupFrontend } from "./lib/desktop-host-package.mjs";
import { spawnSync } from "node:child_process";
import { packageManagerInvocation } from "../web/scripts/package-manager.mjs";
import { createRequire } from "node:module";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ARTIFACTS_ROOT,
  DESKTOP_DEFAULTS_RESOURCE,
  FRONTEND_BUILD_STEPS,
  buildDefaultsDocument,
  buildDesktopManifest,
  clearBundleOutputDirs,
  collectBundleArtifacts,
  formatCommand,
  hashPath,
  missingBundleKinds,
  missingIcons,
  parseDesktopArgs,
  platformSupportError,
  nativeTargetError,
  releaseIdFor,
  resolveBundleKinds,
  tauriBuildArgs,
  tauriConfigOverride,
  tauriFrontendDist,
  validateIconSource
} from "./lib/desktop-release.mjs";
import { buildDefines, describeBuildProfile, loadBuildProfile, updateEndpointFor, updaterPlatformKey } from "./lib/build-profile.mjs";
import { notarizeMacDiskImages } from "./lib/macos-notarization.mjs";
import {
  ADHOC_IDENTITY,
  describeMacSigning,
  findMachOFiles,
  notarizationCredentials,
  notarizationGap,
  parseCodeSigningIdentities,
  resolveMacSigning
} from "./lib/macos-signing.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
// Explicit external composition projects use the same packaging pipeline.
// Standalone client builds keep their empty-provider desktop project.
const desktopDir = path.resolve(process.env.WOOHAA_DESKTOP_PROJECT_DIR ?? path.join(root, "desktop"));
const iconsDir = path.join(root, "desktop", "icons");
const configPath = path.join(desktopDir, "tauri.conf.json");
const defaultsPath = path.join(process.env.WOOHAA_DESKTOP_PACKAGING_DIR ?? path.join(desktopDir, "build", "packaging"), DESKTOP_DEFAULTS_RESOURCE);
const require = createRequire(import.meta.url);

const usage = `Tauri 桌面发行打包

用法：
  pnpm desktop:bundle [选项]
  pnpm desktop:icons [--icon-source desktop/icons/source.png]

选项：
  --ui-url <url>       写入 bundle 默认界面地址（同源 loopback）；未给则启动随包宿主并同源加载界面
  --backend-url <url>  只写 origin 时用；等价于 --ui-url <url>/
  --bundles <list>     收窄 bundle 种类（darwin: app,dmg；win32: nsis；linux: deb,rpm,appimage）
  --no-bundle          只编译 release 可执行文件，不产出安装包
  --debug              用 debug profile（复用已有调试产物，用于验证打包链路）
  --target <triple>    指定本机 target；不支持跨平台或跨架构装配
  --frontend <dir>     前端 dist 目录（默认 web/frontend/dist）
  --build-frontend     先构建前端与扩展发布产物（包含前端所需的两套 WASM 绑定）
  --identifier <id>    覆盖 bundle identifier
  --version <semver>   覆盖应用版本
  --out <dir>          manifest（及 --copy 时的产物副本）输出目录
  --copy               把 bundle 复制到 <out>/bundles/
  --release-id <id>    覆盖 release 标识
  --dry-run            只打印将执行的步骤与配置，不写盘、不编译
  --help               显示帮助

macOS 签名与公证（环境变量）：
  APPLE_SIGNING_IDENTITY            40 位 SHA-1 指纹或证书名；缺省为 ad-hoc
  APPLE_API_KEY /
  APPLE_API_ISSUER /
  APPLE_API_KEY_PATH                App Store Connect API Key（推荐）
  APPLE_ID / APPLE_PASSWORD /
  APPLE_TEAM_ID                     Apple ID + App 专用密码
`;

function fail(message) {
  console.error(`[desktop] ${message}`);
  process.exit(1);
}

/** cargo/rustup 通常不在 GUI/CI 的 PATH 里；与其它桌面脚本同一处理方式。 */
function childEnv(extra = {}) {
  return {
    ...process.env,
    ...(process.platform === "darwin" ? { APPLE_SIGNING_IDENTITY: process.env.APPLE_SIGNING_IDENTITY ?? "-" } : {}),
    PATH: `${path.join(homedir(), ".cargo", "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    ...extra
  };
}

/** 包管理器入口：优先调用方的 npm_execpath，避免依赖 PATH 里的 pnpm shim。 */
function managerCommand(args) {
  return packageManagerInvocation(args);
}

function run(command, args, options = {}) {
  console.log(`[desktop] $ ${formatCommand(command, args)}`);
  const { env, ...rest } = options;
  const result = spawnSync(command, args, { cwd: root, env: childEnv(env), stdio: "inherit", ...rest });
  if (result.error) throw new Error(`无法启动 ${command}：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} 退出码 ${result.status ?? "null"}`);
}

/**
 * 只需要输出的探测命令；非零退出时返回 null。
 *
 * 合并 stderr：`codesign -dvv`、`spctl`、`stapler` 都把结果写进 stderr。
 */
function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env: childEnv(options.env), encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function runManager(args) {
  const { command, args: commandArgs } = managerCommand(args);
  run(command, commandArgs);
}

function resolveTauriCli() {
  let packagePath;
  try {
    packagePath = require.resolve("@tauri-apps/cli/package.json");
  } catch {
    throw new Error("未找到 @tauri-apps/cli；先执行 pnpm install（根 package.json 已固定版本）。");
  }
  const cliDir = path.dirname(packagePath);
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const entry = path.join(cliDir, pkg.bin?.tauri ?? "tauri.js");
  if (!fs.existsSync(entry)) throw new Error(`@tauri-apps/cli 入口不存在：${entry}`);
  return { entry, version: pkg.version };
}

function readConfig() {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  delete config.$schema;
  return config;
}

/**
 * 实际参与编译的 Rust 版本。
 *
 * 必须在 `desktop/` 下探测：`desktop/rust-toolchain.toml` 固定 1.97.1，而仓库根用的可能是
 * 另一个全局 toolchain。在根目录探测会把错误版本写进 manifest（首次真实构建即出现）。
 */
function rustVersion() {
  const result = spawnSync("rustc", ["--version"], { cwd: desktopDir, env: childEnv(), encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error("未找到 rustc；桌面打包需要 Rust 工具链。");
  return result.stdout.trim();
}

/**
 * 实际会被嵌入的前端 dist：`--frontend` 优先，否则解析 tauri.conf.json 的 `build.frontendDist`
 * （相对 `desktop/`），并把绝对路径写回配置覆盖，保证「校验的产物」与「打入包的产物」一致。
 */
function frontendDistPath(options, config) {
  if (options.frontend) return path.resolve(root, options.frontend);
  const declared = config.build?.frontendDist;
  if (!declared) throw new Error("tauri.conf.json 缺少 build.frontendDist，且未给出 --frontend。");
  return path.resolve(desktopDir, declared);
}

function outDirPath(options) {
  return path.resolve(root, options.out ?? path.join(DEFAULT_ARTIFACTS_ROOT, options.resolvedReleaseId));
}

/** 平台与图标集检查：这两项在任何前端构建之前就能判定。 */
function assertPlatformAndIcons({ platform }) {
  const unsupported = platformSupportError(platform);
  if (unsupported) throw new Error(unsupported);
  const missing = missingIcons({ iconsDir, platform });
  if (missing.length > 0) {
    throw new Error(`图标集不完整（缺 ${missing.join(" / ")}）；先执行 \`pnpm desktop:icons\`。`);
  }
}

/** 前端产物检查：在（可选的）前端构建之后执行。 */
function assertFrontend(frontendDist) {
  if (!fs.existsSync(path.join(frontendDist, "index.html"))) {
    throw new Error(
      `前端产物缺失：${path.join(frontendDist, "index.html")}。` +
        " 先执行 `pnpm build`，或加 `--build-frontend` 由本脚本构建。"
    );
  }
}

function buildNativeTools() {
  const probe = spawnSync("rustc", ["-vV"], { cwd: path.join(root, "bevy"), env: childEnv(), encoding: "utf8" });
  const triple = /host:\s*(\S+)/.exec(probe.stdout ?? "")?.[1];
  if (probe.error || probe.status !== 0 || !triple) throw new Error("无法探测原生 Rust host triple");
  if (triple !== nodeArtifact().triple) throw new Error(`Rust host ${triple} 与本机宿主目标 ${nodeArtifact().triple} 不匹配，请使用对应原生工具链`);
  run("cargo", ["build", "--release", "--target", triple, "--no-default-features", "--features", "native-renderer", "--bin", "model-renderer", "--bin", "world-video-encoder"], { cwd: path.join(root, "bevy"), env: { CARGO_TARGET_DIR: path.join(root, "bevy/target") } });
}

/**
 * 解析本次 macOS 签名与公证。
 *
 * 只在真正构建前判定：证书缺失、同名证书歧义、公证凭据半套都在这里立刻失败，
 * 而不是等到 tauri 打完 300 MiB 才报 ambiguous。
 */
function macSigning({ env = process.env } = {}) {
  if (process.platform !== "darwin") return null;
  const requested = env.APPLE_SIGNING_IDENTITY ?? ADHOC_IDENTITY;
  const notarization = requested === ADHOC_IDENTITY ? null : notarizationCredentials(env);
  const identitiesOutput = capture("security", ["find-identity", "-v", "-p", "codesigning"]) ?? "";
  return resolveMacSigning({ identity: requested, notarization, identities: parseCodeSigningIdentities(identitiesOutput) });
}

/**
 * 签宿主动作树里的 Mach-O。
 *
 * `desktop-host.tar.gz` 里的原生模块（当前是 dsh 的 `node-addon-require-builtin`）在 bundle 之外，
 * tauri 的签名走不到；未签的 ad-hoc 模块会被签好的 `woohaa-node` 以
 * 「mapping process and mapped file have different Team IDs」拒绝加载。所以要在打归档**之前**
 * 用同一身份签掉，否则归档哈希也会白算。
 *
 * ad-hoc 构建下不签：ad-hoc 主程序本来就加载不了任何带团队标识的模块，签名反而更糟。
 */
function signHostBinaries(resourceRoot, signing) {
  if (!signing || signing.adhoc) return [];
  const binaries = findMachOFiles(resourceRoot);
  for (const binary of binaries) {
    run("/usr/bin/codesign", ["--force", "--timestamp", "--options", "runtime", "--sign", signing.identity, binary]);
  }
  console.log(`[desktop] 已用 ${signing.fingerprint} 签 ${binaries.length} 个宿主原生模块`);
  return binaries;
}

/**
 * 构建后核对签名结果，而不是只信任打包日志。
 *
 * 三件事：产物确实带 Developer ID 与团队标识、公证票据已装订、Gatekeeper 实际放行。
 * `spctl` 是唯一能证明「用户双击能开」的检查；没有公证它必然 rejected，所以只在公证过的
 * 情况下降级为失败——未公证时把结论留在 manifest 的 notes 里，不假装通过。
 */
function verifyMacSignature({ artifacts, signing }) {
  const app = artifacts.find(artifact => artifact.path.endsWith(".app"));
  const dmg = artifacts.find(artifact => artifact.path.endsWith(".dmg"));
  if (!signing || signing.adhoc) {
    console.log("[desktop] macOS 签名：ad-hoc，不检查 Developer ID 与公证");
    return;
  }
  if (!app && !dmg) {
    console.log("[desktop] 本次未产出 .app/.dmg（--no-bundle），跳过签名与公证核对");
    return;
  }
  if (!app) {
    console.log("[desktop] 未产出 .app，跳过 Developer ID 核对（只产出了 DMG）");
  } else {
    const details = capture("/usr/bin/codesign", ["-dvv", app.path]) ?? "";
    if (!/^Authority=Developer ID Application: /m.test(details)) {
      throw new Error(`产物没有 Developer ID 签名：${relative(app.path)}\n${details.split("\n").slice(0, 8).join("\n")}`);
    }
    if (!/^TeamIdentifier=\S+/m.test(details)) throw new Error(`产物缺少 TeamIdentifier：${relative(app.path)}`);
  }

  // Tauri 公证并装订 App；随后生成的 DMG 由 notarizeMacDiskImages 独立公证。
  // 每个分发目标都必须有票据，不能用 App 的票据代替 DMG 的票据。
  //
  // 判据是 `stapler validate`（读包内票据，不看缓存），**不是** `spctl`：spctl 查本机
  // Gatekeeper 缓存，CI 机器评估过同一路径的旧 ad-hoc 包后会持续返回 rejected，
  // 曾把已经 Accepted 并装订好的产物误判成失败。spctl 只作诊断输出。
  const targets = [app, dmg].filter(Boolean);
  const stapled = targets.filter(target => capture("/usr/bin/xcrun", ["stapler", "validate", target.path]) !== null);
  for (const target of targets) {
    const assessment = capture("/usr/bin/spctl", target.path.endsWith(".dmg")
      ? ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", target.path]
      : ["--assess", "--type", "exec", "-vv", target.path]);
    if (!assessment) console.log(`[desktop] spctl 未放行 ${target.name}（缓存可能过期；以已装订票据为准）`);
  }
  if (signing.notarization) {
    const missing = targets.filter(target => !stapled.includes(target));
    if (missing.length > 0) {
      throw new Error(
        `已公证的产物没有装订票据：${missing.map(target => relative(target.path)).join(" / ")}；` +
          "确认公证返回 Accepted 且 stapler staple 成功。"
      );
    }
    console.log(`[desktop] 公证核对：票据已装订 ${stapled.map(target => target.name).join(" / ")}`);
    return;
  }
  console.log(`[desktop] 公证核对：未公证（票据 ${stapled.length}/${targets.length}），首次打开会被拦截`);
}

function frontendBuildSteps(standalone) {
  return standalone?FRONTEND_BUILD_STEPS.filter(step=>!step.includes("scripts/build-bevy-wasm.mjs")).map(step=>step.includes("@woohaa3/frontend")?[...step.slice(0,-1),"build:desktop"]:step):FRONTEND_BUILD_STEPS;
}

function buildFrontend(standalone) {
  console.log("[desktop] 构建前端与扩展发布产物（含 Bevy 与图像编辑器 WASM 绑定）");
  for (const step of frontendBuildSteps(standalone)) runManager(step);
}

function writeDefaults(uiUrl) {
  fs.mkdirSync(path.dirname(defaultsPath), { recursive: true });
  const document = buildDefaultsDocument({ uiUrl });
  fs.writeFileSync(defaultsPath, `${JSON.stringify(document, null, 2)}\n`);
  return document;
}

/** 图标模式：由 1024 源图重建桌面图标集，并清掉手机/Windows Store 专用产物。 */
function runIcons(options) {
  const sourcePath = path.resolve(root, options.iconSource ?? path.join("desktop", "icons", "source.png"));
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`图标源不存在：${sourcePath}。请提供 ≥1024×1024 的正方形 PNG。`);
  }
  const size = validateIconSource({ buffer: fs.readFileSync(sourcePath), label: sourcePath });
  console.log(`[desktop] 图标源 ${sourcePath}（${size.width}×${size.height}）`);
  const cli = resolveTauriCli();
  run(process.execPath, [cli.entry, "icon", sourcePath, "--output", iconsDir], { cwd: desktopDir });
  // 本应用只面向电脑与平板：手机图标树与 Windows Store 资源不入库。
  const removed = [];
  for (const entry of ["android", "ios"]) {
    const target = path.join(iconsDir, entry);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(`${entry}/`);
    }
  }
  for (const entry of fs.readdirSync(iconsDir)) {
    if (/^Square\d+x\d+Logo\.png$/.test(entry) || entry === "StoreLogo.png") {
      fs.rmSync(path.join(iconsDir, entry), { force: true });
      removed.push(entry);
    }
  }
  console.log(`[desktop] 已重建 ${iconsDir}${removed.length ? `（清理 ${removed.join(" / ")}）` : ""}`);
}

async function runBuild(options) {
  const sourceBefore = readSourceIdentity(root);
  const platform = process.platform;
  const arch = process.arch;
  const config = readConfig();
  const cli = resolveTauriCli();
  const frontendDist = frontendDistPath(options, config);
  const resolvedReleaseId = options.releaseId ?? releaseIdFor({ platform, arch });
  const resolved = { ...options, resolvedReleaseId };

  const kindList = resolveBundleKinds({ platform, requested: options.bundles, bundle: options.bundle });
  const targetError = nativeTargetError({ platform, arch, target: options.target });
  if (targetError) throw new Error(targetError);
  assertPlatformAndIcons({ platform });
  // 更新源、信任根与构建期常量都来自 build profile；env 只在 loader 内作为加载期覆盖。
  // 必须在 buildFrontend 之前加载：公开桶与官方信任根要通过 WOOHAA3_DEFINES 进入前端/后端产物。
  const buildProfile = loadBuildProfile({ repoRoot: path.dirname(root), env: process.env });
  if (!buildProfile.ok) {
    const detail = buildProfile.errors.map((error) => `  ${error.path}: ${error.message}`).join("\n");
    throw new Error(`build profile 校验失败（${buildProfile.path ?? "未知路径"}）：\n${detail}`);
  }
  console.log(`[desktop] ${describeBuildProfile(buildProfile)}`);
  // 签名/公证在编译之前判定：证书歧义与凭据半套不该等到 tauri 打完包才报。
  const signing = options.dryRun ? null : macSigning();
  if (signing) console.log(describeMacSigning(signing));
  const defines = buildDefines(buildProfile.resolved);
  if (defines && !process.env.WOOHAA3_DEFINES?.trim()) {
    process.env.WOOHAA3_DEFINES = JSON.stringify(defines);
  }
  if (defines) console.log(`[desktop] build-profile defines: ${Object.keys(defines).join(", ")}`);
  if (options.buildFrontend && !options.dryRun) {
    // 发布产物自报发布版本：桌面端没有部署脚本，按 git 现场取值只能得到 `<sha>-dirty`
    // （构建过程会写入生成资源，工作区必然是脏的），管理端「上报端版本」因此看不出是哪个版本。
    // 显式注入后，诊断/遥测上报的就是 desktop/tauri.conf.json 的发布版本。
    const frontendVersion = options.version ?? config.version;
    if (frontendVersion) {
      process.env.WOOHAA_FRONTEND_BUILD_VERSION = frontendVersion;
      process.env.WOOHAA_FRONTEND_BUILD_COMMIT = "";
    }
    buildFrontend(!options.uiUrl);
  }
  if (!options.dryRun) assertFrontend(frontendDist);

  const override = tauriConfigOverride({
    identifier: options.identifier,
    version: options.version,
    frontendDist: options.frontend ? (process.env.WOOHAA_DESKTOP_PROJECT_DIR ? frontendDist : tauriFrontendDist(frontendDist, desktopDir)) : null,
    defaultsPath
  });
  const platformKey = updaterPlatformKey({ platform, arch });
  const updateEndpoint = updateEndpointFor(buildProfile.resolved, platformKey) || null;
  const updatePublicKey = buildProfile.resolved.updatePublicKeys[0] ?? null;
  if (!options.dryRun && !options.debug && !options.uiUrl && !buildProfile.resolved.allowUnconfiguredUpdate && (!updateEndpoint || !updatePublicKey)) {
    throw new Error("缺少桌面更新源或公钥：在 build-profile.json 配 cdn.updatePath 与 desktop.update.publicKeys，或设 desktop.allowUnconfiguredUpdate=true 明确承认不带自动更新。");
  }
  let hostPackage = null;
  if (!options.dryRun && !options.uiUrl) {
    buildNativeTools();
    const prepared = await prepareDesktopHost({ frontend: frontendDist, build: resolvedReleaseId, runtimeReleaseVersion: options.debug ? undefined : (options.version ?? config.version), ...(process.env.WOOHAA_DESKTOP_HOST_STAGING ? { output: path.resolve(process.env.WOOHAA_DESKTOP_HOST_STAGING) } : {}) });
    const endpoint = updateEndpoint;
    const publicKey = updatePublicKey;
    const standalone = standaloneBundleConfig({ ...prepared, endpoint, publicKey });
    const startupFrontend = prepareStartupFrontend(frontendDist, path.join(path.dirname(defaultsPath), "startup-frontend"));
    override.build = { ...override.build, frontendDist: process.env.WOOHAA_DESKTOP_PROJECT_DIR ? startupFrontend : tauriFrontendDist(startupFrontend, desktopDir) };
    override.plugins = standalone.plugins;
    // 必须先签再打归档：未签的原生模块会让签好的 woohaa-node 加载失败，而归档哈希是在打包时定死的。
    const signedNested = signHostBinaries(prepared.resourceRoot, signing);
    const hostArchive = createHostArchive(prepared.resourceRoot, path.join(path.dirname(defaultsPath), "desktop-host.tar.gz"));
    const runtimeFile = path.join(path.dirname(defaultsPath), "desktop-runtime.json");
    fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
    fs.writeFileSync(runtimeFile, JSON.stringify({ hostArchiveSha256: hostArchive.sha256, nodeVersion: prepared.nodeVersion, ...(endpoint ? { updater: { endpoint, publicKey } } : {}) }));
    override.bundle = { ...override.bundle, ...standalone.bundle, resources: { ...override.bundle?.resources, ...standalone.bundle.resources, [runtimeFile]: "desktop-runtime.json", [hostArchive.path]: "desktop-host.tar.gz", [path.join(root, "bevy/assets/")]: "native-assets/" } };
    hostPackage = { status: "packaged", nodeVersion: prepared.nodeVersion, nodeSha256: prepared.nodeSha256, extensions: prepared.extensions, packages: prepared.packages, updater: endpoint ? "configured" : "unconfigured", ...(signing && !signing.adhoc ? { signedNestedBinaries: signedNested.length } : {}) };
  }
  let nativeComposition = null;
  if (process.env.WOOHAA_DESKTOP_COMPOSITION_IDENTITY) {
    const identityPath = path.resolve(process.env.WOOHAA_DESKTOP_COMPOSITION_IDENTITY);
    nativeComposition = JSON.parse(fs.readFileSync(identityPath, "utf8"));
    override.bundle = { ...override.bundle, resources: {
      ...override.bundle?.resources, [identityPath]: "native-composition.json"
    } };
  }
  const args = tauriBuildArgs({ options, kinds: kindList, config: override });

  if (options.dryRun) {
    console.log("[desktop] dry-run：以下步骤不会执行");
    console.log(`  平台/架构：${platform}/${arch}`);
    if (options.buildFrontend) for (const step of frontendBuildSteps(!options.uiUrl)) console.log(`  pnpm ${step.join(" ")}`);
    if (!options.uiUrl) console.log("  cargo build 原生 model-renderer (--release)，然后装配宿主运行时");
    console.log(`  前端 dist：${relative(frontendDist)}`);
    console.log(`  bundle 种类：${kindList.length > 0 ? kindList.join(", ") : "（--no-bundle）"}`);
    console.log(`  默认值资源：${relative(defaultsPath)}`);
    console.log(`  macOS 签名：${process.env.APPLE_SIGNING_IDENTITY ? "APPLE_SIGNING_IDENTITY 已设置" : "ad-hoc（APPLE_SIGNING_IDENTITY 未设置）"}`);
    console.log(`  ${JSON.stringify(buildDefaultsDocument({ uiUrl: options.uiUrl }), null, 2).split("\n").join("\n  ")}`);
    console.log(`  manifest：${relative(outDirPath(resolved))}/manifest.json`);
    console.log(`  $ ${formatCommand(process.execPath, [cli.entry, ...args])}   (cwd=${relative(desktopDir)})`);
    console.log(`  提示：运行未给出 --ui-url 时，app 打开内置前端资源，需要同源 loopback 时再注入。`);
    return;
  }

  writeDefaults(options.uiUrl);
  // 先清空本次要产出的 bundle 目录：tauri 不清理旧版本，残留会让 manifest 混进上一版安装包
  // （发布索引要求恰好一个 updater archive，直接失败），也会被 --copy 复制进上传目录。
  clearBundleOutputDirs({ desktopDir, targetDir: process.env.CARGO_TARGET_DIR, target: options.target, debug: options.debug, kinds: kindList });
  run(process.execPath, [cli.entry, ...args], { cwd: desktopDir });

  const outDir = outDirPath(resolved);
  fs.mkdirSync(outDir, { recursive: true });
  const collected = collectBundleArtifacts({ desktopDir, targetDir: process.env.CARGO_TARGET_DIR, target: options.target, debug: options.debug, kinds: kindList });
  const missing = missingBundleKinds({
    desktopDir, targetDir: process.env.CARGO_TARGET_DIR,
    target: options.target,
    debug: options.debug,
    kinds: kindList,
    artifacts: collected
  });
  if (missing.length > 0) {
    throw new Error(
      `以下 bundle 未产出任何产物：${missing.map(entry => `${entry.kind}（期望 ${relative(entry.dir)}）`).join("，")}；请检查 tauri build 输出。`
    );
  }
  if (platform === "darwin") {
    const app = collected.find(artifact => artifact.path.endsWith(".app"));
    if (app) {
      run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path]);
      const bundledNode = path.join(app.path, "Contents/MacOS/woohaa-node");
      if (fs.existsSync(bundledNode)) run(bundledNode, ["--input-type=module", "-e", "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(':memory:'); db.close(); console.log('bundled Node',process.versions.node)"]);
    }
    // stapling mutates the DMG: finish it before hashing or copying any artifact.
    notarizeMacDiskImages({ artifacts: collected, signing });
    verifyMacSignature({ artifacts: collected, signing });
  }
  const artifacts = [];
  for (const artifact of collected) {
    const { sha256, bytes } = await hashPath(artifact.path);
    artifacts.push({
      kind: artifact.kind,
      name: artifact.name,
      path: relative(artifact.path),
      sha256,
      bytes
    });
  }
  if (options.copy) {
    // 复制目标是跨构建复用的目录：不清掉的话，每次发布都会把历史版本的安装包一起带进构件
    // （实测一次归档里叠了三个版本、元数据 527 MB），而这次构建只该产出这一版。
    const bundlesDir = path.join(outDir, "bundles");
    fs.rmSync(bundlesDir, { recursive: true, force: true });
    for (const artifact of collected) {
      const destination = path.join(bundlesDir, artifact.kind, artifact.name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(artifact.path, destination, { recursive: true });
    }
    console.log(`[desktop] 已复制产物到 ${relative(bundlesDir)}`);
  }

  const indexSha256 = (await hashPath(path.join(frontendDist, "index.html"))).sha256;
  const manifest = buildDesktopManifest({
    releaseId: resolved.resolvedReleaseId,
    createdAt: new Date().toISOString(),
    product: {
      name: config.productName ?? null,
      version: options.version ?? config.version ?? null,
      identifier: options.identifier ?? config.identifier ?? null
    },
    platform: { os: platform, arch },
    toolchain: { rust: rustVersion(), tauriCli: cli.version },
    frontend: {
      dist: relative(frontendDist),
      indexSha256,
      source: options.buildFrontend ? "built-by-script" : "prebuilt"
    },
    bootstrap: {
      uiUrl: options.uiUrl,
      defaultsResource: DESKTOP_DEFAULTS_RESOURCE,
      precedence: ["--ui-url", "WOOHAA_DESKTOP_URL", "bundle 默认值", "内置前端资源"]
    },
    artifacts,
    hostPackage,
    bundles: kindList,
    target: options.target,
    debug: options.debug,
    notes: [
      platform === "darwin"
        ? signing && !signing.adhoc
          ? signing.notarization
            ? `Developer ID 已签名并公证（${signing.name}）。`
            : `Developer ID 已签名但未公证（${signing.name}）；${notarizationGap(signing)}`
          : "ad-hoc 签名；没有 Developer ID 与公证，首次打开会被 Gatekeeper 拦截。"
        : "未签名：没有 Authenticode（Windows）或 apt/rpm 仓库与签名（Linux）。",
      "未启用 gpu-debug：发行构建不携带 Bevy pass 资源名。",
      hostPackage ? "本机宿主已装配；真实启动验收记录独立保存。" : "显式外部 UI 调试模式：本机宿主未装配。"
    ]
  });
  // Capture provenance for same-revision installer + offline scene delivery.
  const sourceAfter = readSourceIdentity(root);
  if (nativeComposition) manifest.nativeComposition = nativeComposition;
  manifest.sourceRevision = sourceBefore.revision;
  manifest.sourceDirty = sourceBefore.dirty || sourceAfter.dirty || sourceBefore.revision !== sourceAfter.revision;
  const manifestPath = path.join(outDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`[desktop] 产物：${artifacts.length ? artifacts.map(entry => entry.path).join(", ") : "（未产出安装包）"}`);
  console.log(`[desktop] manifest：${relative(manifestPath)}`);
  console.log("[desktop] 渲染/合成/性能未在本环境采集，保持「待人工验证」。");
}

function relative(target) {
  const value = path.relative(root, target);
  return value.startsWith("..") ? target : value;
}

async function main() {
  const options = parseDesktopArgs(process.argv.slice(2));
  if (options.mode === "help") {
    console.log(usage);
    return;
  }
  if (options.mode === "icons") {
    runIcons(options);
    return;
  }
  await runBuild(options);
}

main().catch(error => fail(error.message));
