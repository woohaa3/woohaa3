/**
 * 浏览器挂载路径解析器
 * （change: 2026-10-15-support-configurable-app-base-path，design D2/D3/D5）。
 *
 * 启动时从宿主注入的公开元数据读取一次挂载路径，随后固定用于整个页面生命周期（只读部署上下文）。
 * 所有「逻辑路径 → 公开 URL」的映射都必须经本模块，且只在明确的传输/展示出口发生一次：
 * 应用内部（DTO、route、持久化媒体引用、扩展清单 identity）始终保持逻辑路径，不含部署前缀。
 *
 * 页面加载后再改挂载配置需要刷新页面（本模块不监听运行期变化）。
 */
import {
  addAppBasePath,
  appBasePathPrefix,
  normalizeAppBasePath,
  stripAppBasePath,
  APP_BASE_PATH_META,
  type AppBasePathNormalization
} from "@woohaa3/contracts";

/** 从 document 读取宿主注入的公开挂载路径；无注入（测试/非浏览器）退回根路径。 */
function readBasePath(doc: Document | undefined): string {
  if (!doc) return "/";
  const meta = doc.querySelector(`meta[name="${APP_BASE_PATH_META}"]`);
  const content = meta?.getAttribute("content") ?? "";
  const normalized: AppBasePathNormalization = normalizeAppBasePath(content);
  if (normalized.ok) return normalized.basePath;
  // 退回：从 <base href> 的 pathname 派生。
  const href = doc.querySelector("base")?.getAttribute("href") ?? "";
  if (href) {
    try {
      const pathname = new URL(href, doc.baseURI ?? "http://localhost/").pathname;
      const fromHref = normalizeAppBasePath(pathname);
      if (fromHref.ok) return fromHref.basePath;
    } catch {
      // 忽略并退回根路径。
    }
  }
  return "/";
}

let cached: string | null = null;

/** 当前挂载路径（规范化，根为 `/`）。 */
export function currentAppBasePath(): string {
  if (cached === null) cached = readBasePath(globalThis.document);
  return cached;
}

/** 测试/宿主覆盖当前挂载路径（仅测试与启动引导使用）。 */
export function setAppBasePathForTesting(basePath: string): void {
  const result = normalizeAppBasePath(basePath);
  cached = result.ok ? result.basePath : "/";
}

/** 逻辑路径 → 公开 URL 路径（加一次挂载前缀）。 */
export function appPublicUrl(logicalPath: string): string {
  return addAppBasePath(currentAppBasePath(), logicalPath);
}

/** 挂载前缀（不含尾斜杠；根为 `""`）。 */
export function appBasePathPrefixValue(): string {
  return appBasePathPrefix(currentAppBasePath());
}

/** 公开 pathname → 应用逻辑 pathname；不在挂载内返回参数原样（路由只处理挂载内请求）。 */
export function stripAppLocationPathname(pathname: string): string {
  return stripAppBasePath(currentAppBasePath(), pathname) ?? pathname;
}

/**
 * 把「只接收应用逻辑路径」的 fetch 出口包装一次：站内根相对路径加挂载前缀后再请求。
 * 完整 URL、Request 与外部地址原样透传（不重写外部 URL）。每个传输出口只用一次，避免重复加前缀。
 */
export function getAppPublicFetch(): typeof globalThis.fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const sameOrigin = typeof input === "string" && input.startsWith("/");
    const mapped = sameOrigin ? appPublicUrl(input) : input;
    const pending = globalThis.fetch(mapped, init);
    if (!sameOrigin || publicFetchObservers.size === 0) return pending;
    // 只把「宿主不可达」当失败：网络错误与 ingress 在后端不可达时回的 502/503/504。
    // 4xx 是业务结论，不能触发重连遮罩。
    return pending.then(
      (response) => {
        notifyPublicFetch(!(response.status === 502 || response.status === 503 || response.status === 504));
        return response;
      },
      (error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) notifyPublicFetch(false);
        throw error;
      }
    );
  };
}

/**
 * 同源请求的可达性观察者（change: 2026-10-21-harden-extension-fault-isolation，D6）：
 * App 级宿主连通性据此判断「本机服务是否掉线」。观察者异常不影响请求本身。
 */
const publicFetchObservers = new Set<(ok: boolean) => void>();

function notifyPublicFetch(ok: boolean): void {
  for (const observer of [...publicFetchObservers]) {
    try {
      observer(ok);
    } catch {
      /* 观察者失败不影响请求 */
    }
  }
}

export function observeAppPublicFetch(observer: (ok: boolean) => void): () => void {
  publicFetchObservers.add(observer);
  return () => {
    publicFetchObservers.delete(observer);
  };
}
