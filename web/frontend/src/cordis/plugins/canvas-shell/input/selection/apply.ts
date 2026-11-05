/**
 * 选择计划执行：所有按下路径共用的唯一写入方式。
 *
 * 写入顺序固定为「先记按下前选区，再提交新选区」，这样双击处理器拿到的
 * `selectedBefore` 不会被本次按下污染。
 */
import { recordSelectionPress } from "./sequence.js";
import type { PressSelectionPlan, SelectionPressState } from "./types.js";

export type SelectionSink = (nodeIds: string[]) => void;

type PressState = SelectionPressState & { selected: readonly string[] };

export function applyPressSelection(plan: PressSelectionPlan, setSelection: SelectionSink): void {
  if (plan.selection !== null) setSelection([...plan.selection]);
}

/**
 * 提交一次按下选择并记录序列。调用方仍负责后续领域手势（拖动/地面拖动/预览旋转）。
 */
export function commitPressSelection(input: {
  state: PressState;
  nodeId: string | null;
  plan: PressSelectionPlan;
  setSelection: SelectionSink;
  x?: number;
  y?: number;
}): void {
  const selectedBefore = [...input.state.selected];
  applyPressSelection(input.plan, input.setSelection);
  recordSelectionPress(input.state, {
    nodeId: input.nodeId,
    selectedBefore,
    reason: input.plan.reason,
    x: input.x ?? 0,
    y: input.y ?? 0
  });
}

/** 已经由领域手势消费的按下（例如已选模型预览旋转）只需记录序列。 */
export function noteSelectionPress(input: {
  state: PressState;
  nodeId: string | null;
  reason: PressSelectionPlan["reason"];
  x?: number;
  y?: number;
}): void {
  recordSelectionPress(input.state, {
    nodeId: input.nodeId,
    selectedBefore: [...input.state.selected],
    reason: input.reason,
    x: input.x ?? 0,
    y: input.y ?? 0
  });
}
