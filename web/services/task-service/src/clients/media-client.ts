/**
 * Media Service client（change: split-web-runtime-services，任务 3.5 / 4.5）。
 *
 * Task Service 通过它把稳定输入引用换成短期签名 URL，并把 provider 媒体输出转存为稳定对象。
 * **不** import Media 实现，也不持有 COS 凭据：只走版本化内部 HTTP 协议（design D7）。
 */
import { buildInternalHeaders,
  checkProtocolVersion,
  createCorrelationId,
  hashStorageKeyForLog,
  retryDelayMs,
  shouldRetryTransport,
  withTimeout,
  type MediaImportResponse,
  type MediaMetadata,
  type MediaSignResponse,
  type MediaVerifyResponse,
  type ProtocolErrorBody } from "@woohaa3/contracts";

export type MediaClientOptions = {
  baseUrl: string;
  serviceToken?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof globalThis.fetch;
  logger?: (event: Record<string, unknown>) => void;
};

export class MediaClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "MediaClientError";
    this.code = code;
    this.status = status;
  }
}

export type MediaClient = {
  /**
   * 确认对象可读并逐项比对 metadata。
   *
   * `scope.canvasId` 声明「这次核验属于哪张画布」：同步到远端的画布资产只在托管存储里，
   * 不带作用域会 stat 到主存储而误判不存在（稳定媒体结果的 verify-and-adopt 必须带）。
   */
  verify(
    storageKey: string,
    expected?: Partial<Omit<MediaMetadata, "storageKey">>,
    scope?: { canvasId?: string }
  ): Promise<{ exists: boolean; matches: boolean; metadata?: MediaMetadata }>;
  sign(storageKey: string, expiresSeconds?: number, scope?: { canvasId: string }): Promise<string>;
  /**
   * 按 locator 导入 provider 输出。
   *
   * 远端托管生成的结果在服务端命名空间里，客户端只有 locator：取数与授权由存储层完成，
   * 媒体层只做校验与登记。`expected` 给了就强校验元数据。
   */
  importFromLocator(input: {
    locator: string;
    canvasId?: string;
    contentType?: string;
    maxBytes?: number;
    expected?: { contentType?: string; size?: number; checksum?: string };
  }): Promise<MediaMetadata>;
  /**
   * 转存 provider 媒体输出。
   *
   * `canvasId` 声明「这次写入属于哪张画布」（缺省表示与画布无关，如扩展任务）：Media Service
   * 只把它透传给存储层做画布作用域路由，自己不认识画布。同步到远端的画布必须带上，否则字节
   * 会落到主存储而不是该画布路由到的后端。
   */
  importFromUrl(input: { url: string; contentType?: string; maxBytes?: number; canvasId?: string }): Promise<MediaMetadata>;
  /** provider 以 base64/bytes 返回时：把字节交给 Media 内容寻址写入（Task 不接触 COS）。 */
  importBytes(input: {
    bytesBase64: string;
    contentType: string;
    maxBytes?: number;
    canvasId?: string;
  }): Promise<MediaMetadata>;
};

export function createMediaClient(options: MediaClientOptions): MediaClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  async function post<T>(path: string, body: unknown, transportOptions: { retryTransport?: boolean } = {}): Promise<T> {
    const maxRetries = transportOptions.retryTransport === false
      ? 0
      : options.maxRetries ?? 2;
    for (let attempt = 0; ; attempt += 1) {
      const correlationId = createCorrelationId();
      try {
        const response = await withTimeout(
          (signal) =>
            fetchImpl(`${baseUrl}${path}`, {
              method: "POST",
              headers: buildInternalHeaders({ serviceToken: options.serviceToken, correlationId }),
              body: JSON.stringify(body),
              signal
            }),
          options.timeoutMs
        );
        const parsed = (await response.json().catch(() => null)) as unknown;
        if (response.ok) return parsed as T;
        const errorBody = parsed as ProtocolErrorBody | null;
        const code = errorBody?.code ?? "storage-failed";
        if (shouldRetryTransport({ attempt, status: response.status, code, maxRetries })) {
          await delay(retryDelayMs(attempt));
          continue;
        }
        throw new MediaClientError(code, errorBody?.message ?? "媒体服务请求失败", response.status);
      } catch (error) {
        if (error instanceof MediaClientError) throw error;
        if (shouldRetryTransport({ attempt, maxRetries })) {
          await delay(retryDelayMs(attempt));
          continue;
        }
        throw new MediaClientError("unavailable", "媒体服务暂时不可用");
      }
    }
  }

  return {
    async verify(storageKey, expected, scope) {
      const result = await post<MediaVerifyResponse>("/internal/v1/media/verify", {
        storageKey,
        ...(expected ? { expected } : {}),
        ...(scope?.canvasId ? { canvasId: scope.canvasId } : {})
      });
      options.logger?.({ event: "media-verify", storageKeyHash: hashStorageKeyForLog(storageKey) });
      if (!result.exists) return { exists: false, matches: false };
      return { exists: true, matches: result.matches, metadata: result.metadata };
    },

    async sign(storageKey, expiresSeconds, scope) {
      const result = await post<MediaSignResponse>("/internal/v1/media/sign", {
        storageKey,
        ...(expiresSeconds !== undefined ? { expiresSeconds } : {}),
        ...(scope ? { canvasId: scope.canvasId } : {})
      });
      options.logger?.({ event: "media-sign", storageKeyHash: hashStorageKeyForLog(storageKey) });
      return result.url;
    },

    async importFromUrl(input) {
      // 转存重试归 Media Service（超时/网络/5xx，有界退避）；这里不再叠一层传输重试，
      // 否则一次抖动会放大成 9 次 provider 请求。
      const result = await post<MediaImportResponse>("/internal/v1/media/import", input, { retryTransport: false });
      options.logger?.({
        event: "media-import",
        storageKeyHash: hashStorageKeyForLog(result.storageKey),
        size: result.size
      });
      return result;
    },

    async importBytes(input) {
      const result = await post<MediaImportResponse>("/internal/v1/media/import-bytes", input);
      options.logger?.({
        event: "media-import-bytes",
        storageKeyHash: hashStorageKeyForLog(result.storageKey),
        size: result.size
      });
      return result;
    },

    async importFromLocator() {
      // 内部 HTTP 协议面没有 locator 入口，也**不该**再补一个：locator 的解析属于存储层，
      // 隔着 HTTP 传一遍只会把后端身份带到协议里。本机宿主的装配走进程内 media port。
      throw new MediaClientError("unavailable", "当前装配不支持按 locator 导入：请使用进程内媒体端口");
    }
  };
}

/** 协议版本自检（供启动 smoke test 使用）。 */
export function assertMediaProtocolVersion(declared: unknown): void {
  const check = checkProtocolVersion(declared);
  if (!check.ok) throw new MediaClientError(check.code, check.message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
