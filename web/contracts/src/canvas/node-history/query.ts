/**
 * 节点生成历史：opaque cursor 与查询归一化
 * （自 `node-history.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R06）。
 */
import { isJsonObject } from "../../validation.js";
import {
  NODE_HISTORY_LIMITS,
  isNodeGenerationKind,
  type CanvasHistoryQuery,
  type NodeHistoryKindCounts
} from "./types.js";

/**
 * 稳定 opaque cursor：`(createdAt, entryId)` 倒序位置。
 *
 * 新版本到达不会改变既有 cursor 对旧页的顺序语义（按 createdAt 再 entryId 稳定排序）。
 */
export function encodeNodeHistoryCursor(input: { createdAt: string; entryId: string }): string {
  return base64UrlEncode(`${input.createdAt}\u0001${input.entryId}`);
}

export function decodeNodeHistoryCursor(raw: unknown): { createdAt: string; entryId: string } | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  const decoded = base64UrlDecode(raw);
  if (decoded === null) return null;
  const index = decoded.indexOf("\u0001");
  if (index <= 0) return null;
  const createdAt = decoded.slice(0, index);
  const entryId = decoded.slice(index + 1);
  if (!createdAt || !entryId) return null;
  return { createdAt, entryId };
}

/** 归一化列表分页参数（limit 钳制、cursor 与筛选回落）。 */
export function normalizeNodeHistoryQuery(input: unknown): { limit: number; cursor?: string } {
  const record = isJsonObject(input) ? input : {};
  const rawLimit = record.limit;
  const limit = typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, NODE_HISTORY_LIMITS.maxPageSize)
    : NODE_HISTORY_LIMITS.defaultPageSize;
  const cursor = typeof record.cursor === "string" && record.cursor !== "" ? record.cursor : undefined;
  return { limit, ...(cursor ? { cursor } : {}) };
}

/** 归一化画布级查询：limit 钳制、cursor 与 kind 回落。 */
export function normalizeCanvasHistoryQuery(input: unknown): CanvasHistoryQuery {
  const record = isJsonObject(input) ? input : {};
  const rawLimit = record.limit;
  const limit = typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, NODE_HISTORY_LIMITS.maxPageSize)
    : NODE_HISTORY_LIMITS.defaultPageSize;
  const cursor = typeof record.cursor === "string" && record.cursor !== "" ? record.cursor : undefined;
  const kind = isNodeGenerationKind(record.kind) ? record.kind : undefined;
  return { limit, ...(kind ? { kind } : {}), ...(cursor ? { cursor } : {}) };
}

/** 空计数（全部为 0），供无条目画布与测试使用。 */
export function emptyNodeHistoryKindCounts(): NodeHistoryKindCounts {
  return { text: 0, image: 0, video: 0, audio: 0, model: 0 };
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = globalThis.btoa ? globalThis.btoa(binary) : Buffer.from(binary, "binary").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    const binary = globalThis.atob ? globalThis.atob(withPadding) : Buffer.from(withPadding, "base64").toString("binary");
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
