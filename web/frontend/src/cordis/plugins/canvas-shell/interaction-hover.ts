/**
 * 指针 hover 与视频播放跟踪
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；
 *   change: enable-video-node-live-preview）。
 *
 * 从 `interaction-controller.ts` 拆出：节点端点/连线悬停态与视频 hover 播放。只读取注入的
 * state 与 video sessions，不持有 pointer 监听。
 */
import type { HitTarget } from "./hit-test.js";
import type { InteractionQuery, InteractionState } from "./interaction-core.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { hoverNodeStore } from "../../services/hover-store.js";
import { builtinNodeCapabilityResolver, type NodeCapabilityResolver, shotPreviewOwnershipOf } from "@woohaa3/contracts";
import type { VideoFrameSessions } from "../canvas-runtime/video-frame-session.js";

export type HoverTrackerDeps = {
  projectCanvas?: (canvas: import("@woohaa3/contracts").ServerCanvas | null) => import("@woohaa3/contracts").ServerCanvas | null;
  nodeCapabilities?: NodeCapabilityResolver;
  state: InteractionState;
  videoSessions?: VideoFrameSessions | null;
  modalActive: () => boolean;
  schedule: () => void;
  /**
   * 模型网格命中：卡片下方的模型 AABB picking（change: play-model-animations-on-hover）。
   * `point` 为 canvas 内 CSS 坐标，`surface` 为 CSS 尺寸。只在画布含模型节点时调用。
   */
  modelPick?: (point: { x: number; y: number }, surface: { width: number; height: number }) => InteractionQuery<{ nodeId: string } | null>;
  historyAt?: (nodeId: string) => string | undefined;
};

/** working 画布是否含 3D 模型节点（无模型时跳过模型 picking 的跨 WASM 调用）。 */
function canvasHasModelNode(resolver: NodeCapabilityResolver = builtinNodeCapabilityResolver): boolean {
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
  return canvas?.document.nodes.some((node) => !!resolver.resolve({ canvas, node, data: canvas.nodeData[node.id] }).focus) ?? false;
}

/**
 * 播放入口资格：只有**节点本体**、**模型网格**或**拍摄镜头预览内容区**命中才建立普通
 * 播放 hover（change: 2026-10-13-add-film-set-hover-camera-entity，design D4；
 * change: 2026-10-15-add-film-set-shooting-shot-previews，design D6）。
 *
 * 选中抓手、端点、历史/下载、连线删除与聚合把手等控件命中仍保留 2D hover 高亮
 * （`state.hoveredNodeId`），但不得作为播放入口。片场地面（`film-scope`）**不再**开播
 * （design D6：移除地面/default 开播路径），只有动态拍摄镜头预览**内容区**建立拍摄播放候选。
 */
function playbackHoverNodeId(hit: HitTarget | null): string | null {
  if (!hit) return null;
  return hit.kind === "node" || hit.kind === "model-preview" || hit.kind === "shot-preview"
    ? hit.nodeId
    : null;
}

/**
 * 跟踪指针下的视频节点并驱动 hover 播放（change: enable-video-node-live-preview，design D3）。
 */
export function createHoverTracker(deps: HoverTrackerDeps) {
  const { state } = deps;
  let queryPending = false;
  let nextQueryAt = 0;
  let pointer: { point: { x: number; y: number }; surface: { width: number; height: number } } | null = null;
  /**
   * 由**命中**派生拍摄播放目标：仅当命中拍摄镜头预览**内容区**且权威 nodeData 归属合法时发布。
   *
   * 归属只从当前规范画布读取（不缓存、不猜默认镜头）；缺失/非法归属即不建立候选。片场地面命中
   * 不再开播（change: 2026-10-15，design D6）。
   */
  const playbackTargetFromHit = (
    hit: HitTarget | null
  ): import("../../../extension-api/model-workspace.js").HoverPlaybackTarget => {
    if (!hit || hit.kind !== "shot-preview") return null;
    const canonical = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
    const canvas = deps.projectCanvas?.(canonical) ?? canonical;
    const ownership = shotPreviewOwnershipOf(canvas?.nodeData?.[hit.nodeId]);
    if (!ownership) return null;
    return {
      kind: "shot-preview",
      previewNodeId: hit.nodeId,
      filmSetNodeId: ownership.filmSetNodeId,
      clipId: ownership.clipId
    };
  };
  let lastQueryLog = "";
  const publishPlaybackTarget = (hit: HitTarget | null) => {
    const target = playbackTargetFromHit(hit);
    const blocked = deps.modalActive() || state.gesture.kind !== "none";
    const previous = hoverNodeStore.getPlaybackSnapshot().target;
    hoverNodeStore.setPlaybackTarget(target, blocked);
    const snapshot = hoverNodeStore.getPlaybackSnapshot();
    const signature = JSON.stringify({ hit: hit?.kind ?? null,
      previewNodeId: target?.previewNodeId ?? null, gesture: state.gesture.kind,
      modal: deps.modalActive(), blocked: snapshot.blocked, epoch: snapshot.epoch });
    if (signature !== lastQueryLog && (target || previous)) console.info("[shot-startup] hover-hit " + signature);
    lastQueryLog = signature;
  };

  /**
   * 解析指针下的节点 hover 目标：卡片命中优先；卡片为空白但落在模型网格（渲染在卡片下方）时，
   * 回退到模型 AABB picking，使 hover 模型本体也建立 `hover.nodeId` 以驱动 hover 播放
   * （change: play-model-animations-on-hover）。
   */
  const resolveHoverHit = (
    cardHit: HitTarget | null,
    point: { x: number; y: number },
    surface: { width: number; height: number }
  ): HitTarget | null => {
    if (cardHit !== null) return cardHit;
    if (!deps.modelPick || !canvasHasModelNode(deps.nodeCapabilities)) return null;
    const pick = deps.modelPick(point, surface);
    return pick.ok && pick.value ? { kind: "node", nodeId: pick.value.nodeId } : null;
  };

  const suspendVideo = () => {
    if (state.hoveredVideoNode === null) return;
    state.hoveredVideoNode = null;
    deps.videoSessions?.setHovered(null);
  };

  const updateHoveredVideo = (hit: HitTarget | null) => {
    const sessions = deps.videoSessions;
    if (!sessions) return;
    if (deps.modalActive() || state.gesture.kind !== "none") {
      suspendVideo();
      return;
    }
    let next: string | null = null;
    if (hit && hit.kind === "node") {
      const canvasState = woohaa3CanvasStore.getState().canvas;
      const entry = canvasState?.document.nodes.find((candidate) => candidate.id === hit.nodeId);
      if (entry?.type === "video") next = hit.nodeId;
    }
    if (next === state.hoveredVideoNode && (next === null || sessions.playingNodeId() === next)) return;
    state.hoveredVideoNode = next;
    sessions.setHovered(next);
  };

  /**
   * 更新指针下的悬停态（change: add-node-endpoint-hover / add-edge-hover-delete）。
   *
   * modal 输入隔离或画布手势进行中时不建立 hover 投影：模型动画门禁以 `hover.nodeId` 为
   * 唯一播放触发，因此手势期间必须提交无 hover scene 才能停止播放
   * （change: play-model-animations-on-hover，任务 3.2 / design D1）。
   */
  const updateHover = (hit: HitTarget | null) => {
    if (deps.modalActive() || state.gesture.kind !== "none") {
      clearHover();
      return;
    }
    publishPlaybackTarget(hit);
    const nextNodeId = hit && "nodeId" in hit ? hit.nodeId : null;
    const nextPort = hit && hit.kind === "port" ? hit.side : null;
    const nextEdgeId = hit && (hit.kind === "edge" || hit.kind === "edge-delete") ? hit.edgeId : null;
    const historyId = hit?.kind === "history" ? deps.historyAt?.(hit.nodeId) : undefined;
    const nextHistory = historyId && nextNodeId ? { nodeId: nextNodeId, presentationId: historyId } : null;
    if (nextNodeId === state.hoveredNodeId && nextPort === state.hoveredPort && nextEdgeId === state.hoveredEdgeId
      && nextHistory?.presentationId === state.hoveredHistory?.presentationId) return;
    state.hoveredHistory = nextHistory;
    state.hoveredNodeId = nextNodeId;
    state.hoveredPort = nextPort;
    state.hoveredEdgeId = nextEdgeId;
    // 发布播放 hover 供插件层订阅（普通模型动画 hover 播放）：只有可播放入口（节点本体/模型网格）
    // 才建立；选中抓手、端点、历史/下载、连线与片场地面范围都不作为普通播放入口
    // （change: 2026-10-15-add-film-set-shooting-shot-previews，design D6）。拍摄预览内容区由
    // `publishPlaybackTarget` 单独发布 typed target，不走这里。
    hoverNodeStore.setNodeId(playbackHoverNodeId(hit));
    deps.schedule();
  };

  /**
   * 指针移动时的 hover 结算：卡片命中 → 模型网格回退 → 视频 hover。
   *
   * `cardHit` 是 `queryPoint` 结果（`ok:false` 表示几何不可用/过期）。卡片为空白但指针落在
   * 模型网格（渲染在卡片下方）时，用 `modelPickAt` 回退，使 hover 模型本体也建立
   * `hover.nodeId` 以驱动 hover 播放（change: play-model-animations-on-hover）。
   */
  const settlePointerHover = (
    cardHit: InteractionQuery<HitTarget | null>,
    point: { x: number; y: number },
    surface: { width: number; height: number }
  ) => {
    pointer = { point, surface };
    queryPending = !cardHit.ok;
    nextQueryAt = performance.now() + 100;
    if (!cardHit.ok) {
      console.info("[shot-startup] hover-query " + JSON.stringify({ status: "unavailable", retry: true }));
      // 几何不可用/过期：清除悬停；进行中的手势按既有取消规则处理（design D3）。
      clearHover();
      return;
    }
    const hit = resolveHoverHit(cardHit.value, point, surface);
    updateHoveredVideo(hit);
    updateHover(hit);
    // 只有共享命中（含内容区）决定拍摄播放入口；AABB 回退只驱动普通模型 hover。
    publishPlaybackTarget(cardHit.value);
  };

  /** 清除全部悬停态；仅在确实有悬停时触发重绘。 */
  const clearHover = () => {
    // 无论 state 是否已空，都确保发布的 hover 节点被清除（手势/modal/输入清除时停止 hover 播放）。
    hoverNodeStore.setPlaybackTarget(null, true);
    hoverNodeStore.setNodeId(null);
    if (state.hoveredNodeId === null && state.hoveredPort === null && state.hoveredEdgeId === null && !state.hoveredHistory) return;
    state.hoveredHistory = null;
    state.hoveredNodeId = null;
    state.hoveredPort = null;
    state.hoveredEdgeId = null;
    deps.schedule();
  };

  return { updateHoveredVideo, updateHover, settlePointerHover, clearHover, suspendVideo,
    needsRefresh: () => queryPending && pointer !== null && performance.now() >= nextQueryAt,
    forgetPointer: () => { pointer = null; queryPending = false; clearHover(); },
    refreshGround: (query: (point: { x: number; y: number }) => InteractionQuery<HitTarget | null>) => {
      if (!pointer || deps.modalActive() || state.gesture.kind !== "none") { hoverNodeStore.setPlaybackTarget(null, true); return; }
      const result = query(pointer.point);
      queryPending = !result.ok;
      nextQueryAt = performance.now() + 100;
      if (!result.ok) { hoverNodeStore.setPlaybackTarget(null, true); return; }
      publishPlaybackTarget(result.value);
    }
  };
}
