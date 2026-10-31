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
  isMergeEligibleNode,
  readNodeHeight,
  readNodeWidth,
  refitWoohaa3CanvasGroups,
  resolveDraggedNodeDropTargets,
  resolveMergeTarget,
  settleDraggedGroups,
  settleDraggedNodeBoundaries,
  type CanvasCommand,
  type Woohaa3CanvasNode,
} from "@woohaa3/contracts";
import { planFilmSetMembershipCommands, planGroupStructureChange, planMoveNodes } from "../../../extension-api/command-planner.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import {
  applyDragAttachKey,
  dragAttachProjection,
  evaluateDragAttachContact,
  pruneDragAttachState,
  revalidateDragAttachEdges,
} from "./drag-attach.js";
import { sharedCanvasNodeIndex } from "./canvas-node-index.js";
import { groupBadgeProjectionsOf } from "./group-badge-projection.js";
import { isShotPreviewOnlySelection } from "./shot-preview-protection.js";
import type { InteractionCore } from "./interaction-core.js";
import type { Gesture } from "./interaction-types.js";
import {nodeDrop} from '../../services/node-drop/index.js';
import {nodeMerge, type NodeMergeDrag} from '../../services/node-merge/index.js';

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

export function createDragGestureFamily(
  core: Pick<InteractionCore, "state" | "submit" | "buildScene" | "buildDragScene" | "schedule" | "clearHeldKeys"> &
    Partial<Pick<InteractionCore, "options" | "writable">>
): DragGestureFamily {
  const { state, submit, buildScene, schedule } = core;
  /** 只读会话不提示也不消费合并；缺省注入时按可写处理（独立单元/测试）。 */
  const writable = (): boolean => core.writable?.() ?? true;

  /**
   * 被拖动的选择集是否**全部**是受保护的拍摄镜头预览。
   *
   * 预览由源镜头生命周期维护，拖动只是移动纯 2D 卡片；它既不能被其它节点「复制导入」，也不能
   * 被其它节点「复制导入」。因此这时完全跳过 `nodeDrop` 分派：既不显示接收提示，
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

  /**
   * 计算当前拖动唯一合并候选（change: 2026-10-27-merge-same-type-node-history，任务 2.2 / design D1、D3）。
   *
   * 只认单根节点拖动、可写会话、可参与合并的来源；目标从索引的同类型桶里取，pointermove 上
   * 只扫同类小列表。DOM 高亮与确认框由 `node-merge` 插件负责，本族只决定是否显示提示与消费释放。
   */
  const resolveMergeCandidate = (gesture: Extract<Gesture, { kind: "drag" }>): NodeMergeDrag | null => {
    if (!gesture.moved || gesture.origins.size !== 1) return null;
    if (previewOnlyDrag(gesture.origins)) return null;
    if (!writable()) return null;
    const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
    const index = sharedCanvasNodeIndex(canvasState);
    if (!canvasState || !index) return null;
    const sourceNodeId = [...gesture.origins.keys()][0]!;
    const sourceNode = index.byId.get(sourceNodeId);
    if (!sourceNode) return null;
    if (!isMergeEligibleNode({ node: sourceNode, data: canvasState.nodeData[sourceNodeId] })) return null;
    const candidates = index.mergeRectsByType.get(sourceNode.type);
    if (!candidates || candidates.length === 0) return null;
    const position = state.localPositions.get(sourceNodeId) ?? index.absolutePosition(sourceNodeId);
    if (!position) return null;
    const center = {
      x: position.x + readNodeWidth(sourceNode) / 2,
      y: position.y + readNodeHeight(sourceNode) / 2
    };
    const resolved = resolveMergeTarget({
      sourceType: sourceNode.type,
      center,
      candidates,
      excludeNodeIds: new Set(gesture.origins.keys())
    });
    if (!resolved) return null;
    return { sourceNodeIds: [sourceNodeId], targetNodeId: resolved.nodeId, point: center };
  };

  const dragDropCommands = (
    origins: Map<string, { x: number; y: number }>,
    previews: Map<string, { x: number; y: number }>
  ): CanvasCommand[] => {
    const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
    if (!canvasState) return planMoveNodes(Object.fromEntries(previews));
    const index = sharedCanvasNodeIndex(canvasState);
    if (!index) return planMoveNodes(Object.fromEntries(previews));
    // 收起/隐藏的容器不接收拖入，避免落入它不可见的展开范围。
    const eligibleGroupIds = index.dropTargetGroupIds;
    // 释放结算从 working 快照冻结 group 尺寸；pointermove 期间不碰撞求解。
    const roots = index.dragRoots(origins);
    const draggedNonGroup = [...roots.keys()].filter((id) => index.byId.get(id)?.type !== "group");
    const original: Woohaa3CanvasNode[] = index.orderedNodes.map((node) => ({
      ...node,
      position: { ...node.position },
      data: {}
    })) as unknown as Woohaa3CanvasNode[];
    const groupSizes = new Map(index.groupBounds.map(group => [group.id, {width: group.width, height: group.height}]));
    const groupBadgeProjections = groupBadgeProjectionsOf(
      index.source,
      index.groups.map(group => group.id)
    );
    const movingGroups = [...roots.keys()].filter(id => index.byId.get(id)?.type === "group");
    let settled = original;
    if (movingGroups.length > 0) {
      const groupIdeal = new Map<string, { x: number; y: number }>();
      for (const id of movingGroups) {
        const position = previews.get(id) ?? index.absolutePosition(id);
        if (position) groupIdeal.set(id, position);
      }
      const groupResult = settleDraggedGroups(original, movingGroups, groupIdeal, {
        groupSizes,
        eligibleGroupIds,
        collapsedGroupIds: index.collapsedGroupIds,
        groupBadgeProjections,
        protectedNodeIds: new Set(index.compositeNodes.map(node => node.id)),
      });
      if (!groupResult.ok) {
        core.options?.onInteractionError?.(new Error("空间不足，已恢复原位"));
        return [];
      }
      settled = groupResult.nodes;
    }
    if (draggedNonGroup.length > 0) {
      const nodeIdeal = new Map<string, { x: number; y: number }>();
      for (const id of draggedNonGroup) {
        const position = previews.get(id) ?? index.absolutePosition(id);
        if (position) nodeIdeal.set(id, position);
      }
      const nodeResult = settleDraggedNodeBoundaries(settled, draggedNonGroup, nodeIdeal, {
        groupSizes,
        eligibleGroupIds,
        collapsedGroupIds: index.collapsedGroupIds,
        groupBadgeProjections,
        documentOrder: index.documentOrder,
      });
      if (!nodeResult.ok) {
        core.options?.onInteractionError?.(new Error(nodeResult.reason === "node-too-large" ? "节点超出组的可用范围" : "空间不足，已恢复原位"));
        return [];
      }
      settled = nodeResult.nodes;
    }
    // 成员移动后让父组贴合（change: canvas-grouping-redesign）。
    // 释放结算只保证成员不越界，不以 refit 为副作用，所以把成员拖近时框不会缩小；
    // 这里对受影响的组补一次贴合。移动的是组本身时不 refit —— 组不该因搬动而改尺寸。
    // 受影响的组 = 成员**落入后**的父组 + 它**离开前**的父组：只 refit 新父组会让旧父组
    // 留着一圈空壳，只 refit 旧父组则新父组不会撑开去包住刚拖入的成员。
    const affectedGroupIds = new Set<string>();
    for (const id of draggedNonGroup) {
      const next = settled.find((node) => node.id === id)?.parentId;
      const previous = original.find((node) => node.id === id)?.parentId;
      if (next) affectedGroupIds.add(next);
      if (previous) affectedGroupIds.add(previous);
    }
    if (affectedGroupIds.size > 0) {
      settled = refitWoohaa3CanvasGroups([...settled], affectedGroupIds).nodes;
    }
    const changedCommands = planGroupStructureChange(original, settled);
    // 片场成员拖出/拖回：结构差异之外，同一批次切换 binding 的软摘除状态，
    // 保留对象动作脚本；拖回时恢复。非片场组不会产生补丁。
    const filmSetCommands = planFilmSetMembershipCommands(canvasState, original, settled);
    // Both pure moves and structural drops use the same atomic diff planner.
    return [...changedCommands, ...filmSetCommands];
  };

  const evaluate = (): boolean => {
    const gesture = state.gesture;
    let dropChanged = false;
    if(gesture.kind==='drag' && gesture.moved){
      // 合并候选优先于接收方预览：命中时只显示「松手合并」，不点亮接收方
      // （change: 2026-10-27-merge-same-type-node-history，任务 2.2 / design D3）。
      const mergeCandidate = resolveMergeCandidate(gesture);
      nodeMerge.preview(mergeCandidate);
      if (mergeCandidate) {
        nodeDrop.clear();
      } else if (!previewOnlyDrag(gesture.origins)) {
        // 接收方预览。受保护预览的拖动只移动卡片，不做接收方预览（不显示接收提示）。
        nodeDrop.preview([...gesture.origins.keys()],state.lastPointerWorld);
      } else {
        nodeDrop.clear();
      }
      const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
      const index = sharedCanvasNodeIndex(canvasState);
      const roots = index?.dragRoots(gesture.origins) ?? gesture.origins;
      const draggedNonGroup = [...roots.keys()].filter((id) => index?.byId.get(id)?.type !== "group");
      const groupSizes = index ? new Map(index.groupBounds.map(group => [group.id, { width: group.width, height: group.height }])) : undefined;
      const targets = canvasState && index && draggedNonGroup.length > 0
        ? resolveDraggedNodeDropTargets(
          index.orderedNodes,
          draggedNonGroup,
          state.localPositions,
          { groupSizes, eligibleGroupIds: index.dropTargetGroupIds },
        )
        : [];
      dropChanged = targets.length !== state.dropTargetGroupIds.length
        || targets.some((id, i) => id !== state.dropTargetGroupIds[i]);
      state.dropTargetGroupIds = targets;
      if (dropChanged) schedule("input");
    } else {
      nodeMerge.clear();
      if (state.dropTargetGroupIds.length > 0) {
        state.dropTargetGroupIds = [];
        schedule("input");
      }
    }
    if (gesture.kind !== "drag" || !gesture.attach) return dropChanged;
    // Most drags have no held Q/E key: no contact geometry is needed.
    if (!gesture.attach.mode) {
      const changed = gesture.attach.contactNodeId !== null;
      gesture.attach.contactNodeId = null;
      return changed;
    }
    const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
    const scene = core.buildDragScene?.() ?? buildScene();
    if (!canvasState || !scene) return false;
    return evaluateDragAttachContact(gesture.attach, scene, canvasState) || dropChanged;
  };

  const commit = (
    gesture: Extract<Gesture, { kind: "drag" }>,
    previews: Map<string, { x: number; y: number }>
  ): void => {
    // 合并先于接收方 drop 裁决：命中即消费释放，源节点不提交位置命令，等确认框结果。
    const mergeCandidate = resolveMergeCandidate(gesture);
    if (mergeCandidate && nodeMerge.drop(mergeCandidate)) {
      nodeMerge.clear();
      nodeDrop.clear();
      return;
    }
    nodeMerge.clear();
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
    nodeMerge.clear();
    state.dropTargetGroupIds = [];
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
