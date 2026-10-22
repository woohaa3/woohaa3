/**
 * MCP 内部协议共享解码原语
 * （自 `mcp-internal.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R08）。
 *
 * 各请求族 codec 只依赖本模块的受限原语与 `types`，不经过旧 barrel 形成环。
 */
import { isBoundedId, isFiniteNumber, isJsonObject } from "../../validation.js";

export type McpDecodeResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export function ok<T>(value: T): McpDecodeResult<T> {
  return { ok: true, value };
}

export function fail(code: string, message: string): McpDecodeResult<never> {
  return { ok: false, code, message };
}

export function readOptionalId(body: Record<string, unknown>, key: string): string | undefined | { error: string } {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!isBoundedId(value)) return { error: `${key} 必须是非空字符串` };
  return value;
}

/** 读取必填非空 id；缺失/非法返回错误对象（change: 2026-10-07-remove-residual-compatibility）。 */
export function readRequiredId(body: Record<string, unknown>, key: string): string | { error: string } {
  const value = body[key];
  if (!isBoundedId(value)) return { error: `${key} 必须是非空字符串` };
  return value;
}

/** 读取可选有限数值；缺省/`null` 视为未提供，非法返回错误。 */
export function readOptionalNumber(
  input: unknown,
  label: string
): { ok: true; value: number | undefined } | { ok: false; code: string; message: string } {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (!isFiniteNumber(input)) return { ok: false, code: "malformed-request", message: `${label} 必须是有限数值` };
  return { ok: true, value: input };
}

export { isJsonObject, isFiniteNumber, isBoundedId };
