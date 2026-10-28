/**
 * Extension 浏览器产物 / 发布目录 / 加载诊断契约
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 1.1 / design D4/D5/D6/D10）。
 *
 * 本模块是**部署协议**的纯数据契约：extensionId、纯 metadata、artifact manifest、发布 release
 * 目录与加载错误码。它与**管理协议**（`manifest.ts` 的可信元数据 DTO）分离：
 *
 * - 管理配置（用户/管理员可编辑）继续只引用稳定 extensionId，MUST NOT 携带模块地址；
 * - 部署协议由发布方生成，是唯一允许携带同源资源地址的地方；地址必须经严格校验
 *   （同源、固定前缀、无 query/fragment、无路径穿越），且不来自 query/localStorage/管理响应。
 *
 * 与 `frontend-runtime.ts` 一样，Cordis 仅 **type-only** 引用；本模块不打包、不运行 Cordis，
 * 不 import React/DOM/宿主实现，可在浏览器或 Node 构建工具中安全加载。
 */
import type { Plugin } from "@deepseek-ai/cordis";
import type {
  ApplicationExtensionFrontendActivation,
  ApplicationExtensionFrontendConfigScope,
  ApplicationExtensionFrontendEntry
} from "./frontend-runtime.js";
import { isBoundedId, isJsonObject, isNonEmptyString, isNonNegativeInteger } from "../../validation.js";
import { isPluginIcon, type PluginIcon } from "../../plugin-icon.js";
import { isAccessAction } from "./access.js";
import type { ExtensionAppPageMetadata, ExtensionAppPageRuntime } from "./app-page.js";

export type { ApplicationExtensionFrontendEntry };

/** 浏览器扩展产物协议版本（schema 变更必须升版并保持旧值可辨认）。 */
export const EXTENSION_BROWSER_PROTOCOL_VERSION = 1 as const;

/**
 * 宿主公开 SDK 的 ABI 版本。首版使用**精确整数匹配**（design D2）：不做未经实现验证的
 * semver 兼容推断。同 ABI 内新增兼容导出可以新增清单需求；旧宿主缺失时拒绝激活。
 * 任何破坏性 ABI 变更（删除/改名导出、改变 React/JSX 模式、改变分组成员）必须 +1。
 */
export const EXTENSION_SDK_ABI_VERSION = 1 as const;

/** SDK 能力分组（design D2）。builder 不允许用私有文件路径绕过公共入口。 */
export const EXTENSION_SDK_GROUPS = ["core", "ui", "model", "authoring"] as const;
export type ExtensionSdkGroup = (typeof EXTENSION_SDK_GROUPS)[number];

/** 宿主当前 React major；artifact 声明的 React major 必须精确匹配。 */
export const HOST_REACT_MAJOR = 18 as const;

/**
 * 纯 extension metadata（`src/frontend/metadata.ts` 的约定导出形状）。
 *
 * 只含 JSON 可序列化数据：稳定 extensionId、version、label、description、activation、
 * configScope、required 与 SDK ABI。MUST NOT 引用 plugin/UI/CSS/业务 store 或后端校验实现。
 *
 * `appPages`（可选）是本扩展贡献的**纯路由元数据**：宿主 Router 在扩展实现加载前即可登记
 * 页面路径与资格。可执行页面入口（`createPlugin`）只随运行时 descriptor 提供，不进 metadata。
 */
export type ExtensionFrontendMetadata = {
  /** 部署侧提供的所在目录，仅用于展示。 */
  directory?: string;
  extensionId: string;
  version: string;
  label: string;
  description: string;
  /** 设置页插件卡片上的图标：语义图形名（`PLUGIN_ICON_NAMES`）或品牌图形路径；缺省显示通用插件图标。 */
  icon?: PluginIcon;
  activation: ApplicationExtensionFrontendActivation;
  configScope: ApplicationExtensionFrontendConfigScope;
  required: boolean;
  sdkAbi: number;
  /** 本扩展贡献的纯 app/page 路由元数据（可选；仅站点入口可声明）。 */
  appPages?: readonly ExtensionAppPageMetadata[];
  /**
   * 扩展前端自带设置面板（可选）：设置弹窗「插件详情」会加载本扩展前端，并渲染它经
   * `settings.plugin-config` slot 贡献的面板。设置因此按需加载这些扩展资源，其余扩展不加载。
   *
   * 若该扩展未激活，宿主可经 descriptor 的可选 `settingsPlugin()` 只装配设置贡献
   * （change: 2026-10-17-move-settings-into-canvas-dialog）；旧 artifact 没有该入口时只复用已存在
   * 的贡献，不执行完整业务 plugin。
   */
  settingsPanel?: boolean;
};

/** artifact 中单个输出文件的分类统计（design D5）。 */
export const EXTENSION_BROWSER_FILE_KINDS = [
  "entry",
  "implementation",
  "private-chunk",
  "style",
  "asset",
  "sourcemap"
] as const;
export type ExtensionBrowserFileKind = (typeof EXTENSION_BROWSER_FILE_KINDS)[number];

export type ExtensionBrowserFile = {
  /** 相对 artifact 根目录的 POSIX 路径；MUST NOT 以 `/` 开头或含 `..`。 */
  path: string;
  bytes: number;
  gzipBytes: number;
  /** 小写十六进制 SHA-256。 */
  sha256: string;
  kind: ExtensionBrowserFileKind;
};

/**
 * artifact 内一条静态/动态 import 边（design D5：完整依赖图证据）。
 *
 * `from` 必须是 files 中的相对路径；`resolved` 为内部 chunk 的相对路径，
 * 外部/bare 依赖为 `null` 并在发布装配时拒绝（browser 产物只允许相对 ESM）。
 * 由构建器从打包器 metafile 生成，不用文本正则推断，避免误判字符串字面量。
 */
export type ExtensionBrowserImport = {
  from: string;
  /** 原始说明符（用于诊断）。 */
  specifier: string;
  /** 内部目标相对路径；外部依赖为 null。 */
  resolved: string | null;
};

/**
 * 单 extension browser artifact manifest（`browser-dist/artifact-manifest.json`）。
 *
 * `artifactId` 从全部输出文件内容及规范化 metadata/ABI 要求确定性计算，manifest 自身不递归
 * 参与 hash；可复现性不依赖生成时间或绝对 workspace 路径（design D5）。
 */
export type ExtensionBrowserArtifactManifest = {
  schemaVersion: typeof EXTENSION_BROWSER_PROTOCOL_VERSION;
  artifactId: string;
  metadata: ExtensionFrontendMetadata;
  protocolVersion: number;
  sdkAbi: number;
  reactMajor: number;
  /** 薄 activation 入口相对路径（相对 artifact 根）。 */
  entry: string;
  /** 完整样式表相对路径（首期每个 artifact 汇总一份 stylesheet）。 */
  styles: string[];
  requiredSdkGroups: ExtensionSdkGroup[];
  requiredSdkExports: string[];
  files: ExtensionBrowserFile[];
  /** 每条内部/外部 import 边的依赖图证据（相对 ESM 完整性校验用）。 */
  imports: ExtensionBrowserImport[];
};

/** 发布目录中的一个 entry：metadata + 定位资源所需的同源地址（design D6）。 */
export type ExtensionBrowserReleaseEntry = {
  metadata: ExtensionFrontendMetadata;
  artifactId: string;
  /** 同源、固定 `/extensions/<id>/<artifactId>/...` 前缀、无 query/fragment。 */
  entryURL: string;
  styleURLs: string[];
  protocolVersion: number;
  sdkAbi: number;
  reactMajor: number;
  requiredSdkGroups: ExtensionSdkGroup[];
  requiredSdkExports: string[];
};

/**
 * 发布目录（`/extension-releases/<releaseId>.json`）。
 *
 * HTML 通过发布脚本写入 `<link rel="woohaa-extension-release" href="...">`；loader 只接受该
 * 发布方提供的目录地址。`releaseId` 基于 canonical manifest 内容计算。
 */
export type ExtensionReleaseCatalog = {
  schemaVersion: typeof EXTENSION_BROWSER_PROTOCOL_VERSION;
  releaseId: string;
  hostSdkAbi: number;
  entries: ExtensionBrowserReleaseEntry[];
};

/** 加载/安装状态（design D10）：分别对应未请求、禁用、资源准备等阶段。 */
export const EXTENSION_LOAD_STATUSES = [
  "registered",
  "disabled",
  "loading",
  "load-failed",
  "waiting",
  "active",
  "failed",
  "unloading",
  "disposed"
] as const;
export type ExtensionLoadStatus = (typeof EXTENSION_LOAD_STATUSES)[number];

/** 加载错误分类（design D7/D9/D10）。 */
export const EXTENSION_LOAD_ERROR_CODES = [
  "catalog-unavailable",
  "invalid-catalog",
  "invalid-artifact",
  "network",
  "css",
  "timeout",
  "evaluation",
  "abi",
  "descriptor",
  "binding-conflict",
  "fiber"
] as const;
export type ExtensionLoadErrorCode = (typeof EXTENSION_LOAD_ERROR_CODES)[number];

/** 可公开加载诊断（不含 handler payload/凭据）；供 Plugin Manager/诊断面板消费。 */
export type ExtensionLoadDiagnostic = {
  extensionId: string;
  status: ExtensionLoadStatus;
  artifactId: string | null;
  releaseId: string | null;
  errorCode: ExtensionLoadErrorCode | null;
  /** 安全文案（不回显资源 URL、payload 或凭据）。 */
  message: string | null;
};

export type ExtensionBrowserDecodeResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

function fail(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

const HEX_64 = /^[0-9a-f]{64}$/;

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && HEX_64.test(value);
}

/** 相对 POSIX 路径：非空、不以 `/` 开头、无 `\`、无 `..` 段、无 query/fragment。 */
function isSafeRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  if (value.includes("?") || value.includes("#")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * 同源发布资源地址：以固定前缀开头的绝对路径，无 query/fragment，无路径穿越。
 * loader 只用发布 HTML link 指定的目录；此校验保证目录内容不会指向外部/任意地址。
 */
export function isValidPublishedExtensionUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false; // 协议相对：跨源
  if (value.includes("?") || value.includes("#")) return false;
  if (value.includes("\\")) return false;
  const segments = value.split("/").slice(1);
  return segments.length > 0 && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function readSdkGroups(raw: unknown): ExtensionBrowserDecodeResult<ExtensionSdkGroup[]> {
  if (!Array.isArray(raw)) return fail("malformed", "requiredSdkGroups 必须是数组");
  const out: ExtensionSdkGroup[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!EXTENSION_SDK_GROUPS.includes(entry as never)) {
      return fail("malformed", `未知 SDK 分组：${String(entry)}`);
    }
    if (seen.has(entry as string)) return fail("malformed", `SDK 分组重复：${entry}`);
    seen.add(entry as string);
    out.push(entry as ExtensionSdkGroup);
  }
  return { ok: true, value: out };
}

function readSdkExports(raw: unknown): ExtensionBrowserDecodeResult<string[]> {
  if (!Array.isArray(raw)) return fail("malformed", "requiredSdkExports 必须是数组");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isBoundedId(entry)) return fail("malformed", "requiredSdkExports 含非法导出名");
    if (seen.has(entry)) return fail("malformed", `SDK 导出需求重复：${entry}`);
    seen.add(entry);
    out.push(entry);
  }
  return { ok: true, value: out };
}

function readAppPageMetadata(raw: unknown, index: number): ExtensionBrowserDecodeResult<ExtensionAppPageMetadata> {
  if (!isJsonObject(raw)) return fail("malformed", `appPages[${index}] 必须是对象`);
  if (!isBoundedId(raw.pageId)) return fail("malformed", `appPages[${index}].pageId 非法`);
  if (!isNonEmptyString(raw.path) || !raw.path.startsWith("/")) {
    return fail("malformed", `appPages[${index}].path 必须以 / 开头`);
  }
  if (raw.legacyRedirectPaths !== undefined) {
    if (!Array.isArray(raw.legacyRedirectPaths)) return fail("malformed", `appPages[${index}].legacyRedirectPaths 必须是数组`);
    for (const legacy of raw.legacyRedirectPaths) {
      if (!isNonEmptyString(legacy) || !legacy.startsWith("/")) {
        return fail("malformed", `appPages[${index}].legacyRedirectPaths 必须以 / 开头`);
      }
    }
  }
  if (typeof raw.requiresAuth !== "boolean") return fail("malformed", `appPages[${index}].requiresAuth 必须是布尔值`);
  if (raw.requiredActions !== undefined) {
    if (!Array.isArray(raw.requiredActions)) return fail("malformed", `appPages[${index}].requiredActions 必须是数组`);
    for (const action of raw.requiredActions) {
      if (!isAccessAction(action)) return fail("malformed", `appPages[${index}].requiredActions 含未知 action`);
    }
  }
  if (raw.title !== undefined && !isNonEmptyString(raw.title)) return fail("malformed", `appPages[${index}].title 非法`);
  return {
    ok: true,
    value: {
      pageId: raw.pageId,
      path: raw.path,
      ...(raw.legacyRedirectPaths !== undefined ? { legacyRedirectPaths: raw.legacyRedirectPaths as string[] } : {}),
      requiresAuth: raw.requiresAuth,
      ...(raw.requiredActions !== undefined ? { requiredActions: raw.requiredActions as import("./access.js").AccessAction[] } : {}),
      ...(raw.title !== undefined ? { title: raw.title as string } : {})
    }
  };
}

/** 站点入口的纯路由贡献：重复 pageId/路径在解码期稳定失败。 */
function readAppPagesMetadata(raw: unknown): ExtensionBrowserDecodeResult<ExtensionAppPageMetadata[]> {
  if (!Array.isArray(raw)) return fail("malformed", "appPages 必须是数组");
  const out: ExtensionAppPageMetadata[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const decoded = readAppPageMetadata(entry, index);
    if (!decoded.ok) return decoded;
    if (seenIds.has(decoded.value.pageId)) return fail("malformed", `appPages 含重复 pageId：${decoded.value.pageId}`);
    seenIds.add(decoded.value.pageId);
    for (const path of [decoded.value.path, ...(decoded.value.legacyRedirectPaths ?? [])]) {
      if (seenPaths.has(path)) return fail("malformed", `appPages 含重复路径：${path}`);
      seenPaths.add(path);
    }
    out.push(decoded.value);
  }
  return { ok: true, value: out };
}

function readMetadata(raw: unknown): ExtensionBrowserDecodeResult<ExtensionFrontendMetadata> {
  if (!isJsonObject(raw)) return fail("malformed", "metadata 必须是对象");
  if (!isBoundedId(raw.extensionId)) return fail("malformed", "metadata.extensionId 非法");
  if (!isNonEmptyString(raw.version)) return fail("malformed", "metadata.version 非法");
  if (!isNonEmptyString(raw.label)) return fail("malformed", "metadata.label 非法");
  if (!isNonEmptyString(raw.description)) return fail("malformed", "metadata.description 非法");
  if (raw.directory !== undefined && !isNonEmptyString(raw.directory)) return fail("malformed", "metadata.directory 非法");
  if (raw.icon !== undefined && !isPluginIcon(raw.icon)) {
    return fail("malformed", "metadata.icon 既不是插件图标名，也不是 /plugin-icons/ 下的品牌图形路径");
  }
  if (raw.activation !== "always" && raw.activation !== "server-active" && raw.activation !== "browser-local") {
    return fail("malformed", "metadata.activation 非法");
  }
  if (raw.configScope !== "site" && raw.configScope !== "browser-local") {
    return fail("malformed", "metadata.configScope 非法");
  }
  if (typeof raw.required !== "boolean") return fail("malformed", "metadata.required 必须是布尔值");
  if (!isNonNegativeInteger(raw.sdkAbi)) return fail("malformed", "metadata.sdkAbi 非法");
  if (raw.settingsPanel !== undefined && typeof raw.settingsPanel !== "boolean") {
    return fail("malformed", "metadata.settingsPanel 必须是布尔值");
  }
  if (raw.configScope === "browser-local" && raw.required === true) {
    return fail("malformed", "browser-local extension 不得声明 required");
  }
  if (raw.configScope === "site" && raw.activation === "browser-local") {
    return fail("malformed", "站点 extension 不得使用 browser-local activation");
  }
  if (raw.configScope === "browser-local" && raw.activation !== "browser-local") {
    return fail("malformed", "browser-local extension activation 必须是 browser-local");
  }
  let appPages: ExtensionAppPageMetadata[] | undefined;
  if (raw.appPages !== undefined) {
    // 纯前端可选入口不得贡献站点页面；只有站点入口能声明 appPages。
    if (raw.configScope === "browser-local") {
      return fail("malformed", "browser-local extension 不得声明 appPages");
    }
    const decoded = readAppPagesMetadata(raw.appPages);
    if (!decoded.ok) return decoded;
    if (decoded.value.length > 0) appPages = decoded.value;
  }
  return {
    ok: true,
    value: {
      extensionId: raw.extensionId,
      version: raw.version,
      label: raw.label,
      description: raw.description,
      ...(raw.directory !== undefined ? { directory: raw.directory } : {}),
      ...(raw.icon !== undefined ? { icon: raw.icon } : {}),
      activation: raw.activation,
      configScope: raw.configScope,
      required: raw.required,
      sdkAbi: raw.sdkAbi,
      ...(appPages ? { appPages } : {}),
      ...(raw.settingsPanel !== undefined ? { settingsPanel: raw.settingsPanel } : {})
    }
  };
}

function readFiles(raw: unknown): ExtensionBrowserDecodeResult<ExtensionBrowserFile[]> {
  if (!Array.isArray(raw)) return fail("malformed", "files 必须是数组");
  const out: ExtensionBrowserFile[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (!isJsonObject(entry)) return fail("malformed", `files[${index}] 必须是对象`);
    if (!isSafeRelativePath(entry.path)) return fail("malformed", `files[${index}].path 非法`);
    if (seen.has(entry.path)) return fail("malformed", `files 含重复 path：${entry.path}`);
    seen.add(entry.path);
    if (!isNonNegativeInteger(entry.bytes)) return fail("malformed", `files[${index}].bytes 非法`);
    if (!isNonNegativeInteger(entry.gzipBytes)) return fail("malformed", `files[${index}].gzipBytes 非法`);
    if (!isSha256Hex(entry.sha256)) return fail("malformed", `files[${index}].sha256 非法`);
    if (!EXTENSION_BROWSER_FILE_KINDS.includes(entry.kind as never)) {
      return fail("malformed", `files[${index}].kind 非法`);
    }
    out.push({
      path: entry.path,
      bytes: entry.bytes,
      gzipBytes: entry.gzipBytes,
      sha256: entry.sha256,
      kind: entry.kind as ExtensionBrowserFileKind
    });
  }
  return { ok: true, value: out };
}

function readImports(raw: unknown): ExtensionBrowserDecodeResult<ExtensionBrowserImport[]> {
  if (!Array.isArray(raw)) return fail("malformed", "imports 必须是数组");
  const out: ExtensionBrowserImport[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isJsonObject(entry)) return fail("malformed", `imports[${index}] 必须是对象`);
    if (!isSafeRelativePath(entry.from)) return fail("malformed", `imports[${index}].from 非法`);
    if (!isNonEmptyString(entry.specifier)) return fail("malformed", `imports[${index}].specifier 非法`);
    if (entry.resolved !== null && !isSafeRelativePath(entry.resolved)) {
      return fail("malformed", `imports[${index}].resolved 非法`);
    }
    out.push({
      from: entry.from,
      specifier: entry.specifier,
      resolved: entry.resolved === null ? null : entry.resolved
    });
  }
  return { ok: true, value: out };
}

/**
 * 严格解码 artifact manifest。拒绝未知/非法字段、路径穿越与不一致的 identity/ABI。
 * 这是 loader 侧的运行时防线；builder 侧另有构建期校验。
 */
export function decodeExtensionBrowserArtifactManifest(raw: unknown): ExtensionBrowserDecodeResult<ExtensionBrowserArtifactManifest> {
  if (!isJsonObject(raw)) return fail("malformed", "artifact manifest 必须是对象");
  if (raw.schemaVersion !== EXTENSION_BROWSER_PROTOCOL_VERSION) return fail("malformed", "schemaVersion 不兼容");
  if (!isSha256Hex(raw.artifactId)) return fail("malformed", "artifactId 必须是 sha256 十六进制");
  if (raw.protocolVersion !== EXTENSION_BROWSER_PROTOCOL_VERSION) return fail("malformed", "protocolVersion 不兼容");
  if (!isNonNegativeInteger(raw.sdkAbi)) return fail("malformed", "sdkAbi 非法");
  if (!isNonNegativeInteger(raw.reactMajor)) return fail("malformed", "reactMajor 非法");
  if (!isSafeRelativePath(raw.entry)) return fail("malformed", "entry 非法");
  const metadata = readMetadata(raw.metadata);
  if (!metadata.ok) return metadata;
  if (!Array.isArray(raw.styles) || !raw.styles.every(isSafeRelativePath)) {
    return fail("malformed", "styles 非法");
  }
  const groups = readSdkGroups(raw.requiredSdkGroups);
  if (!groups.ok) return groups;
  const exports = readSdkExports(raw.requiredSdkExports);
  if (!exports.ok) return exports;
  const files = readFiles(raw.files);
  if (!files.ok) return files;
  const imports = readImports(raw.imports);
  if (!imports.ok) return imports;

  // entry 与 styles 必须出现在 files 中（防止清单声明了不存在的资源）。
  const paths = new Set(files.value.map((file) => file.path));
  if (!paths.has(raw.entry)) return fail("malformed", "entry 不在 files 中");
  for (const style of raw.styles) {
    if (!paths.has(style)) return fail("malformed", `style 不在 files 中：${style}`);
  }
  if (metadata.value.sdkAbi !== raw.sdkAbi) return fail("malformed", "metadata.sdkAbi 与 manifest.sdkAbi 不一致");
  // 依赖图：每条 from 都在 files 中；内部 resolved 目标也在 files 中；外部依赖一律拒绝。
  for (const [index, edge] of imports.value.entries()) {
    if (!paths.has(edge.from)) return fail("malformed", `imports[${index}].from 不在 files 中`);
    if (edge.resolved === null) {
      return fail("malformed", `artifact 残留外部依赖：${edge.from} -> ${edge.specifier}`);
    }
    if (!paths.has(edge.resolved)) return fail("malformed", `imports[${index}].resolved 不在 files 中`);
  }

  return {
    ok: true,
    value: {
      schemaVersion: EXTENSION_BROWSER_PROTOCOL_VERSION,
      artifactId: raw.artifactId,
      metadata: metadata.value,
      protocolVersion: EXTENSION_BROWSER_PROTOCOL_VERSION,
      sdkAbi: raw.sdkAbi,
      reactMajor: raw.reactMajor,
      entry: raw.entry,
      styles: [...raw.styles],
      requiredSdkGroups: groups.value,
      requiredSdkExports: exports.value,
      files: files.value,
      imports: imports.value
    }
  };
}

function readReleaseEntry(raw: unknown, index: number): ExtensionBrowserDecodeResult<ExtensionBrowserReleaseEntry> {
  if (!isJsonObject(raw)) return fail("malformed", `entries[${index}] 必须是对象`);
  const metadata = readMetadata(raw.metadata);
  if (!metadata.ok) return metadata;
  if (!isSha256Hex(raw.artifactId)) return fail("malformed", `entries[${index}].artifactId 必须是 sha256 十六进制`);
  if (!isValidPublishedExtensionUrl(raw.entryURL)) return fail("malformed", `entries[${index}].entryURL 非法`);
  if (!Array.isArray(raw.styleURLs) || !raw.styleURLs.every(isValidPublishedExtensionUrl)) {
    return fail("malformed", `entries[${index}].styleURLs 非法`);
  }
  if (!isNonNegativeInteger(raw.protocolVersion)) return fail("malformed", `entries[${index}].protocolVersion 非法`);
  if (!isNonNegativeInteger(raw.sdkAbi)) return fail("malformed", `entries[${index}].sdkAbi 非法`);
  if (!isNonNegativeInteger(raw.reactMajor)) return fail("malformed", `entries[${index}].reactMajor 非法`);
  const groups = readSdkGroups(raw.requiredSdkGroups);
  if (!groups.ok) return groups;
  const exports = readSdkExports(raw.requiredSdkExports);
  if (!exports.ok) return exports;
  if (metadata.value.sdkAbi !== raw.sdkAbi) {
    return fail("malformed", `entries[${index}] metadata.sdkAbi 与 entry.sdkAbi 不一致`);
  }
  return {
    ok: true,
    value: {
      metadata: metadata.value,
      artifactId: raw.artifactId,
      entryURL: raw.entryURL,
      styleURLs: [...raw.styleURLs],
      protocolVersion: raw.protocolVersion,
      sdkAbi: raw.sdkAbi,
      reactMajor: raw.reactMajor,
      requiredSdkGroups: groups.value,
      requiredSdkExports: exports.value
    }
  };
}

/**
 * 严格解码发布目录：schema/ABI 兼容、同源地址、重复 ID/artifactId 拒绝。
 * 目录缺失或非法属于 `invalid-catalog`，不应被当作“无扩展”静默通过（design D6/D10）。
 */
export function decodeExtensionReleaseCatalog(raw: unknown): ExtensionBrowserDecodeResult<ExtensionReleaseCatalog> {
  if (!isJsonObject(raw)) return fail("malformed", "release catalog 必须是对象");
  if (raw.schemaVersion !== EXTENSION_BROWSER_PROTOCOL_VERSION) return fail("malformed", "schemaVersion 不兼容");
  if (!isSha256Hex(raw.releaseId)) return fail("malformed", "releaseId 必须是 sha256 十六进制");
  if (!isNonNegativeInteger(raw.hostSdkAbi)) return fail("malformed", "hostSdkAbi 非法");
  if (!Array.isArray(raw.entries)) return fail("malformed", "entries 必须是数组");
  const entries: ExtensionBrowserReleaseEntry[] = [];
  const seenIds = new Set<string>();
  const seenArtifacts = new Set<string>();
  for (const [index, entry] of raw.entries.entries()) {
    const decoded = readReleaseEntry(entry, index);
    if (!decoded.ok) return decoded;
    if (seenIds.has(decoded.value.metadata.extensionId)) {
      return fail("malformed", `release 含重复 extensionId：${decoded.value.metadata.extensionId}`);
    }
    seenIds.add(decoded.value.metadata.extensionId);
    if (seenArtifacts.has(decoded.value.artifactId)) {
      return fail("malformed", `release 含重复 artifactId：${decoded.value.artifactId}`);
    }
    seenArtifacts.add(decoded.value.artifactId);
    entries.push(decoded.value);
  }
  return {
    ok: true,
    value: {
      schemaVersion: EXTENSION_BROWSER_PROTOCOL_VERSION,
      releaseId: raw.releaseId,
      hostSdkAbi: raw.hostSdkAbi,
      entries
    }
  };
}

/** 判定 artifact 的 ABI/React 是否与当前宿主兼容（在实现求值前调用；design D2）。 */
export function isArtifactCompatibleWithHost(
  entry: Pick<ExtensionBrowserReleaseEntry, "sdkAbi" | "reactMajor" | "protocolVersion">,
  host: { sdkAbi: number; reactMajor: number } = { sdkAbi: EXTENSION_SDK_ABI_VERSION, reactMajor: HOST_REACT_MAJOR }
): boolean {
  return (
    entry.protocolVersion === EXTENSION_BROWSER_PROTOCOL_VERSION &&
    entry.sdkAbi === host.sdkAbi &&
    entry.reactMajor === host.reactMajor
  );
}

/** 从 metadata 投影现有管理 registry 的入口摘要（纯数据；不含实现）。 */
export function metadataToEntrySummary(metadata: ExtensionFrontendMetadata): {
  extensionId: string;
  configScope: ApplicationExtensionFrontendConfigScope;
  activation: ApplicationExtensionFrontendActivation;
} {
  return {
    extensionId: metadata.extensionId,
    configScope: metadata.configScope,
    activation: metadata.activation
  };
}

/**
 * 从发布目录纯 metadata 投影 AppPage registry 条目（2026-10-12 发布协议扩展）。
 *
 * owner extensionId 由 metadata 绑定；`createPlugin` 不在 metadata 中，由 page scope 在挂载时
 * 经 descriptor 的 `appPages` 补齐。核心只消费纯数据路由，不硬编码任何业务 pageId。
 */
export function metadataToAppPageEntries(
  metadata: readonly ExtensionFrontendMetadata[]
): import("./app-page.js").ExtensionAppPageEntry[] {
  const out: import("./app-page.js").ExtensionAppPageEntry[] = [];
  for (const entry of metadata) {
    for (const page of entry.appPages ?? []) {
      out.push({ ...page, extensionId: entry.extensionId });
    }
  }
  return out;
}

/**
 * 宿主注入扩展的 runtime bindings（design D1/D2）。
 *
 * 只含 app-level 不可变、可跨 scope 复用的**运行时引用**：当前 App runtime 稳定 token、
 * SDK ABI、宿主实际 React / `react/jsx-runtime` 导出与按需准备的 SDK 具名导出 map。
 * MUST NOT 包含 page Context、store、canvasId、凭据或业务 service 实例——这些仍由当前
 * Cordis scope 注入（`ctx.*`）。
 */
export type ExtensionRuntimeBindings = {
  /** 当前 document 的 App runtime 稳定 token（不序列化、不跨浏览器）。 */
  token: object;
  sdkAbi: number;
  react: object;
  jsxRuntime: object;
  /**
   * 宿主实际的 `react-dom` / `react-dom/client` 导出。扩展内联的第三方 UI 库（如 antd）依赖 react-dom，
   * 它必须与宿主共用同一份 React 内部状态，否则实现在加载阶段就会失败，因此绝不另打包第二份。
   */
  reactDom: object;
  reactDomClient: object;
  sdk: Readonly<Record<string, unknown>>;
};

/** artifact 薄入口导出的实现 descriptor：metadata identity + 无副作用 plugin 工厂。 */
export type ExtensionBrowserDescriptor = {
  extensionId: string;
  configScope?: ApplicationExtensionFrontendConfigScope;
  activation?: ApplicationExtensionFrontendActivation;
  required?: boolean;
  label?: string;
  description?: string;
  plugin: () => Plugin;
  /**
   * 设置专用工厂（可选；change: 2026-10-17-move-settings-into-canvas-dialog，任务 5.1/5.2）。
   *
   * 只构造 `settings.plugin-config` 设置面板所需的贡献，MUST NOT 启动生成入口、画布事件、
   * 业务轮询或任务执行。宿主仅在设置打开时、且该扩展未激活时调用；缺少本字段的旧 artifact
   * 只复用已存在的贡献，不回退执行完整 `plugin()`。
   */
  settingsPlugin?: () => Plugin;
  /**
   * 本扩展的 app/page **运行时入口**（2026-10-12 发布协议扩展）。
   *
   * 与 `metadata.appPages`（纯路由数据，随发布目录）按 pageId 关联：Router 用 metadata 解析
   * 路径，page scope 用这里的 `createPlugin` 装配页面。缺省表示本扩展不贡献独立页面。
   */
  appPages?: readonly ExtensionAppPageRuntime[];
};

/** 薄 activation 入口的导出形状：先绑定 runtime，返回无业务副作用的 descriptor。 */
export type ExtensionBrowserModule = {
  loadExtension(bindings: ExtensionRuntimeBindings): Promise<{ descriptor: ExtensionBrowserDescriptor }>;
};
