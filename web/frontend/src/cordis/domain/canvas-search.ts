/**
 * 画布作品查找（change: 2026-10-09-improve-canvas-workflow，任务 4.2 / design D6）。
 *
 * 按当前画布共用名称（显式名/已提交摘要）、中文类型与类型 ID 搜索，可叠加类型筛选；
 * 结果含名称、类型与所属组，同名用组名及短 ID 辅助区分；按显示名、nodeId 稳定排序。
 *
 * 只搜索当前已授权文档；不读取完整参数、任务审计或其它画布。纯函数：可从规范画布变更
 * 驱动的索引调用，不逐帧扫描。
 */
import type { ServerCanvas, CanvasNodeData } from "@woohaa3/contracts";
import { contentTypeLabelForNode, resolveNodeDisplayName } from "@woohaa3/contracts";

export type CanvasSearchKind = "text" | "image" | "video" | "audio" | "model3d" | "composite-asset";

export type CanvasSearchResult = {
  nodeId: string;
  /** 显示名称。 */
  name: string;
  /** 中文类型标记。 */
  typeLabel: string;
  /** 节点类型 ID。 */
  type: string;
  /** 所属组名（无组为 null）。 */
  groupName: string | null;
  /** 同名区分用短 ID。 */
  shortId: string;
};

export type CanvasSearchQuery = {
  query: string;
  /** 类型筛选（空表示全部）。 */
  kinds?: readonly string[];
};

/** 可搜索的节点类型（结构容器 group 也纳入，便于按名称定位）。 */
const SEARCHABLE_EXTRA: readonly string[] = ["group"];

export function searchCanvasNodes(canvas: ServerCanvas, input: CanvasSearchQuery): CanvasSearchResult[] {
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  // 先构建完整名称表，保证组名可解析（不依赖节点顺序）。
  const nameById = new Map<string, string>();
  for (const node of canvas.document.nodes) {
    const data = nodeData[node.id];
    nameById.set(node.id, resolveNodeDisplayName({
      type: node.type,
      explicitName: data?.title,
      prompt: data?.prompt
    }).displayName);
  }

  const results: CanvasSearchResult[] = [];
  for (const node of canvas.document.nodes) {
    if (input.kinds && input.kinds.length > 0 && !input.kinds.includes(node.type)) {
      if (!SEARCHABLE_EXTRA.includes(node.type)) continue;
    }
    results.push({
      nodeId: node.id,
      name: nameById.get(node.id)!,
      typeLabel: contentTypeLabelForNode(node.type),
      type: node.type,
      groupName: node.parentId ? nameById.get(node.parentId) ?? null : null,
      shortId: node.id.slice(-4)
    });
  }

  const normalized = input.query.trim().toLowerCase();
  const filtered = normalized === ""
    ? results
    : results.filter((result) =>
        result.name.toLowerCase().includes(normalized)
        || result.typeLabel.toLowerCase().includes(normalized)
        || result.type.toLowerCase().includes(normalized)
      );

  return filtered.sort((left, right) => {
    if (left.name !== right.name) return left.name < right.name ? -1 : 1;
    return left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0;
  });
}
