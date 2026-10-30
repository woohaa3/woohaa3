import type { ContentContributionResolver, ContentNodeDataCodec } from "./content-contribution.js";
import type { CanvasNodeData } from "./domain/index.js";

/** Identity syntax is open; only a registered codec grants write capability. */
export function contentOwnerId(data: unknown): string | null {
  if (!record(data)) return null;
  const id = data.extensionId;
  return typeof id === "string" && id.length <= 200 && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(id) ? id : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function finiteJson(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finiteJson);
  return record(value) && Object.values(value).every(finiteJson);
}

function normalized(codec: ContentNodeDataCodec, data: CanvasNodeData, extensionId: string): CanvasNodeData | null {
  const value = codec.normalize(structuredClone(data));
  return record(value) && contentOwnerId(value) === extensionId && finiteJson(value) ? value as CanvasNodeData : null;
}

export type ContentNodeDataWriteResult =
  | { ok: true; value: CanvasNodeData }
  | { ok: false; code: "content-owner-unavailable" | "content-command-rejected" | "content-codec-failed"; message: string };

/** The whole merged value is normalized only after the owner accepts the patch. */
export function applyContentNodeDataPatch(
  previous: CanvasNodeData,
  patch: CanvasNodeData | null,
  content: ContentContributionResolver
): ContentNodeDataWriteResult {
  return validateContentNodeDataWrite(previous, patch, patch === null ? {} : { ...previous, ...patch }, content);
}

/** Exact replacement used by field removal; deleted fields must not be merged back. */
export function replaceContentNodeData(
  previous: CanvasNodeData,
  next: CanvasNodeData,
  content: ContentContributionResolver
): ContentNodeDataWriteResult {
  return validateContentNodeDataWrite(previous, next, next, content);
}

function validateContentNodeDataWrite(
  previous: CanvasNodeData,
  patch: CanvasNodeData | null,
  next: CanvasNodeData,
  content: ContentContributionResolver
): ContentNodeDataWriteResult {
  const beforeId = contentOwnerId(previous);
  const extensionId = contentOwnerId(next);
  if (!extensionId || (beforeId !== null && beforeId !== extensionId)
    || (Object.prototype.hasOwnProperty.call(previous, "extensionId") && previous.extensionId !== extensionId)) {
    return { ok: false, code: "content-owner-unavailable", message: "content-owner-unavailable" };
  }
  const codec = content.resolve(extensionId)?.nodeData;
  if (!codec) return { ok: false, code: "content-owner-unavailable", message: "content-owner-unavailable" };
  try {
    const diagnostic = codec.validatePatch(structuredClone(previous), structuredClone(patch));
    if (diagnostic) return { ok: false, code: "content-command-rejected", message: diagnostic.code };
    const value = normalized(codec, next, extensionId);
    if (!value) return { ok: false, code: "content-codec-failed", message: "content-codec-failed" };
    const decoded = codec.decode(structuredClone(value));
    if (!decoded.ok) return { ok: false, code: "content-command-rejected", message: decoded.code };
    return { ok: true, value };
  } catch {
    return { ok: false, code: "content-codec-failed", message: "content-codec-failed" };
  }
}

/** Loading never destroys opaque content merely because its owner is unavailable. */
export function normalizeContentNodeData(data: CanvasNodeData, content: ContentContributionResolver): CanvasNodeData {
  const extensionId = contentOwnerId(data);
  const codec = extensionId ? content.resolve(extensionId)?.nodeData : undefined;
  if (!codec || !extensionId) return data;
  try {
    return normalized(codec, data, extensionId) ?? data;
  } catch {
    return data;
  }
}

/** Clipboard callers treat failure as an aborted copy and retain their previous payload. */
export function sanitizeContentNodeData(data: CanvasNodeData, content: ContentContributionResolver): CanvasNodeData {
  const extensionId = contentOwnerId(data);
  const codec = extensionId ? content.resolve(extensionId)?.nodeData : undefined;
  if (!codec || !extensionId) throw Error("content-owner-unavailable");
  try {
    const value = codec.sanitizeRuntime(structuredClone(data));
    if (!record(value) || contentOwnerId(value) !== extensionId || !finiteJson(value)) throw Error("content-codec-failed");
    return value as CanvasNodeData;
  } catch {
    throw Error("content-codec-failed");
  }
}
