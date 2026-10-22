/**
 * 开发期宿主 watch（`scripts/dev.mjs` 默认开启，`--no-watch` 关闭）。
 *
 * 分两层，各管一件事：
 * 1. **重建层**（本模块）：监听工作区包源码，变化后重跑**该包自己声明的**构建脚本
 *    （`build` / `server:build` / `build:browser` + 全局 `assemble:extensions`）。
 *    这里不复制 `web/scripts/build-package.mjs` 的 esbuild 配置，构建口径只有一份。
 * 2. **重载层**（`dev.mjs`）：宿主进程以 `node --watch` 运行，已加载模块被重写后自动重启；
 *    因此只有真正被宿主加载过的产物才会触发宿主重启。
 *
 * 定位规则：从变化文件向上找最近的 `package.json`，得到包名与构建脚本；`node_modules`、
 * 构建产物目录、隐藏目录（`.foo` 停用约定）、测试文件一律不参与。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveExtensionRoots } from "./extension-scan.mjs";

/** 宿主源码根（相对仓库根）；扩展根由 `extensions.config.json` / `WOOHAA3_EXTENSION_DIRS` 决定。 */
export const HOST_SOURCE_ROOTS = ["web/backend", "web/contracts", "web/services", "web/vendor"];

/** 产物、依赖与缓存目录：出现在路径里就说明不是源码变化。 */
const IGNORED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "server-dist",
  "browser-dist",
  ".browser-build",
  "coverage",
  ".turbo",
  ".local"
]);

/** 会参与构建的源码扩展名；其它文件（图片、字体等）不触发重建。 */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".css", ".json"]);

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function isSourceFile(repoRoot, file) {
  if (hasIgnoredSegment(repoRoot, file) || TEST_FILE.test(path.basename(file))) return false;
  return path.basename(file) === "package.json"
    || (path.relative(repoRoot, file).split(path.sep).includes("src") && SOURCE_EXTENSIONS.has(path.extname(file)));
}

function sourceDigest(file) {
  try { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
  catch { return null; }
}

/** Windows 的递归监听可能报告未改内容的文件事件；启动时记录真实源码，避免重建/重启风暴。 */
function sourceSnapshot(repoRoot, roots) {
  const snapshot = new Map();
  const scan = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (hasIgnoredSegment(repoRoot, file)) continue;
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile() && isSourceFile(repoRoot, file)) snapshot.set(file, sourceDigest(file));
    }
  };
  for (const root of roots) scan(root);
  return snapshot;
}

/**
 * 解析需要监听的源码根：固定宿主根 + 扩展根（与启动期扩展宿主、静态预检读同一份配置）。
 * 扩展根配置非法时不阻断 watch —— 退回缺省根，配置问题仍由启动期扩展宿主报出。
 *
 * @param {{ repoRoot: string, env?: NodeJS.ProcessEnv }} input
 * @returns {string[]} 已存在且是目录的绝对路径
 */
export function resolveHostWatchRoots({ repoRoot, env = process.env } = {}) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) throw new Error("缺少 repoRoot");
  const roots = HOST_SOURCE_ROOTS.map((relative) => path.resolve(repoRoot, relative));
  try {
    roots.push(...resolveExtensionRoots({ repoRoot, env }).roots);
  } catch {
    roots.push(path.resolve(repoRoot, "web/extensions"), path.resolve(repoRoot, "extensions"));
  }
  return [...new Set(roots)].filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** 从变化文件向上找最近的 `package.json` 所在目录（不越过 repoRoot）。 */
function nearestPackageDir({ boundary, file }) {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || !(parent === boundary || isInside(boundary, parent))) return null;
    dir = parent;
  }
}

function hasIgnoredSegment(repoRoot, absolute) {
  return path
    .relative(repoRoot, absolute)
    .split(path.sep)
    .some((segment) => IGNORED_SEGMENTS.has(segment) || (segment.startsWith(".") && segment !== "." && segment !== ".."));
}

/**
 * 该包变化后要跑的构建步骤。
 * - `build`：包自己的公开入口（`dist/`）。
 * - `server:build`：只有统一后端需要 —— dev 跑的宿主入口就是它的 `server-dist/index.js`；
 *   服务包的 `server-dist` 只服务 release 组装与生产入口，dev 不执行。
 * - `build:browser` + `assemble:extensions`：扩展浏览器产物走独立构建与装配，宿主 Vite 不编译
 *   扩展源码；装配后刷新页面生效。
 */
function buildSteps({ dir, manifest, backendDir }) {
  const scripts = manifest.scripts ?? {};
  const steps = [];
  if (typeof scripts.build === "string") steps.push({ scope: "package", script: "build" });
  if (dir === backendDir && typeof scripts["server:build"] === "string") {
    steps.push({ scope: "package", script: "server:build" });
  }
  if (typeof scripts["build:browser"] === "string") {
    steps.push({ scope: "package", script: "build:browser" });
    steps.push({ scope: "workspace", script: "assemble:extensions" });
  }
  return steps;
}

/**
 * 把一个变化文件解析成「重建哪个包、跑哪些脚本」。
 *
 * @returns {{ key: string, dir: string, name: string, file: string, steps: { scope: "package"|"workspace", script: string }[] } | null}
 */
export function resolveWatchTarget({ repoRoot, backendDir, file, watchRoots }) {
  const absolute = path.resolve(file);
  if (!watchRoots.some((root) => isInside(root, absolute) || absolute === root)) return null;
  if (!isSourceFile(repoRoot, absolute)) return null;

  const dir = nearestPackageDir({ boundary: watchRoots.filter(root => absolute === root || isInside(root, absolute)).sort((a,b) => b.length-a.length)[0], file: absolute });
  if (dir === null) return null;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (typeof manifest?.name !== "string" || manifest.name.length === 0) return null;

  const steps = buildSteps({ dir, manifest, backendDir });
  if (steps.length === 0) return null;
  return { key: dir, dir, name: manifest.name, file: path.relative(repoRoot, absolute), steps };
}

/**
 * 重建队列：同一批次的变化合并成一次构建，构建期间的新变化排到下一轮；全局串行，
 * 避免多个包同时写同一个装配目录。失败只记录，不结束 dev 会话（改坏代码时继续可迭代）。
 */
export function createRebuildQueue({ runBuild, log = () => {}, debounceMs = 150 }) {
  const pending = new Map();
  let timer = null;
  let tail = Promise.resolve();
  let closed = false;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (closed || pending.size === 0) return tail;
    const batch = [...pending.values()];
    pending.clear();
    tail = tail.then(async () => {
      for (const target of batch) {
        try {
          await runBuild(target);
        } catch (error) {
          log({ event: "rebuild-failed", target: target.name, message: error instanceof Error ? error.message : String(error) });
        }
      }
      if (!closed && pending.size > 0) flush();
    });
    return tail;
  };

  return {
    schedule(target) {
      if (closed) return;
      pending.set(target.key, target);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
      timer.unref?.();
    },
    /** 等待已排队与正在运行的构建结束（测试与退出用）。 */
    idle() {
      if (timer !== null) flush();
      return tail;
    },
    close() {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending.clear();
    }
  };
}

/**
 * 启动源码监听。`watch` 可注入（测试用假 watcher），默认 `fs.watch` 递归监听。
 *
 * 递归监听会在构建删除/重建目录时抛出 `ENOENT: scandir`（Linux 上遍历不存在的目录），
 * 之后可能不再投递事件。这里在 `error` 后关闭并按退避重建该根的监听：重建期间漏掉的
 * 事件是短暂的，但不会静默失去整棵根的监听。
 *
 * @returns {{ roots: string[], idle: () => Promise<void>, close: () => void }}
 */
export function startHostWatch({
  repoRoot,
  backendDir,
  env = process.env,
  runStep,
  log = () => {},
  debounceMs = 150,
  reattachDelayMs = 250,
  watch = fs.watch,
  watchRoots = resolveHostWatchRoots({ repoRoot, env })
}) {
  const sources = sourceSnapshot(repoRoot, watchRoots);
  const queue = createRebuildQueue({
    debounceMs,
    log,
    runBuild: async (target) => {
      for (const step of target.steps) await runStep(step, target);
      // Windows 只监听这个重载入口，避免 Node 隐式监听依赖目录的重复通知。
      // 浏览器发布目录同样经 fs 读取，需要在装配完成后显式通知宿主。
      if (process.platform === "win32" || target.steps.some(step => step.script === 'assemble:extensions')) {
        const entry = path.join(backendDir, 'server-dist/index.js');
        if (fs.existsSync(entry)) {
          const now = new Date();
          fs.utimesSync(entry, now, now);
        }
      }
    }
  });

  const watchers = new Map();
  const reattachTimers = new Set();
  const errorCounts = new Map();
  let closed = false;

  const attach = (root) => {
    let watcher;
    try {
      watcher = watch(root, { recursive: true }, (_event, filename) => {
        const name = typeof filename === "string" ? filename : filename?.toString?.() ?? "";
        if (name.length === 0) return;
        errorCounts.set(root, 0);
        const file = path.resolve(root, name);
        if (!isSourceFile(repoRoot, file)) return;
        const digest = sourceDigest(file);
        if (sources.get(file) === digest || !sources.has(file) && digest === null) return;
        sources.set(file, digest);
        const target = resolveWatchTarget({ repoRoot, backendDir, file, watchRoots });
        if (target !== null) queue.schedule(target);
      });
    } catch (error) {
      log({ event: "watch-unavailable", root, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    watchers.set(root, watcher);
    watcher.on?.("error", (error) => {
      log({ event: "watch-error", root, message: error instanceof Error ? error.message : String(error) });
      try {
        watcher.close();
      } catch {
        /* 已经失效的监听器关闭失败可忽略 */
      }
      watchers.delete(root);
      if (closed) return;
      const attempt = (errorCounts.get(root) ?? 0) + 1;
      errorCounts.set(root, attempt);
      const timer = setTimeout(() => {
        reattachTimers.delete(timer);
        if (!closed) attach(root);
      }, Math.min(reattachDelayMs * attempt, 2000));
      timer.unref?.();
      reattachTimers.add(timer);
    });
  };

  for (const root of watchRoots) attach(root);

  return {
    roots: watchRoots,
    idle: () => queue.idle(),
    close() {
      closed = true;
      queue.close();
      for (const timer of reattachTimers) clearTimeout(timer);
      reattachTimers.clear();
      for (const watcher of watchers.values()) {
        try {
          watcher.close();
        } catch {
          /* 关闭期间的错误不影响退出 */
        }
      }
      watchers.clear();
    }
  };
}
