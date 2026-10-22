/**
 * 多选聚合拉线
 * （change: add-multi-select-aggregate-connect，design D1–D6）。
 *
 * 多选节点时在选区左右显示聚合把手；从把手拖到目标节点即为整组建立连线。本模块只做纯逻辑：
 * 把手启用门禁、选区几何、成员展开、批量边规划与瞬时投影。它不创建监听、不提交命令、不写规范状态。
 */
import {
  bevyAggregateHandle,
  bevySelectionBounds,
  createHighEntropyId,
  isValidWoohaa3CanvasConnection,
  sortNodesParentsFirst,
  type AggregateConnectDirection,
  type BevyAggregateConnect,
  type CanvasCommand,
  type CanvasRenderScene,
  type ServerCanvas,
  type Woohaa3CanvasNode,
} from "@woohaa3/contracts";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import type { InteractionCore } from "./interaction-core.js";

/** 读取当前 working canvas（本页 pending 命令即时生效）。 */
function workingCanvas(): ServerCanvas | null {
  return workingCanvasOf(woohaa3CanvasStore.getState());
}

/** 聚合把手圆钮命中半径（世界坐标，随缩放放宽；与节点端口一致）。 */
export function aggregateHitRadius(zoom: number): number {
  return Math.max(12, 12 / zoom);
}

/**
 * 选中节点递归展开为可连接叶子（change: add-multi-select-aggregate-connect，design D3）。
 *
 * group 展开为其非 group 叶子成员（稳定视觉顺序，与 `aggregateOutputLeaves` 一致）；
 * 普通节点保留自身。group 自身不作为持久化边端点。
 */
export function expandSelectionMembers(
  canvas: ServerCanvas,
  ids: readonly string[]
): Woohaa3CanvasNode[] {
  const nodes = canvas.document.nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    data: (canvas.nodeData?.[node.id] as Woohaa3CanvasNode["data"]) ?? {},
  })) as Woohaa3CanvasNode[];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ordered = sortNodesParentsFirst([...nodes]);
  const members = new Map<string, Woohaa3CanvasNode>();
  const visit = (id: string, guard: Set<string>) => {
    if (guard.has(id)) return;
    guard.add(id);
    const node = byId.get(id);
    if (!node) return;
    if (node.type !== "group") {
      members.set(node.id, node);
      return;
    }
    for (const child of ordered) {
      if (child.parentId === id) visit(child.id, guard);
    }
  };
  for (const id of ids) visit(id, new Set());
  // 稳定顺序：按 sortNodesParentsFirst 的顺序输出。
  return ordered.filter((node) => members.has(node.id));
}

/**
 * 选中节点的绝对矩形（世界坐标），直接从当前 render scene 读取
 * （scene 节点已是绝对几何，change: add-multi-select-aggregate-connect）。
 */
function sceneSelectionRects(
  scene: CanvasRenderScene
): Array<{ id: string; x: number; y: number; width: number; height: number }> {
  const selected = new Set(scene.selection.nodes);
  return scene.nodes
    .filter((node) => selected.has(node.id))
    .map((node) => ({ id: node.id, x: node.x, y: node.y, width: node.width, height: node.height }));
}

/**
 * 聚合把手投影（纯 scene 版，change: add-multi-select-aggregate-connect，design D1/D2/D5）。
 *
 * 显示条件：活动选择 ≥ 2 个节点；单个 group（已自带输出端点）或单个普通节点不显示聚合把手。
 * 空选区返回 `null`。选区展开为成员与批量规划由 `expandSelectionMembers` 处理。
 */
export function sceneAggregateHandleGeometry(
  scene: CanvasRenderScene
): {
  bounds: { x: number; y: number; width: number; height: number };
  input: { x: number; y: number };
  output: { x: number; y: number };
} | null {
  if (scene.selection.nodes.length < 2) return null;
  const bounds = bevySelectionBounds(sceneSelectionRects(scene));
  if (!bounds) return null;
  return {
    bounds,
    input: bevyAggregateHandle(bounds, "input"),
    output: bevyAggregateHandle(bounds, "output"),
  };
}

/** 把手命中结果。 */
export type AggregateHandleHit = { direction: AggregateConnectDirection };

/**
 * 命中聚合把手（纯 scene、世界坐标），change: add-multi-select-aggregate-connect，design D6。
 * 无把手（不满足显示条件）时返回 `null`。
 */
export function hitAggregateHandle(
  scene: CanvasRenderScene,
  world: { x: number; y: number }
): AggregateHandleHit | null {
  const geometry = sceneAggregateHandleGeometry(scene);
  if (!geometry) return null;
  const radius = aggregateHitRadius(scene.viewport.zoom);
  for (const direction of ["input", "output"] as const) {
    const point = geometry[direction];
    if (Math.hypot(world.x - point.x, world.y - point.y) <= radius) return { direction };
  }
  return null;
}

/**
 * 规划聚合批量边（change: add-multi-select-aggregate-connect，design D3）。
 *
 * - 输出：每个成员 `成员 -> 目标`；输入：`目标 -> 成员`；
 * - 逐条经 `isValidWoohaa3CanvasConnection` 过滤（自身、非法 handle、纯备注、group 目标、重复边）；
 * - 使用稳定 edge ID；全部无效时返回空数组（调用方不提交空批次）。
 */
export function planAggregateBatchConnect(
  canvas: ServerCanvas,
  memberIds: readonly string[],
  targetId: string,
  direction: AggregateConnectDirection
): CanvasCommand[] {
  const nodes = canvas.document.nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    data: (canvas.nodeData?.[node.id] as Woohaa3CanvasNode["data"]) ?? {},
  })) as Woohaa3CanvasNode[];
  const data = { get: (id: string) => canvas.nodeData?.[id] as Record<string, unknown> | undefined };
  const commands: CanvasCommand[] = [];
  for (const memberId of memberIds) {
    const source = direction === "output" ? memberId : targetId;
    const target = direction === "output" ? targetId : memberId;
    if (!isValidWoohaa3CanvasConnection({ source, target, sourceHandle: null, targetHandle: null }, nodes, canvas.document.edges, data)) {
      continue;
    }
    commands.push({
      type: "edge.add",
      edge: {
        id: createHighEntropyId(`edge-${source}-${target}`),
        source,
        target,
        sourceHandle: null,
        targetHandle: null,
      },
    });
  }
  return commands;
}

/**
 * 拖拽中的预览边（change: add-multi-select-aggregate-connect，design D5）。
 *
 * 指针落在合法目标节点（非成员、非空白）时返回该目标对应的全部合法边；否则返回空数组。
 */
export function aggregatePreviewEdges(
  canvas: ServerCanvas,
  scene: CanvasRenderScene,
  memberIds: readonly string[],
  direction: AggregateConnectDirection,
  world: { x: number; y: number }
): Array<{ id: string; source: string; target: string }> {
  const target = aggregateTargetAt(scene, memberIds, world);
  if (!target) return [];
  const commands = planAggregateBatchConnect(canvas, memberIds, target.id, direction);
  return commands
    .filter((command): command is Extract<CanvasCommand, { type: "edge.add" }> => command.type === "edge.add")
    .map((command) => ({ id: command.edge.id as string, source: command.edge.source, target: command.edge.target }));
}

/**
 * 指针下的合法目标节点（视觉层级从高到低、非成员、非 group、非 ghost）
 * change: add-multi-select-aggregate-connect。
 */
export function aggregateTargetAt(
  scene: CanvasRenderScene,
  memberIds: readonly string[],
  world: { x: number; y: number }
): { id: string } | null {
  const memberSet = new Set(memberIds);
  const target = [...scene.nodes]
    .reverse()
    .find(
      (node) =>
        !memberSet.has(node.id)
        && node.type !== "group"
        && node.ghost !== true
        && world.x >= node.x
        && world.x <= node.x + node.width
        && world.y >= node.y
        && world.y <= node.y + node.height,
    );
  return target ? { id: target.id } : null;
}

/**
 * 把把手与拖拽状态投影为版本化 render scene 的瞬时字段
 * （change: add-multi-select-aggregate-connect，design D5）。
 */
export function aggregateConnectProjection(
  direction: AggregateConnectDirection | null,
  cursor: { x: number; y: number } | null,
  pendingEdges: readonly { id: string; source: string; target: string }[]
): BevyAggregateConnect {
  return {
    direction,
    ...(cursor ? { cursor } : {}),
    pendingEdges: pendingEdges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
  };
}

/** aggregate-connect 手势族能力（change: add-multi-select-aggregate-connect，design D4/D6）。 */
export type AggregateConnectFamily = {
  /** 开始拖拽（命中把手后调用）；成员由当前 selection 展开。 */
  begin: (direction: AggregateConnectDirection, world: { x: number; y: number }, pointerId: number) => boolean;
  /** 推进拖拽（更新指针与预览）。 */
  move: (world: { x: number; y: number }) => void;
  /** 正常释放：命中合法目标则单批次提交；返回是否提交。 */
  finish: (world: { x: number; y: number }) => void;
  /** 取消：丢弃预览、不提交。 */
  cancel: () => void;
  /** 当前是否存在把手（无论是否拖拽）。 */
  hasHandles: () => boolean;
  /** 当前瞬时投影；无把手时 `null`。 */
  projection: () => BevyAggregateConnect | null;
};

/**
 * 创建 aggregate-connect 手势族
 * （change: add-multi-select-aggregate-connect，design D4/D6）。
 *
 * 手势状态内聚在单次 pointer 手势内；`begin` 由 2d-input 在命中把手且门禁通过后调用。
 */
export function createAggregateConnectFamily(
  core: Pick<InteractionCore, "state" | "submit" | "writable" | "schedule" | "buildScene">,
): AggregateConnectFamily {
  const { state, submit, writable, schedule, buildScene } = core;

  const currentMembers = (): string[] | null => {
    const canvas = workingCanvas();
    if (!canvas) return null;
    const members = expandSelectionMembers(canvas, state.selected);
    if (members.length === 0) return null;
    if (members.length === 1 && state.selected.length === 1) return null;
    return members.map((node) => node.id);
  };

  return {
    hasHandles: () => currentMembers() !== null,
    begin: (direction, world, pointerId) => {
      if (!writable()) return false;
      const members = currentMembers();
      if (!members) return false;
      state.gesture = {
        kind: "aggregate-connect",
        pointerId,
        direction,
        members,
        cursor: { ...world },
        pendingEdges: [],
      };
      schedule();
      return true;
    },
    move: (world) => {
      const gesture = state.gesture;
      if (gesture.kind !== "aggregate-connect") return;
      gesture.cursor = { ...world };
      const canvas = workingCanvas();
      const scene = buildScene();
      gesture.pendingEdges = canvas && scene
        ? aggregatePreviewEdges(canvas, scene, gesture.members, gesture.direction, world)
        : [];
      schedule();
    },
    finish: (world) => {
      const gesture = state.gesture;
      if (gesture.kind !== "aggregate-connect") return;
      const canvas = workingCanvas();
      const scene = buildScene();
      state.gesture = { kind: "none" };
      if (canvas && scene && writable()) {
        const target = aggregateTargetAt(scene, gesture.members, world);
        if (target) {
          const commands = planAggregateBatchConnect(canvas, gesture.members, target.id, gesture.direction);
          if (commands.length > 0) submit(commands);
        }
      }
      schedule();
    },
    cancel: () => {
      if (state.gesture.kind !== "aggregate-connect") {
        schedule();
        return;
      }
      state.gesture = { kind: "none" };
      schedule();
    },
    projection: () => {
      const gesture = state.gesture;
      if (gesture.kind === "aggregate-connect") {
        return aggregateConnectProjection(gesture.direction, gesture.cursor, gesture.pendingEdges);
      }
      // 未拖拽：只要把手可见即投影（direction=null）。
      return currentMembers() ? aggregateConnectProjection(null, null, []) : null;
    },
  };
}

