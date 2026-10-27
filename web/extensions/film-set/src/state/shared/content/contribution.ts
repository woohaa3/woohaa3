/**
 * 片场 nodeData codec。浏览器与后端共用这一份，内核只按 extensionId 调用。
 */
import type { ContentContribution, ContentNodeDataCodec } from "../../../../../../contracts/src/canvas/content-contribution.js";
import { FILM_SET_EXTENSION_ID } from "../identity.js";
import { decodeFilmSetContent, filmSetAssetReferences } from "./codec.js";
import { FILM_SET_CONTENT_FIELD } from "./types.js";

const INVALID = "film-set-content-invalid";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const filmSetNodeDataCodec: ContentNodeDataCodec = {
  decode(data) {
    const field = isRecord(data) ? data[FILM_SET_CONTENT_FIELD] : data;
    const result = decodeFilmSetContent(field);
    return result.ok ? { ok: true, value: result.value } : { ok: false, code: INVALID, reason: INVALID };
  },
  validatePatch(_previous, patch) {
    if (!isRecord(patch) || patch[FILM_SET_CONTENT_FIELD] === undefined) return null;
    const result = decodeFilmSetContent(patch[FILM_SET_CONTENT_FIELD]);
    return result.ok ? null : { code: INVALID, reason: INVALID };
  },
  normalize(data) {
    if (!isRecord(data) || data[FILM_SET_CONTENT_FIELD] === undefined) return data;
    const next = { ...data };
    const result = decodeFilmSetContent(data[FILM_SET_CONTENT_FIELD]);
    if (result.ok) next[FILM_SET_CONTENT_FIELD] = result.value;
    else delete next[FILM_SET_CONTENT_FIELD];
    return next;
  },
  sanitizeRuntime(data) {
    return data;
  },
  copy(nodeData) {
    const normalized = filmSetNodeDataCodec.normalize(nodeData);
    const decoded = filmSetNodeDataCodec.decode(normalized);
    return {
      data: normalized,
      assetRefs: decoded.ok ? filmSetAssetReferences(decoded.value as never) : [],
      remap: {}
    };
  },
  diff(before, after) {
    return { ok: true, forward: after, inverse: before };
  }
};

export const filmSetContentContribution: ContentContribution = {
  extensionId: FILM_SET_EXTENSION_ID,
  nodeData: filmSetNodeDataCodec
};
