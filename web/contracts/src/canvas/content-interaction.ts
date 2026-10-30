/**
 * 内容 owner 的交互策略分派（change: 2026-10-28-generic-extension-content-ownership，任务 4.1）。
 *
 * 内核只问注册表：`isManagedNode` 命中谁，就由谁决定选择/删除/复制/重命名等动作。
 * 复合资产缺少 owner 时按只读处理；未声明 interaction 的 owner 使用通用行为。
 */
import type { ContentContribution, ContentContributionResolver, ContentInteractionPolicy } from "./content-contribution.js";
import { locateContentNode } from "./content-location.js";
import { isCompositeAssetNodeType } from "./domain/core/composite-asset-identity.js";

export type ContentAction = Parameters<ContentInteractionPolicy["selectionActions"]>[0];

export function contentOwnerForNode(
  content: ContentContributionResolver | undefined,
  type: string,
  data: unknown
): ContentContribution | null {
  if (!content) return null;
  const located = locateContentNode(content, type, data);
  return located.ok && located.location ? content.resolve(located.location.extensionId) : null;
}

export type ContentActionDecision = { allowed: true } | { allowed: false; reason: string };

export function resolveContentHoverPlaybackTarget(
  content: ContentContributionResolver | undefined,
  type: string,
  data: unknown
): { ownerNodeId: string; entityId: string } | null {
  const owner = contentOwnerForNode(content, type, data);
  if (!owner?.interaction) return null;
  try {
    return owner.interaction.hoverPlaybackTarget(type, data);
  } catch {
    return null;
  }
}

export function resolveContentDoubleClickTarget(
  content: ContentContributionResolver | undefined,
  type: string,
  data: unknown
): { kind: string; nodeId: string; entityId?: string } | null {
  const owner = contentOwnerForNode(content, type, data);
  if (!owner?.interaction) return null;
  try {
    return owner.interaction.doubleClickTarget(type, data);
  } catch {
    return null;
  }
}

export function decideContentAction(
  content: ContentContributionResolver | undefined,
  action: ContentAction,
  type: string,
  data: unknown
): ContentActionDecision {
  if (isCompositeAssetNodeType(type)) {
    const owner = contentOwnerForNode(content, type, data);
    if (!owner) return { allowed: false, reason: "content-owner-unavailable" };
    const policy = owner.interaction;
    if (!policy) return { allowed: true };
    try {
      return policy.selectionActions(action, type, data);
    } catch {
      return { allowed: false, reason: "content-interaction-failed" };
    }
  }
  const owner = contentOwnerForNode(content, type, data);
  const policy = owner?.interaction;
  if (!policy) return { allowed: true };
  try {
    return policy.selectionActions(action, type, data);
  } catch {
    return { allowed: false, reason: "content-interaction-failed" };
  }
}
