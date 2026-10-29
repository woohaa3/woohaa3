/**
 * Canvas → Media 协议 client（change: split-web-runtime-services，任务 3.5 / 5.5）。
 *
 * Canvas 用它校验稳定资产引用（verify），并把 archive 媒体校验交给 Media Service。
 * **不** import COS adapter、不持有 COS 凭据（proposal BREAKING / design D2）。
 */
import { buildInternalHeaders,
  createCorrelationId,
  hashStorageKeyForLog,
  retryDelayMs,
  shouldRetryTransport,
  withTimeout,
  type MediaMetadata,
  type MediaStorageScope,
  type MediaVerifyResponse,
  type ProtocolErrorBody } from "@woohaa3/contracts";

export type CanvasMediaClientOptions = {
  baseUrl: string;
  serviceToken?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof globalThis.fetch;
  logger?: (event: Record<string, unknown>) => void;
};

export class CanvasMediaClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "CanvasMediaClientError";
    this.code = code;
    this.status = status;
  }
}

export type CanvasMediaClient = {
  /**
   * 读取稳定媒体字节（分立部署走内部 HTTP）。
   *
   * `canvasId` 可选：远端画布的字节只在服务端托管存储里（键 `<canvasId>/media/<key>`），
   * 调用方知道所属画布时必须传，服务端据此路由与判权；省略表示与画布无关（保持旧行为）。
   */
  read?(storageKey: string, canvasId?: string, extensionId?: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  /**
   * 核验稳定对象。
   *
   * `scope` 声明该对象属于哪张画布（远端画布的资产可能只在服务端托管存储里）；省略时保持
   * 旧行为，只查主存储。
   */
  verify(
    storageKey: string,
    expected?: Partial<Omit<MediaMetadata, "storageKey">>,
    scope?: MediaStorageScope
  ): Promise<{ exists: boolean; matches: boolean; metadata?: MediaMetadata }>;
};

export function createCanvasMediaClient(options: CanvasMediaClientOptions): CanvasMediaClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    async read(storageKey, canvasId, extensionId) {
      const response = await withTimeout(signal => fetchImpl(`${baseUrl}/internal/v1/media/extension-read`, {
        method: "POST", headers: buildInternalHeaders({ serviceToken: options.serviceToken, correlationId: createCorrelationId() }),
        // 有画布就带上作用域：body.canvasId 由 media-service 用 canvasScopeOf 校验后交给存储路由。
        body: JSON.stringify({ ...(extensionId ? { extensionId } : {}), storageKey, ...(canvasId !== undefined ? { canvasId } : {}) }), signal
      }), options.timeoutMs);
      if (!response.ok) throw new CanvasMediaClientError("media-read-failed", "稳定媒体资源读取失败", response.status);
      const result = await response.json() as { bytesBase64?: string; contentType?: string };
      if (typeof result.bytesBase64 !== "string" || result.bytesBase64.length > 24 * 1024 * 1024 || typeof result.contentType !== "string") throw new CanvasMediaClientError("malformed-response", "稳定媒体资源响应非法");
      return { bytes: Buffer.from(result.bytesBase64, "base64"), contentType: result.contentType };
    },
    async verify(storageKey, expected, scope) {
      const maxRetries = options.maxRetries ?? 2;
      for (let attempt = 0; ; attempt += 1) {
        const correlationId = createCorrelationId();
        try {
          const response = await withTimeout(
            (signal) =>
              fetchImpl(`${baseUrl}/internal/v1/media/verify`, {
                method: "POST",
                headers: buildInternalHeaders({ serviceToken: options.serviceToken, correlationId }),
                body: JSON.stringify({
                  storageKey,
                  ...(expected ? { expected } : {}),
                  ...(scope ? { canvasId: scope.canvasId } : {})
                }),
                signal
              }),
            options.timeoutMs
          );
          const parsed = (await response.json().catch(() => null)) as unknown;
          if (response.ok) {
            const result = parsed as MediaVerifyResponse;
            options.logger?.({ event: "media-verify", storageKeyHash: hashStorageKeyForLog(storageKey) });
            if (!result.exists) return { exists: false, matches: false };
            return { exists: true, matches: result.matches, metadata: result.metadata };
          }
          const errorBody = parsed as ProtocolErrorBody | null;
          const code = errorBody?.code ?? "storage-failed";
          if (shouldRetryTransport({ attempt, status: response.status, code, maxRetries })) {
            await delay(retryDelayMs(attempt));
            continue;
          }
          throw new CanvasMediaClientError(code, errorBody?.message ?? "媒体服务请求失败", response.status);
        } catch (error) {
          if (error instanceof CanvasMediaClientError) throw error;
          if (shouldRetryTransport({ attempt, maxRetries })) {
            await delay(retryDelayMs(attempt));
            continue;
          }
          throw new CanvasMediaClientError("unavailable", "媒体服务暂时不可用");
        }
      }
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
