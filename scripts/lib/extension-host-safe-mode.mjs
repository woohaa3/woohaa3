/**
 * 安全模式（change: 2026-10-21-harden-extension-fault-isolation，D7）：判定哪些扩展照常装配，
 * 以及暂停扩展的占位登记。从 `extension-host.mjs` 拆出，行为不变。
 */
import fs from "node:fs";
import path from "node:path";

import { FALLBACK_ORDER } from "./extension-host-modules.mjs";

/**
 * 安全模式下仍装配的扩展（D7）：**非可写根**，且声明了 bootstrap 槽位实现或 `required`
 * （extension.json 顶层 `required`，或已构建 browser 产物 metadata 的 `required`）。
 *
 * 判定只读 JSON 声明，不执行扩展代码，也不认识具体扩展身份（extension-purity）。可写根扩展一律暂停：
 * 那是「放进目录就能生效」的位置，正是安全模式要隔离的对象。
 */
export function isSafeModeEssential(extension, descriptor) {
  if (extension.rootWritable === true) return false;
  // 受管扩展（市场安装）一律不是必需：它们不得声明 bootstrap / required（安装预检拒绝）。
  if (extension.managed === true) return false;
  if (descriptor?.bootstrap) return true;
  if (descriptor?.required === true) return true;
  return browserArtifactRequired(extension.dir);
}

function browserArtifactRequired(dir) {
  const manifestPath = path.join(dir, "browser-dist", "artifact-manifest.json");
  if (!fs.existsSync(manifestPath)) return false;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"))?.metadata?.required === true;
  } catch {
    // 损坏的产物不能把扩展升格为必需；正常启动时由发布目录校验报错。
    return false;
  }
}

/** 安全模式暂停扩展的占位登记：只有纯 JSON 的站点条目，没有任何可执行模块。 */
export function suspendedRegistration(extension, descriptor) {
  return {
    extensionId: extension.extensionId,
    directory: extension.dir,
    descriptor,
    descriptorPath: extension.descriptorPath,
    order: descriptor.backend?.order ?? descriptor.site?.order ?? FALLBACK_ORDER,
    metadataOrder: FALLBACK_ORDER,
    siteOrder: descriptor.site?.order ?? FALLBACK_ORDER,
    hostPluginOrder: FALLBACK_ORDER,
    canvasContentOrder: FALLBACK_ORDER,
    backend: null,
    hostPlugin: null,
    canvasContent: null,
    iconPath: null,
    metadataExport: null,
    metadataModule: null,
    publicRoutes: [],
    site: true,
    hasBrowserArtifact: false,
    suspended: true,
    modules: []
  };
}
