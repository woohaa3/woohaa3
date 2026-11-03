import type { MarketplaceFailureCode } from "@woohaa3/contracts";
import { isMarketplaceFailureCode } from "@woohaa3/contracts";

/** Manager 内部失败：带稳定失败码（D11）。 */
export class ExtensionManagerError extends Error {
  readonly code: MarketplaceFailureCode;
  readonly issues?: readonly string[];
  /**
   * 瞬时失败（连接中断、网络超时、5xx、读到一半断流）：下载流水线可以自动重试。
   * 确定性失败（摘要不符、大小超限、HTTP 4xx、磁盘只读）标 false，重试只会拖长失败。
   */
  readonly retryable: boolean;
  constructor(code: MarketplaceFailureCode, message: string, issues?: readonly string[], options?: { retryable?: boolean }) {
    super(message);
    this.name = "ExtensionManagerError";
    this.code = code;
    if (issues && issues.length > 0) this.issues = issues;
    this.retryable = options?.retryable === true;
  }
}

/** 把任意抛出物归一为 Manager 失败：识别包工具抛出的 `code`，其余按给定兜底码。 */
export function toManagerError(error: unknown, fallback: MarketplaceFailureCode, options?: { retryable?: boolean }): ExtensionManagerError {
  if (error instanceof ExtensionManagerError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return new ExtensionManagerError(isMarketplaceFailureCode(code) ? code : fallback, message, undefined, options);
}
