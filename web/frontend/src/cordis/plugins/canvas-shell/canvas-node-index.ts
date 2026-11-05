/**
 * 按 working document 身份缓存的结构/位置索引
 * （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D5；
 *   change: remove-canvas-groups-and-film-set —— 画布只保留普通节点，位置即绝对坐标）。
 *
 * 交互 owner 只维护一份可丢弃 `byId`、`liveIds` 与绝对坐标派生：key 为 working canvas
 * 对象身份（store 仅在结构与位置输入变化时替换该对象），因此 selection / pan/zoom 不使其
 * 失效，而 pending / 远端结构与位置变化会产生新对象并正确失效。
 *
 * 不复制带 `data` 的完整节点数组；重复的手势（按下 origin 解析、拖动根过滤、释放规划）
 * 复用同一张表。
 */
import {
  effectiveCanvasNodeSize,
  isMergeEligibleNode,
  type MergeTargetCandidate,
  type ServerCanvas
} from "@woohaa3/contracts";
import type { DropRect } from "./hit-test.js";
import { modelSceneStore } from "../model-scene/model-scene-store.js";

/** 结构/位置索引（丢弃后可重建，不持有规范事实副本）。 */
export type CanvasNodeIndex = {
  /** 来源 working canvas（身份 key）。 */
  readonly source: ServerCanvas;
  /** Stable document-order runtime view built once with the working identity. */
  readonly orderedNodes: readonly ServerCanvas["document"]["nodes"][number][];
  /** id → 节点（直接引用来源节点，不复制；contract helper 不读取 `data`）。 */
  readonly byId: ReadonlyMap<string, ServerCanvas["document"]["nodes"][number]>;
  /** 当前存活节点 id 集合（失效 selection / 粘连 owner 判定）。 */
  readonly liveIds: ReadonlySet<string>;
  /** 旧组折叠呈现遗留：画布已无容器，恒为空集合。 */
  readonly hiddenNodeIds: ReadonlySet<string>;
  /** Complete working AABB facts, including off-screen nodes. */
  readonly workingBounds: readonly ({ id: string } & DropRect)[];
  /**
   * 同类型合并候选：按节点 `type` 分桶的可见 working 几何（文档顺序）。
   *
   * 只收 v1 范围内且可参与合并的节点（change: 2026-10-27-merge-same-type-node-history，
   * 任务 2.1 / design D1）。
   */
  readonly mergeRectsByType: ReadonlyMap<string, readonly MergeTargetCandidate[]>;
  /** Query cached working bounds; pan/zoom and pointermove never rebuild it. */
  readonly queryWorkingAabb: (rect: DropRect) => readonly ({ id: string } & DropRect)[];
  readonly children: ReadonlyMap<string, readonly string[]>;
  /** Canonical document tie-break order, derived once per source identity. */
  readonly documentOrder: ReadonlyMap<string, number>;
  /** 节点绝对坐标；不存在返回 `null`。 */
  absolutePosition(id: string): { x: number; y: number } | null;
  /** 拖动原点集合（画布无嵌套，恒等返回副本）。 */
  dragRoots(origins: ReadonlyMap<string, { x: number; y: number }>): Map<string, { x: number; y: number }>;
  /** 节点的父级绝对坐标（无父级返回 `{x:0,y:0}`）。 */
  parentAbsolutePosition(id: string): { x: number; y: number };
};

/** 就地构造索引；`canvas` 为 null 时返回 null。 */
export function createCanvasNodeIndex(canvas: ServerCanvas | null): CanvasNodeIndex | null {
  if (!canvas) return null;
  const nodes = canvas.document.nodes;
  // 直接引用来源节点：contract 几何 helper 只读 id/type/position/width/height，
  // 不读取 renderer-only 的 `data`。避免每次手势复制整表。
  const byId = new Map<string, ServerCanvas["document"]["nodes"][number]>();
  for (const node of nodes) byId.set(node.id, node);
  const positions = new Map<string, { x: number; y: number }>();
  const documentOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const absolutePosition = (id: string): { x: number; y: number } | null => {
    const cached = positions.get(id);
    if (cached) return cached;
    const node = byId.get(id);
    if (!node?.position) return null;
    const position = { x: node.position.x, y: node.position.y };
    positions.set(id, position);
    return position;
  };
  const workingBounds = nodes.flatMap(node => {
    const position = absolutePosition(node.id);
    if (!position) return [];
    const size = indexNodeSize(node);
    return [{ id: node.id, x: position.x, y: position.y, width: size.width, height: size.height }];
  });
  // 合并候选按类型分桶：只收可合并的节点，保持文档顺序（同距离时后者优先）。
  const mergeRectsByType = new Map<string, MergeTargetCandidate[]>();
  for (const node of nodes) {
    if (!isMergeEligibleNode({ node, data: canvas.nodeData[node.id] })) continue;
    const position = absolutePosition(node.id);
    if (!position) continue;
    const size = indexNodeSize(node);
    const bucket = mergeRectsByType.get(node.type) ?? [];
    bucket.push({
      nodeId: node.id,
      type: node.type,
      x: position.x,
      y: position.y,
      width: size.width,
      height: size.height
    });
    mergeRectsByType.set(node.type, bucket);
  }
  return {
    source: canvas,
    orderedNodes: [...byId.values()],
    byId,
    children: new Map(),
    documentOrder,
    liveIds: new Set(byId.keys()),
    hiddenNodeIds: new Set(),
    workingBounds,
    mergeRectsByType,
    queryWorkingAabb: (rect) => {
      if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return [];
      return workingBounds.filter(entry => entry.x < rect.x + rect.width && entry.x + entry.width > rect.x
        && entry.y < rect.y + rect.height && entry.y + entry.height > rect.y);
    },
    absolutePosition,
    parentAbsolutePosition: (id) => {
      const parentId = byId.get(id)?.parentId;
      return parentId ? absolutePosition(parentId) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
    },
    dragRoots: (origins) => new Map([...origins].map(([id, origin]) => [id, { ...origin }]))
  };
}

/** 读取节点宽高（共享 fallback），供纯逻辑规划复用。 */
export function indexNodeSize(node: ServerCanvas["document"]["nodes"][number]): { width: number; height: number } {
  return effectiveCanvasNodeSize(node);
}

/** 单槽 memo：working canvas 对象身份 + prepared 模型修订号。 */
let memoSource: ServerCanvas | null = null;
let memoRevision = -1;
let memoIndex: CanvasNodeIndex | null = null;

/** 返回与来源身份匹配的共享索引；身份或模型资源变化时重建（丢弃旧索引）。 */
export function sharedCanvasNodeIndex(canvas: ServerCanvas | null): CanvasNodeIndex | null {
  const revision = modelSceneStore.getRevision();
  if (canvas === memoSource && revision === memoRevision) return memoIndex;
  memoSource = canvas;
  memoRevision = revision;
  memoIndex = createCanvasNodeIndex(canvas);
  return memoIndex;
}
