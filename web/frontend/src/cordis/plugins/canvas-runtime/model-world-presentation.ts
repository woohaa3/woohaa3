/**
 * 运行时侧的共享世界模型拾取/选择接线。
 *
 * 世界模型与空模型没有内容卡片，指针命中只能来自渲染器的 `queryModelPick`（真实可见
 * 表面或空模型世界锚点）。本模块把该结果收敛为画布选择语义；它不发送命令、不进入
 * 聚焦、也不替代卡片命中——卡片命中仍由交互 controller 原有路径处理。
 */
import type { ServerCanvas } from "@woohaa3/contracts";

export type WorldModelPickValue = { nodeId: string } | null;

export type WorldModelPickResult =
  | { ok: true; value: WorldModelPickValue }
  | { ok: false; reason: string };

export type WorldModelSelectionInput = {
  canvas: ServerCanvas | null | undefined;
  pick: WorldModelPickResult | null | undefined;
  selected: readonly string[];
  additive?: boolean;
};

/**
 * 是否应在卡片命中为空时补一次世界模型拾取。
 *
 * 聚焦工作区、模态浮层和正在进行的画布手势仍由原 controller 门禁处理；这里只在普通
 * 画布空白卡片命中时启用，避免抢走 2D 组/导演区自己的地面选择。
 */
export function shouldUseWorldModelPick(input: {
  cardHitNodeId: string | null;
  focusActive: boolean;
  modalActive: boolean;
  gestureActive?: boolean;
}): boolean {
  return (
    !input.focusActive &&
    !input.modalActive &&
    !input.gestureActive &&
    input.cardHitNodeId === null
  );
}

/**
 * 节点是否是「只存在于共享世界 3D 空间」的对象：世界模型实例或世界镜头。
 *
 * 两者都没有可点的内容卡片（模型 3D 绘制，镜头只有视锥与机位），指针命中必须来自
 * 渲染器的 `queryModelPick`。
 */
export function isSharedWorldObject(canvas: ServerCanvas | null | undefined, nodeId: string): boolean {
  const data = canvas?.nodeData?.[nodeId];
  return data?.sharedWorldInstance !== undefined || data?.worldCamera !== undefined;
}

/**
 * 把运行时拾取结果转换为选择集合；不是世界对象或拾取不可用时返回 null。
 *
 * 返回数组而不是直接 setSelection：调用方仍需执行既有的写权限/历史门禁。
 */
export function worldModelSelectionFromPick(
  input: WorldModelSelectionInput
): string[] | null {
  if (!input.pick?.ok || !input.pick.value) return null;
  const nodeId = input.pick.value.nodeId;
  if (!isSharedWorldObject(input.canvas, nodeId)) return null;
  const exists = input.canvas?.document.nodes.some((node) => node.id === nodeId) ?? false;
  if (!exists) return null;
  if (!input.additive) return [nodeId];
  return input.selected.includes(nodeId)
    ? input.selected.filter((id) => id !== nodeId)
    : [...input.selected, nodeId];
}

/** 世界模型拾取查询的屏幕输入；宽度/高度保持当前 surface。 */
export function worldModelPickPoint(input: {
  x: number;
  y: number;
  surface: { width: number; height: number };
}): { x: number; y: number; width: number; height: number } {
  return {
    x: input.x,
    y: input.y,
    width: Math.max(1, input.surface.width),
    height: Math.max(1, input.surface.height)
  };
}

/**
 * 合并 2D 卡片框选与世界模型框选结果：世界模型没有内容卡片，必须由 Rust 的模型 AABB
 * 框选补充；同一节点若两边都命中只保留一次（卡片顺序优先）。
 */
export function mergeMarqueeSelection(
  cardIds: readonly string[],
  modelIds: readonly string[]
): string[] {
  const merged = [...cardIds];
  for (const id of modelIds) if (!merged.includes(id)) merged.push(id);
  return merged;
}
