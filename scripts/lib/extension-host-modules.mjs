/**
 * 扩展宿主的模块解析原语：加载期错误、包内相对子路径解析、browser 产物探测。
 *
 * 从 `extension-host.mjs` 拆出（源码规模：宿主主文件不超过 master 行数）；宿主、安全模式、受管根三个
 * 模块都依赖这里，放在最底层避免循环导入。行为与拆分前逐字一致。
 */
import fs from "node:fs";
import path from "node:path";

/** 声明未给出 `order` 时的兜底排序值（与生成器口径一致）。 */
export const FALLBACK_ORDER = 1000;

/** 声明指向的模块不存在时的候选相对路径（仅无 `exports` 映射时使用）。 */
const MODULE_FALLBACKS = (subpath) => {
  const relative = subpath.replace(/^\.\//, "");
  return [`./dist/${relative}.js`, `./${relative}.js`, `./${relative}/index.js`];
};

/** 加载期错误：带稳定 code 与扩展目录，便于启动日志与运维处置。 */
export class ExtensionLoadError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ExtensionLoadError";
    this.code = code;
    for (const [key, value] of Object.entries(details)) this[key] = value;
  }
}

function isInside(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function readPackageJson(dir, { extensionId, descriptorPath }) {
  const packageFile = path.join(dir, "package.json");
  try {
    return JSON.parse(fs.readFileSync(packageFile, "utf8"));
  } catch (error) {
    throw new ExtensionLoadError(
      "EXTENSION_PACKAGE_INVALID",
      `扩展 ${extensionId} 的 package.json 无法解析（${packageFile}）：${error.message}`,
      { extensionId, directory: dir, descriptorPath }
    );
  }
}

/** 从 `exports` 映射取运行时入口目标（`import` 优先，其次 `default`/`node`）。 */
function exportTarget(pkg, subpath) {
  const entry = pkg.exports?.[subpath];
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    return entry.import ?? entry.default ?? entry.node ?? null;
  }
  return null;
}

/**
 * 把声明里的包内相对子路径解析成扩展目录内的绝对文件路径。
 *
 * 只接受 `./x` 形态；候选目标必须是包内相对路径，解析后（含 realpath）必须落在扩展目录内。
 */
export function resolveModuleFile(dir, subpath, { extensionId, descriptorPath = null } = {}) {
  if (typeof subpath !== "string" || !subpath.startsWith("./") || subpath.includes("\\") || subpath.split("/").includes("..")) {
    throw new ExtensionLoadError(
      "EXTENSION_MODULE_INVALID",
      `扩展 ${extensionId} 的模块子路径非法（只接受包内相对路径如 ./backend）：${String(subpath)}`,
      { extensionId, directory: dir, descriptorPath, subpath }
    );
  }
  const pkg = readPackageJson(dir, { extensionId, descriptorPath });
  const declared = exportTarget(pkg, subpath);
  if (declared !== null && (typeof declared !== "string" || !declared.startsWith("./") || declared.includes("\\") || declared.split("/").includes(".."))) {
    throw new ExtensionLoadError(
      "EXTENSION_MODULE_INVALID",
      `扩展 ${extensionId} 的 package.json exports["${subpath}"] 不是包内相对路径：${String(declared)}`,
      { extensionId, directory: dir, descriptorPath, subpath }
    );
  }
  const candidates = declared === null ? MODULE_FALLBACKS(subpath) : [declared];
  for (const candidate of candidates) {
    const absolute = path.resolve(dir, candidate);
    if (!isInside(dir, absolute)) {
      throw new ExtensionLoadError(
        "EXTENSION_MODULE_ESCAPES_DIR",
        `扩展 ${extensionId} 的模块目标越出扩展目录：${candidate}`,
        { extensionId, directory: dir, descriptorPath, subpath }
      );
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const realDir = fs.realpathSync(dir);
    const real = fs.realpathSync(absolute);
    if (!isInside(realDir, real)) {
      throw new ExtensionLoadError(
        "EXTENSION_MODULE_ESCAPES_DIR",
        `扩展 ${extensionId} 的模块目标经软链越出扩展目录：${candidate}`,
        { extensionId, directory: dir, descriptorPath, subpath }
      );
    }
    return real;
  }
  throw new ExtensionLoadError(
    "EXTENSION_MODULE_MISSING",
    `扩展 ${extensionId} 的模块不存在（${subpath} → 试过 ${candidates.join("、")}）；先构建该扩展`,
    { extensionId, directory: dir, descriptorPath, subpath }
  );
}

/** 扩展是否具备已构建的 browser 产物（发布目录发现的唯一依据）。 */
export function hasBrowserArtifact(dir) {
  return fs.existsSync(path.join(dir, "browser-dist", "artifact-manifest.json"));
}
