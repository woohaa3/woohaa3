/**
 * 单节点拖动与 Q/E 触碰粘连的 gesture 逻辑
 * （change: add-drag-touch-connections；从 `interaction-2d-input` 拆出以保持在文件体积上限内）。
 *
 * 只通过注入的共享 `InteractionCore` 能力访问状态、场景与提交；不自建监听，也不持有
 * 跨手势状态。粘连子状态完整内聚在单次 drag gesture 内（design D1）。
 *
 * 结构与位置索引按 working 身份缓存复用（change: 2026-10-10-optimize-canvas-interaction-hot-path，
 * design D5）：释放时直接生成选中根的**净位置**命令。
 */
import {
  createHighEntropyId,
  decodeWorkflowGroupData,
  effectiveCanvasNodeSize,
  isMergeEligibleNode,
  planGroupMembershipCommand,
  resolveMergeTarget,
  type CanvasCommand,
} from "@woohaa3/contracts";
import { planMoveNodes } from "../../../extension-api/command-planner.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import {
  applyDragAttachKey,
  dragAttachProjection,
  evaluateDragAttachContact,
  pruneDragAttachState,
  revalidateDragAttachEdges,
} from "./drag-attach.js";
import { sharedCanvasNodeIndex } from "./canvas-node-index.js";
import { setAlignmentGuides } from "./alignment-snap.js";
import type { InteractionCore } from "./interaction-core.js";
import type { Gesture } from "./interaction-types.js";
import {nodeDrop} from '../../services/node-drop/index.js';
import {nodeMerge, type NodeMergeDrag} from '../../services/node-merge/index.js';

/** drag gesture 的提交/取消/粘连求值能力。 */
export type DragGestureFamily = {
  /** 落点位置更新命令（与 `commit` 共用）。 */
  dragDropCommands: (
    origins: Map<string, { x: number; y: number }>,
    previews: Map<string, { x: number; y: number }>
  ) => CanvasCommand[];
  /** 基于当前 working scene 求值粘连接触；返回是否变化。 */
  evaluate: () => boolean;
  /** 正常释放：位置命令在前、待提交边在后，单批次提交（design D4）。 */
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
    Partial<Pick<InteractionCore, "options" | "writable" | "queryDropTarget">>
): DragGestureFamily {
  const { state, submit, buildScene, schedule } = core;
  /** 只读会话不提示也不消费合并；缺省注入时按可写处理（独立单元/测试）。 */
  const writable = (): boolean => core.writable?.() ?? true;

  /**
   * 计算当前拖动唯一合并候选（change: 2026-10-27-merge-same-type-node-history，任务 2.2 / design D1、D3）。
   *
   * 只认单根节点拖动、可写会话、可参与合并的来源；目标从索引的同类型桶里取，pointermove 上
   * 只扫同类小列表。DOM 高亮与确认框由 `node-merge` 插件负责，本族只决定是否显示提示与消费释放。
   */
  const resolveMergeCandidate = (gesture: Extract<Gesture, { kind: "drag" }>): NodeMergeDrag | null => {
    if (!gesture.moved || gesture.origins.size !== 1) return null;
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
    const size = effectiveCanvasNodeSize(sourceNode as unknown as { type: string; width?: number; height?: number });
    const center = { x: position.x + size.width / 2, y: position.y + size.height / 2 };
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
    // 只提交有净变化的节点：回到原点释放不应产生空位置更新。
    const moved = Object.fromEntries([...previews].filter(([id, position]) => {
      const origin = origins.get(id);
      return !origin || origin.x !== position.x || origin.y !== position.y;
    }));
    return Object.keys(moved).length > 0 ? planMoveNodes(moved) : [];
  };

  const evaluate = (): boolean => {
    const gesture = state.gesture;
    if(gesture.kind==='drag' && gesture.moved){
      // 合并候选优先于接收方预览：命中时只显示「松手合并」，不点亮接收方
      // （change: 2026-10-27-merge-same-type-node-history，任务 2.2 / design D3）。
      const mergeCandidate = resolveMergeCandidate(gesture);
      nodeMerge.preview(mergeCandidate);
      if (mergeCandidate) nodeDrop.clear();
      else nodeDrop.preview([...gesture.origins.keys()],state.lastPointerWorld);
    } else {
      nodeMerge.clear();
      nodeDrop.clear();
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
    // 合并先于接收方 drop 裁决：命中即消费释放，源节点不提交位置命令，等确认框结果。
    const mergeCandidate = resolveMergeCandidate(gesture);
    if (mergeCandidate && nodeMerge.drop(mergeCandidate)) {
      nodeMerge.clear();
      nodeDrop.clear();
      return;
    }
    nodeMerge.clear();
    if(gesture.moved && nodeDrop.drop([...gesture.origins.keys()],state.lastPointerWorld)){
      nodeDrop.clear();return;
    }
    nodeDrop.clear();
    const positionCommands = previews.size > 0 ? dragDropCommands(gesture.origins, previews) : [];
    const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
    // 拖入 2D 组：成员表补丁与位置更新放进同一批次，避免两条记录互相抢 revision。
    // 用 working 画布的组矩形判定，而不是 Rust drop target：拖动中的节点在 snapshot 里
    // 还是旧位置，落在组内成员卡片上时也应当算加入组。
    const dropPoint = state.lastPointerWorld;
    const groupNode = gesture.moved && canvasState && dropPoint
      ? [...canvasState.document.nodes].reverse().find((node) => node.type === "workflow-group-2d" && node.position
        && dropPoint.x >= node.position.x && dropPoint.y >= node.position.y
        && dropPoint.x <= node.position.x + (node.width ?? 260)
        && dropPoint.y <= node.position.y + (node.height ?? 195))
      : undefined;
    const groupCommand = groupNode && canvasState
      && decodeWorkflowGroupData(canvasState.nodeData[groupNode.id]?.workflowGroup2d).ok
      ? planGroupMembershipCommand(
          canvasState,
          groupNode.id,
          [...gesture.origins.keys()],
          createHighEntropyId("group-scope-version"),
        )
      : null;
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
    const submitted = commands.length > 0 ? submit(commands) : undefined;
    if (groupCommand) {
      // 成员表补丁不属于可撤销的位置编辑计划；等位置提交落定后单独走会话命令，
      // 保证不会与位置批次抢 revision。
      Promise.resolve(submitted).then((state) => {
        if (state === "rejected") return;
        core.options?.getSession?.()?.submitCommands(
          [groupCommand],
          `web-group-drop-${Date.now().toString(36)}`
        );
      });
    }
  };

  const cancel = (): void => {
    nodeDrop.clear();
    nodeMerge.clear();
    state.gesture = { kind: "none" };
    state.draft = null;
    state.localPositions = new Map();
    state.localSizes = new Map();
    // 取消路径不经过 pointerup 收尾：同样要推进版本号，否则覆盖层留着上一次的线。
    setAlignmentGuides(state, []);
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
