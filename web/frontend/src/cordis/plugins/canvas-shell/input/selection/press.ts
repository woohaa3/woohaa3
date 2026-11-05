/**
 * 节点按下的选择计划。
 *
 * 2D 卡片、模型预览与共享世界对象都走这里：追加选择、已选保持、容器优先和
 * 同容器兄弟切换只维护一份规则。调用方只负责把手势继续下去。
 */
import type { ServerCanvas } from "@woohaa3/contracts";
import { enclosingAuthoringScope, hasSelectedSiblingInScope, scopeSelectionPrecedence } from "./scope.js";
import type { PressSelectionPlan } from "./types.js";

export function toggleSelected(selected: readonly string[], nodeId: string): string[] {
  return selected.includes(nodeId)
    ? selected.filter((id) => id !== nodeId)
    : [...selected, nodeId];
}

/**
 * 计算一次按下对选区的影响。
 *
 * - Shift 先切换该节点，不进入容器；
 * - 已选节点保持（随后可由领域手势消费，例如拖动/预览旋转）；
 * - 容器尚未进入时返回 `scope` 计划，第一次点击选中容器；
 * - 容器已进入（容器自身已选或同区已有兄弟）时直接选子元素，并标记
 *   `sibling-switch`，供双击忽略聚焦。
 */
export function resolvePressSelection(input: {
  canvas: ServerCanvas | null;
  nodeId: string;
  selected: readonly string[];
  additive?: boolean;
  /** 目标归一化阶段已解析的容器。 */
  scopeId?: string | null;
}): PressSelectionPlan {
  const scopeId = input.scopeId !== undefined
    ? input.scopeId
    : enclosingAuthoringScope(input.canvas, input.nodeId);
  if (input.additive) {
    return { selection: toggleSelected(input.selected, input.nodeId), reason: "toggle", scopeId, gesture: "toggle" };
  }
  if (input.selected.includes(input.nodeId)) {
    return { selection: null, reason: "already-selected", scopeId, gesture: "keep" };
  }
  const scope = scopeSelectionPrecedence({
    canvas: input.canvas,
    nodeId: input.nodeId,
    selected: input.selected,
    scopeId
  });
  if (scope) {
    return { selection: [scope], reason: "scope-entry", scopeId: scope, gesture: "scope" };
  }
  return {
    selection: [input.nodeId],
    reason: hasSelectedSiblingInScope(input.canvas, input.selected, scopeId) ? "sibling-switch" : "child",
    scopeId,
    gesture: "child"
  };
}

/** 右键补选：只补齐当前节点，不做容器钻取，也不切换已选节点。 */
export function resolveContextSelection(input: {
  canvas: ServerCanvas | null;
  nodeId: string;
  selected: readonly string[];
}): PressSelectionPlan {
  const scopeId = enclosingAuthoringScope(input.canvas, input.nodeId);
  if (input.selected.includes(input.nodeId)) {
    return { selection: null, reason: "already-selected", scopeId, gesture: "keep" };
  }
  return { selection: [input.nodeId], reason: "child", scopeId, gesture: "child" };
}
