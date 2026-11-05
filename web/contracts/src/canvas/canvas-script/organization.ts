/**
 * Shared organization projection（change: remove-canvas-groups-and-film-set）。
 *
 * 画布组已删除，组织摘要只剩受影响节点集合；`groups` 恒为空。保留该形状是为了让
 * Canvas Script 预检回执与 Agent 工具的输出契约保持稳定，不强迫调用方改写读模型。
 */
import { effectiveCanvasNodeSize } from "../node-dimensions.js";

export type OrganizationNode = {
  id: string;
  type: string;
  title?: string;
  /** 2D 卡片布局；导演区/共享世界模型没有卡片。 */
  position?: { x: number; y: number };
  width?: number;
  height?: number;
};

export type CanvasOrganization = {
  groups: Array<{
    nodeId: string;
    title: string;
    parentId: string | null;
    memberIds: string[];
    membersComplete: boolean;
    worldBounds: { x: number; y: number; width: number; height: number };
  }>;
  affectedNodeIds: string[];
  complete: boolean;
  warnings: Array<{ code: string; nodeIds: string[]; message: string }>;
};

export function organizationWorldBounds(node: OrganizationNode) {
  const size = effectiveCanvasNodeSize(node);
  return { x: node.position?.x ?? 0, y: node.position?.y ?? 0, ...size };
}

export function projectCanvasOrganization(
  nodes: readonly OrganizationNode[],
  affectedNodeIds: readonly string[],
): CanvasOrganization {
  void nodes;
  return {
    groups: [],
    affectedNodeIds: [...affectedNodeIds],
    complete: true,
    warnings: [],
  };
}
