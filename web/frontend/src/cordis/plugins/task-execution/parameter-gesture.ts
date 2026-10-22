/**
 * 参数手势记录器（change: 2026-10-09-improve-canvas-workflow，任务 1.6 / design D5.1）。
 *
 * 把参数控件的连续变更合并成**一次**完成动作：拖动滑块到结束只记一次，文本型参数在
 * 确认/失焦时结束。记录 `{nodeId, modelKey}` 分区的 before/after，供 Edit Journal 的
 * 本地参数条目撤销/重做（不回退规范参数或任务、不重新提交）。
 *
 * before 由调用方在**手势开始**时提供当前分区值（含缺省）；后续 patch 只累积 after。
 * 纯逻辑：调用方在「完成」时调用 `end()` 并消费返回值。
 */
export type ParameterGesture = {
  nodeId: string;
  modelKey: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

export type ParameterGestureRecorder = {
  /**
   * 记录一次参数变更。首次调用建立手势（`before` 必须为该分区的完整当前值）。
   * 同分区连续调用合并进同一手势；切换分区时先结束旧手势（调用方应显式 end）。
   */
  patch(input: {
    nodeId: string;
    modelKey: string;
    before: Record<string, unknown>;
    values: Record<string, unknown>;
  }): void;
  /** 结束当前手势；返回可记录的手势或 null（无手势/无实际变化）。 */
  end(): ParameterGesture | null;
  isActive(): boolean;
  cancel(): void;
};

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function createParameterGestureRecorder(): ParameterGestureRecorder {
  let active: ParameterGesture | null = null;

  return {
    patch(input) {
      if (!active || active.nodeId !== input.nodeId || active.modelKey !== input.modelKey) {
        active = {
          nodeId: input.nodeId,
          modelKey: input.modelKey,
          before: { ...input.before },
          after: { ...input.before }
        };
      }
      for (const [key, value] of Object.entries(input.values)) {
        active.after[key] = value;
      }
    },

    end() {
      const current = active;
      active = null;
      if (!current) return null;
      const changed = Object.keys(current.after).some((key) => !sameValue(current.after[key], current.before[key]))
        || Object.keys(current.before).some((key) => !(key in current.after));
      return changed ? current : null;
    },

    isActive() {
      return active !== null;
    },

    cancel() {
      active = null;
    }
  };
}
