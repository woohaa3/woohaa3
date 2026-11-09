#!/usr/bin/env node
/**
 * 单文件 web host 的 SEA main（**必须是 CJS**）。
 *
 * SEA 只支持 CJS main：写成 `.mjs` 会被当 CJS 解析，直接
 * `Cannot use import statement outside a module`。本文件因此不用 `import` 语法。
 *
 * 职责：
 * 1. 定位资源根，首启把内嵌 payload 释放成普通磁盘目录；
 * 2. 在**同一进程内**加载 `web-host.mjs` 启动服务。
 *
 * 为什么不 spawn 一个子进程去跑启动器：`process.execPath` 指向 SEA 可执行文件本身，
 * 用 `execPath web-host.mjs` 会再次执行本文件（SEA 总是跑内嵌 main），直接无限递归。
 * 资源释放后的布局与目录形态完全一致，所以进程内 `import()` 即可，无需二次启动。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

/** 版本标识文件：payload 变更时必须重新解压。 */
const RELEASE_MARKER = 'web-host-release.json';

function log(message) {
  process.stderr.write(`[web-host-sea] ${message}\n`);
}

/** 资源根（可写、跨启动保留）。缺省 `~/.local/share/woohaa3/web-host`。 */
function resolveResourceRoot() {
  const explicit = process.env.WOOHAA3_WEB_HOST_RESOURCE_DIR;
  if (explicit && explicit.trim() !== '') return path.resolve(explicit);
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'woohaa3', 'web-host');
}

function readMarker(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, RELEASE_MARKER), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 把内嵌 payload 释放到资源根。
 *
 * 只在标记缺失或 releaseId 变化时解压：每次启动都解压 40MB+ 毫无必要。
 * 先解压到 staging 再 rename，避免中途崩溃留下半个资源目录（那种目录会让下次启动
 * 以一个「文件都在但内容不全」的状态跑起来，很难排查）。
 */
function materialize(sea, root) {
  // `getAsset()` 返回 ArrayBuffer（不是 Buffer），`createHash().update()` 与 `writeFileSync()`
  // 都不接受 ArrayBuffer，必须先包一层。
  const payload = Buffer.from(sea.getAsset('woohaa-payload.tar.gz'));
  const releaseId = createHash('sha256').update(payload).digest('hex');
  if (readMarker(root)?.releaseId === releaseId && fs.existsSync(path.join(root, 'web-host.mjs'))) {
    return { root, extracted: false };
  }

  const parent = path.dirname(root);
  fs.mkdirSync(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(root)}.${process.pid}.staging`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const archive = path.join(parent, `.${path.basename(root)}.${process.pid}.tar.gz`);
  fs.writeFileSync(archive, payload);
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync('tar', ['-xzf', archive, '-C', staging], { stdio: 'inherit' });
  } finally {
    fs.rmSync(archive, { force: true });
  }
  fs.writeFileSync(
    path.join(staging, RELEASE_MARKER),
    `${JSON.stringify({ releaseId, extractedAt: new Date().toISOString() }, null, 2)}\n`
  );
  fs.rmSync(root, { recursive: true, force: true });
  fs.renameSync(staging, root);
  return { root, extracted: true };
}

async function main() {
  let sea;
  try {
    sea = require('node:sea');
  } catch {
    log('当前 Node 运行时没有 node:sea；本文件只能由 SEA 可执行文件启动');
    process.exit(1);
  }
  if (!sea.isSea()) {
    log('不是 SEA 环境：请用单文件可执行程序启动，或改用目录形态的 web-host.mjs');
    process.exit(1);
  }

  const root = resolveResourceRoot();
  const started = Date.now();
  const { extracted } = materialize(sea, root);
  if (extracted) log(`资源已释放到 ${root}（${Date.now() - started}ms）`);

  // 资源已经落成普通目录；启动器据此按磁盘布局解析 scripts/lib。
  // 必须用绝对路径 + pathToFileURL：SEA 里相对 import() 一律 ERR_MODULE_NOT_FOUND。
  const { pathToFileURL } = require('node:url');
  process.env.WOOHAA3_WEB_HOST_RESOURCE_DIR = root;
  await import(pathToFileURL(path.join(root, 'web-host.mjs')).href);
}

main().catch((error) => {
  log(`启动失败：${error && error.message ? error.message : String(error)}`);
  if (error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
