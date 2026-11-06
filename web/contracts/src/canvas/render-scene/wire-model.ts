/**
 * `CanvasRenderScene` 模型 wire 类型（自 `render-scene.ts` 拆出）
 * （change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R01）。
 *
 * 纯 wire 叶子类型，**无任何 import**：可被渲染 wire 类型、几何投影、聚焦投影与外部
 * `model-focus`/`model-placement` 等直接引用，避免经过 `render-scene.js` barrel 形成环。
 */

export type BevyModelPlacement = {
  offset: { x: number; y: number; z: number };
  scale: number;
  yaw: number;
};

export type BevyModelPreview = {
  azimuth: number;
  elevation: number;
  distanceScale: number;
  targetOffset?: [number, number, number];
};

export const MODEL_PREVIEW_MIN_HEIGHT = 160;

/**
 * 卡片默认视角：正对模型正面（局部 +Z），保留 30° 俯视。
 *
 * 早先是方位 45° 的斜视角，模型在卡片里总是斜对观察者；改为正面后主体朝向与顶面
 * 体积感兼顾。`azimuth` 用的是与聚焦观察相机同一套绕 Y 轴方位角，0 即沿 +Z 看向原点。
 */
export const DEFAULT_MODEL_PREVIEW: BevyModelPreview = {
  azimuth: 0, elevation: Math.PI / 6, distanceScale: 1, targetOffset: [0, 0, 0]
};

/**
 * 轻量模型引用（change: optimize-model-scene-snapshot-hot-path）。
 *
 * 节点只携带稳定 `resourceKey` 与动态 placement；模型内容由独立的不可变资源通道
 * （`prepare_and_register_model_resource`）注册，`CanvasRenderScene` 不再内联 `ops`。`signature`
 * 用于 Bevy 判断是否需要替换 ECS entity 树，`sceneVersion` 决定渲染语义。
 */
export type BevyModelReference = {
  /** Stable bind-pose anchor in asset XYZ; editor projects it onto world ground. */
  groundAnchorLocal?: [number, number, number];
  /** Local additive joint/group rotations; model axes, normalized xyzw quaternion. */
  partRotations?: Record<string, readonly [number, number, number, number]>;
  /** Scene IR 版本（V1 或 V2）；显式携带以便 Bevy 区分渲染语义。 */
  sceneVersion: string;
  /** 按内容签名注册的资源 key（`sceneVersion:signature`）；不含节点 id。 */
  resourceKey: string;
  /** 模型内容签名；placement/viewport 变化时不变。 */
  signature: string;
  placement?: BevyModelPlacement;
};
