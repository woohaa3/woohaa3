/**
 * 站点应用插件前端可信清单（纯组装，不再构建期扫描）
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 1.2 / design D1/D5；
 *  change: 2026-10-10-unify-extension-frontend-entry，任务 3.1：曾改为扫描约定入口；
 *  change: 2026-10-12-build-and-load-extensions-independently，任务 4.6 / design D4/D6：
 *  **移除 eager glob**。生产业务入口不再由宿主构建期扫描/编译 extension 源码；它们由发布目录
 *  （`/extension-releases/<id>.json`）在运行时登记为异步 `loadDescriptor` 入口。
 *
 * 本模块只保留**纯组装/校验**：把已登记的入口（测试 fixture 或发布目录运行时投影）校验、去重并
 * 稳定排序。生产发现属发布装配（`scripts/assemble-extension-release.mjs`）与 App 级 runtime
 * service，不在宿主业务构建中。
 */
import type {
  ApplicationExtensionFrontendActivation,
  ApplicationExtensionFrontendEntry
} from "@woohaa3/contracts";

/** 校验单个入口的合法配置范围/激活策略/required 组合。 */
export function assertValidEntry(entry: ApplicationExtensionFrontendEntry): void {
  if (typeof entry.extensionId !== "string" || entry.extensionId === "") {
    throw new Error("前端插件入口 extensionId 必须是非空字符串");
  }
  if (entry.configScope !== "site" && entry.configScope !== "browser-local") {
    throw new Error(`未知的前端入口 configScope：${String(entry.configScope)}`);
  }
  if (entry.activation !== "always" && entry.activation !== "server-active" && entry.activation !== "browser-local") {
    throw new Error(`未知的前端入口 activation：${String(entry.activation)}`);
  }
  if (entry.configScope === "browser-local") {
    if (entry.activation !== "browser-local") {
      throw new Error(`browser-local 前端入口 activation 必须是 browser-local：${entry.extensionId}`);
    }
    if (entry.required === true) throw new Error(`browser-local 前端入口不得声明 required：${entry.extensionId}`);
  } else if (entry.activation === "browser-local") {
    throw new Error(`站点前端入口不得使用 browser-local activation：${entry.extensionId}`);
  }
  if (typeof entry.createPlugin !== "function") throw new Error(`前端入口缺少 createPlugin()：${entry.extensionId}`);
  if (entry.configScope === "browser-local" && entry.appPages && entry.appPages.length > 0) {
    throw new Error(`browser-local 前端入口不得声明 appPages：${entry.extensionId}`);
  }
  for (const page of entry.appPages ?? []) {
    if (page.extensionId !== entry.extensionId) throw new Error(`appPage owner 与入口不一致：${page.pageId}`);
    if (typeof page.pageId !== "string" || page.pageId === "") throw new Error("appPage 缺少 pageId");
    if (typeof page.path !== "string" || !page.path.startsWith("/")) throw new Error(`appPage path 必须以 / 开头：${page.pageId}`);
    if (page.createPlugin !== undefined && typeof page.createPlugin !== "function") {
      throw new Error(`appPage createPlugin 非法：${page.pageId}`);
    }
  }
}

/**
 * 组装并校验前端清单（显式注入）：
 * - 非空 identity、唯一 identity、合法元数据与入口形状；
 * - 稳定顺序（按 extensionId 排序）；
 * - 重复 identity 在任何业务装配前稳定失败。
 *
 * 生产不再有隐式扫描来源；调用方必须显式传入已登记入口（fixtures 或发布目录运行时投影）。
 */
export function createApplicationExtensionFrontendManifest(
  entries: readonly ApplicationExtensionFrontendEntry[]
): ApplicationExtensionFrontendEntry[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    assertValidEntry(entry);
    if (seen.has(entry.extensionId)) throw new Error(`前端清单含重复 extensionId：${entry.extensionId}`);
    seen.add(entry.extensionId);
  }
  return [...entries].sort((a, b) => (a.extensionId < b.extensionId ? -1 : a.extensionId > b.extensionId ? 1 : 0));
}

/** 空生产清单（宿主业务构建不在构建期发现 extension；运行时由发布目录登记）。 */
export const APPLICATION_EXTENSION_FRONTEND_ENTRIES: readonly ApplicationExtensionFrontendEntry[] = [];

export type { ApplicationExtensionFrontendActivation };
