/**
 * 单节点拖动与 Q/E 触碰粘连的 gesture 逻辑
 * （change: add-drag-touch-connections；从 `interaction-2d-input` 拆出以保持在文件体积上限内）。
 *
 * 只通过注入的共享 `InteractionCore` 能力访问状态、场景与提交；不自建监听，也不持有
 * 跨手势状态。粘连子状态完整内聚在单次 drag gesture 内（design D1）。
 *
 * 结构与位置索引按 working 身份缓存复用（change: 2026-10-10-optimize-canvas-interaction-hot-path，
 * design D5）：释放时无重父化/容器尺寸变化直接生成选中根的**净位置**命令，不构造全场
 * before/after 再判无结构变化；有重父化时以共享索引避免 parent find 的平方级扫描。
 */
import {
  FILM_SET_SHOT_PREVIEW_NODE_TYPE,
  findGroupContainingCenter,
  reparentDraggedNodes,
  type CanvasCommand,
  type Woohaa3CanvasNode,
} from "@woohaa3/contracts";
import { planGroupStructureChange, planMoveNodes } from "../../../extension-api/command-planner.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import {
  applyDragAttachKey,
  dragAttachProjection,
  evaluateDragAttachContact,
  pruneDragAttachState,
  revalidateDragAttachEdges,
} from "./drag-attach.js";
import { sharedCanvasNodeIndex, indexNodeSize, type CanvasNodeIndex } from "./canvas-node-index.js";
import { isShotPreviewOnlySelection } from "./shot-preview-protection.js";
import type { InteractionCore } from "./interaction-core.js";
import type { Gesture } from "./interaction-types.js";
import {nodeDrop} from '../../services/node-drop/index.js';

/** drag gesture 的提交/取消/粘连求值能力。 */
export type DragGestureFamily = {
  /** 落点重父化 + 位置更新命令（与 `commit` 共用）。 */
  dragDropCommands: (
    origins: Map<string, { x: number; y: number }>,
    previews: Map<string, { x: number; y: number }>
  ) => CanvasCommand[];
  /** 基于当前 working scene 求值粘连接触；返回是否变化。 */
  evaluate: () => boolean;
  /** 正常释放：位置/结构命令在前、待提交边在后，单批次提交（design D4）。 */
  commit: (gesture: Extract<Gesture, { kind: "drag" }>, previews: Map<string, { x: number; y: number }>) => void;
  /** 取消完整手势：清 held/preview 且不提交（design D6）。 */
  cancel: () => void;
  /** Q/E held 键路由；返回是否已消费（只在带粘连子状态的拖动中）。 */
  onAttachKey: (code: "KeyQ" | "KeyE", down: boolean) => boolean;
  /** 当前拖动是否带粘连子状态。 */
  attachActive: () => boolean;
  /** 当前粘连瞬时投影（未越过移动阈值时 `null`）。 */
  projection: () => import("@woohaa3/contracts").BevyDragAttach | null;
  /** working canvas 更新时清理失效 contact/pending；返回是否变化。 */
  prune: () => boolean;
};

/** 把绝对落点预览投影为相对其父级的持久化坐标（含完整祖先链），仅保留净变化的节点。 */
function netPositionUpdates(
  index: CanvasNodeIndex,
  previews: Map<string, { x: number; y: number }>
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [id, preview] of previews) {
    const node = index.byId.get(id);
    if (!node) continue;
    const parent = index.parentAbsolutePosition(id);
    const next = { x: preview.x - parent.x, y: preview.y - parent.y };
    // 无净变化不产生命令（design D5）；与结构 diff 的严格比较保持一致。
    if (node.position.x === next.x && node.position.y === next.y) continue;
    positions[id] = next;
  }
  return positions;
}

/**
 * 用拖动预览覆盖被拖动节点的位置（相对父级；其余节点按引用复用），供命中 group 与
 * 重父化复用。只复制有预览的节点，避免整表深拷贝。
 */
function projectPreviewNodes(
  index: CanvasNodeIndex,
  previews: Map<string, { x: number; y: number }>
): Woohaa3CanvasNode[] {
  const nodes = index.source.document.nodes;
  const projected: Woohaa3CanvasNode[] = new Array(nodes.length);
  for (let position = 0; position < nodes.length; position += 1) {
    const node = nodes[position]!;
    const preview = previews.get(node.id);
    if (!preview) {
      projected[position] = node as unknown as Woohaa3CanvasNode;
      continue;
    }
    const parent = index.parentAbsolutePosition(node.id);
    projected[position] = {
      ...node,
      position: { x: preview.x - parent.x, y: preview.y - parent.y },
      data: {}
    } as unknown as Woohaa3CanvasNode;
  }
  return projected;
}

export function createDragGestureFamily(
  core: Pick<InteractionCore, "state" | "submit" | "buildScene" | "buildDragScene" | "schedule" | "clearHeldKeys">
): DragGestureFamily {
  const { state, submit, buildScene, schedule } = core;

  /**
   * 被拖动的选择集是否**全部**是受保护的拍摄镜头预览。
   *
   * 预览由源镜头生命周期维护，拖动只是移动纯 2D 卡片；它既不能被其它节点「复制导入」，也不能
   * 被片场当作可接收素材。因此这时完全跳过 `nodeDrop` 分派：既不显示「放到此处加入片场」提示，
   * 也不消费释放（保持一次纯移动，change: 2026-10-15-add-film-set-shooting-shot-previews，D2/D8）。
   */
  const previewOnlyDrag = (origins: Map<string, { x: number; y: number }>): boolean => {
    const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
    if (!canvasState || origins.size === 0) return false;
    // 便宜预筛：只要有一个被拖动节点不是预览类型就不必做归属解析（拖动每次 pointermove 都会到这里）。
    let previewShaped = 0;
    for (const node of canvasState.document.nodes) {
      if (origins.has(node.id) && node.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE) previewShaped += 1;
    }
    if (previewShaped !== origins.size) return false;
    return isShotPreviewOnlySelection({
      selectedNodeIds: [...origins.keys()],
      nodes: canvasState.document.nodes.map((node) => ({ id: node.id, type: node.type })),
      nodeData: canvasState.nodeData
    });
  };

  const dragDropCommands = (
    origins: Map<string, { x: number; y: number }>,
    previews: Map<string, { x: number; y: number }>
  ): CanvasCommand[] => {
    const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
    const index = sharedCanvasNodeIndex(canvasState);
    if (!index) return planMoveNodes(Object.fromEntries(previews));
    // 收起/隐藏的容器不接收拖入，避免落入它不可见的展开范围。
    const eligibleGroupIds = index.dropTargetGroupIds;
    // 拖动非 group 节点才可能触发重父化；只有 group 被拖动时是纯位置更新。
    const draggedNonGroup = [...origins.keys()].filter((id) => index.byId.get(id)?.type !== "group");
    if (draggedNonGroup.length === 0) {
      return planMoveNodes(netPositionUpdates(index, previews));
    }
    // With stationary containers, detect the common no-reparent case from the
    // shared group candidates and the moved roots alone. Complex mixed group
    // drags keep the canonical full planner below.
    const movingGroup = [...previews.keys()].some(id => index.byId.get(id)?.type === "group");
    if (!movingGroup) {
      const groupAt = (id: string) => {
        const node = index.byId.get(id);
        const position = previews.get(id) ?? index.absolutePosition(id);
        if (!node || !position) return null;
        const size = indexNodeSize(node);
        const cx = position.x + size.width / 2, cy = position.y + size.height / 2;
        return index.groupBounds.find(group =>
          eligibleGroupIds.has(group.id) && cx >= group.x && cx <= group.x + group.width
          && cy >= group.y && cy <= group.y + group.height)?.id ?? null;
      };
      const explicitTarget = groupAt(draggedNonGroup[0]!);
      const reparent = draggedNonGroup.some(id => {
        const node = index.byId.get(id);
        return node && (node.parentId ?? null) !== (explicitTarget ?? groupAt(id));
      });
      if (!reparent) return planMoveNodes(netPositionUpdates(index, previews));
    }
    const projected = projectPreviewNodes(index, previews);
    // Freeze group sizes from the working snapshot, before applying dragged member positions.
    const groupSizes = new Map(index.groupBounds.map(group => [group.id, {width: group.width, height: group.height}]));
    const target = findGroupContainingCenter(projected, draggedNonGroup[0]!, groupSizes, eligibleGroupIds);
    const { nodes: reparented, reparented: didReparent } = reparentDraggedNodes(projected, draggedNonGroup, target, groupSizes, eligibleGroupIds);
    if (!didReparent) {
      // 无重父化/容器尺寸变化：直接生成选中根的净位置（持久化相对坐标），
      // 不构造全场 before/after 再比较（design D5）。
      return planMoveNodes(netPositionUpdates(index, previews));
    }
    const original: Woohaa3CanvasNode[] = index.source.document.nodes.map((node) => ({
      ...node,
      position: { ...node.position },
      data: {}
    })) as unknown as Woohaa3CanvasNode[];
    return planGroupStructureChange(original, reparented);
  };

  const evaluate = (): boolean => {
    const gesture = state.gesture;
    if(gesture.kind==='drag' && gesture.moved){
      // 片场复制导入。受保护预览的拖动只移动卡片，不做接收方预览（不显示导入提示）。
      if (!previewOnlyDrag(gesture.origins)) {
        nodeDrop.preview([...gesture.origins.keys()],state.lastPointerWorld);
      } else {
        nodeDrop.clear();
      }
    }
    if (gesture.kind !== "drag" || !gesture.attach) return false;
    // Most drags have no held Q/E key: no contact geometry is needed.
    if (!gesture.attach.mode) {
      const changed = gesture.attach.contactNodeId !== null;
      gesture.attach.contactNodeId = null;
      return changed;
    }
    const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
    const scene = core.buildDragScene?.() ?? buildScene();
    if (!canvasState || !scene) return false;
    return evaluateDragAttachContact(gesture.attach, scene, canvasState);
  };

  const commit = (
    gesture: Extract<Gesture, { kind: "drag" }>,
    previews: Map<string, { x: number; y: number }>
  ): void => {
    // 片场复制拖入在普通移动之前裁决：命中即消费释放，源节点回位、不提交源 move/parent/edge
    // （change: 2026-10-08-make-film-set-model-only，design D4）。受保护预览的拖动只移动卡片，
    // 不进 drop 分派（不显示导入提示，也不消费释放）。
    if(!previewOnlyDrag(gesture.origins) && gesture.moved && nodeDrop.drop([...gesture.origins.keys()],state.lastPointerWorld)){
      nodeDrop.clear();return;
    }
    nodeDrop.clear();
    const positionCommands = previews.size > 0 ? dragDropCommands(gesture.origins, previews) : [];
    const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
    const edgeCommands = gesture.attach && canvasState
      ? revalidateDragAttachEdges(gesture.attach, canvasState).map((edge) => ({
          type: "edge.add" as const,
          edge: {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            sourceHandle: null,
            targetHandle: null
          }
        }))
      : [];
    const commands = [...positionCommands, ...edgeCommands];
    if (commands.length > 0) submit(commands);
  };

  const cancel = (): void => {
    nodeDrop.clear();
    state.gesture = { kind: "none" };
    state.draft = null;
    state.localPositions = new Map();
    state.localSizes = new Map();
    core.clearHeldKeys();
    schedule("position-preview");
  };

  return {
    dragDropCommands,
    evaluate,
    commit,
    cancel,
    onAttachKey: (code, down) => {
      const gesture = state.gesture;
      if (gesture.kind !== "drag" || !gesture.attach) return false;
      if (applyDragAttachKey(gesture.attach, code, down)) {
        evaluate();
        schedule();
      }
      return true;
    },
    attachActive: () => state.gesture.kind === "drag" && state.gesture.attach !== undefined,
    projection: () => {
      const gesture = state.gesture;
      if(gesture.kind!=='drag'){nodeDrop.clear();}
      if (gesture.kind !== "drag" || !gesture.attach || !gesture.moved) return null;
      return dragAttachProjection(gesture.attach);
    },
    prune: () => {
      const gesture = state.gesture;
      if (gesture.kind !== "drag" || !gesture.attach) return false;
      const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
      if (!canvasState) return false;
      return pruneDragAttachState(gesture.attach, canvasState);
    }
  };
}
