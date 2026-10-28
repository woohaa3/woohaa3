/**
 * 构建产物新鲜度：拦「src 比 dist 新」的静默旧代码（2026-10-28）。
 *
 * 现场：新增 `web/services/task-service/src/worker/result-archive.ts` 后，宿主 watch 产出的
 * `dist/index.js` 只含调用点、不含函数定义；下一次用 `pnpm dev --skip-build` 重启时直接
 * `ReferenceError: createResultArchiver is not defined`，报错完全看不出「产物过期」。
 *
 * 这里只做一件事：对 dev 实际加载的产物，比较它与 `src` 的最新 mtime。`--skip-build`
 * 的语义是「我保证产物是新的」，所以启动前必须验一遍；构建完也验一遍，防止构建自身失败
 * 却留下半新半旧的 bundle。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** dev 启动时会被 import 的产物（相对包目录）。 */
const ARTIFACT_FILES = ["dist/index.js", "dist/backend.js"];

/**
 * 各服务自己的 `server-dist` 是独立部署入口，dev 的统一宿主不加载它（宿主读的是
 * `web/backend/server-dist`），所以只有 backend 需要参与判定，否则每次启动都要为
 * 几个用不到的独立产物重建。
 */
const SERVER_ENTRY_PACKAGE = path.join("web", "backend");

/** 源码目录里不参与产物新鲜度的文件：改测试不该要求重建。 */
const IGNORED_SOURCE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** 参与检查的包：契约、宿主、服务、vendor、扩展。 */
function packageDirs(root) {
  const dirs = [];
  const push = (dir) => {
    if (existsSync(path.join(dir, "package.json"))) dirs.push(dir);
  };
  push(path.join(root, "web/contracts"));
  push(path.join(root, "web/backend"));
  for (const group of ["web/services", "web/vendor", "web/extensions"]) {
    const base = path.join(root, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) push(path.join(base, name));
  }
  return dirs;
}

/** `src` 下最新的源码文件（跳过测试与 node_modules）。 */
export function newestSource(dir) {
  let newest = { mtime: 0, file: undefined };
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || IGNORED_SOURCE.test(entry.name)) continue;
      const mtime = statSync(full).mtimeMs;
      if (mtime > newest.mtime) newest = { mtime, file: path.relative(dir, full) };
    }
  }
  return newest;
}

/**
 * 找出「产物比源码旧」的包。
 *
 * @returns {Array<{name, artifact, artifactMtime, source, sourceMtime}>} 相对 `root` 的路径
 */
export function findStaleArtifacts(root, options = {}) {
  // 构建与写盘之间有毫秒级抖动；1s 容差避免把同一秒内的正常构建误判成过期。
  const toleranceMs = options.toleranceMs ?? 1000;
  const stale = [];
  for (const dir of packageDirs(root)) {
    const sourceDir = path.join(dir, "src");
    if (!existsSync(sourceDir)) continue;
    const candidates = path.relative(root, dir) === SERVER_ENTRY_PACKAGE
      ? [...ARTIFACT_FILES, "server-dist/index.js"]
      : ARTIFACT_FILES;
    const artifacts = candidates.map((file) => path.join(dir, file)).filter((file) => existsSync(file));
    if (artifacts.length === 0) continue;
    const source = newestSource(sourceDir);
    if (source.mtime === 0) continue;
    for (const artifact of artifacts) {
      const artifactMtime = statSync(artifact).mtimeMs;
      if (source.mtime <= artifactMtime + toleranceMs) continue;
      stale.push({
        name: path.relative(root, dir),
        artifact: path.relative(root, artifact),
        artifactMtime,
        source: path.relative(root, path.join(sourceDir, source.file)),
        sourceMtime: source.mtime
      });
    }
  }
  return stale;
}

/** 一行一条，便于直接贴到终端告警里。 */
export function formatStaleArtifacts(stale) {
  return stale.map((entry) => `${entry.name}（${entry.artifact} 早于 ${entry.source}）`).join("；");
}
