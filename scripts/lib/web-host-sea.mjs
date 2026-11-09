/**
 * 单文件发布（SEA）：把整个 web host 打成一个可执行文件。
 *
 * ## 为什么这样做
 *
 * Node 的 SEA（Single Executable Application）只支持**一个 CJS main**，且运行期
 * `import()` 只能走绝对路径（相对路径会 `ERR_MODULE_NOT_FOUND`），因此不能直接把
 * 「扩展宿主 + 扩展目录」这套按文件系统动态加载的实现塞进内存。
 *
 * 采用的办法是：把资源目录压成 tar.gz 内嵌成 SEA asset，进程启动时释放到数据目录，
 * 再按**普通磁盘布局**跑现有代码。这样：
 * - 分发是**一个文件**；
 * - 扩展仍然从真实目录动态 import（热装、受管根、信任链都不退化）；
 * - 静态服务、Range、旧版本回退全部沿用现有实现。
 *
 * ## 已实测的硬约束
 *
 * - SEA main 必须是 CJS（`.mjs` 会被当 CJS 解析 → `Cannot use import statement outside a module`）；
 * - `sea.getAsset()` 返回整块 Buffer，190MB asset 会让峰值 RSS 从 43MB 涨到 435MB。
 *   所以 payload 必须压缩后再内嵌（实测 228MB → 44MB），并且只在首启解压一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { systemTar, systemTarArgs } from './desktop-platform-commands.mjs';
import { webNodeArtifact } from './web-host-node.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** SEA main（CJS）在 `scripts/` 下，本文件在 `scripts/lib/`。 */
const SEA_MAIN = path.resolve(HERE, '..', 'sea-main.cjs');

/** payload asset 名（SEA 配置里 `assets` 的 key）。 */
export const PAYLOAD_ASSET = 'woohaa-payload.tar.gz';

/**
 * 把资源目录压成 payload。
 *
 * 排除 `node/`（运行时是承载它的可执行文件本身）与 `data/`（运行期数据，不属于分发包）。
 */
export function createPayload(resourceRoot, output) {
  const root = path.resolve(resourceRoot);
  for (const required of ['web-host.mjs', 'backend.cjs', 'frontend', 'extensions', 'scripts']) {
    if (!fs.existsSync(path.join(root, required))) {
      throw new Error(`资源目录不完整，缺少 ${required}：${root}`);
    }
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const tar = systemTar();
  // 排除项：
  // - `node/`：运行时是承载它的可执行文件本身；
  // - `data/`：运行期数据，不属于分发包；
  // - `.sea-build*/` 与 `*.tar.gz`：本函数自己的中间产物。临时目录默认建在产物旁边，
  //   若该目录恰好落在资源根内（`--out` 与 `--single-file` 同父目录时就会发生），
  //   tar 会把自己正在写的 payload 打进去，报「file changed as we read it」并失败。
  const excludes = ['--exclude=./node', '--exclude=./data', '--exclude=./.sea-build', '--exclude=./.sea-build/*', '--exclude=*.tar.gz'];
  execFileSync(tar, systemTarArgs(tar, ['-czf', output, ...excludes, '-C', root, '.'], process.platform), {
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' }
  });
  return {
    path: output,
    bytes: fs.statSync(output).size,
    sha256: createHash('sha256').update(fs.readFileSync(output)).digest('hex')
  };
}

/** SEA 配置：CJS main + 一个压缩 payload asset。 */
export function seaConfig({ main, payload, output }) {
  return {
    main,
    output,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: { [PAYLOAD_ASSET]: payload }
  };
}

/**
 * 把 SEA blob 注入到 Node 可执行文件，产出单文件。
 *
 * `postject` 是官方文档给出的注入工具。本仓没有把它列进依赖，所以按需通过
 * `npx --yes postject` 拉取——它只做 ELF/PE/Mach-O 的段注入，不参与运行期。
 * `WOOHAA_POSTJECT` 可指向本地已安装的 postject 入口以避免联网。
 */
export function injectSeaBlob({ nodeBinary, blob, output, platform = process.platform }) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(nodeBinary, output);
  fs.chmodSync(output, 0o755);
  const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
  const explicit = process.env.WOOHAA_POSTJECT?.trim();
  const command = explicit ? process.execPath : 'npx';
  const args = explicit
    ? [explicit, output, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', fuse]
    : ['--yes', 'postject', output, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', fuse];
  if (platform === 'darwin') {
    // macOS 需要先去掉签名再注入，否则内核会拒绝运行被改过的二进制。
    try {
      execFileSync('codesign', ['--remove-signature', output], { stdio: 'ignore' });
    } catch {
      /* 未签名时无签名可去 */
    }
    args.push('--macho-segment-name', 'NODE_SEA');
  }
  execFileSync(command, args, { stdio: 'inherit' });
  if (platform === 'darwin') {
    execFileSync('codesign', ['--sign', '-', output], { stdio: 'inherit' });
  }
  return { output, bytes: fs.statSync(output).size };
}

/**
 * 完整构建：blob → 注入 → 产出 `<output>` 单文件。
 *
 * `nodeBinary` 必须是**固定版本**的 Node（`prepareWebHostNode` 解出来的那个）：
 * SEA 的 blob 与产生它的 Node 版本强绑定，混用会启动即崩。
 *
 * `workDir` 缺省放在 output 的**同级**目录而不是其中：若它落在资源根里面，
 * 打包 payload 时会把自己正在写的文件也读进来（tar 报 `file changed as we read it`）。
 */
export function buildSingleFile({ resourceRoot, nodeBinary, output, workDir = path.join(path.dirname(output), '.sea-build') }) {
  // 兜底：显式传入的 workDir 若在资源根内，挪到外面。
  const resolvedRoot = path.resolve(resourceRoot);
  let effectiveWorkDir = path.resolve(workDir);
  if (effectiveWorkDir === resolvedRoot || effectiveWorkDir.startsWith(`${resolvedRoot}${path.sep}`)) {
    effectiveWorkDir = path.join(path.dirname(resolvedRoot), `.sea-build-${process.pid}`);
  }
  fs.rmSync(effectiveWorkDir, { recursive: true, force: true });
  fs.mkdirSync(effectiveWorkDir, { recursive: true });
  const payload = createPayload(resourceRoot, path.join(effectiveWorkDir, 'payload.tar.gz'));
  const mainFile = path.join(effectiveWorkDir, 'sea-main.cjs');
  fs.copyFileSync(SEA_MAIN, mainFile);
  const blob = path.join(effectiveWorkDir, 'sea-prep.blob');
  const configFile = path.join(effectiveWorkDir, 'sea-config.json');
  fs.writeFileSync(configFile, `${JSON.stringify(seaConfig({ main: mainFile, payload: payload.path, output: blob }), null, 2)}\n`);
  execFileSync(process.execPath, ['--experimental-sea-config', configFile], { stdio: 'inherit' });
  const injected = injectSeaBlob({ nodeBinary, blob, output });
  fs.rmSync(effectiveWorkDir, { recursive: true, force: true });
  return { ...injected, payload };
}

export { webNodeArtifact };
