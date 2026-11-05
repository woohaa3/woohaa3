/**
 * 单帧瞬时态推进（与场景构建无关的逐帧工作）
 * （change: 2026-10-10-optimize-canvas-interaction-hot-path，从 `interaction-controller` 拆出以
 * 保持业务单文件 ≤500 行的体积守卫）。
 *
 * 先推进与场景无关的逐帧工作（modal held input 清理、聚焦有效性、纹理与视频会话、
 * 失效 selection/draft/粘连/聚合成员清理）。是否构建/提交场景由调用方（唯一帧结算点）
 * 依据失效账本决定。
 */
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { modelPreviewStore } from "../../services/model-preview-store.js";
import { sharedCanvasNodeIndex } from "./canvas-node-index.js";
import type { InteractionState } from "./interaction-core.js";

/** 瞬时态推进所需注入能力（全部来自 controller 闭包）。 */
export type TransientFrameDeps = {
  focusInputBlocked: () => boolean;
  clearHeldKeys: () => void;
  /** 聚焦目标失效检查（删除 / Scene IR 移除 / selection 清除）。 */
  syncModelFocusValid: () => void;
  /**
   * 本帧资源需求投影（先准入再创建）。
   *
   * 必须在 `syncTexture` / `syncVideoSessions` 之前调用：未准入的节点不得创建解码器
   * 或纹理（design D1/D2）。缺省跳过（旧测试路径）。
   */
  projectResidency?: () => void;
  syncTexture: () => void;
  syncVideoSessions: () => void;
  state: InteractionState;
  isFocused: () => boolean;
  setSelection: (ids: string[]) => void;
  clearHover: () => void;
  cancelTransientGesture: () => void;
  cancelDragGesture: () => void;
  pruneAttach: () => boolean;
  cancelAggregateConnect: () => void;
  markInvalidated: (reason: string) => void;
  writable: () => boolean;
};

/** 推进一帧的瞬时态工作。纯副作用函数：不构建场景、不跨 WASM 边界。 */
export function advanceTransientState(deps: TransientFrameDeps): void {
  const { state } = deps;
  // modal 打开时清理 focus held input；非模态 panel 不打断 focus 飞行（D6）。
  if (deps.focusInputBlocked()) deps.clearHeldKeys();
  deps.syncModelFocusValid();
  // 先算本帧准入集合（含档位/用途），再让各媒体 owner 只为准入项创建资源（design D1/D2）。
  deps.projectResidency?.();
  // 先确保就绪纹理已上传（上传完成的节点 texture 标记才会生效）。
  deps.syncTexture();
  // 视频会话按当前 canonical/working 画布同步（新增/换源/删除），并推进 hover 播放。
  deps.syncVideoSessions();
  // 被拒绝/重基 blocked 导致 working 中消失的节点：清理失效 selection 与连线草稿（任务 4.6）。
  const working = workingCanvasOf(woohaa3CanvasStore.getState());
  if (working) {
    const index = sharedCanvasNodeIndex(working)!;
    const liveIds = index.liveIds;
    const focused = deps.isFocused();
    const visible = (id: string) => liveIds.has(id) && (focused || !index.hiddenNodeIds.has(id));
    modelPreviewStore.prune(liveIds);
    if (state.gesture.kind === "model-preview" && !liveIds.has(state.gesture.nodeId)) {
      deps.cancelTransientGesture();
    }
    const edgeVisible = (id: string) => working.document.edges.some(edge =>
      edge.id === id && visible(edge.source) && visible(edge.target));
    if (state.selectedEdgeId && !edgeVisible(state.selectedEdgeId)) {
      state.selectedEdgeId = null;
      deps.markInvalidated("edge-selection-prune");
    }
    if (state.hoveredEdgeId && !edgeVisible(state.hoveredEdgeId)) deps.clearHover();
    const survivors = state.selected.filter(visible);
    if (survivors.length !== state.selected.length) deps.setSelection(survivors);
    if (state.hoveredNodeId && !visible(state.hoveredNodeId)) deps.clearHover();
    if (state.draft && !visible(state.draft.source)) state.draft = null;
    // 拖动粘连：owner 从 working 消失则取消整次手势；否则只移除失效 target 的预览（D6）。
    if (state.gesture.kind === "drag") {
      if ([...state.gesture.origins.keys()].some(id => !visible(id))) {
        deps.cancelDragGesture();
      } else if (state.gesture.attach && deps.pruneAttach()) {
        deps.markInvalidated("attach-prune");
      }
    }
    // 世界模型地面拖动：节点消失/隐藏或会话转只读时取消未提交的位移预览（D6）。
    if (state.gesture.kind === "world-ground") {
      if (!visible(state.gesture.start.nodeId) || !deps.writable()) deps.cancelDragGesture();
    }
    // 镜头视锥拖动：镜头消失/隐藏或会话转只读时取消未提交的位姿预览（D6）。
    if (state.gesture.kind === "world-camera") {
      if (!visible(state.gesture.start.nodeId) || !deps.writable()) deps.cancelDragGesture();
    }
    // 聚合拉线：成员失效时只保留存活成员；全部失效或会话转只读则取消（D6）。
    if (state.gesture.kind === "aggregate-connect") {
      const liveMembers = state.gesture.members.filter((id) => liveIds.has(id));
      if (liveMembers.length !== state.gesture.members.length) state.gesture.members = liveMembers;
      if (liveMembers.length === 0 || !deps.writable()) deps.cancelAggregateConnect();
    }
  }
}
