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

import { managedLayout, readInstallations, resolveManagedRoot } from "./extension-installations.mjs";

export const EXTENSION_DIRS_ENV = "WOOHAA3_EXTENSION_DIRS";
/**
 * 可写扩展根（change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 5.1）。
 *
 * 部署侧数据目录（运维可写）里的扩展只能提供普通应用扩展；槽位实现（存储/身份/权限）
 * 只允许来自非可写根。`extensions.config.json` 的 `roots` 条目也可以写成
 * `{ "path": "...", "writable": true }`。
 */
export const EXTENSION_WRITABLE_DIRS_ENV = "WOOHAA3_EXTENSION_WRITABLE_DIRS";

/**
 * 开发者模式登记目录（change: 2026-10-27-add-extension-dev-reload，D3）。
 *
 * 逗号分隔的本机扩展目录。与配置根不同：**开发构建专属**、只告警不抛错、优先级最高
 * （dev > managed > builtin），且不写入 installations.json、不参与签名信任。
 */
export const EXTENSION_DEV_DIRS_ENV = "WOOHAA3_EXTENSION_DEV_DIRS";

/**
 * 开发者模式是否可用（change: 2026-10-27-add-extension-dev-reload，D10）。
 *
 * 只认**显式开启**，不按 `NODE_ENV` 推断：桌面宿主无论开发还是发布都设 `NODE_ENV=production`
 * （见 `desktop-host-data.mjs`），用 NODE_ENV 判断会把 `pnpm dev:desktop` 一起误杀。
 * 因此发布形态天然没有该变量 → 没有入口；开发编排显式注入 `WOOHAA3_EXTENSION_DEV_MODE=1`。
 */
export const EXTENSION_DEV_MODE_ENV = "WOOHAA3_EXTENSION_DEV_MODE";

export function devSourceAllowed(env = process.env) {
  const flag = String(env?.[EXTENSION_DEV_MODE_ENV] ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/**
 * 解析开发者登记目录。生产构建立即返回空集（视为「没有这个入口」），
 * 目录不存在只记告警，不让启动失败。
 */
export function resolveDevSourceDirs({ repoRoot, env = process.env, warnings = [] } = {}) {
  if (!devSourceAllowed(env)) return [];
  const raw = env?.[EXTENSION_DEV_DIRS_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  const dirs = [];
  for (const entry of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    const absolute = path.resolve(repoRoot, entry);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
      warnings.push({
        code: "EXTENSION_DEV_DIR_MISSING",
        extensionId: null,
        directory: absolute,
        message: `开发者登记目录不存在或不是目录：${entry} → ${absolute}`
      });
      continue;
    }
    if (!dirs.includes(absolute)) dirs.push(absolute);
  }
  return dirs;
}
export const EXTENSION_CONFIG_FILE = "extensions.config.json";
export const EXTENSION_CONFIG_SCHEMA_VERSION = 1;
export const EXTENSION_PACKAGE_PREFIX = "@woohaa3/extension-";
export const EXTENSION_DESCRIPTOR_NAME = "extension.json";
export const DEFAULT_EXTENSION_ROOTS = ["web/extensions", "extensions"];
export const WORKSPACE_FILE = "web/pnpm-workspace.yaml";

/**
 * 严格 semver 的核心三段比较（预发布后缀不参与；非法版本排最前）。
 *
 * 与 contracts 的 compareSemver / extension-descriptor 的 satisfiesRange 同一口径；
 * 扫描器在这里单独实现是为了避免与 extension-descriptor 形成循环 import。
 */
export function compareExtensionVersions(a, b) {
  const parse = (value) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(typeof value === "string" ? value : "");
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

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

  // 受管安装根（change: 2026-10-21-add-extension-marketplace-point，任务 4.1 / design D7）：不是配置根——
  // 它不按「直接子目录」扫描，而按 installations.json 的版本指针取 installed/<id>/<current>。
  // 与配置根重叠会让同一目录被两种规则解释，直接拒绝：受管根等于某个配置根、包含某个配置根，
  // 或恰好是某个配置根的非点号直接子目录（会被当成一个扩展目录扫描）。受管根位于配置根更深处或
  // 点号目录下（如缺省的 <repo>/.woohaa3/extensions）不会被扫描到，允许。
  const managedRoot = resolveManagedRoot({ repoRoot, env });
  for (const root of roots) {
    const parent = path.dirname(managedRoot);
    const directChild = parent === root && !path.basename(managedRoot).startsWith(".");
    if (isInsideOrSame(managedRoot, root) || directChild) {
      throw new ExtensionScanError(
        "EXTENSION_MANAGED_ROOT_OVERLAP",
        `受管扩展根不能与配置根重叠：${managedRoot} ↔ ${root}（检查 WOOHAA3_EXTENSION_MANAGED_DIR）`
      );
    }
  }

  return { roots, writableRoots, managedRoot, source, configPath, configFile: path.resolve(repoRoot, configFile) };
}

function isInsideOrSame(parent, candidate) {
  const a = path.resolve(parent);
  const b = path.resolve(candidate);
  return a === b || b.startsWith(`${a}${path.sep}`);
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
 * - `warnings`：受管根的非致命问题（指针损坏、版本目录缺失、与内置根同 id）；受管扩展是可选插件，
 *   这些问题只跳过该扩展，不让启动失败。
 *
 * 受管根记录带 `managed: true`、`rootWritable: false`、`managedVersion`；内置根同 id 优先。
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
      const packageVersion = typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
      // 分发版本与 pack:extension 同一口径：extension.json.version 优先，否则 package.json.version。
      // site.version / metadata.version 是展示口径，不参与「能不能升级」的判断。
      const distributionVersion =
        typeof descriptor?.version === "string" && descriptor.version.trim() ? descriptor.version.trim() : packageVersion;
      const record = {
        extensionId,
        declaredId,
        directory: entry.name,
        dir,
        root,
        origin: "builtin",
        rootWritable: isWritableRoot(root),
        packageName: pkg.name,
        packageVersion,
        distributionVersion,
        hasBackend: Boolean(descriptor?.backend || descriptor?.hostPlugin || descriptor?.metadata || (descriptor?.publicRoutes?.length ?? 0) > 0),
        hotSwappable: Boolean(descriptor?.hostPlugin),
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

  // 内置候选在合并受管根之前固定下来：即使某个内置 id 被受管版本覆盖，宿主仍需要它的版本与目录
  // 做 semver 判断、卸载回退和「内置 vX」展示。可写根不算内置（运维手放目录，不随发布打包）。
  const builtinExtensions = extensions
    .filter((entry) => entry.rootWritable !== true)
    .map((entry) => ({
      extensionId: entry.extensionId,
      version: entry.distributionVersion ?? "",
      directory: entry.dir,
      requiresBackend: entry.hasBackend === true,
      hotSwappable: entry.hotSwappable === true
    }));

  const warnings = [];
  for (const record of scanManagedRoot(resolved.managedRoot, warnings)) {
    const previous = byId.get(record.extensionId);
    if (previous) {
      const previousIsBuiltin = previous.rootWritable !== true && previous.managed !== true;
      const managedVersion = record.distributionVersion ?? record.managedVersion;
      const builtinVersion = previous.distributionVersion;
      // 同 id 只允许「受管版本严格高于内置版本」覆盖。手工改 installations.json、或旧客户端
      // 绕过 resolve 写入的不更高版本，一律继续用内置，避免降级/同版本不同内容。
      if (!previousIsBuiltin || !managedVersion || !builtinVersion || compareExtensionVersions(managedVersion, builtinVersion) <= 0) {
        warnings.push({
          code: "EXTENSION_MANAGED_SHADOWED",
          extensionId: record.extensionId,
          directory: record.dir,
          message: previousIsBuiltin
            ? `受管扩展 ${record.extensionId}@${managedVersion ?? "?"} 不高于内置版本 ${builtinVersion ?? "未知"}（${path.relative(repoRoot, previous.dir)}），内置优先，受管版本不装配`
            : `受管扩展 ${record.extensionId}@${managedVersion ?? "?"} 与可写根扩展同 id（${path.relative(repoRoot, previous.dir)}），可写根优先，受管版本不装配`
        });
        continue;
      }
      record.builtinVersion = builtinVersion;
      record.builtinDirectory = previous.dir;
      record.builtinRequiresBackend = previous.hasBackend === true;
      record.builtinHotSwappable = previous.hotSwappable === true;
      const index = extensions.indexOf(previous);
      if (index >= 0) extensions[index] = record;
      byId.set(record.extensionId, record);
      warnings.push({
        code: "EXTENSION_MANAGED_OVERRIDES_BUILTIN",
        extensionId: record.extensionId,
        directory: record.dir,
        message: `受管扩展 ${record.extensionId}@${managedVersion} 高于内置版本 ${builtinVersion}，本次装配受管版本（内置目录 ${path.relative(repoRoot, previous.dir)}）`
      });
      continue;
    }
    byId.set(record.extensionId, record);
    extensions.push(record);
  }

  // 开发者模式（change: 2026-10-27-add-extension-dev-reload，D3/D4）：优先级高于受管与内置。
  // 只告警、不抛错——登记目录由开发者自己维护，写坏了不应让整个宿主起不来。
  const devDirs = resolveDevSourceDirs({ repoRoot, env, warnings });
  for (const record of scanDevSources(devDirs, repoRoot, warnings)) {
    const previous = byId.get(record.extensionId);
    if (previous) {
      record.shadowedOrigin = originOf(previous);
      record.shadowedDirectory = previous.dir;
      const index = extensions.indexOf(previous);
      if (index >= 0) extensions[index] = record;
      byId.set(record.extensionId, record);
      warnings.push({
        code: "EXTENSION_DEV_OVERRIDES_INSTALLED",
        extensionId: record.extensionId,
        directory: record.dir,
        message: `开发者模式覆盖了 ${record.shadowedOrigin} 版本 ${record.extensionId}（${path.relative(repoRoot, previous.dir)}）；退出开发者模式后回落`
      });
      continue;
    }
    byId.set(record.extensionId, record);
    extensions.push(record);
  }

  extensions.sort((a, b) => (a.extensionId === b.extensionId ? (a.dir < b.dir ? -1 : 1) : a.extensionId < b.extensionId ? -1 : 1));
  return { ...resolved, devDirs, extensions, builtinExtensions, disabled, skipped, warnings };
}

/** 在场形态（D4）：dev > managed > builtin。可写根沿用内置口径，不单列。 */
export function originOf(record) {
  if (record?.dev === true) return "dev";
  if (record?.managed === true) return "managed";
  return "builtin";
}

/**
 * 扫描开发者登记目录（每个目录可以是单个扩展，也可以是一组扩展的父目录）。
 *
 * 与配置根的区别：不解析 `.name` 停用前缀（开发者不会用改名来停用），
 * 但要求 `package.json` 与 `extension.json` 至少有一个能给出 identity；冲突只告警跳过。
 */
export function scanDevSources(devDirs, repoRoot = devDirs[0] ?? process.cwd(), warnings = []) {
  const records = [];
  const seen = new Set();
  for (const root of devDirs) {
    const candidates = [];
    if (fs.existsSync(path.join(root, "package.json")) || fs.existsSync(path.join(root, EXTENSION_DESCRIPTOR_NAME))) {
      candidates.push(root);
    } else {
      for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        candidates.push(path.join(root, entry.name));
      }
    }
    for (const dir of candidates) {
      const record = readDevSource(dir, root, warnings);
      if (!record) continue;
      if (seen.has(record.extensionId)) {
        warnings.push({
          code: "EXTENSION_DEV_DUPLICATE",
          extensionId: record.extensionId,
          directory: dir,
          message: `开发者模式重复登记了同一个扩展：${record.extensionId}（${path.relative(repoRoot, dir)}）`
        });
        continue;
      }
      seen.add(record.extensionId);
      records.push(record);
    }
  }
  return records;
}

/** 读一个开发者目录；不合格只告警并返回 null。 */
function readDevSource(dir, root, warnings) {
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    pkg = null;
  }
  let descriptor = null;
  let descriptorPath = null;
  try {
    ({ descriptor, descriptorPath } = readExtensionDescriptor(dir));
  } catch (error) {
    warnings.push({ code: "EXTENSION_DEV_REJECTED", extensionId: null, directory: dir, message: `开发者目录声明无法读取：${error.message}` });
    return null;
  }
  const declaredId = typeof descriptor?.extensionId === "string" && descriptor.extensionId.trim() ? descriptor.extensionId.trim() : null;
  const packageId = typeof pkg?.name === "string" && pkg.name.startsWith(EXTENSION_PACKAGE_PREFIX) ? pkg.name.slice(EXTENSION_PACKAGE_PREFIX.length) : null;
  const extensionId = declaredId ?? packageId;
  if (!extensionId) {
    warnings.push({ code: "EXTENSION_DEV_REJECTED", extensionId: null, directory: dir, message: `开发者目录既无 extension.json 也无合法包名，已跳过：${dir}` });
    return null;
  }
  const packageVersion = typeof pkg?.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
  return {
    extensionId,
    declaredId,
    directory: path.basename(dir),
    dir,
    root,
    dev: true,
    origin: "dev",
    rootWritable: false,
    packageName: typeof pkg?.name === "string" ? pkg.name : null,
    packageVersion,
    distributionVersion:
      typeof descriptor?.version === "string" && descriptor.version.trim() ? descriptor.version.trim() : packageVersion,
    hasBackend: Boolean(descriptor?.backend || descriptor?.hostPlugin || descriptor?.metadata || (descriptor?.publicRoutes?.length ?? 0) > 0),
    hotSwappable: Boolean(descriptor?.hostPlugin),
    descriptorPath,
    hasBrowserEntry: hasBrowserEntry(dir)
  };
}

/**
 * 按 `installations.json` 的版本指针读取受管扩展（只读；不存在的受管根视为空）。
 *
 * 每个条目必须满足：版本目录存在、带 `@woohaa3/extension-*` 的 package.json、`extension.json` 的
 * extensionId 与指针键一致。任一不满足都只告警跳过——指针目录被手工删除时宿主照常启动。
 * `uninstalling` 状态的条目仍装配（卸载流程先停用再删指针）。
 */
export function scanManagedRoot(managedRoot, warnings = []) {
  if (typeof managedRoot !== "string" || !fs.existsSync(managedRoot)) return [];
  const { state, warnings: readWarnings } = readInstallations(managedRoot);
  for (const message of readWarnings) warnings.push({ code: "EXTENSION_MANAGED_INSTALLATIONS_INVALID", extensionId: null, directory: managedRoot, message });
  const layout = managedLayout(managedRoot);
  const records = [];
  for (const [extensionId, entry] of Object.entries(state.extensions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const skip = (code, message, dir = null) => warnings.push({ code, extensionId, directory: dir, message });
    let dir;
    try {
      dir = layout.versionDir(extensionId, entry.current);
    } catch (error) {
      skip("EXTENSION_MANAGED_POINTER_INVALID", `受管扩展 ${extensionId} 的版本指针非法：${error.message}`);
      continue;
    }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      skip("EXTENSION_MANAGED_VERSION_MISSING", `受管扩展 ${extensionId} 的版本目录缺失：${dir}；本次不装配（可在插件配置里回滚或重新安装）`, dir);
      continue;
    }
    const packageFile = path.join(dir, "package.json");
    let pkg = null;
    try {
      pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    } catch (error) {
      skip("EXTENSION_MANAGED_PACKAGE_INVALID", `受管扩展 ${extensionId} 的 package.json 无法读取：${error.message}`, dir);
      continue;
    }
    if (typeof pkg?.name !== "string" || !pkg.name.startsWith(EXTENSION_PACKAGE_PREFIX)) {
      skip("EXTENSION_MANAGED_PACKAGE_INVALID", `受管扩展 ${extensionId} 的包名必须以 ${EXTENSION_PACKAGE_PREFIX} 开头：${String(pkg?.name)}`, dir);
      continue;
    }
    let descriptor;
    let descriptorPath;
    try {
      ({ descriptor, descriptorPath } = readExtensionDescriptor(dir));
    } catch (error) {
      skip("EXTENSION_MANAGED_DESCRIPTOR_INVALID", error.message, dir);
      continue;
    }
    if (!descriptorPath || descriptor?.extensionId !== extensionId) {
      skip("EXTENSION_MANAGED_IDENTITY_MISMATCH", `受管扩展 ${extensionId} 的 extension.json 缺失或 extensionId 不一致（${String(descriptor?.extensionId)}）`, dir);
      continue;
    }
    records.push({
      extensionId,
      declaredId: extensionId,
      directory: `${extensionId}@${entry.current}`,
      dir,
      root: managedRoot,
      rootWritable: false,
      origin: "managed",
      managed: true,
      managedVersion: entry.current,
      managedSourceId: entry.sourceId,
      packageName: pkg.name,
      packageVersion: typeof pkg.version === "string" ? pkg.version : null,
      distributionVersion:
        typeof descriptor?.version === "string" && descriptor.version.trim() ? descriptor.version.trim() : entry.current,
      hasBackend: Boolean(descriptor?.backend || descriptor?.hostPlugin || descriptor?.metadata || (descriptor?.publicRoutes?.length ?? 0) > 0),
      hotSwappable: Boolean(descriptor?.hostPlugin),
      descriptorPath,
      hasBrowserEntry: hasBrowserEntry(dir)
    });
  }
  return records;
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
