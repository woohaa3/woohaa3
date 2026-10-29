import { groupBadgeRect } from "./group-badge.js";
import type { ServerCanvas, Woohaa3CanvasSerializedNode } from "./domain/index.js";

/** 展示状态只折叠后代；结构、成员局部位置及用户设置的展开尺寸始终保留。 */
export function hiddenByCollapsedGroups(canvas: ServerCanvas): Set<string> {
  const children = new Map<string, string[]>();
  const pending: string[] = [];
  for (const node of canvas.document.nodes) {
    if (node.parentId) {
      const ids = children.get(node.parentId) ?? [];
      ids.push(node.id);
      children.set(node.parentId, ids);
    }
    if (node.type === "group" && canvas.nodeData[node.id]?.groupCollapsed === true) pending.push(node.id);
  }
  const hidden = new Set<string>();
  for (let at = 0; at < pending.length; at++) {
    for (const id of children.get(pending[at]!) ?? []) {
      if (hidden.has(id)) continue;
      hidden.add(id);
      pending.push(id);
    }
  }
  return hidden;
}

/** 收起后只占用徽标范围；展开结构矩形保留，用于恢复布局及稳定徽标位置。 */
export function groupPresentationRect(
  node: Pick<Woohaa3CanvasSerializedNode, "type">,
  collapsed: boolean,
  rect: { x: number; y: number; width: number; height: number },
  badgeScale = 1,
): { x: number; y: number; width: number; height: number } {
  if (node.type !== "group" || !collapsed) return rect;
  const { x, y, width, height } = groupBadgeRect(rect, badgeScale);
  return { x, y, width, height };
}
