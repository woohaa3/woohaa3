/**
 * 统一内容 owner 定位（change: 2026-10-28-generic-extension-content-ownership，任务 1.1）。
 *
 * 定位只回答「这段数据声明属于谁」，不回答「是否可信」：注册表解析与写入授权仍由
 * `ContentContributionResolver` 决定。因此停用/缺失的扩展仍能被定位，原始字段不会被删除。
 *
 * 支持的声明来源：
 * - 复合资产 `nodeData.extensionId`；
 * - 托管成员 `nodeData.managedBy.extensionId`；
 * - 扩展 descriptor 的 `ownerLocators`（节点类别 + 显式身份字段）；
 * - 扩展 group marker（由 owner 的 `interaction.isManagedNode` 声明，内核不认识具体字段）。
 */
import { readCompositeAssetExtensionId, isCompositeAssetNodeType } from "./domain/core/composite-asset-identity.js";
import { managedNodeRelationOf } from "./managed-node.js";
import type { ContentContributionResolver } from "./content-contribution.js";

export type ContentLocationSource = "composite" | "managed" | "group" | "locator";

export type ContentNodeLocation = {
  extensionId: string;
  sources: readonly ContentLocationSource[];
  entityId?: string;
  ownerNodeId?: string;
};

export type ContentLocationResult =
  | { ok: true; location: ContentNodeLocation | null }
  | { ok: false; code: "content-location-conflict" | "content-location-invalid" };

/** 定位冲突/非法字段稳定返回错误；普通节点没有 owner 时返回 ok + null。 */
export function locateContentNode(
  content: ContentContributionResolver | undefined,
  type: string,
  data: unknown
): ContentLocationResult {
  const found: Array<{ extensionId: string; source: ContentLocationSource; entityId?: string; ownerNodeId?: string }> = [];

  if (isCompositeAssetNodeType(type)) {
    const extensionId = readCompositeAssetExtensionId(data);
    const raw = typeof data === "object" && data !== null ? (data as { extensionId?: unknown }).extensionId : undefined;
    if (raw !== undefined && extensionId === null) return { ok: false, code: "content-location-invalid" };
    if (extensionId) found.push({ extensionId, source: "composite" });
  }

  const rawManaged = typeof data === "object" && data !== null ? (data as { managedBy?: unknown }).managedBy : undefined;
  if (rawManaged !== undefined) {
    const relation = managedNodeRelationOf(data);
    if (!relation) return { ok: false, code: "content-location-invalid" };
    found.push({
      extensionId: relation.extensionId,
      source: "managed",
      entityId: relation.entityId,
      ownerNodeId: relation.ownerNodeId
    });
  }

  const record = typeof data === "object" && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const locators = content?.locators?.() ?? (content?.implementations() ?? []).map((contribution) => ({
    extensionId: contribution.extensionId,
    ownerLocators: contribution.ownerLocators ?? []
  }));
  for (const { extensionId, ownerLocators } of locators) {
    for (const locator of ownerLocators) {
      if (locator.nodeTypes.includes(type) && locator.fields.some((field) => record !== null && Object.hasOwn(record, field))) {
        found.push({ extensionId, source: "locator" });
      }
    }
  }
  for (const contribution of content?.implementations() ?? []) {
    try {
      if (contribution.interaction?.isManagedNode(type, data)) {
        found.push({ extensionId: contribution.extensionId, source: "group" });
      }
    } catch {
      // 单个 owner 的定位器失败按未命中处理，不能拖垮整帧。
    }
  }

  const extensionIds = [...new Set(found.map((entry) => entry.extensionId))];
  if (extensionIds.length > 1) return { ok: false, code: "content-location-conflict" };
  if (extensionIds.length === 0) return { ok: true, location: null };

  const primary = found.find((entry) => entry.extensionId === extensionIds[0]!)!;
  return {
    ok: true,
    location: {
      extensionId: primary.extensionId,
      sources: [...new Set(found.map((entry) => entry.source))],
      ...(primary.entityId ? { entityId: primary.entityId } : {}),
      ...(primary.ownerNodeId ? { ownerNodeId: primary.ownerNodeId } : {})
    }
  };
}
