/**
 * RPC 错误：带稳定 `code`（契约 `EXTENSION_HOST_ERROR_CODES`，或对端透传的业务码）。
 */
import type { ExtensionHostRpcError } from "@woohaa3/contracts";

export class RpcError extends Error {
  readonly code: string;
  readonly data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }

  toWire(): ExtensionHostRpcError {
    return { code: this.code, message: this.message, ...(this.data !== undefined ? { data: this.data } : {}) };
  }
}

export function isRpcError(error: unknown): error is RpcError {
  return error instanceof RpcError;
}

/** 把任意抛出值转成线上错误：保留 `code`（字符串时），消息截断到 2 KiB，不透传堆栈。 */
export function toWireError(error: unknown): ExtensionHostRpcError {
  if (error instanceof RpcError) return error.toWire();
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "internal-error";
  const message = error instanceof Error ? error.message : String(error);
  return { code, message: message.length > 2048 ? `${message.slice(0, 2047)}…` : message };
}

export function fromWireError(error: ExtensionHostRpcError): RpcError {
  return new RpcError(String(error.code), String(error.message ?? ""), error.data);
}
