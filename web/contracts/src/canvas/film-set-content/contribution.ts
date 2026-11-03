/**
 * 片场 nodeData codec。浏览器与后端共用这一份，内核只按 extensionId 调用。
 */
import type { ContentContribution, ContentCopyContext, ContentNodeDataCodec } from "../content-contribution.js";
import { isFilmSetNode } from "../domain/core/composite-asset-identity.js";
import { decodeFilmSetGroupMarker, FILM_SET_GROUP_FIELD, type FilmSetGroupMarker } from "../film-set-group.js";
import { isBoundedId, isJsonObject } from "../../validation.js";
import { decodeFilmSetContent, filmSetAssetReferences } from "./codec.js";
import { FILM_SET_CONTENT_FIELD } from "./types.js";

const FILM_SET_EXTENSION_ID = "film-set";

const INVALID = "film-set-content-invalid";
const INVALID_GROUP = "film-set-group-invalid";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const filmSetNodeDataCodec: ContentNodeDataCodec = {
  decode(data) {
    if (isRecord(data) && data[FILM_SET_GROUP_FIELD] !== undefined) {
      const marker = decodeFilmSetGroupMarker(data[FILM_SET_GROUP_FIELD]);
      return marker.ok ? { ok: true, value: marker.value } : { ok: false, code: INVALID_GROUP, reason: INVALID_GROUP };
    }
    const field = isRecord(data) ? data[FILM_SET_CONTENT_FIELD] : data;
    const result = decodeFilmSetContent(field);
    return result.ok ? { ok: true, value: result.value } : { ok: false, code: INVALID, reason: INVALID };
  },
  validatePatch(_previous, patch) {
    if (!isRecord(patch)) return null;
    if (patch[FILM_SET_GROUP_FIELD] !== undefined && !decodeFilmSetGroupMarker(patch[FILM_SET_GROUP_FIELD]).ok) {
      return { code: INVALID_GROUP, reason: INVALID_GROUP };
    }
    if (patch[FILM_SET_CONTENT_FIELD] === undefined) return null;
    const result = decodeFilmSetContent(patch[FILM_SET_CONTENT_FIELD]);
    return result.ok ? null : { code: INVALID, reason: INVALID };
  },
  normalize(data) {
    if (!isRecord(data)) return data;
    const next = { ...data };
    if (next[FILM_SET_GROUP_FIELD] !== undefined) {
      const marker = decodeFilmSetGroupMarker(next[FILM_SET_GROUP_FIELD]);
      if (marker.ok) next[FILM_SET_GROUP_FIELD] = marker.value;
    }
    if (next[FILM_SET_CONTENT_FIELD] === undefined) return next;
    const result = decodeFilmSetContent(next[FILM_SET_CONTENT_FIELD]);
    if (result.ok) next[FILM_SET_CONTENT_FIELD] = result.value;
    else delete next[FILM_SET_CONTENT_FIELD];
    return next;
  },
  sanitizeRuntime(data) {
    if (!isRecord(data)) return data;
    const next = { ...data };
    if (next[FILM_SET_GROUP_FIELD] !== undefined) {
      const marker = decodeFilmSetGroupMarker(next[FILM_SET_GROUP_FIELD]);
      if (marker.ok) {
        const detached = new Set(marker.value.sceneBindings.filter((binding) => binding.detached).map((binding) => binding.bindingId));
        const sceneBindings = marker.value.sceneBindings.filter((binding) => !binding.detached);
        const { migration: _migration, ...rest } = marker.value;
        const clips = marker.value.clips?.map((clip) => ({
          ...clip,
          ...(clip.bindings ? { bindings: clip.bindings.filter((binding) => !detached.has(binding.itemId)) } : {})
        }));
        next[FILM_SET_GROUP_FIELD] = { ...rest, sceneBindings, ...(clips ? { clips } : {}) };
      }
    }
    if (next[FILM_SET_CONTENT_FIELD] !== undefined) {
      const content = decodeFilmSetContent(next[FILM_SET_CONTENT_FIELD]);
      if (content.ok) next[FILM_SET_CONTENT_FIELD] = content.value;
      else delete next[FILM_SET_CONTENT_FIELD];
    }
    return next;
  },
  copy(nodeData, context) {
    const normalized = filmSetNodeDataCodec.normalize(nodeData);
    const content = isRecord(normalized) ? decodeFilmSetContent(normalized[FILM_SET_CONTENT_FIELD]) : { ok: false as const };
    const assetRefs = content.ok ? filmSetAssetReferences(content.value) : [];
    if (!isRecord(normalized) || normalized[FILM_SET_GROUP_FIELD] === undefined) {
      return { data: normalized, assetRefs, remap: {} };
    }
    const marker = decodeFilmSetGroupMarker(normalized[FILM_SET_GROUP_FIELD]);
    if (!marker.ok) return { data: normalized, assetRefs, remap: {} };
    const remapped = remapFilmSetGroupCopy(marker.value, context);
    return {
      data: { ...normalized, [FILM_SET_GROUP_FIELD]: remapped.marker },
      assetRefs,
      remap: remapped.remap
    };
  },
  diff(before, after) {
    return { ok: true, forward: after, inverse: before };
  },
  schemaVersion(data) {
    if (!isRecord(data) || !isRecord(data[FILM_SET_GROUP_FIELD])) return null;
    const version = data[FILM_SET_GROUP_FIELD].schemaVersion;
    return typeof version === "number" ? version : null;
  },
  inspect(data) {
    if (!isRecord(data) || !Object.prototype.hasOwnProperty.call(data, FILM_SET_CONTENT_FIELD)) return { ok: true, report: null };
    return { ok: true, report: filmSetContentInventory(data[FILM_SET_CONTENT_FIELD]) };
  },
  rejectLegacy(type, data) {
    if (isFilmSetNode(type, data) || filmSetObjectContainerData(data)) return { code: "film-set-legacy-retired", reason: "film-set-legacy-retired" };
    return null;
  }
};

function filmSetObjectContainerData(data: unknown): boolean {
  if (!isJsonObject(data) || data.extensionId !== FILM_SET_EXTENSION_ID || data.compositeAssetRole !== "object-container") return false;
  const owner = data.filmSetObject;
  return isJsonObject(owner)
    && Object.keys(owner).every((key) => ["schemaVersion", "filmSetNodeId", "itemId"].includes(key))
    && owner.schemaVersion === 1
    && isBoundedId(owner.filmSetNodeId)
    && isBoundedId(owner.itemId);
}

function filmSetContentInventory(filmSet: unknown): Array<{ code: string; confirmedLegacy: boolean; detail: string; path: string }> {
  const path = FILM_SET_CONTENT_FIELD;
  if (isRecord(filmSet)) {
    const findings = [];
    if (filmSet.schemaVersion === undefined) findings.push({ code: "film-set-missing-schema-version", confirmedLegacy: true, detail: "缺 schemaVersion（按 schema 1 读取，不升级为 2）", path });
    if (filmSet.items === undefined) findings.push({ code: "film-set-missing-items", confirmedLegacy: true, detail: "缺 items（按空集合读取）", path });
    return findings;
  }
  if (filmSet === null) return [{ code: "film-set-null", confirmedLegacy: true, detail: "显式 null（按空集合读取）", path }];
  return [];
}

function remapFilmSetGroupCopy(group: FilmSetGroupMarker, context: ContentCopyContext): { marker: FilmSetGroupMarker; remap: Record<string, string> } {
  const remap: Record<string, string> = {};
  const detached = new Set(group.sceneBindings.filter((binding) => binding.detached).map((binding) => binding.bindingId));
  const active = group.sceneBindings.filter((binding) => !binding.detached);
  for (const [index, clip] of (group.clips ?? []).entries()) remap[`clip:${clip.id}`] = context.createId("clip", index);
  for (const [index, binding] of group.sceneBindings.entries()) {
    const next = context.createId("film-binding", index);
    if (!binding.detached) remap[`binding:${binding.bindingId}`] = next;
  }
  const bindingId = (id: string) => {
    const next = remap[`binding:${id}`];
    if (!next) throw new Error("content-copy-binding-missing");
    return next;
  };
  const sceneBindings = active.map((binding) => {
    const sourceNodeId = context.nodeIds.get(binding.sourceNodeId);
    if (!sourceNodeId) throw new Error("content-copy-source-missing");
    return { ...binding, bindingId: bindingId(binding.bindingId), sourceNodeId };
  });
  const clips = (group.clips ?? []).map((clip) => ({
    ...clip,
    id: remap[`clip:${clip.id}`]!,
    ...(clip.bindings ? { bindings: clip.bindings.filter((binding) => !detached.has(binding.itemId)).map((binding) => ({ ...binding, itemId: bindingId(binding.itemId) })) } : {})
  }));
  const activeClip = group.activeClip ? remap[`clip:${group.activeClip}`] ?? null : group.activeClip;
  const { migration: _migration, ...orchestration } = group;
  return {
    marker: { ...orchestration, sceneBindings, clips, ...(activeClip === undefined ? {} : { activeClip }) },
    remap
  };
}

export const filmSetContentContribution: ContentContribution = {
  extensionId: FILM_SET_EXTENSION_ID,
  contentVersion: 1,
  nodeData: filmSetNodeDataCodec
};
