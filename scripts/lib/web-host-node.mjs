/**
 * Web host 的固定 Node 运行时（`web-host` 形态专用）。
 *
 * 为什么不复用 `desktop-host-package.mjs` 的 `nodeArtifact`：那个函数的支持平台就是
 * **桌面壳**的支持平台（macOS arm64 / Windows x64），桌面装配用它把不支持的平台直接判错。
 * web 形态要跑在 Linux 上，往同一函数里加平台会顺带放开桌面打包（桌面在 Linux 上没有
 * 对应产物与验收），所以这里独立维护一份“web host 支持的平台”。
 *
 * 版本与桌面共用同一个常量 `DESKTOP_NODE_VERSION`：两套分发必须在同一 Node 大版本上，
 * 否则 `node:sqlite`（22.3+/24+）与 `host-manifest` 的版本校验会分叉。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DESKTOP_NODE_VERSION } from './desktop-host-package.mjs';
import { systemTar, systemTarArgs } from './desktop-platform-commands.mjs';

export const WEB_HOST_NODE_VERSION = DESKTOP_NODE_VERSION;

/** web host 支持打包的 Node 发行版；不支持的平台明确报错，不静默回退系统 Node。 */
export function webNodeArtifact(platform = process.platform, arch = process.arch) {
  const version = WEB_HOST_NODE_VERSION;
  if (platform === 'linux' && arch === 'x64') {
    return { version, platform, arch, archive: `node-v${version}-linux-x64.tar.gz`, triple: 'x86_64-unknown-linux-gnu' };
  }
  if (platform === 'linux' && arch === 'arm64') {
    return { version, platform, arch, archive: `node-v${version}-linux-arm64.tar.gz`, triple: 'aarch64-unknown-linux-gnu' };
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return { version, platform, arch, archive: `node-v${version}-darwin-arm64.tar.gz`, triple: 'aarch64-apple-darwin' };
  }
  if (platform === 'win32' && arch === 'x64') {
    return { version, platform, arch, archive: `node-v${version}-win-x64.zip`, triple: 'x86_64-pc-windows-msvc' };
  }
  throw new Error(`web host 不支持该平台：${platform}/${arch}（支持 linux x64/arm64、darwin arm64、win32 x64）`);
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });

/**
 * 下载（带 sha256 校验）并解出固定版本 Node，返回可执行文件路径。
 *
 * 与桌面同一套校验口径：**必须**在 SHASUMS256.txt 里找到该归档且摘要一致，否则失败——
 * 分发里带一个来源不可验证的解释器等于把信任根换成了 CDN。
 */
export async function prepareWebHostNode({ cacheDir, platform = process.platform, arch = process.arch } = {}) {
  const artifact = webNodeArtifact(platform, arch);
  const cache = path.resolve(cacheDir);
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, artifact.archive);
  const sums = path.join(cache, 'SHASUMS256.txt');
  const curl = platform === 'win32' ? 'curl.exe' : 'curl';
  const base = `https://nodejs.org/dist/v${artifact.version}`;
  if (!fs.existsSync(sums)) run(curl, ['--fail', '--location', '--retry', '2', `${base}/SHASUMS256.txt`, '-o', sums]);
  if (!fs.existsSync(archive)) run(curl, ['--fail', '--location', '--retry', '2', `${base}/${artifact.archive}`, '-o', archive]);

  const expected = fs
    .readFileSync(sums, 'utf8')
    .split('\n')
    .find((line) => line.trim().endsWith(` ${artifact.archive}`))
    ?.split(/\s+/)[0];
  const actual = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (!expected || expected !== actual) {
    fs.rmSync(archive, { force: true });
    throw new Error(`Node 发行包校验失败（${artifact.archive}）：期望 ${expected ?? '缺失'}，实际 ${actual}`);
  }

  const extracted = path.join(cache, artifact.archive.replace(/(?:\.tar\.gz|\.zip)$/, ''));
  const binary = path.join(extracted, platform === 'win32' ? 'node.exe' : 'bin/node');
  if (!fs.existsSync(binary)) {
    if (platform === 'win32') {
      run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:WOOHAA_NODE_ARCHIVE -DestinationPath $env:WOOHAA_NODE_CACHE -Force'
      ], { env: { ...process.env, WOOHAA_NODE_ARCHIVE: archive, WOOHAA_NODE_CACHE: cache }, windowsHide: true });
    } else {
      const tar = systemTar(platform);
      run(tar, systemTarArgs(tar, ['-xzf', archive, '-C', cache], platform));
    }
  }
  // 分发依赖 `node:sqlite`（getBuiltinModule）；版本不符时必须在打包期失败，而不是用户机器上才炸。
  const probe = execFileSync(
    binary,
    ['--input-type=module', '-e', "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');db.close();process.stdout.write(process.versions.node)"],
    { encoding: 'utf8', windowsHide: true }
  );
  if (probe !== artifact.version) throw new Error(`Node 探针失败：期望 ${artifact.version}，实际 ${probe}`);

  const license = path.join(extracted, 'LICENSE');
  return { artifact, binary, license: fs.existsSync(license) ? license : null, sha256: actual, extracted };
}
