import type { DocumentPoint } from "../shared/tool-parameters.js";
import {
  type RegionGesture,
  type RegionOptions,
  type RetouchRegionCommand,
  validateRegionGesture
} from "./tool-parameters.js";

/**
 * 区域修饰的画布手势（change: 2026-10-22-add-photocraft-retouch-workflows，U37）。
 *
 * 这里只有**几何**：把「先框选、再拖到目标」「红眼单击/框选」换算成区域命令的
 * `offset` / `points`，并给出可直接显示的拒绝原因。命令参数、事务与草稿在
 * `tool-parameters.ts` 与 `workspace.ts`；共享画布只需在指针事件里调用本模块，然后
 * 用 `workspace.ts` 的 `beginRetouchRegion` 发命令——不在这里复制第二套参数表。
 *
 * 为什么单独一块：共享 `photo-editor-app.tsx` 属单一写入，本域无法在其中加分支；把手势
 * 语义（含「零偏移不算拖动」「红眼最多 64 处」这两条拒绝条件）固定在本域，集成时只做接线，
 * 不需要再解释一遍规则。
 */

/** 一次指针拖动的文档坐标起点/终点。 */
export type RegionDrag = { from: DocumentPoint; to: DocumentPoint };

/** 红眼标记上限（与内核 `validate_region_params` 同一常量）。 */
export const MAX_RED_EYE_POINTS = 64;

function finite(point: DocumentPoint | null | undefined): boolean {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

/**
 * 拖动 → 区域命令的偏移。
 *
 * 返回整数像素偏移：修饰的区域命令按像素工作，亚像素拖动没有意义，还会让「到底有没有拖动」
 * 变得难判。零偏移直接返回 `null`（调用方据此不发起命令），与面板
 * `validateRegionGesture` 的「没有拖动就不要确认」一致。
 */
export function dragOffset(drag: RegionDrag | null): [number, number] | null {
  if (!drag || !finite(drag.from) || !finite(drag.to)) return null;
  const round = (value: number) => {
    const rounded = Math.round(value);
    // `Math.round(-0.2)` 是 `-0`：归一化成 `0`，避免「方向」出现负零这种无意义差异。
    return rounded === 0 ? 0 : rounded;
  };
  const dx = round(drag.to.x - drag.from.x);
  const dy = round(drag.to.y - drag.from.y);
  if (dx === 0 && dy === 0) return null;
  return [dx, dy];
}

/** 拖动是否是一次真正的区域操作（用于决定这次 pointerup 要不要发命令）。 */
export function isRegionDrag(drag: RegionDrag | null): boolean {
  return dragOffset(drag) !== null;
}

/**
 * 手势 → 区域命令参数（不含内核参数名，交给 `regionParams` 生成）。
 *
 * 拖动类命令要 `offset`；红眼要已标记的点。任何一条不满足都返回 `{ reason }`，调用方把
 * 原因显示在当前工具上，而不是静默不响应。
 */
export function regionGestureFromDrag(
  command: RetouchRegionCommand,
  drag: RegionDrag | null,
  options: RegionOptions
): { gesture: RegionGesture } | { reason: string } {
  if (command === "paint.redEye") {
    // 红眼不是拖动：误用拖动入口时明确说明，不把拖动当成「点了一处」。
    return { reason: "红眼需要单击或框选位置，不是拖动" };
  }
  const offset = dragOffset(drag);
  if (!offset) return { reason: "拖动距离不足 1 像素（偏移不能为 0）" };
  const gesture: RegionGesture = { offset };
  const reason = validateRegionGesture(command, options, gesture);
  return reason ? { reason } : { gesture };
}

/** 已标记的红眼位置集合（面板与画布共用的累积语义）。 */
export type RedEyeMarks = { points: readonly (readonly [number, number])[]; reason: string | null };

/**
 * 追加一处红眼位置。
 *
 * 位置取整到像素；重复点（同一像素）不重复添加，超过上限明确拒绝——都不静默丢弃，
 * 让用户知道「点了但没加进去」的原因。
 */
export function addRedEyePoint(
  marks: readonly (readonly [number, number])[],
  point: DocumentPoint | null
): RedEyeMarks {
  if (!finite(point)) return { points: marks, reason: "红眼位置无效（需要画布内的文档坐标）" };
  const next = [Math.round(point!.x), Math.round(point!.y)] as const;
  if (marks.some(([x, y]) => x === next[0] && y === next[1])) {
    return { points: marks, reason: "这个位置已经标记过了" };
  }
  if (marks.length >= MAX_RED_EYE_POINTS) {
    return { points: marks, reason: `一次最多修正 ${MAX_RED_EYE_POINTS} 处红眼` };
  }
  return { points: [...marks, next], reason: null };
}

/** 框选的多处红眼位置（矩形内按像素网格标记，供「框选一只眼睛」用）。 */
export function redEyePointsInRect(rect: { x: number; y: number; width: number; height: number } | null): (readonly [number, number])[] {
  if (!rect) return [];
  const x0 = Math.round(Math.min(rect.x, rect.x + rect.width));
  const y0 = Math.round(Math.min(rect.y, rect.y + rect.height));
  const x1 = Math.round(Math.max(rect.x, rect.x + rect.width));
  const y1 = Math.round(Math.max(rect.y, rect.y + rect.height));
  // 框选只说明「这一块里是眼睛」：取矩形中心一个点，避免把整块都当红眼。
  return [[Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2)]];
}

/**
 * 区域命令在画布上是否按拖动工作。
 *
 * 修补与内容识别移动是拖动；红眼是点选。共享画布据此决定 pointerup 时调用
 * `beginRetouchRegion` 还是追加一个标记。
 */
export function regionGestureKind(command: RetouchRegionCommand): "drag" | "click" {
  return command === "paint.redEye" ? "click" : "drag";
}
