/**
 * 画布按下目标的 2D/3D 归一化。
 *
 * Rust 命中仍是唯一事实源：这里只把「卡片命中」「模型拾取」「地面候选」收敛成同一
 * 份节点目标，让选择规则不必分别认识 2D 卡片与世界对象。控件类命中保持原样，由输入层
 * 的领域分支继续处理。
 */
import { decodeSceneAreaData, type GroundPoint, type ServerCanvas } from "@woohaa3/contracts";
import { cardHitNodeId, type HitTarget } from "../../hit-test.js";
import { isWorldInstanceNode } from "../../model-world-presentation.js";
import { enclosingAuthoringScope } from "./scope.js";
import type { NodePointerTarget } from "./types.js";

/** 卡片命中 → 统一节点目标；控件或空白返回 `null`。 */
export function cardPointerTarget(
  canvas: ServerCanvas | null,
  hit: HitTarget | null
): NodePointerTarget | null {
  if (!hit || hit.kind !== "node") return null;
  const nodeId = cardHitNodeId(hit);
  if (!nodeId) return null;
  const scopeId = enclosingAuthoringScope(canvas, nodeId);
  return isWorldInstanceNode(canvas, nodeId)
    ? { kind: "world-object", nodeId, via: "card", scopeId }
    : { kind: "card", nodeId, via: "card", scopeId };
}

/**
 * 渲染器模型拾取 → 统一世界对象目标。
 *
 * 与既有 `worldModelSelectionFromPick` 一致：只接受真实存在的共享世界实例或镜头；
 * 普通模型卡片仍走卡片路径。
 */
export function pickedWorldTarget(
  canvas: ServerCanvas | null,
  nodeId: string | null | undefined
): NodePointerTarget | null {
  if (!canvas || !nodeId) return null;
  const data = canvas.nodeData[nodeId] as Record<string, unknown> | undefined;
  if (!data || (data.sharedWorldInstance === undefined && data.worldCamera === undefined)) return null;
  if (!canvas.document.nodes.some((node) => node.id === nodeId)) return null;
  return { kind: "world-object", nodeId, via: "pick", scopeId: enclosingAuthoringScope(canvas, nodeId) };
}

/** 画布是否包含只能经渲染器拾取的世界对象；纯 2D 画布不做模型拾取回退。 */
export function hasWorldObject(canvas: ServerCanvas | null): boolean {
  if (!canvas) return false;
  return canvas.document.nodes.some((node) => {
    const data = canvas.nodeData[node.id] as Record<string, unknown> | undefined;
    return data?.sharedWorldInstance !== undefined || data?.worldCamera !== undefined;
  });
}

/** 空白处的地面命中：包含该点的导演区候选，按稳定 id 排序供循环选择。 */
export function groundAreaCandidates(canvas: ServerCanvas | null, ground: GroundPoint | null): string[] {
  if (!canvas || !ground) return [];
  return canvas.document.nodes.flatMap((node) => {
    const area = decodeSceneAreaData(canvas.nodeData[node.id]?.sceneArea);
    if (!area.ok) return [];
    const { min, max } = area.value.bounds;
    return ground.u >= min.u && ground.u <= max.u && ground.v >= min.v && ground.v <= max.v
      ? [node.id]
      : [];
  }).sort();
}
