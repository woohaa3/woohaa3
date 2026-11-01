/**
 * 旧容器读取期迁移（change: remove-canvas-groups-and-film-set）。
 *
 * 普通组与片场都不再是产品能力：画布只保留普通节点。已有文档在读取/规范化时一次性
 * 溶解，**保留成员节点与内容、绝对位置不变**：
 *
 * - `group`（普通组或带 `filmSetGroup` 标记的片场组）：删除容器，成员提升为顶层节点；
 * - 旧 `composite-asset` 片场（`extensionId="film-set"` + `filmSetContent`）：把内容对象
 *   物化为普通卡片后删除容器；
 * - 拍摄镜头预览（`film-set-shot-preview`）是片场派生呈现，直接删除；
 * - 片场受管媒体（镜头产物）保留为普通节点，只清除归属关系；
 * - nodeData 上的组/片场专用字段统一丢弃。
 *
 * 迁移是纯函数、幂等、确定性的：迁移后的文档不再包含任何 `group` / 片场节点，
 * 再次运行不会修改输入。
 */
import type { CanvasNodeData } from "../types";
import type { Woohaa3CanvasDocument, Woohaa3CanvasSerializedNode } from "./document-schema";

const SHOT_PREVIEW_NODE_TYPE = "film-set-shot-preview";
const LEGACY_FILM_SET_EXTENSION_ID = "film-set";

/** 组与片场专用的 nodeData 字段；迁移后不得继续存在于权威文档。 */
const REMOVED_NODE_DATA_FIELDS = [
  "filmSetGroup",
  "filmSetContent",
  "filmSetAnimations",
  "filmSetObjectContainersHidden",
  "scenePlacement",
  "shotPreview",
  "filmSetObject",
  "groupAppearance",
  "groupCollapsed",
  "retainWhenEmpty",
  "groupBadgeScale"
] as const;

type Positioned = {
  id: string;
  position: { x: number; y: number };
  parentId?: string;
};

type LegacyNode = Woohaa3CanvasSerializedNode;

export type LegacyContainerMigration = {
  document: Woohaa3CanvasDocument;
  nodeData: Record<string, CanvasNodeData>;
  changed: boolean;
};

export function migrateLegacyContainerNodes(
  document: Woohaa3CanvasDocument,
  nodeData: Record<string, CanvasNodeData>
): LegacyContainerMigration {
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const removed = new Set<string>();
  const created: LegacyNode[] = [];
  const nextData: Record<string, CanvasNodeData> = { ...nodeData };

  // 1. 旧片场复合资产先物化为普通卡片，再按普通容器处理。
  for (const node of document.nodes) {
    if (node.type !== "composite-asset") continue;
    const rawData = nodeData[node.id] as Record<string, unknown> | undefined;
    if (!isLegacyFilmSetNodeData(rawData)) continue;
    const data = rawData as Record<string, unknown>;
    const legacyPosition = getAbsolutePosition(node, byId);
    const items = readLegacyItems(data);
    items.forEach((item, index) => {
      if (item.kind !== "image" && item.kind !== "video" && item.kind !== "model") return;
      const originSource = readOriginSource(item);
      if (originSource && byId.has(originSource)) return;
      const nodeId = uniqueNodeId(`${node.id}-${item.kind}-${index + 1}`, byId);
      const position = {
        x: legacyPosition.x + 32 + (index % 3) * 280,
        y: legacyPosition.y + 32 + Math.floor(index / 3) * 220
      };
      const createdNode: LegacyNode = {
        id: nodeId,
        type: item.kind === "model" ? "model3d" : item.kind,
        position
      };
      created.push(createdNode);
      byId.set(nodeId, createdNode);
      nextData[nodeId] = legacyItemNodeData(item) as CanvasNodeData;
    });
    removed.add(node.id);
  }

  // 2. 拍摄镜头预览是片场派生呈现，直接删除；受管镜头媒体保留为普通节点。
  for (const node of document.nodes) {
    if (node.type === SHOT_PREVIEW_NODE_TYPE) removed.add(node.id);
  }

  // 3. 组与片场组一律溶解：成员提升为顶层并烘焙绝对位置。
  for (const node of document.nodes) {
    if (node.type === "group") removed.add(node.id);
  }

  const allNodes = [...document.nodes, ...created];
  const keptNodes = allNodes
    .filter((node) => !removed.has(node.id))
    .map((node): LegacyNode => {
      if (!node.parentId) return node;
      const next: LegacyNode = { ...node, position: getAbsolutePosition(node, byId) };
      delete next.parentId;
      return next;
    });

  // 4. nodeData 收敛：删除已消失节点的数据，并丢弃组/片场专用字段。
  const keptIds = new Set(keptNodes.map((node) => node.id));
  for (const nodeId of Object.keys(nextData)) {
    if (!keptIds.has(nodeId)) {
      delete nextData[nodeId];
      continue;
    }
    const data = nextData[nodeId] as Record<string, unknown> | undefined;
    if (!data) continue;
    for (const field of REMOVED_NODE_DATA_FIELDS) delete data[field];
    stripFilmSetOwnership(data, removed);
  }

  const changed = removed.size > 0 || created.length > 0;
  return {
    document: changed ? { ...document, nodes: keptNodes } : document,
    nodeData: nextData,
    changed
  };
}

function isLegacyFilmSetNodeData(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  if (data.extensionId === LEGACY_FILM_SET_EXTENSION_ID) return true;
  return data.extensionId === undefined && typeof data.filmSetContent === "object" && data.filmSetContent !== null;
}

type LegacyItem = {
  id?: unknown;
  kind?: unknown;
  model?: unknown;
  assetId?: unknown;
  origin?: unknown;
  name?: unknown;
};

function readLegacyItems(data: Record<string, unknown>): LegacyItem[] {
  const content = data.filmSetContent;
  if (!content || typeof content !== "object") return [];
  const items = (content as { items?: unknown }).items;
  return Array.isArray(items) ? items.filter((item): item is LegacyItem => typeof item === "object" && item !== null) : [];
}

function readOriginSource(item: LegacyItem): string | null {
  const origin = item.origin;
  if (!origin || typeof origin !== "object") return null;
  const sourceNodeId = (origin as { sourceNodeId?: unknown }).sourceNodeId;
  return typeof sourceNodeId === "string" ? sourceNodeId : null;
}

function legacyItemNodeData(item: LegacyItem): Record<string, unknown> {
  const title = typeof item.name === "string" && item.name.trim() ? item.name : undefined;
  if (item.kind === "model") {
    const model = item.model && typeof item.model === "object" ? (item.model as Record<string, unknown>) : {};
    const { contentVersion, placement, ...rest } = model;
    return {
      ...rest,
      ...(contentVersion !== undefined ? { modelContentVersion: contentVersion } : {}),
      ...(placement !== undefined ? { modelPlacement: placement } : {}),
      title: title ?? "模型"
    };
  }
  const assetId = typeof item.assetId === "string" ? item.assetId : undefined;
  return {
    title: title ?? (item.kind === "image" ? "图片" : "视频"),
    ...(assetId ? { outputAssetId: assetId } : {})
  };
}

function stripFilmSetOwnership(data: Record<string, unknown>, removed: ReadonlySet<string>): void {
  const mediaContent = data.mediaContent;
  if (mediaContent && typeof mediaContent === "object") {
    const payload = (mediaContent as { payload?: unknown }).payload;
    if (payload && typeof payload === "object" && "filmSetNodeId" in payload) {
      delete (payload as Record<string, unknown>).filmSetNodeId;
    }
  }
  const managedBy = data.managedBy;
  if (managedBy && typeof managedBy === "object") {
    const ownerNodeId = (managedBy as { ownerNodeId?: unknown }).ownerNodeId;
    if (typeof ownerNodeId === "string" && removed.has(ownerNodeId)) delete data.managedBy;
  }
}

function uniqueNodeId(candidate: string, byId: ReadonlyMap<string, unknown>): string {
  if (!byId.has(candidate)) return candidate;
  let suffix = 2;
  while (byId.has(`${candidate}-${suffix}`)) suffix += 1;
  return `${candidate}-${suffix}`;
}

function getAbsolutePosition(node: Positioned, byId: ReadonlyMap<string, Positioned>): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let cursor = node.parentId;
  const guard = new Set<string>([node.id]);
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    const parent = byId.get(cursor);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    cursor = parent.parentId;
  }
  return { x, y };
}
