/**
 * 交互控制器共享核心
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；design D2）。
 *
 * 控制器只拥有唯一的共享输入路由与坐标系：pointer capture、client/world 换算、本地
 * viewport、selection 与 hover 瞬时态。gesture family 与事件处理器通过本 Core 访问这些
 * 共享能力，MUST NOT 各自创建 pointer 监听、viewport 副本或页面级单例。
 */
import type { Point, HitTarget } from "./hit-test.js";
import type { CanvasBounds } from "./canvas-surface-metrics.js";
import type { CanvasRenderScene } from "@woohaa3/contracts";
import type { InteractionControllerOptions, Gesture } from "./interaction-types.js";
import type { ModelGestureFamily } from "./model-gesture-family.js";
import type { WheelSourceState } from "./input/wheel-gesture.js";
import type { createLocalViewportStore } from "../canvas-runtime/local-viewport.js";
import type { ProbeCandidate } from "../canvas-runtime/bevy-runtime.js";
import type { planMoveNodes } from "../../../extension-api/command-planner.js";

export type Viewport = { x: number; y: number; zoom: number };
export type Map2D = Map<string, { x: number; y: number }>;
export type SizeMap = Map<string, { width: number; height: number }>;

/** 拖动粘连 Q/E 路由与取消（change: add-drag-touch-connections）。 */
export type DragAttachKeyboardController = {
  /** 拖动中存在粘连子状态时消费 Q/E；返回是否已消费。 */
  onAttachKey: (code: "KeyQ" | "KeyE", down: boolean) => boolean;
  /** 当前拖动是否带粘连子状态。 */
  attachActive: () => boolean;
  /** 取消完整拖动粘连手势并清空预览（不提交命令）。 */
  cancelDragGesture: () => void;
};

/** 控制器可变瞬时态（浏览器本地，不进规范状态）。 */
export type InteractionState = {
  gesture: Gesture;
  selected: string[];
  localPositions: Map2D;
  localSizes: SizeMap;
  draft: { source: string; side: "input" | "output"; x: number; y: number } | null;
  viewportPreview: Viewport | null;
  spacePressed: boolean;
  lastPointerWorld: Point | null;
  hoveredNodeId: string | null;
  hoveredPort: "input" | "output" | null;
  hoveredEdgeId: string | null;
  hoveredVideoNode: string | null;
  hoveredHistory?: { nodeId: string; presentationId: string } | null;
  wheelSource: WheelSourceState;
  viewportCommitTimer: number | null;
  lastNotifiedViewport: Viewport | null;
};

/** 版本化 2D 查询结果：命中或 `null`（合法空白），或 `ok:false`（unavailable/stale）。 */
export type InteractionQuery<T> =
  | { ok: true; generation: number; value: T }
  | { ok: false; reason: "unavailable" | "stale" | "unsupported" };

export type InteractionCore = {
  options: InteractionControllerOptions;
  target: Window & typeof globalThis;
  canvas: HTMLCanvasElement;
  writable: () => boolean;
  modalActive: () => boolean;
  /** 聚焦相机输入门禁（只有 modal 阻断）；见 `InteractionControllerOptions.isFocusInputBlocked`。 */
  focusInputBlocked: () => boolean;
  state: InteractionState;
  /** 场景区手势运行时（T07）：只转发指针，不在此判断权限或写共享世界。 */
  sceneAreaGestures: () => import("../world-scopes/gestures.js").SceneAreaGesturePort | null;
  /**
   * 标记当前场景区手势的输入归属。帧结算只取消 `pointer` 路径启动的手势；
   * `external`（overlay 搬场景手柄）由自己的 end/cancel 收尾。
   */
  claimSceneAreaGesture: (owner: "pointer" | "external") => void;
  localViewport: ReturnType<typeof createLocalViewportStore>;
  viewportListeners: Set<() => void>;
  model: ModelGestureFamily;
  nextSeq: () => number;
  surfaceSize: () => { width: number; height: number; pixelRatio: number };
  /**
   * 读取 canvas 外框（一次同步布局读取）；同一事件内的坐标换算可复用它
   * （change: 2026-10-10-optimize-canvas-interaction-hot-path，任务 5.2）。
   */
  readBounds: () => CanvasBounds;
  activeViewport: () => Viewport;
  clientToWorld: (client: { x: number; y: number }, bounds?: CanvasBounds) => Point;
  pointerWorld: (event: Pick<PointerEvent, "clientX" | "clientY">, bounds?: CanvasBounds) => Point;
  worldToClient: (world: { x: number; y: number }, bounds?: CanvasBounds) => Point;
  /**
   * 构建完整 CanvasRenderScene（冷路径：resize 起点尺寸、zoomToFit 等）。
   * pointermove 命中热路径 MUST NOT 调用它（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
   */
  buildScene: () => CanvasRenderScene | null;
  /** 已接受的节点几何；null 表示节点不在场景内，undefined 表示基线不可用。 */
  renderedNode?: (nodeId: string) => CanvasRenderScene["nodes"][number] | null | undefined;
  /** Current drag geometry from the accepted scene plus local absolute previews. */
  buildDragScene?: () => CanvasRenderScene | null;
  /**
   * 2D 点命中/框选/probe 查询：由 Bevy WASM interaction snapshot 计算
   * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
   * 结果不携带命令副作用；`ok:false` 时调用方 MUST NOT 回退到 TS 几何或开始新手势。
   */
  queryPoint: (
    world: Point,
    zoom: number,
    hoveredEdgeId?: string | null
  ) => InteractionQuery<HitTarget | null>;
  queryMarquee: (rect: { x: number; y: number; width: number; height: number }) => InteractionQuery<string[]>;
  queryWorldGround: (point: Point) => { u: number; v: number } | null;
  queryProbe: (source: string, direction: "prev" | "next") => InteractionQuery<ProbeCandidate[]>;
  /**
   * 模型网格命中（change: play-model-animations-on-hover）。
   * `point` 为 canvas 内 CSS 坐标；返回命中的模型节点 identity 或 `null`。
   */
  queryModelPick: (
    point: Point,
    surface: { width: number; height: number }
  ) => InteractionQuery<{ nodeId: string } | null>;
  setSelection: (nodeIds: string[]) => void;
  submit: (commands: ReturnType<typeof planMoveNodes>) => void | Promise<"committed" | "rejected" | "unavailable">;
  /**
   * 请求一帧重绘并合并 dirty reason（design D2）。
   * 普通 pan/zoom 用 `"viewport"`，使纯视口帧可走固定大小增量；结构/选择/悬停等用缺省
   * `"input"`（fulld）。
   */
  schedule: (reason?: string) => void;
  flush: () => void;
  forgetHoverPointer: () => void;
  clearHover: () => void;
  updateHover: (hit: HitTarget | null) => void;
  updateHoveredVideo: (hit: HitTarget | null) => void;
  /**
   * 指针移动 hover 结算：卡片命中 → 模型网格回退 → 视频 hover
   * （change: play-model-animations-on-hover）。`point` 为 canvas 内 CSS 坐标。
   */
  settlePointerHover: (
    cardHit: InteractionQuery<HitTarget | null>,
    point: Point,
    surface: { width: number; height: number }
  ) => void;
  suspendHoverPlayback: () => void;
  clearHeldKeys: () => void;
  commitViewport: (viewport: Viewport) => void;
  scheduleViewportCommit: () => void;
  notifyViewport: () => void;
  /**
   * 拖动粘连 Q/E held 键路由（change: add-drag-touch-connections，design D2）。
   * 返回是否已消费（只有带粘连子状态的拖动会消费）。
   */
  onAttachKey: (code: "KeyQ" | "KeyE", down: boolean) => boolean;
  /** 当前拖动是否带粘连子状态（键盘路由据此决定是否消费 Q/E）。 */
  attachActive: () => boolean;
  /** 取消完整拖动粘连手势并清空预览（不提交命令）。 */
  cancelDragGesture: () => void;
  /** 当前拖动粘连瞬时投影；无则 `null`。 */
  attachProjection: () => import("@woohaa3/contracts").BevyDragAttach | null;
  /** working canvas 更新时清理失效 contact/pending；返回是否有变化。 */
  pruneAttach: () => boolean;
  /** 当前聚合把手瞬时投影；无把手时 `null`。 */
  aggregateProjection: () => import("@woohaa3/contracts").BevyAggregateConnect | null;
  /** 是否处于聚合拉线拖拽。 */
  aggregateActive: () => boolean;
  /** 取消聚合拉线手势并清空预览（不提交命令）。 */
  cancelAggregateConnect: () => void;
};
