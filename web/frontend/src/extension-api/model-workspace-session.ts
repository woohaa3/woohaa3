/**
 * 模型聚焦会话（最小状态）。
 *
 * 只保留当前聚焦的 model3d nodeId；模型镜头存储、pose/focus 手势与截图已删除。
 */
export type ModelEditorState = { nodeId: string | null };

export class ModelEditorSession {
  private state: ModelEditorState = { nodeId: null };
  private readonly listeners = new Set<() => void>();

  getState = (): ModelEditorState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  enter(nodeId: string): void {
    if (this.state.nodeId === nodeId) return;
    this.state = { nodeId };
    this.emit();
  }

  exit(): void {
    if (this.state.nodeId === null) return;
    this.state = { nodeId: null };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
