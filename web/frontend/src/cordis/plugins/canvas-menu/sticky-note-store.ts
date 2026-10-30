/**
 * 便签正文编辑状态。
 *
 * 与重命名同一套受控模式：Enter+Ctrl 或「完成」提交，Escape 取消；只读时不提交。
 * 便签是长文本，所以用 textarea 而不是单行 input，提交键因此不能是裸 Enter
 * （否则用户换行就提交了）。
 */
export type StickyNoteState = {
  /** 正在编辑的节点；null 表示关闭。 */
  nodeId: string | null;
  value: string;
  busy: boolean;
  error: string | null;
};

/** 正文长度上限。便签是摘要，不是文档；超出部分不写进画布。 */
export const STICKY_NOTE_MAX_LENGTH = 500;

export class StickyNoteStore {
  private state: StickyNoteState = { nodeId: null, value: "", busy: false, error: null };
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): StickyNoteState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  open(nodeId: string, initial: string): void {
    this.apply({ nodeId, value: initial, busy: false, error: null });
  }

  setValue(value: string): void {
    this.apply({ ...this.state, value, error: null });
  }

  setBusy(busy: boolean): void {
    this.apply({ ...this.state, busy });
  }

  setError(error: string): void {
    this.apply({ ...this.state, error });
  }

  close(): void {
    this.apply({ nodeId: null, value: "", busy: false, error: null });
  }

  private apply(next: StickyNoteState): void {
    if (
      next.nodeId === this.state.nodeId
      && next.value === this.state.value
      && next.busy === this.state.busy
      && next.error === this.state.error
    ) {
      return;
    }
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

export const stickyNoteStore = new StickyNoteStore();
