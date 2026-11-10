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
import { builtinNodeCapabilityResolver, type NodeCapabilityResolver } from "@woohaa3/contracts";
import type { VideoFrameSessions } from "../canvas-runtime/video-frame-session.js";
import { resolveWorldCameraVideoSource } from "../canvas-runtime/video-source.js";

export type HoverTrackerDeps = {
  nodeCapabilities?: NodeCapabilityResolver;
  state: InteractionState;
  videoSessions?: VideoFrameSessions | null;
  modalActive: () => boolean;
  /**
   * 视频 hover 播放门禁（缺省同 `modalActive`）。
   *
   * 与 `modalActive` 分开是因为它有更宽的成分：截图/录制拥有的 capture playback owner
   * 只应冻结**被捕捉内容**的确定性（拍摄预览候选与场景动画），不能停掉无关视频卡片的
   * 实时预览——否则后台镜头参考录制（成功前会按退避重试）期间，任何视频节点 hover 都
   * 不播放（真实缺陷：hover 视频节点不再播放）。
   */
  videoPlaybackBlocked?: () => boolean;
  schedule: () => void;
  /**
   * 模型网格命中：卡片下方的模型 AABB picking（change: play-model-animations-on-hover）。
   * `point` 为 canvas 内 CSS 坐标，`surface` 为 CSS 尺寸。只在画布含模型节点时调用。
   */
  modelPick?: (point: { x: number; y: number }, surface: { width: number; height: number }) => InteractionQuery<{ nodeId: string } | null>;
  historyAt?: (nodeId: string) => string | undefined;
};

/**
 * working 画布是否含可做 3D picking 的对象（无对象时跳过跨 WASM 调用）。
 *
 * 世界模型由 focus 能力声明；共享世界镜头没有卡片内容，也必须用同一视锥/机位拾取
 * 建立 hover 与选中反馈。
 */
function canvasHasModelNode(resolver: NodeCapabilityResolver = builtinNodeCapabilityResolver): boolean {
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
  return canvas?.document.nodes.some((node) =>
    !!resolver.resolve({ canvas, node, data: canvas.nodeData[node.id] }).focus
    || canvas.nodeData[node.id]?.worldCamera !== undefined
  ) ?? false;
}

/**
 * 播放入口资格：只有**节点本体**或**模型网格**命中才建立普通播放 hover。
 *
 * 选中抓手、端点、历史/下载、连线删除与聚合把手等控件命中仍保留 2D hover 高亮
 * （`state.hoveredNodeId`），但不得作为播放入口。
 */
function playbackHoverNodeId(hit: HitTarget | null): string | null {
  if (!hit) return null;
  return hit.kind === "node" ? hit.nodeId : null;
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
    // capture playback owner 不参与视频 hover 门禁（见 `videoPlaybackBlocked`）：它只为被捕捉
    // 内容的确定性冻结拍摄预览/场景动画，与普通视频卡片的实时预览无关。
    if ((deps.videoPlaybackBlocked ?? deps.modalActive)() || state.gesture.kind !== "none") {
      suspendVideo();
      return;
    }
    let next: string | null = null;
    if (hit && hit.kind === "node") {
      const canvasState = woohaa3CanvasStore.getState().canvas;
      const entry = canvasState?.document.nodes.find((candidate) => candidate.id === hit.nodeId);
      if (entry?.type === "video" || (entry?.type === "world-camera" && canvasState
        && resolveWorldCameraVideoSource(canvasState, hit.nodeId))) next = hit.nodeId;
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
    const nextNodeId = hit && "nodeId" in hit ? hit.nodeId : null;
    const nextPort = hit && hit.kind === "port" ? hit.side : null;
    const nextEdgeId = hit && (hit.kind === "edge" || hit.kind === "edge-delete") ? hit.edgeId : null;
    const historyId = hit?.kind === "history" ? deps.historyAt?.(hit.nodeId) : undefined;
    const nextHistory = historyId && nextNodeId ? { nodeId: nextNodeId, presentationId: historyId } : null;
    const nextPointer = (nextPort || nextEdgeId) ? state.lastPointerWorld : null;
    const pointerChanged = nextPointer?.x !== state.hoverPointer?.x || nextPointer?.y !== state.hoverPointer?.y;
    if (!pointerChanged && nextNodeId === state.hoveredNodeId && nextPort === state.hoveredPort && nextEdgeId === state.hoveredEdgeId
      && nextHistory?.presentationId === state.hoveredHistory?.presentationId) return;
    state.hoverPointer = nextPointer ? { ...nextPointer } : null;
    state.hoveredHistory = nextHistory;
    state.hoveredNodeId = nextNodeId;
    state.hoveredPort = nextPort;
    state.hoveredEdgeId = nextEdgeId;
    // 发布播放 hover 供插件层订阅（普通模型动画 hover 播放）：只有可播放入口（节点本体/模型网格）
    // 才建立；选中抓手、端点、历史/下载与连线都不作为普通播放入口。
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
      // 几何不可用/过期：清除悬停；进行中的手势按既有取消规则处理（design D3）。
      clearHover();
      return;
    }
    const hit = resolveHoverHit(cardHit.value, point, surface);
    updateHoveredVideo(hit);
    updateHover(hit);
  };

  /** 清除全部悬停态；仅在确实有悬停时触发重绘。 */
  const clearHover = () => {
    // 无论 state 是否已空，都确保发布的 hover 节点被清除（手势/modal/输入清除时停止 hover 播放）。
    hoverNodeStore.setNodeId(null);
    if (state.hoveredNodeId === null && state.hoveredPort === null && state.hoveredEdgeId === null && !state.hoveredHistory) return;
    state.hoverPointer = null;
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
      if (!pointer || deps.modalActive() || state.gesture.kind !== "none") { hoverNodeStore.setNodeId(null); return; }
      // 只刷新查询可用性：保留当前 hover（含连线悬停保持区），避免滚动/平移期间悬停闪烁。
      const result = query(pointer.point);
      queryPending = !result.ok;
      nextQueryAt = performance.now() + 100;
      if (!result.ok) hoverNodeStore.setNodeId(null);
    }
  };
}
