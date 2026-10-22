/**
 * 通用 extension app/page registry
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 0.5/8.1 / design D10；
 *   2026-10-12 发布协议扩展：路由数据来自发布目录纯 metadata，`createPlugin` 来自运行时 descriptor）。
 *
 * 宿主 Router 只认识分支核心页（canvas / task-history / settings）与**通用** extension page：
 * 本模块把发布目录 metadata 与可信入口声明的 `appPages` 收集为唯一权威注册表，校验
 * pageId/path/旧路径全局唯一，并提供纯 route 解析与查询编解码。核心不出现任何业务 pageId 分支。
 *
 * 本批只落地纯路由 registry 与解析；extension page 的 page scope 装配未接通（需要第二扩展根，
 * 属后续批次），因此未注册路径仍沿用分支既有的 Canvas 回退。
 *
 * registry 只持有纯路由数据；`createPlugin`（若存在）来自可信入口，页面挂载时优先使用 registry
 * 携带的工厂，其次由 page scope 从发布目录 descriptor 按 pageId 补齐。
 */
import type { ApplicationExtensionFrontendEntry, ExtensionAppPageEntry, ExtensionAppPageQuery } from "@woohaa3/contracts";

export type { ExtensionAppPageEntry, ExtensionAppPageQuery };

/** 一个已登记的 extension page（owner 由入口 extensionId 绑定）。 */
export type RegisteredAppPage = ExtensionAppPageEntry;

/** registry 输入：页面贡献本身，或携带 `appPages` 的可信前端入口。 */
export type AppPageRegistryInput = ExtensionAppPageEntry | ApplicationExtensionFrontendEntry;

/** 把混合输入（页面或入口）规范化为页面列表。 */
function normalizeInput(input: readonly AppPageRegistryInput[]): ExtensionAppPageEntry[] {
  const pages: ExtensionAppPageEntry[] = [];
  for (const item of input) {
    if ("appPages" in item && Array.isArray(item.appPages)) {
      for (const page of item.appPages) pages.push(page);
    } else {
      pages.push(item as ExtensionAppPageEntry);
    }
  }
  return pages;
}

/** extension page 的解析结果：直接命中或旧路径 redirect。 */
export type AppPageRouteMatch =
  | { kind: "page"; page: RegisteredAppPage }
  | { kind: "legacy-redirect"; page: RegisteredAppPage; requestedPath: string };

/** 从可信前端入口（含 appPages）展开页面贡献。 */
export function appPagesOfEntries(entries: readonly ApplicationExtensionFrontendEntry[]): ExtensionAppPageEntry[] {
  return normalizeInput(entries);
}

/** 收集并校验所有页面贡献（稳定排序、唯一性）。 */
export function collectAppPages(pages: readonly ExtensionAppPageEntry[]): RegisteredAppPage[] {
  const byPageId = new Map<string, RegisteredAppPage>();
  const byPath = new Map<string, RegisteredAppPage>();
  const byLegacyPath = new Map<string, RegisteredAppPage>();
  for (const page of pages) {
    if (byPageId.has(page.pageId)) throw new Error(`extension page 含重复 pageId：${page.pageId}`);
    if (byPath.has(page.path)) throw new Error(`extension page 含重复 path：${page.path}`);
    byPageId.set(page.pageId, page);
    byPath.set(page.path, page);
    for (const legacy of page.legacyRedirectPaths ?? []) {
      if (legacy === page.path) throw new Error(`extension page 旧路径不得与 path 相同：${legacy}`);
      if (byPath.has(legacy) || byLegacyPath.has(legacy)) throw new Error(`extension page 含重复路径：${legacy}`);
      byLegacyPath.set(legacy, page);
    }
  }
  return [...pages].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 通用查询编解码缺省：只保留非空字符串参数（与各页面共享的规范化行为一致）。 */
function defaultDecodeQuery(search: URLSearchParams): ExtensionAppPageQuery {
  const out: Record<string, string> = {};
  for (const [key, value] of search.entries()) if (value !== "") out[key] = value;
  return out;
}
function defaultEncodeQuery(query: ExtensionAppPageQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== "") params.set(key, value);
  return params;
}

/** extension app/page 路由注册表。 */
export type AppPageRegistry = {
  /** 按 pathname 解析（含旧路径 redirect）；未知返回 null。 */
  match(pathname: string): AppPageRouteMatch | null;
  /** 按 pageId 取页面；未知返回 undefined。 */
  get(pageId: string): RegisteredAppPage | undefined;
  /** 全部已登记页面（稳定顺序）。 */
  list(): readonly RegisteredAppPage[];
  /** pageId → 规范路径。 */
  pathFor(pageId: string): string | undefined;
  /** 解码已应用查询（未知/无效参数规范化，不读取任意资源）。 */
  decodeQuery(pageId: string, search: string): ExtensionAppPageQuery;
  /** 编码已应用查询为稳定 search 串（不含 `?`）。 */
  encodeQuery(pageId: string, query: ExtensionAppPageQuery): string;
};

/** 规范化 pathname（去掉末尾 `/`，保留根 `/`）。 */
export function normalizePathname(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/**
 * 由页面贡献构造 registry（纯路由数据，可选自带 createPlugin）。
 * 重复 pageId/path/旧路径在构造期稳定失败。
 */
export function createAppPageRegistry(input: readonly AppPageRegistryInput[]): AppPageRegistry {
  const collected = collectAppPages(normalizeInput(input));
  const byPageId = new Map(collected.map((page) => [page.pageId, page]));
  const byPath = new Map(collected.map((page) => [page.path, page]));
  const byLegacyPath = new Map<string, RegisteredAppPage>();
  for (const page of collected) {
    for (const legacy of page.legacyRedirectPaths ?? []) byLegacyPath.set(legacy, page);
  }
  return {
    match(pathname) {
      const normalized = normalizePathname(pathname);
      const direct = byPath.get(normalized);
      if (direct) return { kind: "page", page: direct };
      const legacy = byLegacyPath.get(normalized);
      if (legacy) return { kind: "legacy-redirect", page: legacy, requestedPath: normalized };
      return null;
    },
    get: (pageId) => byPageId.get(pageId),
    list: () => collected,
    pathFor: (pageId) => byPageId.get(pageId)?.path,
    decodeQuery(pageId, search) {
      const page = byPageId.get(pageId);
      const decode = page?.decodeQuery ?? defaultDecodeQuery;
      try {
        return decode(new URLSearchParams(search));
      } catch {
        return {};
      }
    },
    encodeQuery(pageId, query) {
      const page = byPageId.get(pageId);
      const encode = page?.encodeQuery ?? defaultEncodeQuery;
      const params = encode(query);
      return params.toString();
    }
  };
}

/** 空 registry（非 Vite/测试未注入时的确定性缺省）。 */
export const EMPTY_APP_PAGE_REGISTRY: AppPageRegistry = createAppPageRegistry([]);
