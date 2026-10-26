/**
 * Extension 发布目录（release catalog）loader
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 4.1 / design D6）。
 *
 * 只从发布 HTML 登记的 `<link rel="woohaa-extension-release" href=...>` 读取目录地址；
 * MUST NOT 从 location query、localStorage、站点管理响应或用户配置寻找 URL。目录严格解码，
 * 校验同源/固定发布前缀、无 query/fragment、无路径穿越、ABI 与重复 ID。
 *
 * App 级缓存：同一 document 首次加载后固定 release；page transition 不重新请求。
 * 网络失败可重试同一 pinned URL；不在失败时跳到“最新 release”。
 */
import {
  decodeExtensionReleaseCatalog,
  isValidPublishedExtensionUrl,
  type ExtensionReleaseCatalog
} from "@woohaa3/contracts";
import { ExtensionLoadError } from "./loader.js";
import { appPublicUrl, stripAppLocationPathname } from "../services/app-base-path.js";

/** 发布 HTML 上的目录 link rel（发布方写入；唯一可信来源）。 */
export const EXTENSION_RELEASE_LINK_REL = "woohaa-extension-release";

/** 允许的发布资源前缀（同源、固定发布路径；design D6/D7）。 */
export const EXTENSION_RELEASE_PREFIX = "/extension-releases/";
export const EXTENSION_ARTIFACT_PREFIX = "/extensions/";

/** 从发布 HTML 读取目录地址；缺失/非法返回 null（不抛错，让调用方决定降级）。 */
export function readExtensionReleaseHref(doc: Document | undefined = (globalThis as { document?: Document }).document): string | null {
  if (!doc) return null;
  const link = doc.querySelector(`link[rel="${EXTENSION_RELEASE_LINK_REL}"]`) as HTMLLinkElement | null;
  const href = link?.getAttribute("href")?.trim() ?? "";
  if (!href) return null;
  // 发布 HTML 由宿主注入，可能带本页公开挂载前缀（dev 中间件/`base` 重写），而目录以固定发布
  // 逻辑前缀声明并在请求出口统一加前缀（design D6/D7）。这里先归一掉本页挂载前缀，既不放行
  // 越界地址，也避免把已带前缀的合法地址误判为「无目录」而禁用全部扩展。
  const logical = stripAppLocationPathname(href);
  if (!isValidPublishedExtensionUrl(logical)) return null;
  if (!logical.startsWith(EXTENSION_RELEASE_PREFIX)) return null;
  return logical;
}

export type ExtensionReleaseCatalogLoaderOptions = {
  /** 注入 fetch（测试）；缺省 globalThis.fetch。 */
  fetch?: typeof fetch;
  /** 注入 document（测试）；缺省 globalThis.document。 */
  document?: Document;
  /** 显式目录地址（dev/E2E 注入；生产缺省读 HTML link）。 */
  href?: string;
  logger?: (event: Record<string, unknown>) => void;
};

export type ExtensionReleaseCatalogLoader = {
  /**
   * 加载并固定 release 目录。首次成功后 App 级缓存；后续调用返回同一 Promise。
   * 目录缺失（HTML 无 link）返回 `null`（调用方视为无扩展能力，不禁用核心）。
   */
  load(): Promise<ExtensionReleaseCatalog | null>;
  /** 已固定的 releaseId（未加载为 null）。 */
  currentReleaseId(): string | null;
  /**
   * 改固定到另一个发布目录（change: 2026-10-21-harden-extension-fault-isolation，D6）：
   * 地址按 HTML link 同一规则校验，加载成功后才替换；失败保留原 release 不变。
   */
  repin(releaseHref: string): Promise<ExtensionReleaseCatalog>;
  /**
   * 只读取并校验另一个发布目录，**不**改变已固定的 release
   * （change: 2026-10-21-add-extension-marketplace-point，6.3：热登记只取新增条目）。
   */
  peek(releaseHref: string): Promise<ExtensionReleaseCatalog>;
  dispose(): void;
};

export function createExtensionReleaseCatalogLoader(
  options: ExtensionReleaseCatalogLoaderOptions = {}
): ExtensionReleaseCatalogLoader {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const log = options.logger ?? (() => undefined);
  let pending: Promise<ExtensionReleaseCatalog | null> | null = null;
  let releaseId: string | null = null;

  const resolveHref = (): string | null => {
    if (options.href) return options.href;
    const doc = options.document ?? (globalThis as { document?: Document }).document;
    return readExtensionReleaseHref(doc);
  };

  /** 显式 repin 后的目录地址；优先于 HTML link 与构造参数。 */
  let pinnedHref: string | null = null;

  const fetchCatalog = async (href: string): Promise<ExtensionReleaseCatalog> => {
    if (!isValidPublishedExtensionUrl(href) || !href.startsWith(EXTENSION_RELEASE_PREFIX)) {
      throw new ExtensionLoadError("invalid-catalog", "发布目录地址非法", false);
    }
    let response: Response;
    try {
      // 目录 href 是固定发布**逻辑**前缀；只在请求出口加一次公开挂载前缀。
      response = await doFetch(appPublicUrl(href), { credentials: "same-origin" });
    } catch {
      throw new ExtensionLoadError("network", "发布目录请求失败", true);
    }
    if (!response.ok) {
      throw new ExtensionLoadError("network", `发布目录返回 ${response.status}`, true);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ExtensionLoadError("invalid-catalog", "发布目录不是合法 JSON", false);
    }
    const decoded = decodeExtensionReleaseCatalog(body);
    if (!decoded.ok) {
      throw new ExtensionLoadError("invalid-catalog", `发布目录非法：${decoded.message}`, false);
    }
    // 同源/固定前缀的二次防线（解码已校验整体形态）。
    for (const entry of decoded.value.entries) {
      if (!entry.entryURL.startsWith(EXTENSION_ARTIFACT_PREFIX)) {
        throw new ExtensionLoadError("invalid-catalog", `artifact 地址前缀非法：${entry.entryURL}`, false);
      }
    }
    return decoded.value;
  };

  const loadOnce = async (): Promise<ExtensionReleaseCatalog | null> => {
    const href = pinnedHref ?? resolveHref();
    if (!href) {
      log({ event: "extension-release-catalog-absent" });
      return null;
    }
    const catalog = await fetchCatalog(href);
    releaseId = catalog.releaseId;
    log({ event: "extension-release-catalog-loaded", releaseId, entries: catalog.entries.length });
    return catalog;
  };

  return {
    load() {
      if (!pending) {
        // 失败时不缓存 rejected Promise：允许显式重试同一 pinned URL。
        pending = loadOnce().catch((error: unknown) => {
          pending = null;
          throw error;
        });
      }
      return pending;
    },
    currentReleaseId: () => releaseId,
    async repin(releaseHref) {
      const href = stripAppLocationPathname(releaseHref.trim());
      // 先完整加载并校验新目录，成功后才替换固定的 release；失败时原 release 保持不变。
      const catalog = await fetchCatalog(href);
      pinnedHref = href;
      releaseId = catalog.releaseId;
      pending = Promise.resolve(catalog);
      log({ event: "extension-release-catalog-repinned", releaseId, entries: catalog.entries.length });
      return catalog;
    },
    async peek(releaseHref) {
      return fetchCatalog(stripAppLocationPathname(releaseHref.trim()));
    },
    dispose() {
      pending = null;
      releaseId = null;
      pinnedHref = null;
    }
  };
}
