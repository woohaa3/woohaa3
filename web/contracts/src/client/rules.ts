/**
 * 内部 client 的共享规则（change: split-web-runtime-services，任务 1.4）。
 *
 * 三个 service client（Canvas→Task、Canvas→Media、Task→Media）需要一致的认证、超时、
 * 有限 transport retry、correlation ID 与日志脱敏语义。这里只放**纯规则函数**，不做任何
 * I/O：真正的 `fetch` 由各服务的 client 注入，因此 contracts 保持无副作用（design D7）。
 */
import { CORRELATION_ID_HEADER,
  SERVICE_TOKEN_HEADER,
  WOOHAA3_PROTOCOL_VERSION,
  isRetryableProtocolError,
  type ProtocolErrorCode } from "../errors.js";

/** 默认单次内部请求超时（毫秒）。短超时是「不在 Canvas transaction 内持有长网络请求」的前提。 */
export const DEFAULT_INTERNAL_TIMEOUT_MS = 5_000;

/** 传输层有限重试次数（不含首次）。业务重试归各自 owner，这里只处理瞬时网络/可重试错误。 */
export const DEFAULT_TRANSPORT_RETRIES = 2;

/** 重试退避基数（毫秒）；实际退避 = base * 2^attempt。 */
export const DEFAULT_RETRY_BASE_MS = 100;

export type InternalRequestContext = {
  serviceToken?: string;
  correlationId: string;
  protocolVersion?: number;
};

/** 构造内部请求头；服务身份只放在专用头里，绝不拼进 URL 或 body。 */
export function buildInternalHeaders(context: InternalRequestContext): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-woohaa3-protocol-version": String(context.protocolVersion ?? WOOHAA3_PROTOCOL_VERSION),
    [CORRELATION_ID_HEADER]: context.correlationId
  };
  if (context.serviceToken) headers[SERVICE_TOKEN_HEADER] = context.serviceToken;
  return headers;
}

/** 生成关联 ID；调用方应把它带进日志（绝不带凭据）。 */
export function createCorrelationId(generate: () => string = defaultId): string {
  return generate();
}

function defaultId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 判定一次失败是否值得做**传输层重试**。
 *
 * - 网络异常（无 HTTP 状态）：重试；
 * - 已知可重试协议错误（unavailable/storage-failed）：重试；
 * - 5xx：重试；
 * - 4xx（含 unauthorized / protocol-incompatible / malformed-request / key-reused）：不重试。
 */
export function shouldRetryTransport(input: {
  attempt: number;
  status?: number;
  code?: ProtocolErrorCode | string;
  maxRetries?: number;
}): boolean {
  const maxRetries = input.maxRetries ?? DEFAULT_TRANSPORT_RETRIES;
  if (input.attempt >= maxRetries) return false;
  if (input.code && typeof input.code === "string") {
    if (isRetryableProtocolError(input.code as ProtocolErrorCode)) return true;
    // 已知但不可重试的协议错误：不重试（即使状态码看起来可重试）。
    if (input.status !== undefined) return false;
  }
  if (input.status === undefined) return true;
  return input.status >= 500;
}

/** 计算退避毫秒（指数退避，上限 2 秒）。 */
export function retryDelayMs(attempt: number, baseMs = DEFAULT_RETRY_BASE_MS): number {
  return Math.min(baseMs * 2 ** attempt, 2_000);
}

/** 在超时后 reject 的包装；调用方负责取消底层请求。 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = DEFAULT_INTERNAL_TIMEOUT_MS
): Promise<T> {
  if (timeoutMs <= 0) {
    return operation(new AbortController().signal);
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`内部请求超时（${timeoutMs}ms）`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 日志脱敏：内部 client/服务只允许记录这些安全字段的并集，其余键（可能含 prompt、
 * Yjs bytes、provider body、签名 URL、凭据）一律丢弃。
 */
export const SAFE_LOG_FIELDS = [
  "event",
  "status",
  "code",
  "protocolVersion",
  "correlationId",
  "workerTaskKey",
  "taskKey",
  "terminal",
  "canvasId",
  "nodeId",
  "runId",
  "jobId",
  "commandId",
  "storageKeyHash",
  "size",
  "attempt",
  "durationMs"
] as const;

/** 从任意上下文裁剪出安全日志字段。`storageKey` 只保留 hash（不落完整键）。 */
export function redactForLog(input: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of SAFE_LOG_FIELDS) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
    }
  }
  return safe;
}

/** 对 storageKey 生成短 hash，避免把完整对象键写进日志。 */
export function hashStorageKeyForLog(storageKey: string): string {
  let result = 0;
  for (let index = 0; index < storageKey.length; index += 1) {
    result = (result * 31 + storageKey.charCodeAt(index)) | 0;
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}
