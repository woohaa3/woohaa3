/**
 * 渲染器中立的画布命令规划器
 * （change: replace-godot-canvas-runtime-with-bevy，任务 5.1 / design D4）。
 *
 * 从旧桥接的 `translateToCommands` 提取：把「用户意图」翻译成服务端 `CanvasCommand[]`。
 * 与旧实现的差别：不再有 bridge envelope / operationId 去重 / frame channel；调用方
 * （interaction controller）直接产出一批命令并交给 `CanvasSession.submitCommands`。
 *
 * 纯函数、无 DOM 依赖、不做任何本地 store 写入（规范状态只由服务端 Yjs update 回流）。
 */
import {
  bevyNodeSize,
  createFilmSetGroupMarker,
  createHighEntropyId,
  createWoohaa3CanvasNodeId,
  COMPOSITE_ASSET_DEFAULT_SIZE,
  getWoohaa3CanvasNodeAbsolutePosition,
  getWoohaa3CanvasNodeRect,
  groupPadding,
  groupWoohaa3CanvasNodes,
  isPureModelNodeType,
  isValidWoohaa3CanvasConnection,
  readFilmSetGroupMarker,
  readNodeHeight,
  readNodeWidth,
  refitWoohaa3CanvasGroups,
  sortNodesParentsFirst,
  ungroupWoohaa3CanvasNodes,
  type CanvasCommand,
  type CanvasNodeData,
  type ServerCanvas,
  type Woohaa3CanvasEdge,
  type Woohaa3CanvasJsonObject,
  type Woohaa3CanvasNode,
  type Woohaa3CanvasPosition
} from "@woohaa3/contracts";

export type InsertNodeIntent = {
  nodeType: string;
  position: Woohaa3CanvasPosition;
  width?: number;
  height?: number;
  nodeData?: CanvasNodeData;
  /** 显式节点 ID（change: add-paste-import-workflows，批量导入需要稳定回执）；缺省生成。 */
  nodeId?: string;
  /** 「拉线创建」：在同一次提交里从已有节点连一条边。 */
  connectFromNodeId?: string;
  connectLabel?: string;
};

export type ConnectEdgeIntent = {
  edgeId?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  data?: Woohaa3CanvasJsonObject;
};

export type NodeDataPatchIntent = {
  nodeId: string;
  value: CanvasNodeData;
};

/** 创建节点（可选连线）→ 服务端命令。 */
export function planInsertNode(intent: InsertNodeIntent): CanvasCommand[] {
  const id = intent.nodeId ?? createWoohaa3CanvasNodeId(intent.nodeType);
  // 普通模型使用内嵌预览卡片尺寸；纯模型节点（片场 composite-asset + 通用扩展节点 composite-asset）
  // 矩形即范围框，用纯模型默认尺寸（change: 2026-10-08-make-film-set-model-only 修订；
  // change: 2026-10-10-add-game-furnace-extension 泛化）。
  const compactModelSize = intent.nodeType === "model3d"
    ? bevyNodeSize("image")
    : isPureModelNodeType(intent.nodeType)
      ? COMPOSITE_ASSET_DEFAULT_SIZE
      : null;
  const width = intent.width ?? compactModelSize?.width;
  const height = intent.height ?? compactModelSize?.height;
  return [{
    type: "node.add",
    node: {
      id,
      type: intent.nodeType,
      position: { ...intent.position },
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {})
    },
    ...(intent.nodeData ? { nodeData: intent.nodeData } : {}),
    ...(intent.connectFromNodeId
      ? {
          connect: {
            fromNodeId: intent.connectFromNodeId,
            // 客户端稳定 edgeId（design D7）：服务端保留该 ID，前端 working projection
            // 与服务端生成同一实体，避免本地预览与服务端结果分叉。
            edgeId: createHighEntropyId(`edge-${intent.connectFromNodeId}-${id}`),
            ...(intent.connectLabel ? { label: intent.connectLabel } : {})
          }
        }
      : {})
  }];
}

/** 移动一批节点 → 每个节点一条 `node.update`。 */
export function planMoveNodes(positions: Readonly<Record<string, Woohaa3CanvasPosition>>): CanvasCommand[] {
  return Object.entries(positions).map(([nodeId, position]) => ({
    type: "node.update",
    nodeId,
    position: { ...position }
  }));
}

export type ResizeNodeIntent = {
  nodeId: string;
  width: number;
  height: number;
  /** 可选位置（当前 resize 不改位置，仅预留给参考实现的对齐语义）。 */
  position?: Woohaa3CanvasPosition;
};

/** 调整节点尺寸 → 一条 `node.update{width,height}`（change: add-node-resize）。 */
export function planResizeNode(intent: ResizeNodeIntent): CanvasCommand[] {
  return [{
    type: "node.update",
    nodeId: intent.nodeId,
    width: intent.width,
    height: intent.height,
    ...(intent.position ? { position: { ...intent.position } } : {})
  }];
}

export function planDeleteNodes(nodeIds: readonly string[]): CanvasCommand[] {
  return [{ type: "node.remove", nodeIds: [...nodeIds] }];
}

export function planConnectEdge(intent: ConnectEdgeIntent): CanvasCommand[] {
  return [{
    type: "edge.add",
    edge: {
      // 客户端稳定 edgeId（change: add-frontend-speculative-canvas-state，design D7）：
      // 服务端保留该 ID，前端 working projection 与服务端生成同一实体。
      id: intent.edgeId ?? createHighEntropyId(`edge-${intent.source}-${intent.target}`),
      source: intent.source,
      target: intent.target,
      sourceHandle: intent.sourceHandle ?? null,
      targetHandle: intent.targetHandle ?? null,
      ...(intent.data ? { data: intent.data } : {})
    }
  }];
}

export function planDeleteEdge(edgeId: string): CanvasCommand[] {
  return [{ type: "edge.remove", edgeId }];
}

/** 把空的图片/视频节点切成另一种类型（生成面板的「图片 / 视频」切换）。 */
export function planRetypeNode(nodeId: string, nodeType: "image" | "video"): CanvasCommand[] {
  return [{ type: "node.update", nodeId, nodeType }];
}

export function planNodeDataPatch(intent: NodeDataPatchIntent): CanvasCommand[] {
  return [{ type: "nodeData.patch", nodeId: intent.nodeId, value: intent.value }];
}

/**
 * 由 group-ops 结果（`groupWoohaa3CanvasNodes` / `ungroupWoohaa3CanvasNodes` /
 * `reparentDraggedNodes` / `refitWoohaa3CanvasGroups`）生成**单批次**的结构更新命令
 * （change: add-canvas-node-grouping，任务 1.3 / design D1）。
 *
 * 只比较前后差异，产出最小的 `node.add` / `node.update` / `node.remove` 集合：
 * - 新增节点（如新 group）→ `node.add`；
 * - position/width/height/parentId 变化 → `node.update`（parentId 用 `null` 表示解除）；
 * - 被移除节点（解组时删除的 group）→ `node.remove`。
 *
 * 所有差异在同一次 `submitCommands` 里提交，保证 canonical 不出现半成品结构。
 */
export function planGroupStructureChange(
  before: readonly Woohaa3CanvasNode[],
  after: readonly Woohaa3CanvasNode[]
): CanvasCommand[] {
  const beforeById = new Map(before.map((node) => [node.id, node]));
  const afterById = new Map(after.map((node) => [node.id, node]));
  const commands: CanvasCommand[] = [];

  for (const node of after) {
    const previous = beforeById.get(node.id);
    if (!previous) {
      commands.push({
        type: "node.add",
        node: {
          id: node.id,
          type: node.type,
          position: { ...node.position },
          ...(node.width !== undefined ? { width: node.width } : {}),
          ...(node.height !== undefined ? { height: node.height } : {}),
          ...(node.parentId !== undefined ? { parentId: node.parentId } : {})
        }
      });
      continue;
    }
    const update: Extract<CanvasCommand, { type: "node.update" }> = { type: "node.update", nodeId: node.id };
    let changed = false;
    if (previous.position.x !== node.position.x || previous.position.y !== node.position.y) {
      update.position = { ...node.position };
      changed = true;
    }
    if (previous.width !== node.width && node.width !== undefined) {
      update.width = node.width;
      changed = true;
    }
    if (previous.height !== node.height && node.height !== undefined) {
      update.height = node.height;
      changed = true;
    }
    if (previous.parentId !== node.parentId) {
      // `undefined` 表示顶层；wire 上用 null 显式解除。
      update.parentId = node.parentId ?? null;
      changed = true;
    }
    if (changed) commands.push(update);
  }

  for (const node of before) {
    if (!afterById.has(node.id)) commands.push({ type: "node.remove", nodeIds: [node.id] });
  }

  return commands;
}

/** 新 group 的默认可编辑标题。 */
export const DEFAULT_GROUP_TITLE = "分组";

/**
 * 打组：至少两个顶层非 group 节点 → 一个 group 结构批次
 * （change: add-canvas-node-grouping，任务 1.3 / design D1）。
 *
 * `groupWoohaa3CanvasNodes` 期望顶层绝对坐标；先把选中节点投影为绝对坐标再打组，
 * 再用 `planGroupStructureChange` 产出最小差异批次。组标题并入同一批次的 `nodeData.patch`，
 * 保证 canonical 不出现「有 group 无标题」的中间态。
 */
export function planGroupNodes(
  nodes: readonly Woohaa3CanvasNode[],
  selectedNodeIds: readonly string[]
): CanvasCommand[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const absolute = nodes.map((node) => {
    const abs = getWoohaa3CanvasNodeAbsolutePosition(node, nodeById);
    return { ...node, position: { x: abs.x, y: abs.y } };
  });
  const result = groupWoohaa3CanvasNodes(absolute, [...selectedNodeIds]);
  if (!result) return [];
  return [
    ...planGroupStructureChange(nodes, result.nodes),
    { type: "nodeData.patch", nodeId: result.groupId, value: { title: DEFAULT_GROUP_TITLE } }
  ];
}

/** 解组 / 移出成员 → 一个结构批次。 */
export function planUngroupNodes(
  nodes: readonly Woohaa3CanvasNode[],
  selectedNodeIds: readonly string[]
): CanvasCommand[] {
  const result = ungroupWoohaa3CanvasNodes([...nodes], [...selectedNodeIds]);
  if (!result) return [];
  return planGroupStructureChange(nodes, result.nodes);
}

/** reparent / refit 结果 → 单批次结构更新（组拖动、成员拖入拖出、resize）。 */
export function planGroupedNodeUpdate(
  nodes: readonly Woohaa3CanvasNode[],
  next: readonly Woohaa3CanvasNode[]
): CanvasCommand[] {
  return planGroupStructureChange(nodes, next);
}

function isDescendantIn(nodes: ReadonlyMap<string, Woohaa3CanvasNode>, nodeId: string, ancestorId: string): boolean {
  const seen = new Set<string>();
  let current = nodes.get(nodeId);
  while (current?.parentId) {
    if (current.parentId === ancestorId) return true;
    if (seen.has(current.parentId)) return false;
    seen.add(current.parentId);
    current = nodes.get(current.parentId);
  }
  return false;
}

/**
 * 片场成员拖出/拖回 → binding 的软摘除状态补丁（change 见 film-set-group 的 detached 约定）。
 *
 * 拖出时只改变 `parentId`，不复制或删除卡片；这里在同一批次把片场 binding 标为
 * `detached`，让对象与动作脚本留在片场但不参与渲染/镜头。拖回时清除标记，原动作恢复。
 * 只有原本属于该片场的 binding 才会被切换，伪造的外部来源仍由 reducer 拒绝。
 */
export function planFilmSetMembershipCommands(
  canvas: Pick<ServerCanvas, "document" | "nodeData">,
  before: readonly Woohaa3CanvasNode[],
  after: readonly Woohaa3CanvasNode[]
): CanvasCommand[] {
  const beforeById = new Map(before.map(node => [node.id, node]));
  const afterById = new Map(after.map(node => [node.id, node]));
  const commands: CanvasCommand[] = [];
  for (const group of after) {
    if (group.type !== "group") continue;
    const marker = readFilmSetGroupMarker(canvas.nodeData[group.id]);
    if (!marker) continue;
    let changed = false;
    const sceneBindings = marker.sceneBindings.map(binding => {
      const source = afterById.get(binding.sourceNodeId) ?? beforeById.get(binding.sourceNodeId);
      if (!source) return binding;
      const wasInside = isDescendantIn(beforeById, source.id, group.id);
      const isInside = isDescendantIn(afterById, source.id, group.id);
      if (wasInside && !isInside && binding.detached !== true) {
        changed = true;
        return { ...binding, detached: true };
      }
      if (isInside && binding.detached === true) {
        changed = true;
        const { detached: _detached, ...active } = binding;
        return active;
      }
      return binding;
    });
    if (!changed) continue;
    commands.push({
      type: "nodeData.patch",
      nodeId: group.id,
      value: { filmSetGroup: createFilmSetGroupMarker({ ...marker, sceneBindings }) }
    });
  }
  return commands;
}

/** 让指定 group 贴合其直接成员 → 单批次结构更新。 */
export function planRefitGroups(
  nodes: readonly Woohaa3CanvasNode[],
  groupIds: readonly string[]
): CanvasCommand[] {
  const result = refitWoohaa3CanvasGroups([...nodes], groupIds);
  if (!result.changed) return [];
  return planGroupStructureChange(nodes, result.nodes);
}

/** 读节点的绝对矩形（供控制器在本地预览里定位 group）。 */
export function nodeAbsoluteRect(
  node: Woohaa3CanvasNode,
  nodes: readonly Woohaa3CanvasNode[]
): { x: number; y: number; width: number; height: number } {
  return getWoohaa3CanvasNodeRect(node, new Map(nodes.map((entry) => [entry.id, entry])));
}

/**
 * group 聚合输出：把 group → target 展开为每个可连接叶子成员的真实边
 * （change: add-canvas-node-grouping，任务 4.1/4.2 / design D5）。
 *
 * - 按稳定的组内视觉顺序（`sortNodesParentsFirst` 后的 id 顺序）枚举递归叶子；
 * - 对每个叶子用 `isValidWoohaa3CanvasConnection` 过滤角色不兼容、重复边与自环；
 * - 全部无效时返回**空批次**（调用方据此给出稳定反馈，不提交空命令）。
 *
 * 结果里不存在 `group -> target` 边：group 不能作为持久化边端点。
 */
export function planAggregateConnect(
  nodes: readonly Woohaa3CanvasNode[],
  edges: readonly Woohaa3CanvasEdge[],
  groupId: string,
  targetId: string
): CanvasCommand[] {
  const leaves = aggregateOutputLeaves(nodes, groupId);
  const commands: CanvasCommand[] = [];
  for (const leafId of leaves) {
    if (!isValidWoohaa3CanvasConnection(
      { source: leafId, target: targetId, sourceHandle: null, targetHandle: null },
      [...nodes],
      [...edges],
    )) {
      continue;
    }
    commands.push(...planConnectEdge({ source: leafId, target: targetId }));
  }
  return commands;
}

/**
 * group 具备输出能力的递归叶子（稳定的组内视觉顺序）。
 *
 * 顺序取自 `sortNodesParentsFirst`，保证同一画布多次调用得到相同结果（稳定 edge ID）。
 */
export function aggregateOutputLeaves(
  nodes: readonly Woohaa3CanvasNode[],
  groupId: string
): string[] {
  const ordered = sortNodesParentsFirst([...nodes]);
  const childIds = new Set<string>();
  const collect = (parentId: string) => {
    for (const node of ordered) {
      if (node.parentId !== parentId || childIds.has(node.id)) continue;
      if (node.type === "group") collect(node.id);
      else childIds.add(node.id);
    }
  };
  collect(groupId);
  return [...childIds];
}


/**
 * 整理 group 内部布局（change: add-canvas-node-grouping，任务 3.2 / design D4）。
 *
 * 只布局该 group 的**直接成员**，按组内真实边做简单分层：入度为 0 的成员排第一列，
 * 其余按已有位置顺序排到后续列（列内纵向堆叠）。随后调用 `refitWoohaa3CanvasGroups`
 * 收紧容器尺寸。组外节点与边不受影响。
 *
 * `edges` 由调用方注入（document 的边不属于节点集合）：只消费两端都在直接成员内的边。
 * 返回与 `nodes` 的差异批次；无变化时返回空数组。
 */
export function planTidyGroup(
  nodes: readonly Woohaa3CanvasNode[],
  edges: readonly { source: string; target: string }[],
  groupId: string
): CanvasCommand[] {
  const group = nodes.find((node) => node.id === groupId && node.type === "group");
  if (!group) return [];
  const children = nodes.filter((node) => node.parentId === groupId);
  if (children.length === 0) return [];

  // 组内边：仅统计两端都在直接成员集合中的边。
  const childIds = new Set(children.map((node) => node.id));
  const inDegree = new Map<string, number>(children.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (childIds.has(edge.source) && childIds.has(edge.target)) {
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    }
  }

  const columnWidth = 320;
  const rowHeight = 240;
  const padding = 40;
  // 入度 0 的成员为第一层；其余按其原始 y 顺序进入第二层，保持稳定且可预测。
  const roots = children.filter((child) => (inDegree.get(child.id) ?? 0) === 0);
  const rest = children.filter((child) => (inDegree.get(child.id) ?? 0) !== 0);
  const layers = roots.length > 0 ? [roots, rest] : [children, []];

  const laidOut = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, column) => {
    layer
      .slice()
      .sort((a, b) => a.position.y - b.position.y || a.id.localeCompare(b.id))
      .forEach((child, row) => {
        laidOut.set(child.id, { x: padding + column * columnWidth, y: padding + row * rowHeight });
      });
  });

  const rewrapped = nodes.map((node) => {
    const next = laidOut.get(node.id);
    if (!next) return node;
    return { ...node, position: { ...next } };
  });
  const refit = refitWoohaa3CanvasGroups(rewrapped, [groupId]);
  return planGroupStructureChange(nodes, refit.changed ? refit.nodes : rewrapped);
}

/** 组内排列方式（横条上的图标按钮）。 */
export type GroupArrangementKind = "arrange-horizontal" | "arrange-vertical" | "arrange-grid" | "arrange-diagonal-up" | "arrange-diagonal-down";

/** 排列时相邻成员之间留出的画布间距；与「整理」的行列密度接近，避免成员贴在一起。 */
export const GROUP_ARRANGE_GAP = 24;

/**
 * 排列 group 的**直接成员**（横条上的「横排 / 竖排 / 宫格 / 斜排」图标动作）。
 *
 * - `arrange-horizontal`：单行，从左到右；
 * - `arrange-vertical`：单列，从上到下；
 * - `arrange-grid`：接近正方形的宫格，行优先；
 * - `arrange-diagonal-down`：单行阶梯，向右下（↘）展开；
 * - `arrange-diagonal-up`：单行阶梯，向右上（↗）展开。
 *
 * 成员顺序优先沿用画布上的视觉顺序：横排与斜排按 x/y 排序，竖排与宫格按 y/x 排序，
 * 同一位置再用 id 保证确定性。位置写回 group 的局部坐标，随后用与整理相同的
 * `refitWoohaa3CanvasGroups` 收紧/扩展容器；组外节点不受影响。
 */
export function planArrangeGroupChildren(
  nodes: readonly Woohaa3CanvasNode[],
  groupId: string,
  arrangement: GroupArrangementKind
): CanvasCommand[] {
  const group = nodes.find((node) => node.id === groupId && node.type === "group");
  if (!group) return [];
  const children = nodes.filter((node) => node.parentId === groupId);
  if (children.length === 0) return [];

  const ordered = [...children];
  const byRow = arrangement === "arrange-vertical" || arrangement === "arrange-grid";
  ordered.sort((a, b) => byRow
    ? a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id)
    : a.position.x - b.position.x || a.position.y - b.position.y || a.id.localeCompare(b.id));

  const sizes = new Map(children.map((child) => [child.id, {
    width: readNodeWidth(child),
    height: readNodeHeight(child)
  }]));
  const padding = groupPadding;
  const positions = new Map<string, { x: number; y: number }>();

  if (arrangement === "arrange-horizontal" || arrangement === "arrange-vertical") {
    let cursor = padding;
    for (const child of ordered) {
      const size = sizes.get(child.id)!;
      if (arrangement === "arrange-horizontal") {
        positions.set(child.id, { x: cursor, y: padding });
        cursor += size.width + GROUP_ARRANGE_GAP;
      } else {
        positions.set(child.id, { x: padding, y: cursor });
        cursor += size.height + GROUP_ARRANGE_GAP;
      }
    }
  } else if (arrangement === "arrange-grid") {
    const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
    const cellWidth = Math.max(...ordered.map((child) => sizes.get(child.id)!.width));
    const cellHeight = Math.max(...ordered.map((child) => sizes.get(child.id)!.height));
    ordered.forEach((child, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      positions.set(child.id, {
        x: padding + column * (cellWidth + GROUP_ARRANGE_GAP),
        y: padding + row * (cellHeight + GROUP_ARRANGE_GAP)
      });
    });
  } else {
    // 斜排：x 始终向右累计；向下直接累计高度，向上把整条阶梯翻转，使最左成员落在底部。
    const totalHeight = ordered.reduce((sum, child) => sum + sizes.get(child.id)!.height, 0)
      + GROUP_ARRANGE_GAP * (ordered.length - 1);
    let x = padding;
    let cumulativeBottom = 0;
    for (const child of ordered) {
      const size = sizes.get(child.id)!;
      const y = arrangement === "arrange-diagonal-down"
        ? padding + cumulativeBottom
        : padding + totalHeight - (cumulativeBottom + size.height);
      positions.set(child.id, { x, y });
      x += size.width + GROUP_ARRANGE_GAP;
      cumulativeBottom += size.height + GROUP_ARRANGE_GAP;
    }
  }

  const moved = nodes.map((node) => {
    const next = positions.get(node.id);
    return next ? { ...node, position: { ...next } } : node;
  });
  const refit = refitWoohaa3CanvasGroups(moved, [groupId]);
  return planGroupStructureChange(nodes, refit.changed ? refit.nodes : moved);
}
