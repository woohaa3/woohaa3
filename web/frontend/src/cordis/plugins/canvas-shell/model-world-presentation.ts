/**
 * 共享世界模型呈现的浏览器只读投影。
 *
 * 世界模型的卡片外壳由 Render Scene 抑制；聚焦、选中和空模型指示都必须读取同一份
 * 真实 world pose，不能回落到卡片矩形。这里只把权威 `sharedWorldInstance` 与已准备的
 * 局部 AABB 转成渲染器世界坐标，不写画布状态、不申请模型资源。
 */
import {
  decodeWorldInstanceData,
  SHARED_WORLD_UNITS_PER_METER,
  transformAabb,
  worldToRendererPosition,
  worldToRendererRotation,
  type Aabb,
  type ServerCanvas,
  type Vec3
} from "@woohaa3/contracts";

export type WorldInstancePresentation = {
  kind: "world";
  instanceId: string;
  /** 渲染器世界锚点（米制 → Bevy 世界，Y-up）。 */
  anchor: Vec3;
  rotation: [number, number, number, number];
  /** 实例根缩放（Bevy 世界单位）。 */
  unit: number;
  /** 已应用根变换的模型 AABB；空模型/未准备时为 null。 */
  aabb: Aabb | null;
};

function finiteVec(values: readonly number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}

/**
 * 解析一个节点是否是共享世界实例，并给出渲染器世界的根姿态。
 *
 * `localAabb` 来自 prepared Scene IR；缺失表示模型内容尚未就绪或空模型——调用方应把它
 * 当作“可选中但没有可聚焦几何”，而不是退回卡片位置。
 */
export function worldInstancePresentation(
  canvas: ServerCanvas | null | undefined,
  nodeId: string,
  localAabb?: Aabb | null
): WorldInstancePresentation | null {
  const input = canvas?.nodeData?.[nodeId]?.sharedWorldInstance;
  if (input === undefined) return null;
  const decoded = decodeWorldInstanceData(input);
  if (!decoded.ok) return null;
  const transform = decoded.value.transform;
  const anchor = [...worldToRendererPosition(transform.position)] as Vec3;
  const rotation = worldToRendererRotation(transform.rotation) as [number, number, number, number];
  const unit = transform.scale * SHARED_WORLD_UNITS_PER_METER;
  if (!finiteVec([...anchor, ...rotation, unit]) || unit <= 0) return null;
  const aabb = localAabb
    ? transformAabb({ translation: anchor, rotation: [...rotation], scale: [unit, unit, unit] }, localAabb)
    : null;
  if (aabb && !finiteVec([...aabb.min, ...aabb.max])) return null;
  return {
    kind: "world",
    instanceId: decoded.value.instanceId,
    anchor,
    rotation,
    unit,
    aabb
  };
}

/** 该节点是否是世界实例（即使内容为空）。 */
export function isWorldInstanceNode(canvas: ServerCanvas | null | undefined, nodeId: string): boolean {
  return canvas?.nodeData?.[nodeId]?.sharedWorldInstance !== undefined;
}

/**
 * 空模型/内容未就绪的世界锚点；有几何时返回 null。
 *
 * 供聚焦目标拒绝空模型，同时让画布选择仍可在锚点命中（Bevy 标记由 model-world 包渲染）。
 */
export function emptyWorldModelAnchor(
  canvas: ServerCanvas | null | undefined,
  nodeId: string,
  localAabb?: Aabb | null
): Vec3 | null {
  const world = worldInstancePresentation(canvas, nodeId, localAabb);
  return world && !world.aabb ? world.anchor : null;
}
