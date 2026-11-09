#!/usr/bin/env node
/**
 * Web host 装配器：产出一个「不需要 Node / pnpm」的自包含目录，由内嵌 Node 直接跑起来。
 *
 * 与 `prepare-desktop-host.mjs` 的关系：那份装配服务桌面壳（Tauri 窗口 + 原生 Bevy +
 * 更新源 + 原生工具），其中 Node 运行时、workspace 收集、扩展自包含目录、可移植性断言
 * 都是通用能力，这里**复用同一批 lib**，只把桌面专属的部分换掉：
 * - 前端用浏览器产物（含 `renderer.html` 与 Bevy WASM），不是 `--mode desktop` 的 native-only 产物；
 * - 不产出 `extension-trust.json`（桌面发布才固定信任根）与原生 renderer/world-video-encoder；
 * - 后端用 esbuild 全内联成单文件，因此**不需要** `backend-runtime/node_modules`。
 *
 * 用法：
 *   node scripts/prepare-web-host.mjs [--out <dir>] [--node-cache <dir>]
 *
 * 产物布局（相对 --out）：
 *   web-host.mjs            启动入口（本文件同时负责复制）
 *   backend.cjs             全内联后端（createBackendService 等导出）
 *   frontend/               浏览器静态产物
 *   extensions/<id>/        逐扩展自包含目录（含槽位实现）
 *   scripts/                扩展宿主与静态服务所需脚本（整目录，不能挑文件）
 *   web/contracts/          base-path 契约源码（app-html 依赖）
 *   models.json             模型配置
 *   data/                   运行期数据（首次启动时创建）
 *   node/woohaa-node        固定版本 Node 运行时
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';import {
  copyRuntimeFiles,
  copyRuntimePackage,
  attachRuntimePackage,
  assertPortableTree,
  linkRuntimePackage,
  isExternalDesktopDependency
} from './lib/desktop-host-package.mjs';
import { prepareWebHostNode, webNodeArtifact } from './lib/web-host-node.mjs';
import { scanExtensions } from './lib/extension-scan.mjs';
import { loadBuildProfile, buildDefines, describeBuildProfile } from './lib/build-profile.mjs';
import { applySiteDefaultEnabled } from './lib/site-extension-defaults.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(HERE, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export function resolveWebHostLayout(clientRoot = CLIENT_ROOT) {
  return {
    clientRoot,
    frontendDist: path.join(clientRoot, 'web/frontend/dist'),
    backendEntry: path.join(clientRoot, 'web/backend/src/index.ts'),
    contractsDir: path.join(clientRoot, 'web/contracts'),
    contractsBasePath: path.join(clientRoot, 'web/contracts/src/base-path'),
    modelsFile: path.join(clientRoot, 'web/services/task-service/pptask.models.json'),
    scriptsDir: path.join(clientRoot, 'scripts')
  };
}

/**
 * 把后端全内联成一个 CJS 文件。
 *
 * 为什么必须全内联：`build-package.mjs` 的产物把所有声明过的依赖都留成 external，
 * 那需要随包带 `node_modules`。web host 要做到「目录里没有 node_modules 也能跑」，
 * 只能反过来把这些依赖打进来。这**只**用于这个分发形态，包构建口径不变。
 *
 * `mainFields`/`conditions` 必须按 import 优先：`jsonc-parser` 的 `main` 是 UMD 目录，
 * 内联时会留下 `require('./impl/format')` 这类运行时相对路径，打包即坏。
 */
/**
 * 校验一个已构建的产物里没有残留「未替换的构建期常量」。
 *
 * 为什么需要：esbuild 的 `define` 是文本替换，缺 `WOOHAA3_DEFINES` 时不报错，
 * 标识符原样留在产物里，运行期 `typeof X === "undefined"` 静默走进空分支——
 * 表现是默认配置（公开桶、信任根、默认设置）悄悄为空。
 *
 * esbuild 替换成功后会留下 `// <define:X>` 注释与 `"<define:X>"()` 内部函数名，
 * 它们不代表未替换，必须排除。返回未替换的键名（空数组表示干净）。
 */
export function findUnreplacedDefines(bundledText, keys) {
  return keys.filter((key) => {
    const pattern = new RegExp(`(^|[^\\w:<-])${key}\\b`);
    return bundledText
      .split('\n')
      .some((line) => !line.includes(`<define:${key}>`) && pattern.test(line));
  });
}

/**
 * 读取 `WOOHAA3_DEFINES` 并转成 esbuild 的 `define`。
 *
 * 这段与 `web/scripts/build-package.mjs` 的口径一致：键名是产物里的标识符，值必须是
 * JS 表达式文本（用 JSON 字面量）。**不读这个变量的构建入口会静默丢掉全部运行时默认配置**
 * ——esbuild 不报错，标识符原样留在产物里，`typeof X === "undefined"` 于是走空分支。
 */
function readDefines(env = process.env) {
  const raw = env.WOOHAA3_DEFINES;
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('WOOHAA3_DEFINES 不是合法 JSON（应由 build-profile 的 buildDefines 生成）');
  }
  if (parsed === null || typeof parsed !== 'object') return {};
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, JSON.stringify(value)]));
}

export async function bundleBackend({ entry, outfile, sourcemap = true, env = process.env }) {
  // esbuild 只装在 `web/` workspace 里（客户端的打包口径都在那边）；client 根没有它的依赖。
  const requireFromWeb = createRequire(path.join(CLIENT_ROOT, 'web/package.json'));
  const esbuild = requireFromWeb('esbuild');
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile,
    sourcemap,
    // 内建模块必须留成 require，esbuild 不会也不需要打包它们。
    external: ['node:*'],
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    loader: { '.css': 'empty', '.node': 'empty' },
    // 构建期常量（公开桶、官方信任根、默认设置）。与 build-package.mjs 同一来源。
    define: readDefines(env),
    logLevel: 'error',
    metafile: true
  });
  const external = Object.keys(result.metafile.inputs).filter((key) => key.startsWith('external'));
  if (external.length > 0) {
    throw new Error(`后端仍有未内联的外部依赖：${external.slice(0, 5).join(', ')}`);
  }
  const size = fs.statSync(outfile).size;
  return { outfile, size, modules: Object.keys(result.metafile.inputs).length };
}

/** 递归列出目录下的 `.js` / `.mjs`（扩展产物只有这类需要检查）。 */
function listScripts(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listScripts(full));
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** 复制 `scripts/` 目录（排除测试与本地状态）—— 扩展宿主按整目录相互 import，不能挑文件。 */
function copyScripts(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, entry.name);
    const to = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      fs.cpSync(from, to, { recursive: true, dereference: true });
      continue;
    }
    if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.cjs')) continue;
    if (entry.name.includes('.test.')) continue;
    fs.copyFileSync(from, to);
  }
}

/**
 * 清掉 `pnpm deploy --legacy` 留下的悬空软链。
 *
 * pnpm 会在 `node_modules/.pnpm/node_modules/` 建一层 hoisted 索引，--prod 部署后其中仍有
 * 指向**未部署**的开发包（esbuild / vite / msw 等）的链接。它们运行期不会被解析，但会让
 * `assertPortableTree` 的 realpath 直接 ENOENT，看起来像产物损坏。release 装配
 * （父仓 `assemble-release.mjs`）有同类清理，这里是它的最小对应实现。
 */
export function pruneDanglingLinks(root) {
  const removed = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target = null;
        try {
          target = fs.realpathSync(absolute);
        } catch {
          fs.rmSync(absolute, { force: true });
          removed.push(path.relative(root, absolute).split(path.sep).join('/'));
          continue;
        }
        // 指向树外（workspace 源码）的链接同样必须清掉：分发目录不能依赖仓库。
        if (target !== root && !target.startsWith(`${root}${path.sep}`) && !fs.lstatSync(absolute).isDirectory()) {
          fs.rmSync(absolute, { force: true });
          removed.push(path.relative(root, absolute).split(path.sep).join('/'));
        }
        continue;
      }
      if (entry.isDirectory()) walk(absolute);
    }
  };
  walk(root);
  return removed;
}

/**
 * 装配 web host 资源目录。
 *
 * `includeExtensions` 为空时按 `extensions.config.json` 的扫描根装配全部已启用扩展；
 * 每个扩展都装成自包含目录（`pnpm deploy --prod --legacy`，与 release 装配同口径），
 * 因此运行期不需要 workspace 与仓库源码。
 */
export async function prepareWebHost({
  out,
  nodeCache = path.join(CLIENT_ROOT, '.local/web-host-node'),
  clientRoot = CLIENT_ROOT,
  frontend = null,
  includeExtensions = null,
  deployExtension = null,
  prepareNode = prepareWebHostNode,
  /** 写进 manifest 的版本标识（部署脚本传入工作区 HEAD）；缺省不写。 */
  commit = null
} = {}) {
  const layout = resolveWebHostLayout(clientRoot);
  const output = path.resolve(out ?? path.join(clientRoot, '.local/web-host'));
  const frontendDir = path.resolve(frontend ?? layout.frontendDist);

  if (!fs.existsSync(path.join(frontendDir, 'index.html'))) {
    throw new Error(`前端产物缺失：${frontendDir}/index.html。先运行 pnpm build（浏览器产物，不是 desktop 产物）`);
  }
  // 浏览器形态必须有 renderer.html + WASM realm；缺了说明拿到的是 `--mode desktop` 产物。
  if (!fs.existsSync(path.join(frontendDir, 'renderer.html'))) {
    throw new Error(`${frontendDir} 缺少 renderer.html：这是桌面 native-only 产物，web host 需要浏览器产物`);
  }

  const node = await prepareNode({ cacheDir: nodeCache });
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });

  // 1) 后端单文件
  //
  // **必须在 bundleBackend 之前注入构建期常量**：`build-package.mjs` 的 esbuild `define`
  // 只读 `WOOHAA3_DEFINES`，没注入时那些标识符会原样留在产物里（不被替换），运行期
  // `typeof X === "object"` 恒为 false——表现是**默认配置静默丢失**：settingDefaults
  // （exposer.primary / storage.local.publicEnabled / 市场信任键）、官方扩展信任根、
  // 公开桶全部为空，而构建与启动都不报错。桌面链路由 `build-desktop.mjs` 注入，这里同样。
  const buildProfile = loadBuildProfile({ repoRoot: path.dirname(clientRoot), env: process.env });
  if (!buildProfile.ok) {
    const detail = buildProfile.errors.map((error) => `  ${error.path}: ${error.message}`).join('\n');
    throw new Error(`build profile 校验失败（${buildProfile.path ?? '未知路径'}）：\n${detail}`);
  }
  process.stdout.write(`[web-host] ${describeBuildProfile(buildProfile)}\n`);
  const defines = buildDefines(buildProfile.resolved);
  if (defines && !process.env.WOOHAA3_DEFINES?.trim()) {
    process.env.WOOHAA3_DEFINES = JSON.stringify(defines);
    process.stdout.write(`[web-host] build-profile defines：${Object.keys(defines).join('、')}\n`);
  } else if (!defines) {
    process.stdout.write('[web-host] build-profile 没有可注入的常量（公开桶/信任根/默认设置均为空）\n');
  }

  const backend = await bundleBackend({ entry: layout.backendEntry, outfile: path.join(output, 'backend.cjs') });

  // 校验构建期常量真的被内联替换了。
  //
  // esbuild 的 `define` 是**文本替换**：键名写错、变量没传，都不会报错——标识符会原样留在
  // 产物里，运行期 `typeof X === "undefined"` 于是静默走空分支。那正好是「默认配置没生效」
  // 这类最难查的问题，所以在这里当场拦住。
  //
  // 注意排除 esbuild 自己的标记：成功替换后产物里会出现 `// <define:X__>` 注释与
  // `"<define:X__>"()` 这样的内部函数名，它们**不代表未替换**。这里只匹配「不在
  // `<define:...>` 里、也不在注释里」的裸标识符。
  if (defines) {
    const bundled = fs.readFileSync(path.join(output, 'backend.cjs'), 'utf8');
    const unreplaced = findUnreplacedDefines(bundled, Object.keys(defines));
    if (unreplaced.length > 0) {
      throw new Error(
        `构建期常量没有被内联替换：${unreplaced.join('、')}\n` +
          '  说明 WOOHAA3_DEFINES 没传到 esbuild（build-package.mjs 只读这个环境变量）。\n' +
          '  产物里留着未定义的标识符时不会报错，只会静默丢掉默认配置。'
      );
    }
  }

  // 2) 前端静态产物
  //
  // `dist/` 里的 `extensions/` 与 `extension-releases/` 是**构建期**装配留下的，含每个扩展
  // 的历史版本（本机实测这两项占 257MB / 380MB）。运行期它们由扩展宿主按装配好的扩展目录
  // 重新生成（日志里的 `extension-release-built`），并由 `handleReleaseRequest` 托管，
  // 所以分发包里不能带这两项——带了既多占空间，又会让宿主误用构建期的旧指针。
  copyRuntimeFiles(frontendDir, path.join(output, 'frontend'));
  for (const stale of ['extensions', 'extension-releases', 'desktop-startup.html']) {
    fs.rmSync(path.join(output, 'frontend', stale), { recursive: true, force: true });
  }

  // 3) 扩展宿主所需的脚本与契约（app-html/静态服务会 import web/contracts 的 base-path）
  copyScripts(layout.scriptsDir, path.join(output, 'scripts'));
  copyRuntimeFiles(layout.contractsBasePath, path.join(output, 'web/contracts/src/base-path'));
  // extension-release-protocol 需要 contracts 的**构建产物**（dist/index.js），不是源码。
  const contractsDist = path.join(layout.contractsDir, 'dist');
  if (!fs.existsSync(path.join(contractsDist, 'index.js'))) {
    throw new Error('缺少 @woohaa3/contracts 构建产物：先运行 pnpm --filter @woohaa3/contracts run build');
  }
  copyRuntimeFiles(path.join(contractsDist), path.join(output, 'web/contracts/dist'));

  // 4) 模型配置
  if (fs.existsSync(layout.modelsFile)) fs.copyFileSync(layout.modelsFile, path.join(output, 'models.json'));

  // 5) 扩展：逐扩展自包含目录
  const siteDefaults = buildProfile.resolved.siteExtensionDefaults;
  const scan = scanExtensions({ repoRoot: clientRoot, env: {} });
  // 扫描根可能是三类，处理方式不同：
  // - 源码根（`web/extensions`、`extensions`）：workspace 成员，用 `pnpm deploy --prod` 装自包含目录；
  // - 运行时受管根（`.woohaa3/extensions`，市场/本地安装）：目录本身**就是**已构建的版本化产物，
  //   必须原样复制。对它跑 `pnpm deploy` 会找不到包而失败（它不在 workspace 里）。
  const sourceRoots = new Set(scan.roots.map((root) => path.resolve(root)));
  const scanned = scan.extensions;
  const wanted = includeExtensions ? new Set(includeExtensions) : null;
  const selected = scanned.filter((extension) => !wanted || wanted.has(extension.extensionId));
  const installed = [];
  // 运行时收集器的共享状态：按平台过滤 os/cpu、记录依赖边、把 workspace 包裁剪成运行时形态。
  const state = new Map();
  state.platform = process.platform;
  state.arch = process.arch;
  state.runtimeOnly = true;
  state.excludeDependency = isExternalDesktopDependency;
  // `web/pnpm-workspace.yaml` 的 packageExtensions 修补了上游漏声明的运行依赖
  // （典型：`@google/adk@2.3.0` 的 ESM 里 import 了 uuid 却没写进 dependencies）。
  // 收集器按声明后的依赖图走，缺这一项会在运行期才炸「Cannot find package 'uuid'」。
  const yaml = createRequire(path.join(clientRoot, 'web/backend/package.json'))('yaml');
  state.packageExtensions = yaml.parse(
    fs.readFileSync(path.join(clientRoot, 'web/pnpm-workspace.yaml'), 'utf8')
  ).packageExtensions ?? {};
  const deploy = deployExtension ?? ((name, target) => {
    execFileSync('pnpm', ['--filter', name, 'deploy', '--prod', '--legacy', target], {
      cwd: path.join(clientRoot, 'web'),
      stdio: 'inherit'
    });
  });
  for (const extension of selected) {
    const pkgFile = path.join(extension.dir, 'package.json');
    if (!fs.existsSync(pkgFile)) continue;
    const name = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).name;
    if (typeof name !== 'string' || name === '') continue;
    const target = path.join(output, 'extensions', extension.extensionId);
    if (sourceRoots.has(path.resolve(extension.root))) {
      // 用与桌面装配相同的**运行时收集器**，而不是 `pnpm deploy --prod`。
      //
      // 实测差异很大：`pnpm deploy` 会把 `@woohaa3/frontend`（512MB/份）、
      // `@openai/codex`（430MB）、`@anthropic-ai/claude-agent-sdk`（256MB）这类开发期
      // 或按需下载的依赖一起装进来，全量 21 个扩展装配出来是 2.5GB。收集器按依赖图
      // 逐包复制 + `isExternalDesktopDependency` 白名单排除，并把 workspace 包里的
      // `src`/`server-dist`/测试目录剥掉，同样的集合只要约 90MB。
      const collected = copyRuntimePackage(extension.dir, output, state);
      // 收集结果里**只有扩展自身的文件**，依赖是同级的相对符号链接，整目录 cp 会断链。
      // 因此先复制自身文件，再在目标位置按依赖边**重建**链接（与 `prepareDesktopHost` 同一做法）。
      copyRuntimeFiles(collected, target);
      const deps = path.join(collected, 'node_modules');
      if (fs.existsSync(deps)) {
        for (const name of fs.readdirSync(deps)) {
          const names = name.startsWith('@') ? fs.readdirSync(path.join(deps, name)).map((item) => `${name}/${item}`) : [name];
          for (const dep of names) {
            linkRuntimePackage(fs.realpathSync(path.join(deps, dep)), path.join(target, 'node_modules', dep), output, state);
          }
        }
      }
      process.stdout.write(`[web-host] ${extension.extensionId}：运行时收集器装配完成\n`);
    } else {
      // 受管/市场安装的产物：整目录复制，不经过 pnpm。
      fs.rmSync(target, { recursive: true, force: true });
      copyRuntimeFiles(extension.dir, target);
      process.stdout.write(`[web-host] ${extension.extensionId}：来自运行时受管根，已原样复制\n`);
    }
    if (siteDefaults[extension.extensionId] !== undefined) {
      applySiteDefaultEnabled({ extensionDir: target, enabled: siteDefaults[extension.extensionId] });
    }
    // 扩展产物自己也可能内联了构建期常量（当前只有 `local-storage` 消费公开桶）。
    // 它们由各包自己的 `build` → `build-package.mjs` 构建，只有**那条链路带
    // WOOHAA3_DEFINES** 时才会替换。产物里残留未替换标识符说明它是在缺注入的环境里
    // 构建的（例如干净 checkout 直接装配），此时打包进去等于发一个配置不全的包。
    if (defines) {
      const unresolved = [];
      for (const file of listScripts(path.join(target, 'dist'))) {
        const unreplaced = findUnreplacedDefines(fs.readFileSync(file, 'utf8'), Object.keys(defines));
        for (const key of unreplaced) unresolved.push(`${path.relative(target, file)} → ${key}`);
      }
      if (unresolved.length > 0) {
        throw new Error(
          `扩展 ${extension.extensionId} 的产物含未替换的构建期常量：\n  ${unresolved.join('\n  ')}\n` +
            '  说明这些扩展是在没注入 WOOHAA3_DEFINES 的环境里构建的。\n' +
            '  先带 profile 重建扩展产物：pnpm -C client/web run build:plugins（或整体 pnpm build:units）。'
        );
      }
    }
    installed.push(extension.extensionId);
  }
  if (installed.length === 0) throw new Error('没有装配到任何扩展：检查 extensions.config.json 的扫描根与扩展产物');

  // 6) Node 运行时
  fs.mkdirSync(path.join(output, 'node'), { recursive: true });
  const nodeTarget = path.join(output, 'node', process.platform === 'win32' ? 'woohaa-node.exe' : 'woohaa-node');
  fs.copyFileSync(node.binary, nodeTarget);
  fs.chmodSync(nodeTarget, 0o755);
  if (node.license) fs.copyFileSync(node.license, path.join(output, 'node/NODE_LICENSE'));

  // 7) 启动器与清单
  fs.copyFileSync(path.join(layout.scriptsDir, 'web-host.mjs'), path.join(output, 'web-host.mjs'));
  const artifact = webNodeArtifact();
  const manifest = {
    schema: 1,
    form: 'web-host',
    nodeVersion: artifact.version,
    nodeSha256: node.sha256,
    platform: process.platform,
    arch: process.arch,
    backend: { entry: 'backend.cjs', bytes: backend.size, modules: backend.modules },
    frontend: path.basename(frontendDir),
    extensions: installed,
    // 版本标识：`--status` 与部署脚本靠它回答「目标机上跑的是哪一版」。
    // 部署脚本用 `--commit` 显式传入（与它校验的工作区一致），避免「打包时的 HEAD」
    // 与「部署脚本以为的版本」是两次取值、事后对不上。
    ...(commit ? { commit } : {})
  };
  fs.writeFileSync(path.join(output, 'web-host-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // 源映射只服务开发期排障；分发目录带 24MB 的 map 纯属浪费。
  for (const map of ['backend.cjs.map']) fs.rmSync(path.join(output, map), { force: true });

  assertPortableTree(output);
  return { output, node: nodeTarget, nodeVersion: artifact.version, backend, extensions: installed };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = arg('out', null);
  const singleFile = arg('single-file', null);
  prepareWebHost({
    out,
    nodeCache: path.resolve(arg('node-cache', path.join(CLIENT_ROOT, '.local/web-host-node'))),
    frontend: arg('frontend', null),
    includeExtensions: arg('extensions', null)?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? null,
    commit: arg('commit', null)
  })
    .then(async (result) => {
      const relative = path.relative(process.cwd(), result.output) || '.';
      process.stdout.write(
        `[web-host] 装配完成 → ${relative}\n` +
          `[web-host] Node ${result.nodeVersion}（${path.relative(result.output, result.node)}）\n` +
          `[web-host] 后端 ${(result.backend.size / 1024 / 1024).toFixed(1)}MB / ${result.backend.modules} 模块（无 node_modules）\n` +
          `[web-host] 扩展 ${result.extensions.length} 个：${result.extensions.join('、')}\n`
      );
      if (!singleFile) {
        process.stdout.write(
          `[web-host] 目录形态启动：${path.join(relative, 'node', path.basename(result.node))} ${path.join(relative, 'web-host.mjs')} --port 4173\n` +
            `[web-host] 需要单个可执行文件：加 --single-file <路径>\n`
        );
        return;
      }
      const { buildSingleFile } = await import('./lib/web-host-sea.mjs');
      const built = buildSingleFile({ resourceRoot: result.output, nodeBinary: result.node, output: path.resolve(singleFile) });
      process.stdout.write(
        `[web-host] 单文件：${path.relative(process.cwd(), built.output)}（${(built.bytes / 1024 / 1024).toFixed(0)}MB，内含 payload ${(built.payload.bytes / 1024 / 1024).toFixed(0)}MB）\n` +
          `[web-host] 运行：${path.basename(built.output)} --port 4173\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`[web-host] 装配失败：${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

export { CLIENT_ROOT };
