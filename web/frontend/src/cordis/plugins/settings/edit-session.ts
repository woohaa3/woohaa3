/**
 * 设置工作区的 edit-session（change: 2026-10-17-move-settings-into-canvas-dialog，任务 3.3 / design D4）。
 *
 * 只在内存存在的一次设置编辑会话：
 * - 逐项保存仍是唯一写入方式（不做批量事务）；
 * - 行与扩展面板把「未保存草稿 / 写请求进行中」注册进来，工作区据此决定能否关闭、切分区或返回列表；
 * - 会话不进入 Dialog payload、URL、localStorage、日志或画布数据，关闭/强制释放即丢弃。
 *
 * 纯数据 + 订阅，无 React/DOM 依赖，便于对门禁做确定性单测。
 */

/** 一条编辑项上报的当前状态。 */
export type SettingsEditEntryState = {
  /** 该编辑项是否有未保存输入（含密钥输入）。 */
  dirty: boolean;
  /** 该编辑项是否有写请求进行中（实时动作也算）。 */
  pending: boolean;
};

/** 注册一个编辑项：返回项级 reporter 与注销函数。 */
export type SettingsEditRegistration = {
  report: (state: SettingsEditEntryState) => void;
  dispose: () => void;
};

export type SettingsEditSessionSnapshot = {
  dirty: boolean;
  pending: boolean;
  /** 有任一编辑项处于 dirty 或 pending。 */
  hasChanges: boolean;
};

export type SettingsEditSession = {
  getSnapshot(): SettingsEditSessionSnapshot;
  subscribe(listener: () => void): () => void;
  /** 注册一个编辑项；未提供 initial 时视为干净。 */
  register(entry: { id: string; initial?: SettingsEditEntryState }): SettingsEditRegistration;
  /** 是否有任一保存请求进行中（同步查询，用于拒绝关闭/换视图）。 */
  isPending(): boolean;
  /** 是否有未保存输入（同步查询，用于 dirty 确认门禁）。 */
  isDirty(): boolean;
  /** 用户确认放弃：清除所有 dirty 标记（已成功写入的配置不受影响）。 */
  discardDrafts(): void;
  /** 强制释放（关闭弹窗/页面 dispose）：清空注册与状态。 */
  reset(): void;
};

const CLEAN: SettingsEditEntryState = { dirty: false, pending: false };

export function createSettingsEditSession(): SettingsEditSession {
  const entries = new Map<string, SettingsEditEntryState>();
  const listeners = new Set<() => void>();
  let snapshot: SettingsEditSessionSnapshot = { dirty: false, pending: false, hasChanges: false };
  let disposed = false;

  const publish = () => {
    if (disposed) return;
    let dirty = false;
    let pending = false;
    for (const state of entries.values()) {
      if (state.dirty) dirty = true;
      if (state.pending) pending = true;
      if (dirty && pending) break;
    }
    snapshot = { dirty, pending, hasChanges: dirty || pending };
    for (const listener of listeners) listener();
  };

  const isPending = () => {
    for (const state of entries.values()) if (state.pending) return true;
    return false;
  };
  const isDirty = () => {
    for (const state of entries.values()) if (state.dirty) return true;
    return false;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register(entry) {
      if (!entry.id) throw new Error("设置编辑项缺少 id");
      let current = entry.initial ?? CLEAN;
      entries.set(entry.id, current);
      publish();
      let released = false;
      return {
        report(next) {
          if (released || disposed) return;
          if (current.dirty === next.dirty && current.pending === next.pending) return;
          current = { dirty: next.dirty, pending: next.pending };
          entries.set(entry.id, current);
          publish();
        },
        dispose() {
          if (released) return;
          released = true;
          entries.delete(entry.id);
          publish();
        }
      };
    },
    isPending,
    isDirty,
    discardDrafts() {
      for (const [id, current] of entries) entries.set(id, { dirty: false, pending: current.pending });
      publish();
    },
    reset() {
      disposed = true;
      entries.clear();
      listeners.clear();
      snapshot = { dirty: false, pending: false, hasChanges: false };
    }
  };
}
