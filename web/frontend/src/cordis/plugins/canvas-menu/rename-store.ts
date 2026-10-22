/**
 * 作品重命名输入状态（change: 2026-10-09-improve-canvas-workflow，任务 2.3）。
 *
 * 受控 DOM 输入：Enter 确认、Escape 取消；只读时不提交。名称最多 120 个 Unicode 字符、
 * 不接受纯空白；输入为空时提示填写名称并保留原值。节点切换或 dispose 时清空，避免写错目标。
 */
export type NodeRenameState = {
  /** 正在重命名的节点；null 表示关闭。 */
  nodeId: string | null;
  /** 当前输入值。 */
  value: string;
  /** 初始名称（Escape 恢复/展示）。 */
  initial: string;
  /** 校验或提交错误。 */
  error: string | null;
  /** 是否正在提交。 */
  busy: boolean;
};

export class NodeRenameStore {
  private state: NodeRenameState = { nodeId: null, value: "", initial: "", error: null, busy: false };
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): NodeRenameState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  open(nodeId: string, initial: string): void {
    this.apply({ nodeId, value: initial, initial, error: null, busy: false });
  }

  setValue(value: string): void {
    this.apply({ ...this.state, value, error: null });
  }

  setError(error: string): void {
    this.apply({ ...this.state, error });
  }

  setBusy(busy: boolean): void {
    this.apply({ ...this.state, busy });
  }

  close(): void {
    this.apply({ nodeId: null, value: "", initial: "", error: null, busy: false });
  }

  private apply(next: NodeRenameState): void {
    if (
      next.nodeId === this.state.nodeId
      && next.value === this.state.value
      && next.error === this.state.error
      && next.busy === this.state.busy
    ) {
      return;
    }
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

export const nodeRenameStore = new NodeRenameStore();
