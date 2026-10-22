/**
 * 模型镜头契约：类型与常量
 * （自 `model-cameras.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R18）。
 *
 * 纯类型/常量叶子。镜头是**模型节点的 canonical 子资源**（`nodeData.modelCameras`），不是独立
 * 画布节点。每条记录只持久化用户可编辑且与版本无关的最小字段。
 */

/** 镜头契约版本；结构变化必须升版本。 */
export const MODEL_CAMERAS_VERSION = "woohaa-model-cameras-v1" as const;
export type ModelCamerasVersion = typeof MODEL_CAMERAS_VERSION;

/** 单个模型允许的镜头数量上限。 */
export const MAX_MODEL_CAMERAS = 32;
/** 镜头名称最大长度。 */
export const MAX_MODEL_CAMERA_NAME_LENGTH = 80;
/** 默认名称前缀（“镜头 N”）。 */
export const MODEL_CAMERA_DEFAULT_NAME_PREFIX = "镜头";

/**
 * 镜头仰角的竖直半圆范围（change: add-shot-camera-elevation-control）。
 *
 * 规范允许 `[-90°, +90°]`；派生相机与手势在接近端点处按固定容差钳制（见 `shot-camera.ts`
 * 的 `SHOT_CAMERA_ELEVATION_LIMIT`），避免与世界上方向共线产生奇点。
 */
export const SHOT_CAMERA_MIN_ELEVATION = -Math.PI / 2;
export const SHOT_CAMERA_MAX_ELEVATION = Math.PI / 2;
/** 默认仰角（45°），与既有固定行为兼容。 */
export const SHOT_CAMERA_DEFAULT_ELEVATION = Math.PI / 4;

/** 镜头注视点偏移（相对 placement 后模型 AABB 中心；change: 模型编辑 gizmo 焦点）。 */
export type ModelCameraFocusOffset = { x: number; y: number; z: number };

/**
 * 受支持的镜头画幅（change: 2026-09-28-fix-model-focus-navigation-and-camera-parity，design D8；
 * change: expand-shot-camera-aspects：与生图节点支持的画幅并集对齐）。
 */
export const MODEL_CAMERA_ASPECTS = [
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "5:4",
  "4:5",
  "21:9",
  "4:1",
  "1:4",
  "8:1",
  "1:8"
] as const;
export type ModelCameraAspect = (typeof MODEL_CAMERA_ASPECTS)[number];
/** 缺失/未知画幅的兼容默认值（design D8）。 */
export const DEFAULT_MODEL_CAMERA_ASPECT: ModelCameraAspect = "16:9";

/**
 * capture 长边像素上限（与 Bevy `MAX_CAPTURE_DIMENSION` 一致）。
 */
export const MODEL_CAMERA_MAX_CAPTURE_DIMENSION = 4096;

/** 单条模型镜头记录。 */
export type ModelCamera = {
  /** 模型节点内稳定唯一 id。 */
  id: string;
  /** 用户可见名称。 */
  name: string;
  /** 工具栏顺序（有序非负整数）。 */
  order: number;
  /** 绕世界 Y 轴的方位角（弧度）。 */
  azimuth: number;
  /**
   * 竖直半圆仰角（弧度，`[-90°, +90°]`；change: add-shot-camera-elevation-control）。
   * change: 2026-10-07-remove-residual-compatibility —— 必填；缺失/非法整条集合拒绝。
   */
  elevation: number;
  /**
   * 相机到 focus 的距离（正有限，**世界单位**）。
   */
  distance: number;
  /**
   * 镜头画幅（design D8）。必填，必须是受支持值；未知/缺失拒绝整个集合。
   */
  aspect: ModelCameraAspect;
  /**
   * 注视点偏移（change: 模型编辑 gizmo 焦点）。
   */
  focusOffset?: ModelCameraFocusOffset;
};

export type ModelCamerasDecodeResult =
  | { ok: true; value: ModelCamera[] }
  | { ok: false; reason: string };

/**
 * 单条镜头变更意图（change: add-model-camera-mcp-crud）。
 *
 * MCP 层只表达该意图；真实应用由 `applyModelCameraMutationCommand` 基于**最新权威集合**完成。
 */
export type ModelCameraMutation =
  | {
      kind: "create";
      azimuth: number;
      distance: number;
      name?: string;
      elevation?: number;
      aspect?: ModelCameraAspect;
      focusOffset?: ModelCameraFocusOffset;
    }
  | {
      kind: "update";
      id: string;
      azimuth?: number;
      distance?: number;
      elevation?: number;
      aspect?: ModelCameraAspect;
      focusOffset?: ModelCameraFocusOffset;
    }
  | { kind: "remove"; id: string }
  | { kind: "rename"; id: string; name: string }
  | { kind: "reset"; id: string; azimuth: number; distance: number; elevation?: number };

export type ModelCameraMutationResult =
  | { ok: true; cameras: ModelCamera[] }
  | { ok: false; code: string; message: string };

/** 受限镜头变更意图列表上限（change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 4.4）。 */
export const MAX_MODEL_CAMERA_MUTATIONS = 64;

export type ModelCameraMutationResultBatch =
  | { ok: true; cameras: ModelCamera[] }
  | { ok: false; code: string; message: string; failedIndex: number };
