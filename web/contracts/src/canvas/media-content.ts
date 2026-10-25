/** Portable content identity. Provider payloads belong to their extensions, never a core union. */
import type { Woohaa3CanvasJsonObject } from "./domain/core/document-schema.js";
export type MediaContentRef = { providerId: string; schemaVersion: number; payload: Woohaa3CanvasJsonObject };
export function decodeMediaContentRef(value: unknown): { ok: true; value: MediaContentRef } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "mediaContent 必须是对象" };
  const ref = value as Record<string, unknown>;
  if (Object.keys(ref).some(k => !["providerId", "schemaVersion", "payload"].includes(k)) || typeof ref.providerId !== "string" || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(ref.providerId) || ref.providerId.length > 200)
    return { ok: false, reason: "mediaContent.providerId 非法" };
  if (!Number.isSafeInteger(ref.schemaVersion) || Number(ref.schemaVersion) < 1) return { ok: false, reason: "mediaContent.schemaVersion 必须是正整数" };
  const seen = new Set<object>();
  const json = (v: unknown): boolean => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (!v || typeof v !== "object" || seen.has(v)) return false;
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return false;
    seen.add(v); const valid = Object.values(v).every(json); seen.delete(v); return valid;
  };
  if (!ref.payload || typeof ref.payload !== "object" || Array.isArray(ref.payload) || !json(ref.payload)) return { ok: false, reason: "mediaContent.payload 必须是 JSON 对象" };
  return { ok: true, value: structuredClone(ref) as MediaContentRef };
}
