/**
 * 打包前的「前端产物是否过期」检查（2026-10-31）。
 *
 * 现场：四喜的前端作为扩展跑在宿主里。修好 `isSixiDesktop` 之后重建了
 * `web/extensions/sixi-spike/browser-dist`，但没人重新 `assemble:extensions`，
 * `web/frontend/dist` 里仍是上一次组装的结果 —— 打出来的 exe 里跑的是旧代码，
 * 界面上照旧报 `Command get_token not found`，而源码与测试全是好的。
 *
 * `assertFrontend` 以前只查 `index.html` 在不在，产物再旧也照样通过。这里补上
 * 「比源码旧就报」这一步，规则与 `artifact-freshness.mjs`（`pnpm dev --skip-build` 用的
 * 那一套）保持一致：比 mtime、带 1s 容差、`.test./.spec.` 不参与。
 *
 * 三层都要验，缺一层就会漏掉上面那种情况：
 * 1. 前端源码 → `web/frontend/dist`；
 * 2. 扩展源码 → 各扩展的 `browser-dist`（扩展只改源码不重建，组装出来的也是旧的）；
 * 3. 扩展产物 → `web/frontend/dist`（扩展重建了但没重新组装）。
 *
 * 只做判定，不碰盘。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** 源码里不参与判定的文件：改测试不该要求重新打包。 */
const IGNORED_SOURCE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** 每次组装都会重写的入口，用它代表 `web/frontend/dist` 的整体新旧。 */
const FRONTEND_ENTRY = "index.html";

/** 前端产物直接依赖、但不经由某个扩展目录的源码根（相对仓库根）。 */
const FRONTEND_SOURCE_ROOTS = [
  path.join("web", "frontend", "src"),
  path.join("web", "contracts", "src")
];

/** 目录树里最新的文件（跳过 node_modules 与测试）。不存在时返回 `{ mtime: 0 }`。 */
export function newestFile(dir) {
  if (!existsSync(dir)) return { mtime: 0, file: undefined };
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
      if (mtime > newest.mtime) newest = { mtime, file: full };
    }
  }
  return newest;
}

/** 仓库里的扩展目录（`web/extensions/*` 下有 `package.json` 的那些）。 */
function extensionDirs(root) {
  const base = path.join(root, "web", "extensions");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(base, entry.name))
    .filter((dir) => existsSync(path.join(dir, "package.json")))
    .sort();
}

/**
 * 找出过期的前端 / 扩展产物。
 *
 * @returns {Array<{artifact: string, source: string}>} 路径相对 `root`
 */
export function findStaleFrontend(root, options = {}) {
  // 构建与写盘之间有毫秒级抖动；1s 容差避免把同一秒内的正常构建误判成过期。
  const toleranceMs = options.toleranceMs ?? 1000;
  const dist = options.frontendDist ?? path.join(root, "web", "frontend", "dist");
  const entry = path.join(dist, FRONTEND_ENTRY);
  // 产物本身不存在由 `assertFrontend` 报「缺失」，这里不重复。
  if (!existsSync(entry)) return [];
  const entryMtime = statSync(entry).mtimeMs;
  const stale = [];

  const compare = (artifactFile, artifactMtime, source) => {
    if (source.mtime === 0) return;
    if (source.mtime <= artifactMtime + toleranceMs) return;
    stale.push({
      artifact: path.relative(root, artifactFile),
      source: path.relative(root, source.file)
    });
  };

  // 1. 前端源码 → dist
  for (const relative of FRONTEND_SOURCE_ROOTS) {
    compare(entry, entryMtime, newestFile(path.join(root, relative)));
  }

  for (const dir of extensionDirs(root)) {
    const manifest = path.join(dir, "browser-dist", "artifact-manifest.json");
    // 2. 扩展源码 → 它自己的 browser-dist
    if (existsSync(manifest)) {
      const manifestMtime = statSync(manifest).mtimeMs;
      compare(manifest, manifestMtime, newestFile(path.join(dir, "src")));
      // 3. 扩展产物 → 前端 dist（重建了扩展却没重新组装）
      compare(entry, entryMtime, { mtime: manifestMtime, file: manifest });
    }
  }

  return stale;
}

/** 一行一条，便于直接贴到报错里。 */
export function formatStaleFrontend(stale) {
  return stale
    .map((item) => `${item.artifact} 早于 ${item.source}`)
    .join("；");
}
