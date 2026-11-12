/**
 * npm registry 运行期安装器。
 *
 * 只消费构建期发布的 `runtime-npm-lock.json`：包、版本、integrity、平台约束和入口规则都是
 * 精确值。运行期不解析 semver、不读 dist-tag、不执行 `npx`、不继承用户 PATH，也不安装
 * 清单外的包。安装先写随机 staging 目录，验证包版本、依赖解析、入口探针和脚本后，再原子
 * rename 到版本目录。
 */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};

export function platformKey({ platform = process.platform, arch = process.arch } = {}) {
  return `${platform}-${arch}`;
}

export function parseIntegrity(value) {
  const parsed = [];
  for (const token of String(value ?? '').split(/\s+/)) {
    const match = /^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(token);
    if (match) parsed.push({ algorithm: match[1], digest: match[2] });
  }
  return parsed;
}

export function verifyIntegrity(bytes, integrity) {
  const entries = parseIntegrity(integrity);
  if (!entries.length) fail('INVALID_INTEGRITY', 'Runtime package has no usable integrity');
  for (const entry of entries) {
    if (createHash(entry.algorithm).update(bytes).digest('base64') === entry.digest) return true;
  }
  fail('INVALID_HASH', 'Runtime package integrity mismatch');
}

/** npm tarball 地址是纯函数：`<registry>/<name>/-/<basename>-<version>.tgz`。 */
export function registryTarballUrl(baseUrl, name, version) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (!(base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) {
    fail('INVALID_CONFIG', 'npm registry requires HTTPS (HTTP is allowed only on loopback)');
  }
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail('INVALID_CONFIG', `Invalid locked package identity: ${name}@${version}`);
  }
  const basename = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  const url = new URL(`${name}/-/${basename}-${version}.tgz`, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) fail('INVALID_CONFIG', 'Package URL must stay under the configured registry');
  return url.href;
}

function attemptSignal(signal, timeoutMs) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

/**
 * 用锁定 tarball 的 HEAD 探测 registry 的真实 TTFB。
 *
 * `/-/ping` 只能证明 registry API 主机可达；部分镜像的 tarball 会跳到另一个 CDN 域名，
 * 甚至返回 302，健康检查必须走与实际下载相同的 tarball 路径和重定向策略。
 */
export async function probeRegistry({ baseUrl, name, version, fetchImpl = globalThis.fetch, signal, timeoutMs = 2000, now = () => performance.now() }) {
  const url = registryTarballUrl(baseUrl, name, version);
  const started = now();
  let response;
  try {
    response = await fetchImpl(url, { method: 'HEAD', redirect: 'error', signal: attemptSignal(signal, timeoutMs) });
    // 部分镜像不允许 HEAD；用 Range 只取响应头，不真正下载整个包。
    if ([403, 405, 501].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      response = await fetchImpl(url, {
        method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'error', signal: attemptSignal(signal, timeoutMs)
      });
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw Object.assign(new Error(`${baseUrl}: ${error?.message ?? error}`), { code: 'PROBE_FAILED' });
  }
  await response.body?.cancel().catch(() => {});
  if (!response.ok) throw Object.assign(new Error(`${baseUrl}: HTTP ${response.status}`), { code: 'PROBE_FAILED' });
  return { baseUrl, ms: now() - started };
}

/**
 * 并行探测候选 registry，按 TTFB 排序；全部失败时保持配置顺序，交给实际下载继续尝试。
 * 预检只是排序，不是可用性证明：探测失败、超时或结果不可信都不能阻止后续 fallback。
 */
export async function orderRegistries({ registryUrls, name, version, fetchImpl = globalThis.fetch, signal, timeoutMs = 2000, now }) {
  const candidates = [...new Set((registryUrls ?? []).filter(Boolean))];
  if (candidates.length < 2) return candidates;
  const results = await Promise.allSettled(candidates.map((baseUrl) => probeRegistry({ baseUrl, name, version, fetchImpl, signal, timeoutMs, now })));
  if (signal?.aborted) throw signal.reason ?? new Error('Cancelled');
  const healthy = [];
  const failed = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') healthy.push(result.value);
    else failed.push(candidates[index]);
  });
  healthy.sort((left, right) => left.ms - right.ms);
  return [...healthy.map((entry) => entry.baseUrl), ...failed];
}

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  return value === undefined ? undefined : [value];
}

export function matchesPlatform(entry, key) {
  const [os, cpu] = key.split('-');
  const allow = (list, value) => list === undefined || (list.includes(value) && !list.includes(`!${value}`));
  const osList = normalizeList(entry.os);
  const cpuList = normalizeList(entry.cpu);
  const libcList = normalizeList(entry.libc);
  if (osList !== undefined && !allow(osList, os)) return false;
  if (cpuList !== undefined && !allow(cpuList, cpu)) return false;
  if (libcList !== undefined && !libcList.includes('glibc')) return false;
  return true;
}

/** 从引擎根出发，按 lock 边与平台约束选出本次要安装的包。 */
export function selectPlatformPackages(engine, key) {
  const rootId = `${engine.package}@${engine.version}`;
  if (!engine.packages[rootId]) fail('MISSING_DEPENDENCY', `Runtime lock is missing its root package ${rootId}`);
  const selected = new Set();
  const missing = [];
  const queue = [rootId];
  while (queue.length) {
    const id = queue.pop();
    if (selected.has(id)) continue;
    const entry = engine.packages[id];
    if (!entry) fail('MISSING_DEPENDENCY', `Runtime lock is missing ${id}`);
    if (!matchesPlatform(entry, key)) {
      missing.push(id);
      continue;
    }
    selected.add(id);
    for (const edge of entry.dependencies ?? []) queue.push(edge.target);
  }
  // 同一包在不同 peer 变体里可能对同名依赖给出不同精确版本；两种排布都必须可解析，所以每一
  // 个精确目标都要装（顶层一个、请求方嵌套另一个）。
  const needs = new Map();
  for (const id of selected) {
    for (const edge of engine.packages[id].dependencies ?? []) needs.set(edge.target, (needs.get(edge.target) ?? 0) + 1);
  }
  // 只有被至少两条边请求时，才可能与另一个版本共用顶部槽位；单一请求方的包可以嵌在它下面。
  return { rootId, selected, skipped: missing, needs };
}

/**
 * 生成 npm 兼容的 node_modules 布局。
 *
 * 与 npm 的 hoisting 目标一致：能放在顶层就放顶层，版本冲突时嵌到请求方自己的
 * `node_modules` 下。Node 的向上解析因此总能命中 lock 指定的版本。
 */
export function planLayout(engine, key) {
  const { rootId, selected, skipped, needs } = selectPlatformPackages(engine, key);
  const root = engine.packages[rootId];
  const skippedSet = new Set(skipped);
  /** 只在「可选」且平台不匹配时跳过该依赖边；必需依赖缺失必须让安装失败。 */
  const placements = new Map();
  const rootDir = `node_modules/${root.name}`;
  placements.set(rootDir, rootId);
  const resolveFrom = (dir, name) => {
    let current = dir;
    for (;;) {
      const candidate = current ? `${current}/node_modules/${name}` : `node_modules/${name}`;
      if (placements.has(candidate)) return placements.get(candidate);
      if (!current) return undefined;
      const index = current.lastIndexOf('/node_modules/');
      current = index < 0 ? '' : current.slice(0, index);
    }
  };
  const place = (fromDir, edge) => {
    if (skippedSet.has(edge.target)) {
      if (!edge.optional) fail('MISSING_DEPENDENCY', `${edge.name}@${edge.target} is required on ${key}`);
      return;
    }
    const rootSlot = `node_modules/${edge.name}`;
    if (!placements.has(rootSlot)) {
      // 能被顶层共享的版本放顶层（需要它的人都能向上解析到）；只有当请求方自己已能解析到
      // 另一个版本、且这个版本只被它请求时，才嵌到它下面。
      if (fromDir && (needs.get(edge.target) ?? 0) < 2 && resolveFrom(fromDir, edge.name)) return;
      placements.set(rootSlot, edge.target);
      queue.push({ id: edge.target, dir: rootSlot });
      return;
    }
    if (placements.get(rootSlot) === edge.target) return;
    const nested = fromDir ? `${fromDir}/node_modules/${edge.name}` : rootSlot;
    if (placements.has(nested)) {
      if (placements.get(nested) !== edge.target) fail('LAYOUT_CONFLICT', `Cannot place ${edge.name} for ${fromDir || 'runtime root'}`);
      return;
    }
    placements.set(nested, edge.target);
    queue.push({ id: edge.target, dir: nested });
  };
  const queue = [];
  // 根包按依赖名排序放置，保证同一 lock 的布局稳定。
  const rootEdges = [...(root.dependencies ?? [])].sort((left, right) => left.name.localeCompare(right.name));
  for (const edge of rootEdges) place('', edge);
  // 宽度优先：先占满所有顶层槽位，冲突版本再嵌到请求方下面，与 npm hoisting 的最终布局一致
  // （若按深度优先，后出现的同名不同版本会永远嵌在子依赖里，违反「能放顶层就放顶层」）。
  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const entry = engine.packages[current.id];
    for (const edge of entry.dependencies ?? []) place(current.dir, edge);
  }
  // 请求方目录 → 依赖名 → 实际装在那里的版本（供安装后校验比较同名多版本的情况）。
  const chosen = new Map();
  for (const [dir, id] of placements) {
    if (!dir.startsWith('node_modules/')) continue;
    const index = dir.lastIndexOf('/node_modules/');
    const owner = index < 0 ? '' : dir.slice(0, index);
    chosen.set(`${owner}|${engine.packages[id].name}`, id);
  }
  return { rootId, root, selected, skipped, placements: [...placements].map(([dir, id]) => ({ dir, id })), chosen };
}

export function packageDirectory(root, placement) {
  return path.join(root, ...placement.dir.split('/'));
}

export function safeTarballPath(name) {
  // 规范写法是 `package/<相对路径>`；也有包（@types/node）用 `node/<相对路径>`。npm 自带的
  // unpack 只剥「第一段归档根」，这里保持同一口径：根目录名由包作者决定，不是安全边界。
  // 其余按相对路径校验：拒绝 `..`、绝对路径、`.` 段与 Windows 别名。
  const normalized = name.replace(/^[^/]+\//, '').replace(/\/$/, '').split('/').filter((part) => part !== '.').join('/');
  if (!normalized) return undefined;
  if (normalized.includes('\\') || normalized.includes('\0') || path.posix.isAbsolute(normalized)) fail('UNSAFE_ARCHIVE', `Unsafe package path: ${name}`);
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..')) fail('UNSAFE_ARCHIVE', `Unsafe package path: ${name}`);
  if (/[:<>"|?*\x00-\x1f]/.test(normalized)) fail('UNSAFE_ARCHIVE', `Unsafe package path: ${name}`);
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(parts[parts.length - 1])) fail('UNSAFE_ARCHIVE', `Reserved package path: ${name}`);
  return parts.filter(Boolean).join('/');
}

/**
 * npm tarball 读取器（顺序流式，内存只保留未消费的块）。
 *
 * 支持 ustar 与 PAX 扩展头（npm pack 长路径会用到），只接受普通文件和目录；符号链接、设备
 * 节点与路径穿越一律拒绝。PAX 载荷本身也可能被拆到多个流块里，因此按状态机逐块推进。
 */
export async function extractNpmTarball(archive, destination, { maxBytes = 4 * 1024 * 1024 * 1024, signal } = {}) {
  const input = (await fs.open(archive)).createReadStream();
  const stream = input.pipe(createGunzip());
  const onAbort = () => stream.destroy(signal.reason ?? new Error('Cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const state = {
    pending: Buffer.alloc(0), mode: 'header', remaining: 0, handle: undefined,
    paxBuffer: Buffer.alloc(0), paxSize: 0, paxType: 'x', pax: {},
    expanded: 0, total: 0, files: 0, fileSize: 0, padLeft: 0, padDone: 0
  };
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      state.expanded += chunk.length;
      if (state.expanded > maxBytes + 64 * 1024 * 1024) fail('ARCHIVE_LIMIT', 'Runtime package exceeds declared size');
      state.pending = state.pending.length ? Buffer.concat([state.pending, chunk]) : chunk;
      await advance(state, destination, maxBytes);
    }
    if (state.mode !== 'header' || state.pending.length > 0) fail('UNSAFE_ARCHIVE', 'Truncated package tarball');
    return { files: state.files, bytes: state.total };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await state.handle?.close().catch(() => {});
    stream.destroy();
    input.destroy();
  }
}

/** 逐块推进解包状态机；返回时要么已消费完块，要么在等更多数据。 */
async function advance(state, destination, maxBytes) {
  const closeFile = async () => { await state.handle?.close().catch(() => {}); state.handle = undefined; };
  for (;;) {
    if (state.mode === 'pax') {
      const take = Math.min(state.paxSize - state.paxBuffer.length, state.pending.length);
      if (take > 0) {
        state.paxBuffer = Buffer.concat([state.paxBuffer, state.pending.subarray(0, take)]);
        state.pending = state.pending.subarray(take);
      }
      if (state.paxBuffer.length < state.paxSize) return;
      state.padLeft = (512 - (state.paxSize % 512)) % 512;
      state.padDone = 0;
      state.mode = state.padLeft ? 'paxpad' : 'finishpax';
      continue;
    }
    if (state.mode === 'paxpad') {
      const take = Math.min(state.padLeft - state.padDone, state.pending.length);
      state.pending = state.pending.subarray(take);
      state.padDone += take;
      if (state.padDone < state.padLeft) return;
      state.mode = 'finishpax';
      continue;
    }
    if (state.mode === 'finishpax') {
      if (state.paxType === 'x') {
        const records = {};
        let cursor = 0;
        while (cursor < state.paxBuffer.length) {
          const space = state.paxBuffer.indexOf(0x20, cursor);
          if (space < 0) break;
          const length = Number(state.paxBuffer.subarray(cursor, space).toString());
          if (!Number.isSafeInteger(length) || length <= 0) break;
          const record = state.paxBuffer.subarray(space + 1, cursor + length - 1).toString('utf8');
          const equals = record.indexOf('=');
          if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
          cursor += length;
        }
        state.pax = records;
      }
      state.paxBuffer = Buffer.alloc(0);
      state.mode = 'header';
      continue;
    }
    if (state.mode === 'write') {
      if (!state.pending.length) return;
      const take = Math.min(state.remaining, state.pending.length);
      await state.handle.write(state.pending.subarray(0, take));
      state.pending = state.pending.subarray(take);
      state.remaining -= take;
      if (state.remaining) return;
      await closeFile();
      state.padLeft = (512 - (state.fileSize % 512)) % 512;
      state.padDone = 0;
      state.mode = state.padLeft ? 'filepad' : 'header';
      continue;
    }
    if (state.mode === 'skipfile') {
      const take = Math.min(state.fileSize - state.padDone, state.pending.length);
      state.pending = state.pending.subarray(take);
      state.padDone += take;
      if (state.padDone < state.fileSize) return;
      state.padLeft = (512 - (state.fileSize % 512)) % 512;
      state.padDone = 0;
      state.fileSize = 0;
      state.mode = state.padLeft ? 'filepad' : 'header';
      continue;
    }
    if (state.mode === 'filepad') {
      const take = Math.min(state.padLeft - state.padDone, state.pending.length);
      state.pending = state.pending.subarray(take);
      state.padDone += take;
      if (state.padDone < state.padLeft) return;
      state.mode = 'header';
      continue;
    }
    if (state.pending.length < 512) return;
    const header = state.pending.subarray(0, 512);
    state.pending = state.pending.subarray(512);
    if (header.every((byte) => byte === 0)) { state.pax = {}; continue; }
    const field = (offset, size) => header.subarray(offset, offset + size).toString().split('\0')[0];
    const expected = parseInt(field(148, 8).trim(), 8);
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 32 : header[index];
    if (sum !== expected) fail('UNSAFE_ARCHIVE', 'Invalid tar header checksum');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    if (!Number.isSafeInteger(size) || size < 0) fail('UNSAFE_ARCHIVE', 'Invalid tar entry size');
    if (type === 'x' || type === 'g') {
      state.paxSize = size;
      state.paxType = type;
      state.paxBuffer = Buffer.alloc(0);
      state.mode = 'pax';
      continue;
    }
    const name = safeTarballPath(state.pax.path ?? [field(345, 155), field(0, 100)].filter(Boolean).join('/'));
    const displayName = state.pax.path ?? name;
    state.pax = {};
    if (!['', '0', '5'].includes(type)) fail('UNSAFE_ARCHIVE', `Unsupported package entry: ${displayName}`);
    if (!name) {
      // The tarball's `package/` directory itself.
      state.fileSize = size;
      state.padLeft = (512 - (size % 512)) % 512;
      state.padDone = 0;
      state.mode = state.padLeft ? 'filepad' : 'header';
      continue;
    }
    state.total += size;
    state.files += 1;
    if (state.total > maxBytes) fail('ARCHIVE_LIMIT', 'Runtime package exceeds declared size');
    const target = path.join(destination, name);
    if (type === '5') {
      if (size) fail('UNSAFE_ARCHIVE', 'Directory with content');
      await fs.mkdir(target, { recursive: true });
      state.fileSize = size;
      state.padLeft = (512 - (size % 512)) % 512;
      state.padDone = 0;
      state.mode = state.padLeft ? 'filepad' : 'header';
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    // npm tarball 偶尔同一路径出现两次（重复条目）；运行期以先到者为准，不覆盖已写内容。
    const existing = await fs.lstat(target).catch(() => undefined);
    if (existing?.isFile()) {
      state.fileSize = size;
      state.padLeft = (512 - (size % 512)) % 512;
      state.padDone = 0;
      state.mode = 'skipfile';
      continue;
    }
    state.handle = await fs.open(target, 'wx', parseInt(field(100, 8).trim() || '644', 8) & 0o777);
    state.fileSize = size;
    state.remaining = size;
    if (!size) {
      await closeFile();
      state.padLeft = 0;
      state.padDone = 0;
      state.mode = 'header';
      continue;
    }
    state.mode = 'write';
  }
}

/** 入口规则：平台包内的 `vendor/<triple>/bin/codex` 这类路径必须唯一命中。 */
export async function resolveEntryFile(directory, pattern) {
  const segments = pattern.split('/');
  let candidates = [directory];
  for (const segment of segments) {
    const next = [];
    for (const base of candidates) {
      if (segment === '*') {
        const names = await fs.readdir(base).catch(() => []);
        for (const name of names) next.push(path.join(base, name));
      } else {
        next.push(path.join(base, segment));
      }
    }
    candidates = next;
  }
  const files = [];
  for (const candidate of candidates) {
    const info = await fs.stat(candidate).catch(() => undefined);
    if (info?.isFile()) files.push(candidate);
  }
  if (files.length !== 1) fail('INVALID_ENTRY', `Runtime entry ${pattern} matched ${files.length} files`);
  return files[0];
}

export async function writeDshEntry(root, engine) {
  const modulePath = engine.entry.module;
  const source = [
    "import { createRequire } from 'node:module';",
    "const require = createRequire(import.meta.url);",
    `const { runCli } = await import(require.resolve(${JSON.stringify(modulePath)}));`,
    'export { runCli };',
    ''
  ].join('\n');
  const file = path.join(root, engine.entry.file);
  await fs.writeFile(file, source, { flag: 'wx', mode: 0o644 });
  return file;
}

function lifecycleCommandArgs(command) {
  const match = /^node\s+([A-Za-z0-9._/-]+(?:\s+[A-Za-z0-9._/-]+)*)$/.exec(command);
  if (!match) fail('UNAPPROVED_LIFECYCLE_SCRIPT', `Only plain \`node <script>\` lifecycle commands are allowed: ${command}`);
  return match[1].split(/\s+/);
}

/**
 * 执行审核过的 lifecycle script。
 *
 * 只支持 `node <script>`；用应用自己的 Node（`process.execPath`），cwd 固定在被安装包内，
 * PATH 只含应用工具目录，不能借用户 shell、npm 或网络代理放大安装面。
 */
export async function runAllowedScripts({ root, engine, selected, key, directories, toolsDir, env, signal, states }) {
  const allowed = engine.scripts?.allowed ?? [];
  const executed = [];
  for (const id of selected) {
    const entry = engine.packages[id];
    const manifests = allowed.filter((script) => script.package === entry.name);
    if (!manifests.length) continue;
    const directory = directories.get(id);
    if (!directory) continue;
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    for (const script of manifests) {
      const command = manifest.scripts?.[script.lifecycle]?.trim();
      if (command !== script.command) continue;
      const digest = createHash('sha256').update(`${entry.name}@${entry.version}:${script.lifecycle}:${command}`).digest('hex');
      states?.set(engine.id, { status: 'preparing', stage: 'scripts' });
      await exec(process.execPath, lifecycleCommandArgs(command), {
        cwd: directory,
        env: { ...env, PATH: toolsDir },
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        signal
      });
      executed.push({ package: entry.name, version: entry.version, lifecycle: script.lifecycle, sha256: digest });
    }
  }
  return executed;
}

/** 安装后校验：每个包版本正确，且每个依赖从该包目录能解析到 lock 指定的版本。 */
export async function verifyLayout({ root, engine, key }) {
  const plan = planLayout(engine, key);
  const byDir = new Map(plan.placements.map((placement) => [placement.dir, placement.id]));
  const resolveFrom = (dir, name) => {
    let current = dir;
    for (;;) {
      const candidate = current ? `${current}/node_modules/${name}` : `node_modules/${name}`;
      if (byDir.has(candidate)) return byDir.get(candidate);
      if (!current) return undefined;
      const index = current.lastIndexOf('/node_modules/');
      current = index < 0 ? '' : current.slice(0, index);
    }
  };
  const problems = [];
  for (const placement of plan.placements) {
    const entry = engine.packages[placement.id];
    const directory = packageDirectory(root, placement);
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    } catch {
      problems.push(`${entry.name}@${entry.version} is missing package.json`);
      continue;
    }
    if (manifest.name !== entry.name || manifest.version !== entry.version) problems.push(`${placement.dir} contains ${manifest.name}@${manifest.version}, expected ${entry.name}@${entry.version}`);
    for (const edge of entry.dependencies ?? []) {
      // Optional dependencies declared for another OS/CPU are simply absent on this platform.
      if (!plan.selected.has(edge.target)) {
        const target = engine.packages[edge.target];
        if (edge.optional && target && !matchesPlatform(target, key)) continue;
        problems.push(`${entry.name}@${entry.version} → ${edge.name} is not installed`);
        continue;
      }
      const resolved = resolveFrom(placement.dir, edge.name);
      if (!resolved) { problems.push(`${entry.name}@${entry.version} → ${edge.name} resolves to nothing`); continue; }
      if (resolved === edge.target) continue;
      // 同名依赖出现多个精确版本（peer 变体）时，只要求解析到 lock 为该请求方选定的版本。
      const accepted = (entry.dependencies ?? []).filter((item) => item.name === edge.name).map((item) => item.target);
      const expected = plan.chosen.get(`${placement.dir}|${edge.name}`) ?? edge.target;
      if (accepted.length > 1 && resolved === expected) continue;
      problems.push(`${entry.name}@${entry.version} → ${edge.name} resolves to ${resolved}, expected ${edge.target}`);
    }
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      const optional = manifest.peerDependenciesMeta?.[name]?.optional === true;
      if (optional) continue;
      if (!resolveFrom(placement.dir, name)) problems.push(`${entry.name}@${entry.version} is missing peer ${name} (${range})`);
    }
  }
  if (problems.length) fail('INVALID_LAYOUT', `Runtime layout verification failed: ${problems.slice(0, 5).join('; ')}`);
  return { rootId: plan.rootId, packages: plan.placements.length };
}

export async function verifyEntry({ root, engine, key, toolsDir, env, signal }) {
  const expanded = Object.fromEntries(Object.entries(engine.entry).map(([name, value]) => [name, typeof value === 'string'
    ? value.split('{platform}').join(key).split('{exe}').join(key.startsWith('win32') ? '.exe' : '')
    : value]));
  if (expanded.type === 'module-generator') {
    const file = await writeDshEntry(path.resolve(root), { ...engine, entry: expanded });
    const probeSource = `const module = await import(${JSON.stringify(pathToFileURL(path.resolve(file)).href)});if(typeof module.${expanded.export} !== 'function')process.exit(3);`;
    await exec(process.execPath, ['--input-type=module', '-e', probeSource], {
      cwd: path.resolve(root),
      env: { ...env, PATH: toolsDir },
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      signal
    });
    return { file, kind: 'node' };
  }
  const plan = planLayout(engine, key);
  // Codex 把平台二进制发布成别名（`@openai/codex-linux-x64` → `@openai/codex@0.161.0-linux-x64`），
  // 因此按根包的依赖名定位，而不是按被装包的真实 name。
  const edge = (plan.root.dependencies ?? []).find((item) => item.name === expanded.package);
  const placement = edge && plan.placements.find((item) => item.id === edge.target);
  if (!placement) fail('INVALID_ENTRY', `Runtime entry package ${expanded.package} is not installed for ${key}`);
  const directory = path.resolve(packageDirectory(root, placement));
  const file = path.resolve(await resolveEntryFile(directory, expanded.pattern));
  if (!key.startsWith('win32')) await fs.chmod(file, 0o755);
  try {
    const { stdout, stderr } = await exec(file, ['--version'], {
      cwd: directory,
      env: { ...env, PATH: toolsDir },
      timeout: 15_000,
      maxBuffer: 65536,
      windowsHide: true,
      signal
    });
    const output = `${stdout}\n${stderr}`;
    const expected = expanded.probeVersion;
    if (expected && !output.includes(expected)) fail('INVALID_ENTRY', `${expanded.package} reports ${output.trim().slice(0, 120) || 'nothing'}, expected ${expected}`);
  } catch (error) {
    if (error?.code === 'INVALID_ENTRY') throw error;
    fail('INVALID_ENTRY', `Runtime entry probe failed: ${String(error?.message ?? error).slice(0, 300)}`);
  }
  return { file, kind: 'executable' };
}

export async function probeNpmToolchain({ toolsDir, env, node = process.execPath }) {
  // Absolute path on purpose: the probe runs with `cwd` inside the app tools directory.
  const cli = path.resolve(toolsDir, 'npm', 'bin', 'npm-cli.js');
  try {
    await fs.access(cli);
  } catch {
    fail('NPM_TOOLCHAIN_MISSING', 'App-local npm CLI is missing; reinstall the application');
  }
  const { stdout } = await exec(node, [cli, '--version'], {
    env: { ...env, PATH: toolsDir },
    cwd: path.dirname(cli),
    timeout: 30_000,
    maxBuffer: 65536,
    windowsHide: true
  });
  const version = stdout.trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) fail('NPM_TOOLCHAIN_MISSING', 'App-local npm CLI did not report a version');
  return { node, npmCli: cli, version };
}

export function tarballCacheName(entry) {
  const digest = createHash('sha256').update(entry.integrity).digest('hex').slice(0, 16);
  return `${entry.name.replace(/[^a-zA-Z0-9._-]/g, '_')}-${entry.version}-${digest}.tgz`;
}

export function emptyTempName(prefix) {
  return `${prefix}-${randomUUID()}`;
}
