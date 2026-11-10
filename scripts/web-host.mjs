#!/usr/bin/env node
/**
 * Web host 启动器（daemon 形态）。
 *
 * 只做三件事：定位资源目录与数据目录 → 装配本机宿主后端 → 起 HTTP 服务并打印访问地址。
 * 不开窗口、不读 stdin 控制流、不依赖 Tauri，也不需要系统装过 Node（用的是随包解释器）。
 *
 * 用法（打包后由随包 Node 执行，也可直接 `node web-host.mjs`）：
 *   woohaa-node web-host.mjs [--port 4173] [--host 127.0.0.1] [--data-dir <dir>]
 *                            [--base-path /tools/woohaa/] [--foreground]
 *
 * 进程模型是「前台阻塞」：默认打印地址后继续运行，Ctrl+C / SIGTERM 优雅退出。
 * 要后台常驻请交给 systemd / pm2 / nohup，本脚本不自行 daemonize——那会丢掉日志与
 * 退出码，排障时反而更难。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 本文件同时存在于两处：
 * - 仓库里：`client/scripts/web-host.mjs`，依赖在同目录 `lib/`；
 * - 分发目录根：`<out>/web-host.mjs`，依赖在 `<out>/scripts/lib/`。
 * 用静态 import 只能满足其中一种，所以按实际布局选目录再动态加载。
 */
const LIB = fs.existsSync(path.join(HERE, 'scripts', 'lib'))
  ? path.join(HERE, 'scripts', 'lib')
  : path.join(HERE, 'lib');
const load = async (name) => import(pathToFileURL(path.join(LIB, name)).href);
const { resolveAppBasePath } = await load('app-base-path.mjs');
const { resolveAppPageTitle } = await load('app-html.mjs');
const { startWebHostServer } = await load('web-host-runtime.mjs');
const { loadExtensionHost } = await load('extension-host.mjs');
const { buildWebHostEnvironment } = await load('web-host-environment.mjs');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

/** 资源根：`web-host.mjs` 所在目录（打包布局），或显式 `--resource-root`。 */
function resolveResourceRoot() {
  const explicit = arg('resource-root', null);
  if (explicit) return path.resolve(explicit);
  return HERE;
}

/**
 * 默认数据目录：`$WOOHAA3_WEB_HOST_DATA_DIR` → `--data-dir` → `<resourceRoot>/data`。
 *
 * 放在资源目录内是打包形态的合理缺省（解压即用）；生产部署应显式指到资源目录之外，
 * 否则升级替换整个目录会连同数据一起换掉。
 */
function resolveDataDir(resourceRoot) {
  const explicit = arg('data-dir', null) ?? process.env.WOOHAA3_WEB_HOST_DATA_DIR ?? null;
  return path.resolve(explicit ?? path.join(resourceRoot, 'data'));
}

async function main() {
  const resourceRoot = resolveResourceRoot();
  const manifestFile = path.join(resourceRoot, 'web-host-manifest.json');
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`不是有效的 web host 资源目录（缺 web-host-manifest.json）：${resourceRoot}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.nodeVersion && process.versions.node !== manifest.nodeVersion) {
    // 用系统 Node 直接跑本文件时最容易踩这个：版本不符会在 node:sqlite 上炸得很难懂。
    throw new Error(`本 web host 需要 Node ${manifest.nodeVersion}，当前是 ${process.versions.node}。请用随包解释器：node/woohaa-node web-host.mjs`);
  }

  const host = arg('host', process.env.WOOHAA_WEB_HOST ?? '127.0.0.1');
  const port = Number(arg('port', process.env.WOOHAA_PORT ?? '4173'));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`非法端口：${arg('port', process.env.WOOHAA_PORT)}`);
  const rawBasePath = arg('base-path', process.env.WOOHAA3_BASE_PATH ?? '/');
  const basePath = resolveAppBasePath({ WOOHAA3_BASE_PATH: rawBasePath });
  const dataDir = resolveDataDir(resourceRoot);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const runtimeInstall = arg('runtime-install', process.env.WOOHAA_WEB_HOST_RUNTIME_INSTALL ?? 'npm-registry');
  if (!['npm-registry', 'disabled'].includes(runtimeInstall)) throw new Error(`非法运行期安装策略：${runtimeInstall}（npm-registry|disabled）`);

  const env = buildWebHostEnvironment({ resourceRoot, dataDir, host, port, basePath, runtimeInstall: runtimeInstall === 'disabled' ? 'disabled' : 'enabled' });
  const pageTitle = resolveAppPageTitle(env);
  // 后端产物是独立 bundle：必须在设置完 env 之后加载，它读的是 process.env。
  Object.assign(process.env, env);

  const extensionHost = await loadExtensionHost({
    repoRoot: resourceRoot,
    env,
    logger: (event) => process.stderr.write(`[extensions] ${JSON.stringify(event)}\n`)
  });
  const { createBackendService } = await import(pathToFileURL(path.join(resourceRoot, manifest.backend?.entry ?? 'backend.cjs')).href);
  const backend = await createBackendService({ env, basePath, extensionHost, logger: (event) => process.stderr.write(`${JSON.stringify(event)}\n`) });

  const server = await startWebHostServer({
    backend,
    frontendDir: path.join(resourceRoot, 'frontend'),
    extensionHost,
    host,
    port,
    basePath,
    pageTitle,
    env,
    // 版本自述：`--status` 与部署验收靠它回答「这台机器跑的是哪一版」，
    // 不必去猜资源目录路径、也不依赖目标机装了 jq。
    version: {
      commit: manifest.commit ?? null,
      nodeVersion: manifest.nodeVersion ?? null,
      extensions: Array.isArray(manifest.extensions) ? manifest.extensions.length : null,
      form: manifest.form ?? null
    }
  });

  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const mount = basePath === '/' ? '' : basePath.replace(/\/$/, '');
  const address = `http://${displayHost}:${server.port}${mount}/`;
  process.stdout.write(`${pageTitle} 已启动\n  地址：${address}\n  数据：${dataDir}\n  监听：${host}:${server.port}\n`);
  if (host === '0.0.0.0' || host === '::') {
    process.stdout.write('  注意：绑定到所有网卡；对外暴露请自行加反代与身份校验。\n');
  }
  if (!flag('foreground')) process.stdout.write('  Ctrl+C 停止\n');

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`[web-host] ${signal}：正在停止\n`);
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  process.stderr.write(`[web-host] 启动失败：${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
