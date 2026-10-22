/** Shared organization projection. Positions remain canonical parent coordinates. */
import { effectiveCanvasNodeSize } from "../node-dimensions.js";

export type OrganizationNode = {
  id: string;
  type: string;
  parentId?: string;
  title?: string;
  retainWhenEmpty?: boolean;
  position: { x: number; y: number };
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

export function organizationWorldBounds(
  node: OrganizationNode,
  nodes: ReadonlyMap<string, OrganizationNode>,
) {
  let { x, y } = node.position;
  let parentId = node.parentId;
  const seen = new Set([node.id]);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = nodes.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y, ...effectiveCanvasNodeSize(node) };
}

export function projectCanvasOrganization(
  nodes: readonly OrganizationNode[],
  affectedNodeIds: readonly string[],
  edges: readonly { source: string; target: string }[] = [],
): CanvasOrganization {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const affected = new Set(affectedNodeIds);
  let remainingMembers = 256;
  const organization: CanvasOrganization = {
    groups: [],
    affectedNodeIds: [...affected],
    complete: true,
    warnings: [],
  };
  for (const n of nodes) {
    if (n.type !== "group" || !affected.has(n.id)) continue;
    const members = nodes
      .filter((child) => child.parentId === n.id)
      .map((child) => child.id);
    const memberIds = members.slice(0, remainingMembers);
    remainingMembers -= memberIds.length;
    const membersComplete = memberIds.length === members.length;
    if (!membersComplete) organization.complete = false;
    organization.groups.push({
      nodeId: n.id,
      title: n.title ?? "",
      parentId: n.parentId ?? null,
      memberIds,
      membersComplete,
      worldBounds: organizationWorldBounds(n, byId),
    });
    // Parent containment is intentional. Warn only about overlapping siblings.
    const a = organizationWorldBounds(n, byId);
    for (const other of nodes) {
      if (other.id === n.id || other.parentId !== n.parentId) continue;
      const b = organizationWorldBounds(other, byId);
      if (
        a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y
      ) {
        if (organization.warnings.length >= 64) {
          organization.complete = false;
          break;
        }
        if (
          organization.warnings.some(
            (w) => w.nodeIds.includes(n.id) && w.nodeIds.includes(other.id),
          )
        )
          continue;
        organization.warnings.push({
          code: "overlap",
          nodeIds: [n.id, other.id],
          message:
            "分类组与同层对象重叠，请调整 placement 或 layout 后重新预检",
        });
      }
    }
  }
  const connected = new Set(
    edges.flatMap((edge) => [edge.source, edge.target]),
  );
  const ungrouped = nodes.filter(
    (n) =>
      affected.has(n.id) &&
      n.type !== "group" &&
      !n.parentId &&
      !connected.has(n.id),
  );
  if (ungrouped.length)
    organization.warnings.push({
      code: "ungrouped",
      nodeIds: ungrouped.slice(0, 256).map((n) => n.id),
      message: "独立素材尚未归入分类组；素材库请使用 canvas.group 按用途整理",
    });
  if (!organization.complete)
    organization.warnings.push({
      code: "summary-truncated",
      nodeIds: [],
      message:
        "组织摘要已裁剪；已保存对象按同 revision 分页读回，未提交计划请缩小后重新预检",
    });
  return organization;
}
