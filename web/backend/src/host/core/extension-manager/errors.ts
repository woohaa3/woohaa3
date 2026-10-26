import type { MarketplaceFailureCode } from "@woohaa3/contracts";
import { isMarketplaceFailureCode } from "@woohaa3/contracts";

/** Manager 内部失败：带稳定失败码（D11）。 */
export class ExtensionManagerError extends Error {
  readonly code: MarketplaceFailureCode;
  readonly issues?: readonly string[];
  constructor(code: MarketplaceFailureCode, message: string, issues?: readonly string[]) {
    super(message);
    this.name = "ExtensionManagerError";
    this.code = code;
    if (issues && issues.length > 0) this.issues = issues;
  }
}

/** 把任意抛出物归一为 Manager 失败：识别包工具抛出的 `code`，其余按给定兜底码。 */
export function toManagerError(error: unknown, fallback: MarketplaceFailureCode): ExtensionManagerError {
  if (error instanceof ExtensionManagerError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return new ExtensionManagerError(isMarketplaceFailureCode(code) ? code : fallback, message);
}
