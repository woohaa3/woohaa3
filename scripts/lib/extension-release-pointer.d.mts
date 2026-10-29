/**
 * `extension-release-pointer.mjs` 的类型声明。
 *
 * 该模块是 dev/preview 服务期的 Node 侧代码（纯 ESM，由 `node --test` 覆盖），
 * 由 `web/frontend/vite.config.ts` 消费；本文件让 TS 侧有准确签名，不把 `allowJs` 打开。
 */

export declare const RELEASE_POINTER_PATH: string;
export declare const RELEASE_HREF_PATTERN: RegExp;

export type ReleasePointerSource = "pointer" | "last-good" | null;

export type ReleasePointerResolution = {
  href: string | null;
  source: ReleasePointerSource;
};

/** 逻辑路径 → 宿主 URL（只在请求出口加一次公开挂载前缀）。 */
export declare function backendPath(backendUrl: string, basePath: string, logicalPath: string): string;

export type ReleasePointerResponse = {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
};

export type ReleasePointerOptions = {
  backendUrl: string;
  basePath?: string;
  fetchImpl?: (url: string, init?: { signal?: AbortSignal }) => Promise<ReleasePointerResponse>;
  /** 上次成功注入的目录；只在指针读不到时用于兜底。 */
  lastGoodHref?: string | null;
  /** 重试窗口（毫秒），缺省 3000。 */
  retryWindowMs?: number;
  /** 两次尝试之间的等待（毫秒），缺省 250。 */
  retryDelayMs?: number;
  /** 单次请求超时（毫秒），缺省 1500。 */
  attemptTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: Record<string, unknown>) => void;
};

/**
 * 解析当前发布目录 href。
 *
 * `href === null` 表示本次无法注入；宿主返回非法 href 时抛错（宿主 bug，不静默降级）。
 */
export declare function resolveReleasePointer(options: ReleasePointerOptions): Promise<ReleasePointerResolution>;
