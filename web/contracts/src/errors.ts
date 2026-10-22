/**
 * 跨服务协议的稳定错误码与版本协商（change: split-web-runtime-services，任务 1.3）。
 *
 * 这里是**唯一**允许跨运行单元共享的协议表面的一部分：版本常量、稳定错误码、
 * 无副作用 codec。它刻意不导出任何 service class、repository interface 或 HTTP handler
 * （design D7）。
 *
 * 约定：
 * - 每个内部协议都携带 `WOOHAA3_PROTOCOL_VERSION`；版本不兼容必须在**副作用之前**返回
 *   `protocol-incompatible`。
 * - 错误码字符串是跨进程契约：调用方按字符串判定，不按 `instanceof`。
 */

/** 内部（服务间）协议版本。任何不兼容的结构变化都要提升它。 */
export const WOOHAA3_PROTOCOL_VERSION = 1 as const;
export type Woohaa3ProtocolVersion = typeof WOOHAA3_PROTOCOL_VERSION;

/** 服务身份请求头（受信任代理/服务令牌）。 */
export const SERVICE_TOKEN_HEADER = "x-woohaa3-service-token" as const;
/** 关联 ID 请求头（日志串联用；绝不影响业务语义）。 */
export const CORRELATION_ID_HEADER = "x-woohaa3-correlation-id" as const;

/**
 * 稳定协议错误码。
 *
 * 命名集中在 `contracts` 是因为调用方（Canvas/Task/Media client）需要按码分派重试与降级，
 * 而这些码必须与实现侧的字面量一致。
 */
export const PROTOCOL_ERROR_CODES = [
  /** 协议版本不兼容。 */
  "protocol-incompatible",
  /** 未通过服务身份认证。 */
  "unauthorized",
  /** 请求体/字节/字段超出限制。 */
  "limit-exceeded",
  /** 请求结构非法。 */
  "malformed-request",
  /** 引用的任务记录不存在。 */
  "task-not-found",
  /** 相同幂等 key 使用了不同 payload。 */
  "key-reused",
  /** 提交时读取的模型/interaction 配置已与当前 catalog 不一致（需重新选择/刷新）。 */
  "catalog-changed",
  /** 引用的媒体对象不存在。 */
  "media-not-found",
  /** 媒体对象 metadata 与声明不一致。 */
  "media-mismatch",
  /** 任务/媒体/画布依赖暂时不可用（可重试）。 */
  "unavailable",
  /** 下游写入失败（可重试）。 */
  "storage-failed",
  /** 不受支持的操作。 */
  "unsupported"
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

/** 判定一个字符串是否是已知协议错误码。 */
export function isProtocolErrorCode(value: unknown): value is ProtocolErrorCode {
  return typeof value === "string" && (PROTOCOL_ERROR_CODES as readonly string[]).includes(value);
}

/** 协议错误响应体（所有内部接口统一用它）。 */
export type ProtocolErrorBody = {
  code: ProtocolErrorCode;
  message: string;
  /** 服务端协议版本，便于调用方诊断不兼容。 */
  protocolVersion?: number;
};

/** 该错误码是否值得做**传输层有限重试**（业务重试仍归各自 owner）。 */
export function isRetryableProtocolError(code: ProtocolErrorCode): boolean {
  return code === "unavailable" || code === "storage-failed";
}

/**
 * 校验调用方声明的协议版本。
 *
 * 调用方 MUST 显式声明受支持的版本；缺失或不匹配都在副作用前拒绝，不把缺省视为当前版本。
 */
export function checkProtocolVersion(
  declared: unknown
): { ok: true } | { ok: false; code: "protocol-incompatible"; message: string } {
  if (declared === WOOHAA3_PROTOCOL_VERSION) return { ok: true };
  return {
    ok: false,
    code: "protocol-incompatible",
    message: declared === undefined || declared === null
      ? `协议版本缺失：调用方未声明，服务端 ${WOOHAA3_PROTOCOL_VERSION}`
      : `协议版本不兼容：调用方 ${String(declared)}，服务端 ${WOOHAA3_PROTOCOL_VERSION}`
  };
}
