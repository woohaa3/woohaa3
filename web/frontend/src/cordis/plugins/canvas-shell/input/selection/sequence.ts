/**
 * 按下序列记录与双击聚焦门禁。
 *
 * 浏览器 dblclick 晚于两次 pointerdown/up；双击处理器不能只看“当前是否已选中”，
 * 否则普通双击第一下已经把模型选中、第二下就会被误判成“已选中后进入聚焦”。
 * 这里保留最近两次按下前的选区：如果双击序列开始时目标并不在选区里，这次双击就
 * 只是一次“选入”，不应同时打开模型放大聚焦。
 */
import type { SelectionPressRecord, SelectionPressState } from "./types.js";

/** 与浏览器双击判定保持同一量级；测试可显式传入 now。 */
export const DOUBLE_CLICK_WINDOW_MS = 600;
export const DOUBLE_CLICK_DISTANCE_PX = 8;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function recordSelectionPress(
  state: SelectionPressState,
  input: Omit<SelectionPressRecord, "at"> & { at?: number }
): void {
  state.previousSelectionPress = state.lastSelectionPress;
  state.lastSelectionPress = { ...input, at: input.at ?? now() };
}

export function resetSelectionPress(state: SelectionPressState): void {
  state.lastSelectionPress = null;
  state.previousSelectionPress = null;
}

/**
 * 这次双击是否只应保留选中、不应进入模型聚焦。
 *
 * 取最近两次按下中与本次双击相邻的那一次作为序列起点；起点按下前目标不在选区，
 * 说明目标是在这次双击里才被选中的。模型原本已被选中时返回 `false`，保留双击聚焦。
 */
export function shouldSuppressDoubleClickFocus(
  state: SelectionPressState,
  nodeId: string,
  at = now()
): boolean {
  const last = state.lastSelectionPress;
  // 空白按下（nodeId 为 null）也要参与判断：模型网格可能落在卡片外，pointerdown 不会
  // 选中它，但这次双击仍然只是“选入”。明确按到别的节点时则不串用序列。
  if (!last || (last.nodeId !== null && last.nodeId !== nodeId) || at - last.at > DOUBLE_CLICK_WINDOW_MS) return false;
  const previous = state.previousSelectionPress;
  const start = previous
    && last.at - previous.at <= DOUBLE_CLICK_WINDOW_MS
    && Math.hypot(last.x - previous.x, last.y - previous.y) <= DOUBLE_CLICK_DISTANCE_PX
    ? previous
    : last;
  return !start.selectedBefore.includes(nodeId);
}
