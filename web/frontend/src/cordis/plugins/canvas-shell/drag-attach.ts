/**
 * 单节点拖动中的 Q/E 触碰粘连
 * （change: add-drag-touch-connections，design D1/D2/D3/D4）。
 *
 * 粘连状态完整绑定在单次 drag gesture 生命周期内，不存在跨手势或页面级的第二份状态。
 * 本模块只做纯逻辑：held 键与模式求解、基于当前 working scene 的触须接触判定、
 * 合法性过滤、待提交边的稳定身份与释放前重验。它不创建监听、不提交命令、不写规范状态。
 */
import {
  bevyDragAttachProbe,
  createHighEntropyId,
  dragAttachProbeIntersects,
  isModelNodeType,
  isValidWoohaa3CanvasConnection,
  type BevyDragAttach,
  type CanvasRenderScene,
  type ServerCanvas,
  type Woohaa3CanvasNode,
} from "@woohaa3/contracts";

/** 粘连方向（与 render scene 的 `mode` 同构）。 */
export type DragAttachMode = "predecessor" | "successor";

/** 一个仍保持按下的物理键及其按下顺序（越大越近）。 */
export type DragAttachHeld = { code: "KeyQ" | "KeyE"; order: number };

/** 待提交连线：edge id 在首次锁定时分配，使预览 identity 与最终命令一致。 */
export type DragAttachPendingEdge = { id: string; source: string; target: string };

/**
 * 单节点 drag gesture 的粘连子状态（design D1）。
 *
 * `pending` 以有向端点对（`source>target`）作为 key，天然去重；一次手势可依次锁定多个目标。
 */
export type DragAttachState = {
  nodeId: string;
  held: DragAttachHeld[];
  mode: DragAttachMode | null;
  contactNodeId: string | null;
  pending: Map<string, DragAttachPendingEdge>;
};

/** 粘连键的物理 code（用 `event.code` 而非字符 key，与物理键位一致）。 */
export const DRAG_ATTACH_KEYS = ["KeyQ", "KeyE"] as const;

let heldOrder = 0;

/** 创建粘连子状态（只在合格拖动开始时调用一次）。 */
export function createDragAttachState(nodeId: string): DragAttachState {
  return { nodeId, held: [], mode: null, contactNodeId: null, pending: new Map() };
}

/** 当前活动模式：最近按下且仍保持的键；无保持键时 `null`（design D2）。 */
export function activeAttachMode(held: readonly DragAttachHeld[]): DragAttachMode | null {
  if (held.length === 0) return null;
  const top = held.reduce((latest, entry) => (entry.order > latest.order ? entry : latest));
  return top.code === "KeyQ" ? "predecessor" : "successor";
}

/**
 * 应用一次 KeyQ/KeyE keydown/keyup。返回是否改变了 held/mode。
 *
 * keydown 对已保持的键（自动重复）是幂等无操作；keyup 对未保持的键同样幂等（design D2）。
 */
export function applyDragAttachKey(state: DragAttachState, code: "KeyQ" | "KeyE", down: boolean): boolean {
  if (down) {
    if (state.held.some((entry) => entry.code === code)) return false;
    heldOrder += 1;
    state.held.push({ code, order: heldOrder });
  } else {
    const index = state.held.findIndex((entry) => entry.code === code);
    if (index < 0) return false;
    state.held.splice(index, 1);
  }
  state.mode = activeAttachMode(state.held);
  return true;
}

/** 清空全部 held 键与活动模式（取消路径；迟到 keyup 幂等无操作）。 */
export function clearDragAttachKeys(state: DragAttachState): void {
  state.held.length = 0;
  state.mode = null;
}

/**
 * 节点是否可作为粘连 owner / target：非纯模型、非 ghost、非纯备注。
 *
 * 与连接领域规则（`isValidWoohaa3CanvasConnection`）保持一致：纯备注不参与连线；
 * ghost 只渲染不可交互。
 */
export function isDragAttachConnectable(node: {
  type?: string;
  ghost?: boolean;
}): boolean {
  return !isModelNodeType(node.type ?? "") && node.ghost !== true;
}

/** working canvas 节点 + nodeData 读取器（供连接规则判定纯备注）。 */
function connectionContext(canvas: ServerCanvas): {
  nodes: Woohaa3CanvasNode[];
  data: { get: (id: string) => Record<string, unknown> | undefined };
} {
  const nodeData = (canvas.nodeData ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const nodes = canvas.document.nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    data: (nodeData[node.id] ?? {}) as Woohaa3CanvasNode["data"]
  }));
  return { nodes, data: { get: (id: string) => nodeData[id] } };
}

/** 把 pending 边投影为连接规则可消费的边形状。 */
function pendingEdges(state: DragAttachState) {
  return [...state.pending.values()].map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: null,
    targetHandle: null,
    data: {}
  }));
}

/**
 * 基于当前 working scene 求值触须接触并锁定合法待提交边（design D3）。
 *
 * - 候选按视觉层级从高到低（scene 后绘制者优先）遍历，只取**最高层的合法**节点；
 * - 自身、ghost、纯备注、已有同向边与本手势 pending 边都被排除；
 * - 前序映射 `candidate -> owner`、后序映射 `owner -> candidate`；
 * - 首次锁定即分配稳定 edge id；触须离开只清除 contact，pending 保留。
 *
 * 返回投影是否发生变化（contact 或 pending）。
 */
export function evaluateDragAttachContact(
  state: DragAttachState,
  scene: CanvasRenderScene,
  canvas: ServerCanvas
): boolean {
  const owner = scene.nodes.find((node) => node.id === state.nodeId);
  const mode = state.mode;
  if (!mode || !owner || !isDragAttachConnectable(owner)) {
    if (state.contactNodeId === null) return false;
    state.contactNodeId = null;
    return true;
  }
  const probe = bevyDragAttachProbe(
    { x: owner.x, y: owner.y, width: owner.width, height: owner.height },
    mode
  );
  const { nodes, data } = connectionContext(canvas);
  const existing = [...canvas.document.edges, ...pendingEdges(state)];
  // scene.nodes 的文档顺序即绘制顺序（后绘制 z 更高）：倒序即视觉层级从高到低。
  const ordered = [...scene.nodes].reverse();
  let changed = false;
  let contact: string | null = null;
  for (const candidate of ordered) {
    if (candidate.id === state.nodeId || !isDragAttachConnectable(candidate)) continue;
    if (!dragAttachProbeIntersects(probe, { x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height })) {
      continue;
    }
    const source = mode === "predecessor" ? candidate.id : state.nodeId;
    const target = mode === "predecessor" ? state.nodeId : candidate.id;
    if (!isValidWoohaa3CanvasConnection({ source, target, sourceHandle: null, targetHandle: null }, nodes, existing, data)) {
      continue;
    }
    contact = candidate.id;
    const key = `${source}>${target}`;
    if (!state.pending.has(key)) {
      state.pending.set(key, { id: createHighEntropyId(`edge-${source}-${target}`), source, target });
      changed = true;
    }
    break;
  }
  if (state.contactNodeId !== contact) {
    state.contactNodeId = contact;
    changed = true;
  }
  return changed;
}

/**
 * 释放前基于最新 working canvas 重验 pending 边（design D4）。
 *
 * 目标已删除、同向边已由远端加入或领域规则变化的项被过滤；返回仍合法的待提交边
 * （保留锁定顺序与稳定 edge id）。调用方以「位置命令在前、边命令在后」组成单批次。
 */
export function revalidateDragAttachEdges(
  state: DragAttachState,
  canvas: ServerCanvas
): DragAttachPendingEdge[] {
  const { nodes, data } = connectionContext(canvas);
  const existing = canvas.document.edges;
  const live = new Set(canvas.document.nodes.map((node) => node.id));
  const result: DragAttachPendingEdge[] = [];
  for (const edge of state.pending.values()) {
    if (!live.has(edge.source) || !live.has(edge.target)) continue;
    if (!isValidWoohaa3CanvasConnection({ source: edge.source, target: edge.target, sourceHandle: null, targetHandle: null }, nodes, existing, data)) {
      continue;
    }
    result.push(edge);
  }
  return result;
}

/**
 * working canvas 更新时局部清理失效的 contact/pending（design D6）。
 *
 * 目标删除或失效只移除涉及该目标的预览边；owner 仍有效时其余状态继续。返回是否有变化。
 */
export function pruneDragAttachState(state: DragAttachState, canvas: ServerCanvas): boolean {
  const live = new Set(canvas.document.nodes.map((node) => node.id));
  let changed = false;
  if (state.contactNodeId !== null && !live.has(state.contactNodeId)) {
    state.contactNodeId = null;
    changed = true;
  }
  for (const [key, edge] of [...state.pending]) {
    if (!live.has(edge.source) || !live.has(edge.target)) {
      state.pending.delete(key);
      changed = true;
    }
  }
  return changed;
}

/**
 * 把粘连子状态投影为版本化 render scene 的瞬时字段（design D5）。
 *
 * 字段存在即表示应显示操作条；`mode` 决定活动提示与触须侧；`contactNodeId` 驱动接触反馈；
 * `pendingEdges` 绘制虚线预览。只承载浏览器本地呈现态。
 */
export function dragAttachProjection(state: DragAttachState): BevyDragAttach {
  return {
    nodeId: state.nodeId,
    mode: state.mode,
    ...(state.contactNodeId !== null ? { contactNodeId: state.contactNodeId } : {}),
    pendingEdges: [...state.pending.values()].map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target
    }))
  };
}
