/**
 * 开发者模式产物监听（change: 2026-10-27-add-extension-dev-reload，D2 / D7）。
 *
 * 与 `dev-host-watch.mjs` 是**反向**的两层，不要混用：
 * - `dev-host-watch` 监听**源码**，变化后跑构建（仓库内包）；
 * - 本模块监听**产物**，变化后发 reload（开发者登记目录，构建在作者侧）。
 *
 * 宿主不解释源码，也不跑作者的工具链：它只回答「产物变了吗、变了是哪一个、什么时候发指令」。
 * 监听目标是 `browser-dist` 与 `backend-dist`，两者分别对应前端重装与后端 swap。
 */
import fs from "node:fs";
import path from "node:path";

/** 产物目录名（与 build-extension-browser / build-extension-backend 的缺省输出一致）。 */
export const BROWSER_DIST = "browser-dist";
export const BACKEND_DIST = "backend-dist";

/** 产物变化的两个面：前端重装、后端 swap。一次变化可能同时命中两者。 */
export const DEV_SURFACES = /** @type {const} */ (["browser", "backend"]);

/**
 * 解析某条产物路径属于哪个扩展的哪个面。
 *
 * 只在 `<devDir>/<…>/<surface>-dist/**` 形态下命中；扩展目录是 `-dist` 的父目录。
 * 隐藏文件与临时文件（编辑器/打包器的中间产物）一律忽略，避免半成品触发重装。
 *
 * @returns {{ extensionDir: string, surface: "browser" | "backend" } | null}
 */
export function resolveDevSurface(file) {
  const absolute = path.resolve(file);
  const base = path.basename(absolute);
  if (base.startsWith(".") || base.endsWith(".tmp") || base.endsWith("~")) return null;
  const segments = absolute.split(path.sep);
  // 从最靠近文件的目录往回找第一个 -dist 目录。
  for (let index = segments.length - 2; index > 0; index -= 1) {
    const segment = segments[index];
    if (segment !== BROWSER_DIST && segment !== BACKEND_DIST) continue;
    const extensionDir = segments.slice(0, index).join(path.sep);
    if (!extensionDir) return null;
    return { extensionDir, surface: segment === BROWSER_DIST ? "browser" : "backend" };
  }
  return null;
}

/**
 * 监听一批开发者目录的产物变化，按扩展合并后回调。
 *
 * 语义：
 * - 同一扩展的连续变化在 `debounceMs` 内合并成一次；同一次里同时命中两个面时两个面都上报。
 * - 回调串行执行：上一次 reload 未结束时到达的变化排到下一轮（D7 的「构建期间的新变化排到下一轮」）。
 * - 监听失败（递归监听不可用的文件系统）退化为轮询，并在诊断里说明，不静默失效。
 *
 * @returns {{ close: () => void, idle: () => Promise<void>, watched: string[] }}
 */
export function startDevSourceWatch({
  devDirs,
  onChange,
  log = () => {},
  debounceMs = 120,
  pollMs = 1000,
  watch = fs.watch,
  now = Date.now
}) {
  /** 每个扩展待处理的产物面。 */
  const pending = new Map();
  let timer = null;
  let tail = Promise.resolve();
  let closed = false;
  const watchers = [];
  const timers = new Set();

  /** 用 mtime 生成产物指纹，作为「是否真的变了」与后端模块 token 的共同依据。 */
  const surfaceToken = (extensionDir, surface) => {
    const dir = path.join(extensionDir, surface === "browser" ? BROWSER_DIST : BACKEND_DIST);
    let latest = 0;
    let count = 0;
    const walk = (current) => {
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(file);
          continue;
        }
        try {
          const stat = fs.statSync(file);
          latest = Math.max(latest, stat.mtimeMs);
          count += 1;
        } catch {
          /* 文件在遍历中被替换：本轮忽略，下一次事件会再报 */
        }
      }
    };
    walk(dir);
    return count === 0 ? null : `${Math.floor(latest)}-${count}`;
  };

  const seen = new Map();
  const note = (extensionDir, surface) => {
    const key = `${extensionDir}\u0000${surface}`;
    const token = surfaceToken(extensionDir, surface);
    if (token === null) return;
    if (seen.get(key) === token) return;
    seen.set(key, token);
    const current = pending.get(extensionDir) ?? { surfaces: new Set(), token: now() };
    current.surfaces.add(surface);
    pending.set(extensionDir, current);
    schedule();
  };

  const flush = () => {
    timer = null;
    if (closed || pending.size === 0) return tail;
    const batch = [...pending.entries()];
    pending.clear();
    tail = tail.then(async () => {
      for (const [extensionDir, entry] of batch) {
        try {
          await onChange({ extensionDir, surfaces: [...entry.surfaces].sort() });
        } catch (error) {
          // reload 失败不影响监听继续：下一次保存会再触发一次。
          log({ event: "dev-reload-failed", extensionDir, message: error instanceof Error ? error.message : String(error) });
        }
      }
      if (!closed && pending.size > 0) flush();
    });
    return tail;
  };

  const schedule = () => {
    if (closed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
  };

  const attach = (root) => {
    try {
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        const name = typeof filename === "string" ? filename : filename?.toString?.() ?? "";
        if (!name) return;
        const resolved = resolveDevSurface(path.resolve(root, name));
        if (resolved) note(resolved.extensionDir, resolved.surface);
      });
      watcher.on?.("error", (error) => {
        log({ event: "dev-watch-error", root, message: error instanceof Error ? error.message : String(error) });
      });
      watchers.push(watcher);
      return true;
    } catch (error) {
      return false;
    }
  };

  const watched = [];
  for (const root of devDirs) {
    if (!fs.existsSync(root)) continue;
    if (!attach(root)) {
      // 回退：轮询所有已知扩展的产物 mtime。慢，但不会因为监听不可用而彻底失效。
      log({ event: "dev-watch-fallback-poll", root });
      const poll = setInterval(() => {
        for (const extensionDir of seen.keys()) {
          for (const surface of DEV_SURFACES) note(extensionDir, surface);
        }
      }, pollMs);
      poll.unref?.();
      timers.add(poll);
      continue;
    }
    watched.push(root);
  }

  return {
    watched,
    idle: () => {
      if (timer !== null) {
        clearTimeout(timer);
        flush();
      }
      return tail;
    },
    close() {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          /* 已失效的监听器关闭失败可忽略 */
        }
      }
      for (const handle of timers) clearInterval(handle);
      watchers.length = 0;
      timers.clear();
      pending.clear();
    }
  };
}
