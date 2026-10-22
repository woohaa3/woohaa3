import { decodeFilmSetContent } from "./legacy-film-set-content.js";
/** Offline migration identity planning. Never import from a production entrypoint. */
import { createHash } from "node:crypto";
import { isBoundedId, isJsonObject } from "@woohaa3/contracts";

export type LegacyFilmSetIdentityRecord = { canvasId: string; nodeId: string; nodeData: unknown };
export type LegacyFilmSetItemIdentity = { canvasId: string; nodeId: string; topModelItemId: string };
export type LegacyFilmSetIdentityPlan =
  | { ok: true; mappings: LegacyFilmSetItemIdentity[]; reservedItemIds: string[] }
  | { ok: false; reason: string };

/** JSON tuple encoding keeps IDs containing separators distinct. */
export const legacyFilmSetIdentityKey = (canvasId: string, nodeId: string): string => JSON.stringify([canvasId, nodeId]);

/**
 * Precollect every canonical/history/completion/resource snapshot before allocating any ID.
 * Persist mappings in the migration manifest and pass them back on a resumed/verified run.
 * This only plans IDs; callers must still validate and migrate each complete payload atomically.
 */
export function planLegacyFilmSetItemIdentities(
  records: readonly LegacyFilmSetIdentityRecord[],
  previousMappings: readonly LegacyFilmSetItemIdentity[] = []
): LegacyFilmSetIdentityPlan {
  const reserved = new Set<string>();
  const owners = new Map<string, { canvasId: string; nodeId: string }>();
  for (const [index, record] of records.entries()) {
    if (!isJsonObject(record) || !isBoundedId(record.canvasId) || !record.canvasId || !isBoundedId(record.nodeId) || !record.nodeId) {
      return { ok: false, reason: `迁移记录 ${index} 的画布或节点身份非法` };
    }
    if (!isJsonObject(record.nodeData)) return { ok: false, reason: `迁移记录 ${index} 的 nodeData 必须是对象` };
    const content = decodeFilmSetContent(record.nodeData.filmSetContent);
    if (!content.ok) return { ok: false, reason: `迁移记录 ${index} 无法完整预收集 item 身份：${content.reason}` };
    for (const item of content.value.items) reserved.add(item.id);
    owners.set(legacyFilmSetIdentityKey(record.canvasId, record.nodeId), { canvasId: record.canvasId, nodeId: record.nodeId });
  }
  const allocated = new Map<string, LegacyFilmSetItemIdentity>();
  const claimed = new Set<string>();
  for (const mapping of previousMappings) {
    if (!isJsonObject(mapping) || !isBoundedId(mapping.canvasId) || !mapping.canvasId || !isBoundedId(mapping.nodeId) || !mapping.nodeId
      || !isBoundedId(mapping.topModelItemId) || !mapping.topModelItemId) {
      return { ok: false, reason: "已保存的迁移 item 映射身份非法" };
    }
    const key = legacyFilmSetIdentityKey(mapping.canvasId, mapping.nodeId);
    if (allocated.has(key) || claimed.has(mapping.topModelItemId)) return { ok: false, reason: "已保存的迁移 item 映射重复或跨节点冲突" };
    allocated.set(key, { ...mapping });
    claimed.add(mapping.topModelItemId);
  }
  for (const key of [...owners.keys()].sort()) {
    if (allocated.has(key)) continue;
    const base = `migrated-model-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
    let itemId = base;
    for (let suffix = 2; reserved.has(itemId) || claimed.has(itemId); suffix += 1) itemId = `${base}-${suffix}`;
    allocated.set(key, { ...owners.get(key)!, topModelItemId: itemId });
    claimed.add(itemId);
  }
  return {
    ok: true,
    mappings: [...allocated.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, mapping]) => mapping),
    reservedItemIds: [...reserved].sort()
  };
}
