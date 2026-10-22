/**
 * 按 working document 身份缓存的结构/位置索引
 * （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D5）。
 *
 * 交互 owner 只维护一份可丢弃 `byId`、`liveIds` 与绝对坐标派生：key 为 working canvas
 * 对象身份（store 仅在结构与位置输入变化时替换该对象），因此 selection / pan/zoom 不使其
 * 失效，而 pending / 远端结构与位置变化会产生新对象并正确失效。
 *
 * 不复制带 `data` 的完整节点数组；重复的手势（按下 origin 解析、拖动根过滤、释放规划）
 * 复用同一张表。合法祖先链逐级缓存坐标；循环链回退 contracts，避免缓存污染兄弟查询。
 */
import {
  getWoohaa3CanvasNodeAbsolutePosition,
  isCompositeAssetNodeType,
  readNodeHeight,
  readNodeWidth,
  FILM_SET_SHOT_PREVIEW_NODE_TYPE,
  shotPreviewOwnershipOf,
  type ServerCanvas,
  type Woohaa3CanvasNode
} from "@woohaa3/contracts";

/** 结构/位置索引（丢弃后可重建，不持有规范事实副本）。 */
export type CanvasNodeIndex = {
  /** 来源 working canvas（身份 key）。 */
  readonly source: ServerCanvas;
  /** id → 节点（直接引用来源节点，不复制；contract helper 不读取 `data`）。 */
  readonly byId: ReadonlyMap<string, Woohaa3CanvasNode>;
  /** 当前存活节点 id 集合（失效 selection / 粘连 owner 判定）。 */
  readonly liveIds: ReadonlySet<string>;
  /** Group candidates in document order, matching the canonical parenting helper. */
  readonly groups: readonly Woohaa3CanvasNode[];
  readonly groupBounds: readonly { id: string; x: number; y: number; width: number; height: number }[];
  readonly children: ReadonlyMap<string, readonly string[]>;
  /** Canonical document tie-break order, derived once per source identity. */
  readonly documentOrder: ReadonlyMap<string, number>;
  /** Overlay receivers only; preserves canonical order without a per-frame full scan. */
  readonly compositeNodes: readonly ServerCanvas["document"]["nodes"][number][];
  /**
   * 拍摄镜头预览的 owner → 预览节点索引（change: 2026-10-15 D4）。
   *
   * 片场绝对位置变化时，其名下预览必须跟随同一位移；高频手势阶段只按 owner 命中，
   * **不**扫描整画布或重建几何。
   */
  readonly shotPreviewsByOwner: ReadonlyMap<string, readonly string[]>;
  /** 节点绝对坐标（含完整祖先链）；不存在返回 `null`。 */
  absolutePosition(id: string): { x: number; y: number } | null;
  /**
   * 从拖动原点集合剔除「祖先也在集合内」的后代：后代使用相对坐标随父级移动，
   * 同时拖动会被平移两次（change: add-canvas-node-grouping，design D3）。
   */
  dragRoots(origins: ReadonlyMap<string, { x: number; y: number }>): Map<string, { x: number; y: number }>;
  /** 节点的绝对父级坐标（无父级返回 `{x:0,y:0}`）；用于把绝对落点换算为持久化相对坐标。 */
  parentAbsolutePosition(id: string): { x: number; y: number };
};

/** 就地构造索引；`canvas` 为 null 时返回 null。 */
export function createCanvasNodeIndex(canvas: ServerCanvas | null): CanvasNodeIndex | null {
  if (!canvas) return null;
  const nodes = canvas.document.nodes;
  // 直接引用来源节点：contract 几何 helper 只读 id/type/position/width/height/parentId，
  // 不读取 renderer-only 的 `data`。避免每次手势复制整表。
  const byId = new Map<string, Woohaa3CanvasNode>();
  for (const node of nodes) byId.set(node.id, node as unknown as Woohaa3CanvasNode);
  const positions = new Map<string, { x: number; y: number }>();
  const documentOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }
  const absolutePosition = (id: string) => {
    const cached = positions.get(id);
    if (cached) return cached;
    const node = byId.get(id);
    if (!node) return null;
    const chain: Woohaa3CanvasNode[] = [];
    const visited = new Set<string>();
    let current: Woohaa3CanvasNode | undefined = node;
    let base = { x: 0, y: 0 };
    while (current) {
      if (visited.has(current.id)) {
        // Preserve contract behavior for corrupt cyclic parents; such partial
        // coordinates cannot safely be reused as another node's ancestor base.
        const position = getWoohaa3CanvasNodeAbsolutePosition(node, byId);
        return position;
      }
      visited.add(current.id);
      const known = positions.get(current.id);
      if (known) { base = known; break; }
      chain.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const entry = chain[i]!;
      base = { x: base.x + entry.position.x, y: base.y + entry.position.y };
      positions.set(entry.id, base);
    }
    return positions.get(id)!;
  };
  const groups = [...byId.values()].filter(node => node.type === "group");
  const groupBounds = groups.map(group => ({ id: group.id,
    ...absolutePosition(group.id)!, ...indexNodeSize(group) }));
  // 拍摄镜头预览：从归属数据建立 owner（片场）→ 预览索引，供手势阶段按 owner 命中，
  // 不扫描整画布、不重建几何（change 2026-10-15 D4）。
  const shotPreviewsByOwner = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.type !== FILM_SET_SHOT_PREVIEW_NODE_TYPE) continue;
    const ownership = shotPreviewOwnershipOf(canvas.nodeData[node.id]);
    if (!ownership) continue;
    const list = shotPreviewsByOwner.get(ownership.filmSetNodeId) ?? [];
    list.push(node.id);
    shotPreviewsByOwner.set(ownership.filmSetNodeId, list);
  }
  return {
    source: canvas,
    byId,
    children,
    documentOrder,
    compositeNodes: nodes.filter(node => isCompositeAssetNodeType(node.type)),
    shotPreviewsByOwner,
    liveIds: new Set(byId.keys()),
    groups,
    groupBounds,
    absolutePosition,
    parentAbsolutePosition: (id) => {
      const parentId = byId.get(id)?.parentId;
      return parentId ? absolutePosition(parentId) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
    },
    dragRoots: (origins) => {
      const draggedIds = new Set(origins.keys());
      const roots = new Map<string, { x: number; y: number }>();
      for (const id of draggedIds) {
        let ancestor = byId.get(id)?.parentId;
        let covered = false;
        const guard = new Set<string>([id]);
        while (ancestor && !guard.has(ancestor)) {
          if (draggedIds.has(ancestor)) {
            covered = true;
            break;
          }
          guard.add(ancestor);
          ancestor = byId.get(ancestor)?.parentId;
        }
        if (covered) continue;
        const origin = origins.get(id);
        if (origin) roots.set(id, { ...origin });
      }
      return roots;
    }
  };
}

/** 读取节点宽高（缺省用共享 fallback），供纯逻辑规划复用。 */
export function indexNodeSize(node: Woohaa3CanvasNode): { width: number; height: number } {
  return { width: readNodeWidth(node), height: readNodeHeight(node) };
}

/** 单槽 memo：以 working canvas 对象身份为 key，selection/pan 不失效（design D5）。 */
let memoSource: ServerCanvas | null = null;
let memoIndex: CanvasNodeIndex | null = null;

/** 返回与来源身份匹配的共享索引；身份变化时重建（丢弃旧索引）。 */
export function sharedCanvasNodeIndex(canvas: ServerCanvas | null): CanvasNodeIndex | null {
  if (canvas === memoSource) return memoIndex;
  memoSource = canvas;
  memoIndex = createCanvasNodeIndex(canvas);
  return memoIndex;
}
