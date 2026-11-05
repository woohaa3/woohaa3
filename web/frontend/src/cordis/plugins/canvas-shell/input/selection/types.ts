/** 一次按下为什么改变选区；双击用它判断本次是否只是在“选入”模型。 */
export type SelectionPressReason =
  | "scope-entry"
  | "sibling-switch"
  | "child"
  | "already-selected"
  | "toggle"
  | "empty";

/** 按下后应继续的手势方向：选容器、选子元素、Shift 切换或保持当前选择。 */
export type SelectionPressGesture = "scope" | "child" | "toggle" | "keep";

/**
 * 纯选择计划。`selection === null` 表示保持当前选区；真正写入
 * `InteractionState` 与 `nodeSelectionStore` 由 `apply.ts` 统一完成。
 */
export type PressSelectionPlan = {
  selection: readonly string[] | null;
  reason: SelectionPressReason;
  /** 子元素所属的组/导演区；没有容器时为 `null`。 */
  scopeId: string | null;
  gesture: SelectionPressGesture;
};

/** 按下记录：保留按下前的选区，供浏览器随后触发的 dblclick 判断。 */
export type SelectionPressRecord = {
  nodeId: string | null;
  selectedBefore: readonly string[];
  reason: SelectionPressReason;
  at: number;
  x: number;
  y: number;
};

/** 双击判定需要的最近两次按下；`InteractionState` 按结构实现即可。 */
export type SelectionPressState = {
  lastSelectionPress: SelectionPressRecord | null;
  previousSelectionPress: SelectionPressRecord | null;
};

/** 画布按下时统一后的节点目标（2D 卡片 / 模型预览 / 共享世界对象）。 */
export type NodePointerTarget = {
  kind: "card" | "model-preview" | "world-object";
  nodeId: string;
  via: "card" | "pick";
  scopeId: string | null;
};
