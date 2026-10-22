/**
 * 游戏炼丹炉素材字段草稿（纯逻辑，任务 5.4/5.5）
 * （change: 2026-10-10-add-game-furnace-extension）。
 *
 * 素材名称/分类/描述按 **resourceId + 字段** 合并：草稿键是稳定的 resourceId，因此远端新增
 * 其它素材、任务消息或一次重渲染都不会清空正在编辑的字段。提交时只下发相对权威值**真正变化**
 * 的字段（同字段冲突由服务端逐字段裁决并可诊断），不做整表覆盖。
 *
 * 每个字段还记录**编辑时的权威基线**（`base`）：若提交前权威值已被远端改动，则该字段判为冲突，
 * 提交被拒绝并给出可诊断信息，避免静默覆盖并发编辑。
 *
 * 纯函数：不 import 宿主 store、DOM 或 Node API。
 */
import type { GameResource } from "../shared/index.js";

/** 单个字段的草稿：用户值 + 编辑时基线。 */
export type ResourceFieldDraft = { value: string; base: string };

/** 单项素材的可编辑字段草稿。 */
export type ResourceFieldPatch = Partial<Record<"name" | "category" | "description", ResourceFieldDraft>>;

/** 按 resourceId 索引的草稿。 */
export type ResourceDraft = Record<string, ResourceFieldPatch>;

const FIELDS = ["name", "category", "description"] as const;

/** 在权威素材上应用草稿用于呈现（缺省字段保留权威值）。 */
export function mergedResource(resource: GameResource, patch: ResourceFieldPatch | undefined): GameResource {
  if (!patch) return resource;
  const pick = (field: (typeof FIELDS)[number]) => patch[field]?.value;
  return {
    ...resource,
    ...(pick("name") !== undefined ? { name: pick("name")! } : {}),
    ...(pick("category") !== undefined ? { category: pick("category")! } : {}),
    ...(pick("description") !== undefined ? { description: pick("description")! } : {})
  };
}

/** 草稿相对权威值真正变化的字段（用于脏标记与提交）。 */
export function dirtyResourceFields(resource: GameResource, patch: ResourceFieldPatch | undefined): (keyof ResourceFieldPatch)[] {
  if (!patch) return [];
  const dirty: (keyof ResourceFieldPatch)[] = [];
  for (const field of FIELDS) {
    const entry = patch[field];
    if (!entry) continue;
    if (entry.value !== resource[field]) dirty.push(field);
  }
  return dirty;
}

/** 编辑期间被远端改动、与草稿基线不一致的字段（同字段冲突，可诊断）。 */
export function conflictedResourceFields(resource: GameResource, patch: ResourceFieldPatch | undefined): (keyof ResourceFieldPatch)[] {
  if (!patch) return [];
  const conflicts: (keyof ResourceFieldPatch)[] = [];
  for (const field of FIELDS) {
    const entry = patch[field];
    if (!entry) continue;
    // 权威值已偏离编辑基线，且用户值确实仍想改这个字段 → 冲突。
    if (entry.base !== resource[field] && entry.value !== resource[field]) conflicts.push(field);
  }
  return conflicts;
}

/** 存在脏字段的 resourceId 列表（稳定顺序）。 */
export function dirtyResourceIds(resources: readonly GameResource[], draft: ResourceDraft): string[] {
  return resources.filter((resource) => dirtyResourceFields(resource, draft[resource.resourceId]).length > 0).map((resource) => resource.resourceId);
}

/** 检测到同字段冲突的素材与字段（供 UI 诊断，不静默覆盖）。 */
export function resourceConflicts(
  resources: readonly GameResource[],
  draft: ResourceDraft
): { resourceId: string; fields: (keyof ResourceFieldPatch)[] }[] {
  const out: { resourceId: string; fields: (keyof ResourceFieldPatch)[] }[] = [];
  for (const resource of resources) {
    const fields = conflictedResourceFields(resource, draft[resource.resourceId]);
    if (fields.length > 0) out.push({ resourceId: resource.resourceId, fields });
  }
  return out;
}

/**
 * 构造逐字段提交的 `resources.update` 操作（任务 5.5）。
 *
 * 只包含真正变化、且与基线一致的字段；存在冲突字段时返回 `{ conflict }`，调用方拒绝整批并
 * 提示用户刷新（不静默覆盖并发编辑）。无任何变化返回 `null`。
 */
export function planResourceUpdate(
  resources: readonly GameResource[],
  draft: ResourceDraft
): { ok: true; operation: { type: "resources.update"; updates: { resourceId: string; name?: string; category?: string; description?: string }[] } } | { ok: false; conflicts: { resourceId: string; fields: (keyof ResourceFieldPatch)[] }[] } | null {
  const conflicts = resourceConflicts(resources, draft);
  if (conflicts.length > 0) return { ok: false, conflicts };
  const updates: { resourceId: string; name?: string; category?: string; description?: string }[] = [];
  for (const resource of resources) {
    const patch = draft[resource.resourceId];
    const dirty = dirtyResourceFields(resource, patch);
    if (dirty.length === 0 || !patch) continue;
    const update: { resourceId: string; name?: string; category?: string; description?: string } = { resourceId: resource.resourceId };
    for (const field of dirty) update[field] = patch[field]!.value;
    updates.push(update);
  }
  if (updates.length === 0) return null;
  return { ok: true, operation: { type: "resources.update", updates } };
}

/** 提交成功后清除指定素材的草稿字段（保留其它素材的编辑）。 */
export function clearResourceDraft(draft: ResourceDraft, resourceIds: readonly string[]): ResourceDraft {
  const next: ResourceDraft = { ...draft };
  for (const id of resourceIds) delete next[id];
  return next;
}
