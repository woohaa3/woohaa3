/**
 * 扩展目录扫描与配置根解析
 * （change: 2026-10-15-add-scannable-extension-directories，任务 1.1–1.3 / design D1、D5）。
 *
 * 单一事实源：浏览器构建、前端装配、发布装配与后端注册表生成都从这里取"有哪些扩展"。
 *
 * 规则：
 * - 扩展是**某个配置根的直接子目录**；目录名不必等于 extensionId。
 * - 目录名以 `.` 开头 = 未安装：不参与构建/登记/装配/发布，也不进入 pnpm 工作区成员。
 * - 目录必须带 `package.json`，且包名以 `@woohaa3/extension-` 开头；否则跳过（fixture/工具目录）。
 * - 跨根出现同一 extensionId 时稳定报错，绝不静默取其一。
 *
 * 本模块只读文件系统与 JSON，不执行扩展源码，也不依赖 pnpm 语义。
 */
import fs from "node:fs";
import path from "node:path";

export const EXTENSION_DIRS_ENV = "WOOHAA3_EXTENSION_DIRS";
/**
 * 可写扩展根（change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 5.1）。
 *
 * 部署侧数据目录（运维可写）里的扩展只能提供普通应用扩展；槽位实现（存储/身份/权限）
 * 只允许来自非可写根。`extensions.config.json` 的 `roots` 条目也可以写成
 * `{ "path": "...", "writable": true }`。
 */
export const EXTENSION_WRITABLE_DIRS_ENV = "WOOHAA3_EXTENSION_WRITABLE_DIRS";
export const EXTENSION_CONFIG_FILE = "extensions.config.json";
export const EXTENSION_CONFIG_SCHEMA_VERSION = 1;
export const EXTENSION_PACKAGE_PREFIX = "@woohaa3/extension-";
export const EXTENSION_DESCRIPTOR_NAME = "extension.json";
export const DEFAULT_EXTENSION_ROOTS = ["web/extensions", "extensions"];
export const WORKSPACE_FILE = "web/pnpm-workspace.yaml";

/** 扫描/配置错误：带稳定 code，便于脚本与测试断言。 */
export class ExtensionScanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExtensionScanError";
    this.code = code;
  }
}

/** 解析扩展根清单：环境变量覆盖配置，配置覆盖缺省。 */
export function resolveExtensionRoots({ repoRoot, env = process.env, configFile = EXTENSION_CONFIG_FILE } = {}) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new ExtensionScanError("EXTENSION_REPO_ROOT_MISSING", "缺少 repoRoot");
  }
  const raw = env?.[EXTENSION_DIRS_ENV];
  let declared;
  let source;
  let configPath = null;
  if (typeof raw === "string" && raw.trim().length > 0) {
    // 部署侧覆盖：完全替换配置文件，避免"配置 + 环境"两份来源叠加出第三种结果。
    declared = raw.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => ({ path: entry, writable: false }));
    source = "env";
  } else {
    const candidate = path.resolve(repoRoot, configFile);
    if (fs.existsSync(candidate)) {
      configPath = candidate;
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      } catch (error) {
        throw new ExtensionScanError("EXTENSION_CONFIG_INVALID", `${configFile} 不是合法 JSON：${error.message}`);
      }
      if (parsed?.schemaVersion !== EXTENSION_CONFIG_SCHEMA_VERSION) {
        throw new ExtensionScanError(
          "EXTENSION_CONFIG_INVALID",
          `${configFile} 的 schemaVersion 必须是 ${EXTENSION_CONFIG_SCHEMA_VERSION}`
        );
      }
      if (!Array.isArray(parsed.roots) || parsed.roots.length === 0) {
        throw new ExtensionScanError("EXTENSION_CONFIG_INVALID", `${configFile} 的 roots 必须是非空数组`);
      }
      declared = parsed.roots.map((entry) => {
        if (typeof entry === "string") {
          if (entry.trim().length === 0) throw new ExtensionScanError("EXTENSION_CONFIG_INVALID", `${configFile} 的 roots 条目必须是非空字符串`);
          return { path: entry.trim(), writable: false };
        }
        if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
          const entryPath = typeof entry.path === "string" ? entry.path.trim() : "";
          if (entryPath.length === 0) throw new ExtensionScanError("EXTENSION_CONFIG_INVALID", `${configFile} 的 roots[].path 必须是非空字符串`);
          if (entry.writable !== undefined && typeof entry.writable !== "boolean") {
            throw new ExtensionScanError("EXTENSION_CONFIG_INVALID", `${configFile} 的 roots[].writable 必须是布尔值`);
          }
          return { path: entryPath, writable: entry.writable === true };
        }
        throw new ExtensionScanError("EXTENSION_CONFIG_INVALID", `${configFile} 的 roots 条目必须是字符串或 { path, writable }`);
      });
      source = "config";
    } else {
      declared = DEFAULT_EXTENSION_ROOTS.map((entry) => ({ path: entry, writable: false }));
      source = "default";
    }
  }

  const roots = [];
  const writableRoots = [];
  const seen = new Set();
  for (const entry of declared) {
    const absolute = path.resolve(repoRoot, entry.path);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
      throw new ExtensionScanError(
        "EXTENSION_ROOT_MISSING",
        `扩展根不存在或不是目录：${entry.path}（来自 ${sourceWithPath(source, configPath)}）→ ${absolute}`
      );
    }
    roots.push(absolute);
    if (entry.writable) writableRoots.push(absolute);
  }

  // 环境变量来源的根全部为普通根；可写根由独立变量标记，且必须是已解析根的成员。
  const rawWritable = env?.[EXTENSION_WRITABLE_DIRS_ENV];
  for (const entry of typeof rawWritable === "string" ? rawWritable.split(",").map((value) => value.trim()).filter(Boolean) : []) {
    const absolute = path.resolve(repoRoot, entry);
    if (!roots.includes(absolute)) {
      throw new ExtensionScanError(
        "EXTENSION_WRITABLE_ROOT_UNKNOWN",
        `${EXTENSION_WRITABLE_DIRS_ENV} 列出的可写根必须是已解析根的成员：${entry} → ${absolute}`
      );
    }
    if (!writableRoots.includes(absolute)) writableRoots.push(absolute);
  }

  return { roots, writableRoots, source, configPath, configFile: path.resolve(repoRoot, configFile) };
}

function sourceWithPath(source, configPath) {
  if (source === "env") return `环境变量 ${EXTENSION_DIRS_ENV}`;
  if (source === "config") return configPath ?? EXTENSION_CONFIG_FILE;
  return "缺省配置";
}

/** 目录是否具备约定的 browser 入口（`src/frontend/index.ts` + `metadata.ts`）。 */
export function hasBrowserEntry(dir) {
  return (
    fs.existsSync(path.join(dir, "src", "frontend", "index.ts")) &&
    fs.existsSync(path.join(dir, "src", "frontend", "metadata.ts"))
  );
}

/** 读取扩展声明 `<dir>/extension.json`（不存在返回 null；不在此做完整 schema 校验）。 */
export function readExtensionDescriptor(dir) {
  const descriptorPath = path.join(dir, EXTENSION_DESCRIPTOR_NAME);
  if (!fs.existsSync(descriptorPath)) return { descriptor: null, descriptorPath: null };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  } catch (error) {
    throw new ExtensionScanError("EXTENSION_DESCRIPTOR_INVALID", `${descriptorPath} 不是合法 JSON：${error.message}`);
  }
  return { descriptor: parsed, descriptorPath };
}

/**
 * 扫描全部配置根，返回稳定排序的扩展列表。
 *
 * 返回：
 * - `extensions`：`{ extensionId, directory, dir, root, packageName, packageVersion, declaredId, descriptorPath, hasBrowserEntry }`
 * - `disabled`：`.` 前缀目录（未安装）
 * - `skipped`：目录存在但不是扩展（无 package.json / 包名不符）
 */
export function scanExtensions({ repoRoot, env = process.env, configFile = EXTENSION_CONFIG_FILE } = {}) {
  const resolved = resolveExtensionRoots({ repoRoot, env, configFile });
  const extensions = [];
  const disabled = [];
  const skipped = [];
  const byId = new Map();
  const isWritableRoot = (root) => resolved.writableRoots.includes(root);

  for (const root of resolved.roots) {
    const entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules") continue;
      const dir = path.join(root, entry.name);
      if (entry.name.startsWith(".")) {
        disabled.push({ directory: entry.name, dir, root, rootWritable: isWritableRoot(root) });
        continue;
      }
      const packageFile = path.join(dir, "package.json");
      if (!fs.existsSync(packageFile)) {
        skipped.push({ directory: entry.name, dir, root, rootWritable: isWritableRoot(root), reason: "no-package-json" });
        continue;
      }
      let pkg;
      try {
        pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
      } catch (error) {
        throw new ExtensionScanError("EXTENSION_PACKAGE_INVALID", `${packageFile} 不是合法 JSON：${error.message}`);
      }
      if (typeof pkg?.name !== "string" || !pkg.name.startsWith(EXTENSION_PACKAGE_PREFIX)) {
        skipped.push({ directory: entry.name, dir, root, rootWritable: isWritableRoot(root), reason: "not-extension-package" });
        continue;
      }
      const { descriptor, descriptorPath } = readExtensionDescriptor(dir);
      if (descriptorPath && (typeof descriptor?.extensionId !== "string" || descriptor.extensionId.trim().length === 0)) {
        throw new ExtensionScanError("EXTENSION_DESCRIPTOR_INVALID", `${descriptorPath} 缺少 extensionId`);
      }
      const declaredId = descriptorPath ? descriptor.extensionId.trim() : null;
      const extensionId = declaredId ?? pkg.name.slice(EXTENSION_PACKAGE_PREFIX.length);
      const record = {
        extensionId,
        declaredId,
        directory: entry.name,
        dir,
        root,
        rootWritable: isWritableRoot(root),
        packageName: pkg.name,
        packageVersion: typeof pkg.version === "string" ? pkg.version : null,
        descriptorPath,
        hasBrowserEntry: hasBrowserEntry(dir)
      };
      const previous = byId.get(extensionId);
      if (previous) {
        throw new ExtensionScanError(
          "EXTENSION_ID_DUPLICATE",
          `扩展 extensionId 重复：${extensionId}\n  ${path.relative(repoRoot, previous.dir)}\n  ${path.relative(repoRoot, dir)}`
        );
      }
      byId.set(extensionId, record);
      extensions.push(record);
    }
  }

  extensions.sort((a, b) => (a.extensionId === b.extensionId ? (a.dir < b.dir ? -1 : 1) : a.extensionId < b.extensionId ? -1 : 1));
  return { ...resolved, extensions, disabled, skipped };
}

/** Browser 扩展包括源码包和仅包含预构建产物的安装包。 */
export function browserExtensions(scan) {
  return scan.extensions.filter((extension) => extension.hasBrowserEntry ||
    fs.existsSync(path.join(extension.dir, 'browser-dist', 'artifact-manifest.json')));
}

/**
 * 按 id/目录名定位扩展目录（发布装配等按 extensionId 取源码的场景）。
 *
 * `extensionId` 与 `directory` 都可作为键（两者常常相同）；找不到返回 null，
 * 由调用方决定是报错还是跳过——本模块不静默兜底。
 */
export function createExtensionLocator({ repoRoot, env = process.env, configFile } = {}) {
  const scan = scanExtensions({ repoRoot, env, ...(configFile ? { configFile } : {}) });
  const byKey = new Map();
  for (const extension of scan.extensions) {
    byKey.set(extension.extensionId, extension.dir);
    if (!byKey.has(extension.directory)) byKey.set(extension.directory, extension.dir);
  }
  return {
    scan,
    roots: scan.roots,
    /** 定位扩展目录；未安装（`.` 前缀）或不存在时返回 null。 */
    dirOf: (id) => byKey.get(id) ?? null,
    /** 已安装扩展的 extensionId 列表（稳定排序）。 */
    ids: () => [...scan.extensions].map((extension) => extension.extensionId)
  };
}

/** 读取 `pnpm-workspace.yaml` 的 `packages:` glob 列表（只解析这一项，避免引入 YAML 依赖）。 */
export function readWorkspaceGlobs(workspaceFile) {
  if (!fs.existsSync(workspaceFile)) return [];
  const lines = fs.readFileSync(workspaceFile, "utf8").split("\n");
  const globs = [];
  let inPackages = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (item) {
      globs.push(item[1]);
      continue;
    }
    if (line.trim().length === 0 || /^\s*#/.test(line)) continue;
    break; // 下一个顶层键
  }
  return globs;
}

/**
 * 检查配置根是否被工作区 glob 覆盖。
 *
 * 只按"glob 去掉尾部 `/*` 或 `/**` 后的目录是否等于根目录"判定，覆盖常见写法
 * （`extensions/*`、`../extensions/*`）；更复杂的 glob 视为未覆盖并提示人工确认。
 */
export function checkRootsCoveredByWorkspace({ repoRoot, roots, workspaceFile = path.resolve(repoRoot, WORKSPACE_FILE) }) {
  const globs = readWorkspaceGlobs(workspaceFile);
  const workspaceDir = path.dirname(workspaceFile);
  const covered = [];
  const uncovered = [];
  for (const root of roots) {
    const match = globs.find((glob) => {
      const trimmed = glob.replace(/\/\*\*?$/, "").replace(/\/$/, "");
      if (trimmed.includes("*")) return false;
      return path.resolve(workspaceDir, trimmed) === path.resolve(root);
    });
    if (match) covered.push({ root, glob: match });
    else uncovered.push({ root, relative: path.relative(repoRoot, root) });
  }
  return { globs, workspaceFile, covered, uncovered, ok: uncovered.length === 0 };
}

/** 未覆盖提示：默认只提示（构建期仍会因依赖解析失败暴露），`strict` 时升级为错误。 */
export function assertRootsCoveredByWorkspace({ repoRoot, roots, workspaceFile, strict = false }) {
  const result = checkRootsCoveredByWorkspace({ repoRoot, roots, workspaceFile });
  if (result.ok || !strict) return result;
  const list = result.uncovered
    .map((entry) => `  ${entry.relative}（请在 ${path.relative(repoRoot, result.workspaceFile)} 的 packages 增加该根，例如 "${entry.relative}/*"）`)
    .join("\n");
  throw new ExtensionScanError(
    "EXTENSION_ROOT_NOT_IN_WORKSPACE",
    `扩展根未被工作区 glob 覆盖，其依赖无法解析：\n${list}`
  );
}

/** 覆盖提示文案（脚本打印用；ok 时返回 null）。 */
export function formatWorkspaceCoverageHint(result, { repoRoot }) {
  if (result.ok) return null;
  const list = result.uncovered.map((entry) => `  ${entry.relative}`).join("\n");
  return `[extension-scan] 提示：以下扩展根未被 web/pnpm-workspace.yaml 的 packages 覆盖，其 workspace 依赖可能无法解析：\n${list}\n  （仓库外根需要自行增加 glob；仓库内根可在 ${WORKSPACE_FILE} 增加）`;
}
