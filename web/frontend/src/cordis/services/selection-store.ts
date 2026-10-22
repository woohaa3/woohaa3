/**
 * 瞬时选择 / 编辑焦点 / 快捷键范围的宿主侧存储
 * （change: align-godot-canvas-interactions，任务 3.3 / 3.4）。
 *
 * 运行时上报完整选择集合与编辑焦点；这里保存页面级瞬时状态。**节点业务数据不在这里**，
 * 一律在渲染时从规范 Canvas Store 解析。放在同源模块单例里而不是 React state，
 * 是因为桥接回调来自 `bootCanvas`（非 React 边界），需要一个 React 可订阅的落点。
 *
 * 选择是瞬时的：不写 Y.Doc、不推进 revision、刷新后从空选择开始。
 */

export type SelectionSnapshot = {
  /** 已按规范画布过滤的选择集合（顺序即运行时的选择顺序）。 */
  nodeIds: string[];
  /** 主节点：单节点执行面板使用。 */
  primaryNodeId: string | null;
  /** 运行时文本编辑面是否获得焦点；true 时暂停画布快捷键。 */
  editingFocus: boolean;
  /** 画布是否获得键盘范围（宿主 DOM 焦点 + 编辑焦点综合判定）。 */
  keyboardActive: boolean;
};

const EMPTY_SELECTION: SelectionSnapshot = {
  nodeIds: [],
  primaryNodeId: null,
  editingFocus: false,
  keyboardActive: true
};

export type SelectionListener = () => void;

class NodeSelectionStore {
  private snapshot: SelectionSnapshot = EMPTY_SELECTION;
  private readonly listeners = new Set<SelectionListener>();

  getSnapshot = (): SelectionSnapshot => this.snapshot;

  subscribe = (listener: SelectionListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * 设置运行时上报的选择。`validNodeIds` 是当前规范画布中的有效 ID 集合：
   * 失效 ID 在这里被过滤，保证 copy/delete 上下文不包含已删除节点。
   */
  setFromRuntime(
    raw: { nodeIds: readonly string[]; primaryNodeId: string | null; editingFocus: boolean },
    validNodeIds: ReadonlySet<string>
  ): void {
    const nodeIds = [...new Set(raw.nodeIds)].filter((id) => validNodeIds.has(id));
    const primary = raw.primaryNodeId && nodeIds.includes(raw.primaryNodeId)
      ? raw.primaryNodeId
      : nodeIds[nodeIds.length - 1] ?? null;
    this.apply({ ...this.snapshot, nodeIds, primaryNodeId: primary, editingFocus: raw.editingFocus });
  }

  /** 宿主 DOM 焦点变化：画布是否仍是快捷键作用域。 */
  setKeyboardActive(active: boolean): void {
    this.apply({ ...this.snapshot, keyboardActive: active });
  }

  /** 选中集合过滤后的主节点（向后兼容单节点面板）。 */
  getPrimaryNodeId(): string | null {
    return this.snapshot.primaryNodeId;
  }

  reset(): void {
    this.apply({ ...EMPTY_SELECTION });
  }

  private apply(next: SelectionSnapshot): void {
    if (
      next.primaryNodeId === this.snapshot.primaryNodeId
      && next.editingFocus === this.snapshot.editingFocus
      && next.keyboardActive === this.snapshot.keyboardActive
      && sameIds(next.nodeIds, this.snapshot.nodeIds)
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** 页面级单例。 */
export const nodeSelectionStore = new NodeSelectionStore();
