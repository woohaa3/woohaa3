/**
 * 聚焦连接圆点派生（纯逻辑）
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 7.1 / design D3）。
 *
 * 从当前权威 `document.edges` 派生聚焦节点的直接前序/后序集合：按方向分组、按 nodeId 去重，
 * 入边优先使用合法 `inputMapping.sortKey` 排序，其余按稳定节点顺序与 ID。**不**计算传递依赖、
 * 不改变拓扑、不提交命令。集合实时随 canonical 更新，但不重置聚焦草稿。
 */
import type { ServerCanvas } from "@woohaa3/contracts";

export type ConnectionDot = {
  nodeId: string;
  /** 相邻节点类型（预览分派用）。 */
  nodeType: string;
  /** 安全节点标题（用户可见标题；缺失时按类型回退）。 */
  nodeTitle: string;
};

export type FocusConnections = {
  incoming: ConnectionDot[];
  outgoing: ConnectionDot[];
};

/** 从 canonical 画布派生聚焦节点的直接连接。 */
export function deriveFocusConnections(canvas: ServerCanvas | null, focusNodeId: string): FocusConnections {
  if (!canvas || !focusNodeId) return { incoming: [], outgoing: [] };
  const nodeById = new Map(canvas.document.nodes.map((node) => [node.id, node]));
  const nodeOrder = new Map(canvas.document.nodes.map((node, index) => [node.id, index]));
  const focusData = canvas.nodeData[focusNodeId] as { inputMapping?: unknown } | undefined;
  const sortKeys = inputMappingSortKeys(focusData?.inputMapping);

  const incomingIds = new Set<string>();
  const outgoingIds = new Set<string>();
  for (const edge of canvas.document.edges) {
    if (edge.target === focusNodeId && edge.source !== focusNodeId && nodeById.has(edge.source)) incomingIds.add(edge.source);
    if (edge.source === focusNodeId && edge.target !== focusNodeId && nodeById.has(edge.target)) outgoingIds.add(edge.target);
  }

  const toDot = (nodeId: string): ConnectionDot => {
    const node = nodeById.get(nodeId)!;
    return { nodeId, nodeType: node.type, nodeTitle: nodeTitleOf(canvas, nodeId) };
  };
  const stableSort = (ids: Set<string>, useSortKey: boolean): ConnectionDot[] =>
    [...ids]
      .map(toDot)
      .sort((a, b) => {
        if (useSortKey) {
          const aKey = sortKeys.get(a.nodeId);
          const bKey = sortKeys.get(b.nodeId);
          // 有合法 sortKey 的入边优先，再按 sortKey；无 sortKey 的按节点顺序。
          if (aKey !== undefined && bKey === undefined) return -1;
          if (aKey === undefined && bKey !== undefined) return 1;
          if (aKey !== undefined && bKey !== undefined && aKey !== bKey) return aKey < bKey ? -1 : 1;
        }
        const orderA = nodeOrder.get(a.nodeId) ?? 0;
        const orderB = nodeOrder.get(b.nodeId) ?? 0;
        if (orderA !== orderB) return orderA - orderB;
        return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
      });

  return { incoming: stableSort(incomingIds, true), outgoing: stableSort(outgoingIds, false) };
}

function inputMappingSortKeys(input: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(input)) return map;
  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { sourceNodeId?: unknown; sortKey?: unknown };
    if (typeof record.sourceNodeId === "string" && typeof record.sortKey === "string" && record.sortKey !== "") {
      map.set(record.sourceNodeId, record.sortKey);
    }
  }
  return map;
}

function nodeTitleOf(canvas: ServerCanvas, nodeId: string): string {
  const data = canvas.nodeData[nodeId] as { title?: unknown } | undefined;
  const title = typeof data?.title === "string" ? data.title.trim() : "";
  if (title) return title;
  const node = canvas.document.nodes.find((candidate) => candidate.id === nodeId);
  return fallbackTitle(node?.type ?? "");
}

function fallbackTitle(type: string): string {
  switch (type) {
    case "text":
      return "文本节点";
    case "image":
      return "图片节点";
    case "video":
      return "视频节点";
    case "audio":
      return "音频节点";
    case "model3d":
    case "composite-asset":
      return "模型节点";
    default:
      return "节点";
  }
}
