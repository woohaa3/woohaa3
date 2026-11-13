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
import type { AlignmentGuide } from "../../contract/alignment-snap.js";
import type { InteractionControllerOptions, Gesture } from "./interaction-types.js";
import type { ModelGestureFamily } from "./model-gesture-family.js";
import type { WheelSourceState } from "./input/wheel-gesture.js";
import type { createLocalViewportStore } from "../canvas-runtime/local-viewport.js";
import type { ProbeCandidate } from "../canvas-runtime/bevy-runtime.js";
import type { planMoveNodes } from "../../../extension-api/command-planner.js";
import type { SelectionPressRecord } from "./input/selection/types.js";

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
  /** 最近一次节点按下的选择记录；双击用它区分“选入模型”和“已选后聚焦”。 */
  lastSelectionPress: SelectionPressRecord | null;
  previousSelectionPress: SelectionPressRecord | null;
  localPositions: Map2D;
  localSizes: SizeMap;
  draft: { source: string; side: "input" | "output"; x: number; y: number } | null;
  viewportPreview: Viewport | null;
  spacePressed: boolean;
  lastPointerWorld: Point | null;
  hoveredNodeId: string | null;
  hoveredPort: "input" | "output" | null;
  hoveredEdgeId: string | null;
  selectedEdgeId?: string | null;
  hoverPointer?: Point | null;
  hoveredVideoNode: string | null;
  hoveredHistory?: { nodeId: string; presentationId: string } | null;
  /**
   * 本次拖动命中的辅助对齐线（世界坐标，内置插件 `alignment-guides` 提供策略）。
   * 只在拖动手势内有效；不进规范状态、不进 render scene，由覆盖层按视口换算绘制。
   */
  alignmentGuides: AlignmentGuide[];
  /** 参考线版本号；只在内容变化时递增，供覆盖层判断是否重绘。 */
  alignmentGuidesVersion: number;
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
  /** 导演区手势运行时（T07）：只转发指针，不在此判断权限或写共享世界。 */
  sceneAreaGestures: () => import("../world-scopes/gestures.js").SceneAreaGesturePort | null;
  /**
   * 标记当前导演区手势的输入归属。帧结算只取消 `pointer` 路径启动的手势；
   * `external`（overlay 搬场景手柄）由自己的 end/cancel 收尾。
   */
  claimSceneAreaGesture: (owner: "pointer" | "external") => void;
  /**
   * 当前拖动吸附策略（内置插件 `alignment-guides` 注入；`null` 表示不吸附）。
   * 拖动预览每次求值时读取，插件启停随即可见。
   */
  alignmentSnap: () => import("./alignment-snap.js").AlignmentSnapPolicy | null;
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
  /** 世界模型框选：rect 为 canvas CSS 屏幕矩形（世界模型没有卡片，不能走 2D 框选）。 */
  queryModelMarquee: (rect: { x: number; y: number; width: number; height: number }) => InteractionQuery<string[]>;
  /** 拖动释放时的通用 drop target（最上层实际节点，排除来源）；用于组拖入判定。 */
  queryDropTarget: (point: Point, excludedIds?: readonly string[]) => InteractionQuery<string | null>;
  queryWorldGround: (point: Point) => { u: number; v: number } | null;
  /**
   * 共享世界模型的瞬时地面位移预览（米制增量；`null` 清除）。
   *
   * 只进入 Render Scene 的 `worldGroundPreviews`，不写卡片位置、不发命令；返回 `false`
   * 表示该节点不是世界实例或聚焦/过渡期间不允许预览。
   */
  setWorldGroundPreview: (nodeId: string, delta: { u: number; v: number } | null) => boolean;
  /** 镜头视锥瞬时位姿（地面增量）；只影响本页呈现，不写规范 nodeData。 */
  setWorldCameraPreview: (nodeId: string, delta: { u: number; v: number } | null) => boolean;
  /** 清除全部镜头瞬时位姿。 */
  clearWorldCameraPreviews: () => void;
  /** 清除全部地面位移预览（取消手势/释放提交后）。 */
  clearWorldGroundPreviews: () => void;
  queryProbe: (source: string, direction: "prev" | "next") => InteractionQuery<ProbeCandidate[]>;
  /**
   * 模型网格命中（change: play-model-animations-on-hover）。
   * `point` 为 canvas 内 CSS 坐标；返回命中的模型节点 identity 或 `null`。
   * `tolerance` 为可选的像素级裙边：只有真的点在（或紧贴）露出表面时才算命中，
   * 包围盒内的空白仍然返回 `null`。
   */
  queryModelPick: (
    point: Point,
    surface: { width: number; height: number },
    options?: { tolerance?: number }
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
