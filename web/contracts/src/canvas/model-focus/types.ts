/**
 * 模型聚焦：类型与常量
 * （自 `model-focus.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R24）。
 *
 * 无副作用类型/常量叶子；与 Rust `model3d::focus` 共享同一常量值。
 */
import type { Vec3 } from "../model-transform.js";

export const MODEL_FOCUS_VERSION = "woohaa-model-focus-v1" as const;
export type ModelFocusVersion = typeof MODEL_FOCUS_VERSION;

/** 相机灵敏度与范围常量（design D4，与 Godot 参考实现一致）。 */
export const MODEL_FOCUS_LOOK_SENSITIVITY_DEG_PER_PX = 0.25;
export const MODEL_FOCUS_DOLLY_IN = 0.9;
export const MODEL_FOCUS_DOLLY_OUT = 1.12;
export const MODEL_FOCUS_MIN_DISTANCE = 0.4;
/**
 * 聚焦距离上限。画布 zoom 会把模型放大到数百世界单位，取景距离随之到数千，
 * 不能再停在 400，否则相机会被压进网格。
 */
export const MODEL_FOCUS_MAX_DISTANCE = 10_000_000;
/** 近裁剪面（与 Rust `FOCUS_NEAR` 一致）。距离下限要留出比它更厚的余量。 */
export const MODEL_FOCUS_NEAR = 0.05;
export const MODEL_FOCUS_MIN_FLY_SPEED = 0.4;
export const MODEL_FOCUS_MAX_FLY_SPEED = 80;
export const MODEL_FOCUS_DEFAULT_FLY_SPEED = 6;
export const MODEL_FOCUS_SPEED_FAST = 3;
export const MODEL_FOCUS_SPEED_SLOW = 0.333;
/** 垂直 FOV（弧度）；与 Rust 保持一致。 */
export const MODEL_FOCUS_FOV = (50 * Math.PI) / 180;
/** pitch 接近奇点时的 limit（弧度）。 */
export const MODEL_FOCUS_PITCH_LIMIT = (89 * Math.PI) / 180;
/** 自动取景时包围球外扩系数（留出边距）。 */
export const FRAME_PADDING = 1.12;
/** 卡片底部与模型顶部之间的固定间距（与 Rust `MODEL_CARD_GAP` 一致）。 */
export const MODEL_CARD_GAP = 40.0;
/** 模型单位基准（与 Rust `model_anchor` / `model_unit` 的 `64.0` 一致）。 */
export const MODEL_SIZE_BASE = 64.0;
/**
 * 场景单位 → 画布世界单位的**绝对**换算：1 场景单位（= 1 米，见 `MODEL_API_AXIS_CONVENTIONS`）
 * 固定等于 64 画布单位（change: 2026-10-31-render-models-at-absolute-metric-scale）。
 *
 * 此前单位是 `placement.scale × 192 / extent` 的归一化值，会把每个模型压进约 192 画布单位的
 * 参考框，于是 1.7 m 的人与 20 m 的楼在画布上看起来一样大，且"模型写在世界原点多远"都会
 * 改变显示尺寸。改为绝对米制后：人物约 109 画布单位、2 m 门约 128、20 m 楼约 1280，
 * 跨节点真实可比，也不再受包围盒与原点位置影响。
 *
 * 与 Rust `model3d::CANVAS_UNITS_PER_METER` 同值；改这一处即可整体缩放画布上的真实尺度
 * （默认卡片 248×232 约合 3.9 m × 3.6 m）。
 */
export const CANVAS_UNITS_PER_METER = MODEL_SIZE_BASE;
/** 片场模型适配节点矩形时四周保留的边距（与 Rust `FILM_SET_FIT_MARGIN` 一致）。 */
export const FILM_SET_FIT_MARGIN = 16.0;

/**
 * 聚焦缩小的最近距离：允许相机进入包围球内部以贴近观察细节。
 *
 * 取包围球半径的固定比例；下限仍不低于 [`MODEL_FOCUS_MIN_DISTANCE`]。
 * 默认 `0.5`。
 */
export const FOCUS_ZOOM_IN_RADIUS_FACTOR = 0.5;

/** 模型聚焦瞬时投影：只承载浏览器本地相机状态与稳定目标身份。 */
export type ModelFocusProjection = {
  version: ModelFocusVersion;
  /** 稳定 canonical 节点 id。 */
  nodeId: string;
  /** 聚焦目标中心（世界空间，含 root 锚点）。 */
  target: Vec3;
  /** 环绕 yaw / pitch（弧度）。 */
  yaw: number;
  pitch: number;
  /** 目标到相机距离。 */
  distance: number;
  /** 垂直 FOV（弧度）。 */
  fov: number;
  /** 观察指示用的模型半径（世界单位）。 */
  radius: number;
};

export type ModelFocusCamera = {
  target: Vec3;
  yaw: number;
  pitch: number;
  distance: number;
  flySpeed: number;
};

/** 普通画布正交相机深度（与 Rust `CANVAS_CAMERA_Z` 一致）。 */
export const MODEL_CAMERA_Z = 300;
/** 普通画布正交相机远裁剪面（与 Rust `MODEL_CAMERA_FAR` 一致）；near 为其负值。 */
export const MODEL_CAMERA_FAR = 100_000;

/** 画布 viewport（与协议 `Viewport` 一致）。 */
export type CanvasViewport = { x: number; y: number; zoom: number };

export type Ray = { origin: Vec3; direction: Vec3 };

/** 模型场景输入（几何 + placement + 片场适配）。 */
export type ModelSceneInput = {
  sceneVersion: string;
  ops: readonly import("../scene-ir-v2.js").SceneV2Op[];
  extent: number;
  /** 模型局部规范空间 AABB；缺省时从 ops 计算。 */
  aabb?: import("../model-transform.js").Aabb | null;
  placement?: import("../render-scene/wire-model.js").BevyModelPlacement | null;
  /**
   * 片场（animation3d）适配尺寸：设置后模型投影 AABB 等比适配该矩形（节点矩形）。
   * 普通 model3d 不设置。
   */
  filmSetFit?: { width: number; height: number } | null;
  /**
   * 片场组的徽标锚定方式：设置后模型顶边贴住组底边锚点向下展开；
   * 普通组缺省把模型投影中心对齐锚点。
   */
  badgeTopAnchored?: boolean;
};
