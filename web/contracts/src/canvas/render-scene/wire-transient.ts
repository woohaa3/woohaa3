/**
 * `CanvasRenderScene` 瞬时呈现态 wire 类型（自 `render-scene.ts` 拆出）
 * （change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R01）。
 *
 * 只承载浏览器本地可丢弃的聚焦/编辑/悬停/拖动/聚合/播放投影类型；它们都不进入 canonical
 * ServerCanvas / Y.Doc。与 `wire-scene.ts` 的节点/边结构分离，便于按职责审查。
 */
import type { ModelFocusProjection } from "../model-focus.js";
import type { MotionIr } from "../motion-ir.js";
import type { ModelCameraAspect } from "../model-cameras.js";
import type { AppThemeSnapshot } from "../../theme/index.js";
import type { AggregateConnectDirection, DragAttachMode } from "./node-geometry.js";

/**
 * 节点端点悬停瞬时态（change: add-node-endpoint-hover）。
 *
 * 这是**浏览器本地呈现态**：只承载指针下的节点 id 与端点侧，用于让 Bevy 决定在哪个节点的
 * 左右中点画「+」圆钮。它不进入 ServerCanvas / CanvasCommand / Y.Doc。
 */
export type BevyNodeHover = {
  /** 指针下的节点 id（命中节点、关闭按钮、历史动作、端点或 resize 抓手均算悬停）。 */
  nodeId: string;
  /** Pointer world position for bounded magnetic port feedback. */
  cursor?: { x: number; y: number };
  /** 指针落在某侧端点命中区时的端点侧；否则缺省/`null`。 */
  port?: "input" | "output" | null;
};

/**
 * 连线悬停瞬时态（change: add-edge-hover-delete）。
 *
 * 指针下是某条连线（或其删除按钮）时携带，用于让 Bevy 在连线中点绘制删除按钮。
 * 同样只承载浏览器本地呈现态，不进入 ServerCanvas / Y.Doc。
 */
export type BevyEdgeHover = {
  /** 指针下的连线 id。 */
  edgeId: string;
  /** Pointer world position; the delete control follows the selected curve. */
  cursor?: { x: number; y: number };
};

/** 指针悬停态：节点或连线；`null` 表示无悬停。 */
export type BevyHover = BevyNodeHover | BevyEdgeHover;

export type BevyRenderDraft = {
  source: string;
  side: "input" | "output";
  x: number;
  y: number;
};

/**
 * 框选选区矩形（change: fix-group-and-marquee-preview）。
 *
 * 世界坐标轴对齐矩形；`width`/`height` 可为负（拖拽方向决定），Bevy 会归一化。
 * 这是**浏览器本地瞬时呈现态**：不进入 ServerCanvas / CanvasCommand / Y.Doc。
 */
export type BevyRenderMarquee = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BevyRenderSurface = {
  width: number;
  height: number;
  pixelRatio: number;
  /** 右侧遮挡宽度（CSS 像素）。缺省为 0，内容区铺满表面。 */
  contentRight?: number;
  /** Shared focus workspace rectangle in canvas CSS pixels. */
  contentRect?: { x: number; y: number; width: number; height: number };
  /**
   * 表面相对窗口客户区左上角的偏移（CSS 像素）。
   * 桌面顶栏把画布往下推时，原生交换链仍覆盖整个窗口，相机视口用这个原点对齐 DOM。
   */
  originX?: number;
  originY?: number;
};

/**
 * 公共聚焦过渡进度瞬时更新
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D6/D7）。
 *
 * 由 Canvas Runtime scope 的唯一 coordinator 沿唯一帧账本推入；Rust 三维聚焦相机按此
 * `progress`（0..1 原始进度）求值，不再启动独立的 `Time.delta` 第二时钟。图片/视频的二维
 * 取景仍由各自 feature 直接投影 viewport，不经本字段。
 *
 * 版本化且携带 node / runtimeGeneration 身份：旧代（更小 generation）或不匹配节点的进度在
 * Rust 同步系统内被原子丢弃。只承载可丢弃的渲染瞬时态，不进入 canonical。
 */
export const FOCUS_TRANSITION_VERSION = "woohaa-focus-transition-v1" as const;
export type FocusTransitionVersion = typeof FOCUS_TRANSITION_VERSION;

export type BevyFocusTransition = {
  version: FocusTransitionVersion;
  /** 目标节点 id（必须与当前聚焦目标一致才生效）。 */
  nodeId: string;
  /** 目标 kind（`model` / `image` / `video` / `extension`）。 */
  kind: string;
  /** 0..1 原始进度（未缓动；缓动由两侧共享 smoothstep 施加）。 */
  progress: number;
  /** 前端 runtime generation；旧代更小值被丢弃。 */
  runtimeGeneration: number;
  /** 过渡身份（同一连续聚焦旅程内递增；诊断与去重）。 */
  transitionId: number;
};

/**
 * 拖动粘连待提交连线（change: add-drag-touch-connections，design D5）。
 *
 * 只承载绘制虚线预览所需的最小身份：稳定 edge id 与有向端点对。
 */
export type BevyDragAttachEdge = {
  id: string;
  source: string;
  target: string;
};

/**
 * 单节点拖动中的 Q/E 触碰粘连瞬时投影
 * （change: add-drag-touch-connections，design D5）。
 *
 * 字段**存在**即表示应显示底部操作条；`mode` 决定活动提示与触须侧；`contactNodeId`
 * 驱动接触反馈；`pendingEdges` 绘制立即可见的虚线预览。Bevy 只被动消费该投影，
 * 不执行碰撞、不锁定目标、不分配 edge ID。它是浏览器本地可丢弃状态，不进入
 * canonical Canvas / Y.Doc / IndexedDB cache，也不改变业务 revision。
 */
export type BevyDragAttach = {
  /** 当前被拖动的节点 id。 */
  nodeId: string;
  /** 当前活动粘连方向；未按住 Q/E 时为 `null`（仅显示操作条）。 */
  mode: DragAttachMode | null;
  /** 当前触须接触到的合法目标节点 id；无接触时缺省。 */
  contactNodeId?: string;
  /** 本次拖动已锁定的待提交边（按锁定顺序）。 */
  pendingEdges: BevyDragAttachEdge[];
};

/**
 * 聚合拉线待提交连线（change: add-multi-select-aggregate-connect，design D5）。
 * 只承载虚线预览所需的最小身份：稳定 edge id 与有向端点对。
 */
export type BevyAggregateConnectEdge = {
  id: string;
  source: string;
  target: string;
};

/**
 * 多选聚合拉线瞬时投影（change: add-multi-select-aggregate-connect，design D5）。
 *
 * 字段存在即表示应显示选区左右聚合把手；`direction` 表示正在拖拽的方向（`null` 表示仅显示
 * 把手）；`cursor` 为拖拽中的指针世界坐标；`pendingEdges` 为拖拽中命中的合法预览边。
 * Bevy 只被动消费该投影，不执行碰撞、不展开成员、不分配 edge id。
 * 它是浏览器本地可丢弃状态，不进入 canonical Canvas / Y.Doc / IndexedDB。
 */
export type BevyAggregateConnect = {
  /** 正在拖拽的方向；仅显示把手时为 `null`。 */
  direction: AggregateConnectDirection | null;
  /** 拖拽中的指针世界坐标（仅拖拽中存在）。 */
  cursor?: { x: number; y: number };
  /** 拖拽中命中的待提交边预览。 */
  pendingEdges: BevyAggregateConnectEdge[];
};

/**
 * 模型聚焦瞬时投影（change: add-model-focus-viewing，design D1）。
 *
 * 这是**浏览器本地呈现态**：只承载稳定 canonical nodeId 与本地相机 pose，用于让同一
 * Camera3d 切换到透视聚焦并过滤可见内容。它不进入 ServerCanvas / CanvasCommand / Y.Doc。
 * 缺省（undefined）表示普通正交画布。
 */
export type BevyModelFocus = ModelFocusProjection;

/**
 * 图片聚焦瞬时投影
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，design D2）。
 *
 * 只承载浏览器本地呈现态：聚焦 canonical 图片 nodeId、按可用矩形计算的本地取景
 * （源像素语义）与可见性。Bevy 保持**同一** Camera2d/画布，保留背景内容，按此取景平移
 * 缩放显示纹理；捕获整块编辑视口时 documentView 单独驱动相机，viewport 决定帧布局；不进入 ServerCanvas / CanvasCommand / Y.Doc。缺省表示普通画布。
 */
export const IMAGE_FOCUS_VERSION = "woohaa-image-focus-v1" as const;
export type ImageFocusVersion = typeof IMAGE_FOCUS_VERSION;

export type BevyImageFocus = {
  version: ImageFocusVersion;
  nodeId: string;
  /** 入场完成后切换遮罩与节点外框；省略时兼容既有聚焦呈现。 */
  presentationReady?: boolean;
  /**
   * 本地二维取景：`zoom` 为「1 源像素 = zoom 个 CSS px」，`x`/`y` 为画布局部平移（CSS px）。
   * 由前端依据可用内容矩形与源尺寸计算，Bevy 只消费。
   */
  viewport: { x: number; y: number; zoom: number };
  /** 源像素尺寸（用于 fit/清晰度判定与校验）。 */
  sourceWidth: number;
  sourceHeight: number;
  /** 捕获整块编辑视口时，相机仍跟随文档本身的取景，纹理按 viewport 独立对齐。 */
  documentView?: {
    sourceWidth: number;
    sourceHeight: number;
    viewport: { x: number; y: number; zoom: number };
  };
};

/**
 * 视频聚焦瞬时投影
 * （change: 2026-10-10-add-video-node-focus-workspace，design D1/D2）。
 *
 * 与图片聚焦共用同一二维媒体取景 wire：Bevy 保持**同一** Camera2d/画布，隐藏其它内容，
 * 按此取景平移缩放显示聚焦视频的真实解码纹理；播放/seek/静音等观看态只存在于浏览器视频
 * 会话，不进入 wire、ServerCanvas / CanvasCommand / Y.Doc。缺省表示普通画布。
 */
export const VIDEO_FOCUS_VERSION = "woohaa-video-focus-v1" as const;
export type VideoFocusVersion = typeof VIDEO_FOCUS_VERSION;

export type BevyVideoFocus = {
  version: VideoFocusVersion;
  nodeId: string;
  /** 本地二维取景：语义与 `BevyImageFocus.viewport` 一致。 */
  viewport: { x: number; y: number; zoom: number };
  /** 源视频像素尺寸（用于 fit/清晰度判定与校验；截帧仍按源尺寸）。 */
  sourceWidth: number;
  sourceHeight: number;
};

/**
 * 模型编辑工具瞬时态（change: add-model-editor-gizmo-shot-capture，design D1/D3/D6）。
 *
 * 只承载浏览器本地编辑态：工具模式、聚焦模型 nodeId、选中镜头的派生 pose（当前
 * placement 后 AABB 的正交镜头）。它不进入 ServerCanvas / CanvasCommand / Y.Doc；
 * Bevy 只据此绘制可丢弃的 gizmo 与镜头 frustum，不持有 canonical 所有权。
 */
export const MODEL_EDITOR_VERSION = "woohaa-model-editor-v2" as const;
export type ModelEditorVersion = typeof MODEL_EDITOR_VERSION;

/** Disposable tools and feedback, transported with the instance's accepted render scene. */
export type GizmoHandleName = "x" | "y" | "z" | "center" | "yaw-ring" | "scale" | "orbit-ring" | "elevation-ring" | "distance" | "shot-origin";
export type GizmoFeedback = { hover?: GizmoHandleName; active?: GizmoHandleName; epoch: number };
export type GizmoYawConstraint = { origin: [number, number, number]; u: [number, number, number]; v: [number, number, number]; normal: [number, number, number]; startAngle: number; mode: "plane" | "tangent"; direction: [number, number]; radiansPerPixel: number };

export type BevyModelEditor = {
  /** schema 版本；Bevy 据此校验。 */
  version: ModelEditorVersion;
  /** 编辑目标 canonical 模型 nodeId。 */
  nodeId: string;
  /** 工具模式：整体模型 placement gizmo 或镜头 shot gizmo。 */
  toolMode: "model" | "camera";
  /** Disposable XZ reference grid in display space. */
  grid?: { origin: [number, number, number]; spacing: number };
  feedback?: GizmoFeedback;
  /**
   * 显式镜头工具（change: fix-model-focus-navigation-and-camera-parity，task 4.4/design D6；
   * change: add-shot-camera-elevation-control）。
   * orbit/elevation/distance 允许主按钮在画布任意处拖动编辑选中镜头；focus 只操作注视点 gizmo。
   */
  cameraTool?: "orbit" | "elevation" | "distance" | "focus";
  /** 选中镜头 id（camera 模式）。 */
  cameraId?: string;
  /** 聚焦模型 focus（世界坐标，placement 后 AABB 中心）。 */
  focus: [number, number, number];
  /** 模型包围球半径（gizmo 尺寸）。 */
  radius: number;
  /** 选中镜头的派生正交相机（camera 模式）。 */
  shot?: BevyShotCamera;
};

/** 选中镜头的派生透视相机（design D3；由 `resolveShotCamera` 生成；change: switch-shot-camera-to-perspective）。 */
export type BevyShotCamera = {
  position: [number, number, number];
  focus: [number, number, number];
  /** 透视垂直 FOV（弧度）。 */
  fov: number;
  azimuth: number;
  elevation: number;
  distance: number;
  /** 镜头画幅（change: fix-model-focus-navigation-and-camera-parity，design D8）。 */
  aspect: ModelCameraAspect;
};

/**
 * 活动动画节点播放瞬时投影（change: 2026-10-05-bind-model-animation-to-shots，任务 4.1）。
 *
 * 这是**浏览器本地呈现态**：只承载活动动画节点的稳定 canonical nodeId、本地时钟与已校验
 * 的 `woohaa-motion-ir-v1`。Bevy 据此为该节点独立求值模型姿态与镜头；不进入 ServerCanvas /
 * CanvasCommand / Y.Doc。缺省表示当前无活动动画节点。
 */
export type BevyAnimationPlayback = {
  clipId?: string;
  sourceIdentity?: string;
  generation?: number;
  viewMode?: "overview-observer" | "focus-preview";
  /** 活动动画节点 canonical id。 */
  nodeId: string;
  /** Motion IR 版本（`woohaa-motion-ir-v1`）；Bevy 据此刻意拒绝未知版本。 */
  version: string;
  /** 当前时间（秒）。 */
  time: number;
  /** 时间线时长（秒）。 */
  duration: number;
  looped: boolean;
  playing: boolean;
  /** 所播放镜头背景的具体色（`#rrggbb`）；缺省即跟随主题。 */
  backdrop?: string;
  /** 初始镜头（第 0 秒）。 */
  initialCamera: {
    aspect?: string;
    azimuth: number;
    elevation: number;
    distance: number;
    focusOffset: [number, number, number];
  };
  /** 已校验的镜头轨道（默认值已补齐）。 */
  cameraMotion: MotionIr["cameraMotion"];
  /** 已校验的模型轨道（默认值已补齐）。 */
  modelMotion: MotionIr["modelMotion"];
};

/** 序列化给 Rust 的 theme 形状（与 `AppThemeSnapshot` 同构，显式声明以防漂移）。 */
export type CanvasRenderSceneTheme = AppThemeSnapshot;
