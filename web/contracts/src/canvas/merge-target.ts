/**
 * 同类型节点合并：拖动期目标判定与节点资格
 * （change: 2026-10-27-merge-same-type-node-history，任务 1.1 / design D1、D8）。
 *
 * 纯函数：不依赖 DOM、Bevy、store 或任何服务。前端拖动热路径与 Canvas Service 的
 * 合并写面共用同一份「什么节点可以参与合并」的判定，避免两侧规则漂移。
 *
 * 判定规则：
 * - 只接受与来源 `type` **完全相同**的可见候选；
 * - 拖动中心落在目标完整矩形内（`100%×100%`，即 `|dx| ≤ 0.5·W`、`|dy| ≤ 0.5·H`）；
 * - 多个候选取中心距离最小者；距离相同按文档顺序取**后者**（视觉上层）；
 * - 退化矩形（非有限值或非正尺寸）永不命中。
 */
import { nodeHistoryKindForNodeType } from "./node-history/identity.js";
import { managedNodeRelationOf } from "./managed-node.js";
import { isFilmSetObjectContainerNode } from "./film-set-object-container.js";
import { FILM_SET_SHOT_PREVIEW_NODE_TYPE } from "./domain/core/shot-preview-node.js";
import type { Woohaa3CanvasNode } from "./domain/index.js";

/**
 * 合并目标中心命中比例（目标完整矩形，100%×100%）。
 *
 * 常量集中一处，便于产品调整；判定函数只读它，不各自写魔法数。
 */
export const MERGE_TARGET_CENTER_RATIO = 1;

/**
 * v1 允许合并的节点类型。
 *
 * `composite-asset`（片场/炉体等复合资产）刻意排除：合并会替换内容并删除来源节点，
 * 涉及托管镜头预览的生命周期重建，留待单独验证（design D8）。
 */
export const MERGEABLE_NODE_TYPES = ["text", "image", "video", "audio", "model3d"] as const;

export type MergeableNodeType = (typeof MERGEABLE_NODE_TYPES)[number];

export function isMergeableNodeType(type: string): type is MergeableNodeType {
  return (MERGEABLE_NODE_TYPES as readonly string[]).includes(type);
}

/**
 * 节点是否可参与合并（作为来源或目标）。
 *
 * 排除组、托管节点、拍摄镜头预览与片场对象容器；类型必须属于 v1 范围且承载历史种类。
 * 共享给拖动候选过滤与 Canvas Service 校验。
 */
export function isMergeEligibleNode(input: {
  node: Pick<Woohaa3CanvasNode, "id" | "type">;
  data: unknown;
}): boolean {
  const { node, data } = input;
  if (!isMergeableNodeType(node.type)) return false;
  if (!nodeHistoryKindForNodeType(node.type)) return false;
  // 拍摄镜头预览类型本身不在 v1 范围内（上面的类型判定已排除）；保留显式断言避免未来放宽
  // 类型范围时把预览当成可合并目标。
  if ((node.type as string) === FILM_SET_SHOT_PREVIEW_NODE_TYPE) return false;
  if (managedNodeRelationOf(data)) return false;
  if (isFilmSetObjectContainerNode(node, data)) return false;
  return true;
}

/** 拖动期候选：目标节点的 working 矩形（世界坐标，含有效尺寸）。 */
export type MergeTargetCandidate = {
  nodeId: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MergeTargetResolution = {
  nodeId: string;
  /** 拖动中心到目标中心的欧氏距离（用于多候选确定性选择）。 */
  distance: number;
};

/**
 * 在拖动中心命中的同类型候选里取唯一目标；无合法候选返回 `null`。
 *
 * `candidates` 必须按文档顺序（越靠后越上层）；同距离时后者胜出。
 */
export function resolveMergeTarget(input: {
  sourceType: string;
  center: { x: number; y: number };
  candidates: readonly MergeTargetCandidate[];
  excludeNodeIds?: ReadonlySet<string>;
}): MergeTargetResolution | null {
  const { sourceType, center } = input;
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return null;
  const halfRatio = MERGE_TARGET_CENTER_RATIO / 2;
  let best: MergeTargetResolution | null = null;
  for (const candidate of input.candidates) {
    if (candidate.type !== sourceType) continue;
    if (input.excludeNodeIds?.has(candidate.nodeId)) continue;
    const { width, height } = candidate;
    if (![candidate.x, candidate.y, width, height].every(Number.isFinite)) continue;
    if (width <= 0 || height <= 0) continue;
    const centerX = candidate.x + width / 2;
    const centerY = candidate.y + height / 2;
    const dx = center.x - centerX;
    const dy = center.y - centerY;
    if (Math.abs(dx) > halfRatio * width) continue;
    if (Math.abs(dy) > halfRatio * height) continue;
    const distance = Math.hypot(dx, dy);
    // 同距离取文档顺序更靠后的候选（视觉上层）；`>=` 让后者替换前者。
    if (!best || distance <= best.distance) best = { nodeId: candidate.nodeId, distance };
  }
  return best;
}
