/**
 * 画布作品查找面板状态（change: 2026-10-09-improve-canvas-workflow，任务 4.2）。
 *
 * 纯 store：页面级单例，不进入 React 树之外的副作用；打开/关闭、查询、类型筛选与选中项。
 * 键盘所有者路由由 canvas-shell 的快捷键处理（Ctrl/⌘+F）。
 */
import type { CanvasSearchKind } from "../domain/canvas-search.js";

export type CanvasSearchSnapshot = {
  open: boolean;
  query: string;
  kinds: readonly CanvasSearchKind[];
  /** 高亮结果索引（键盘移动）。 */
  activeIndex: number;
};

const INITIAL: CanvasSearchSnapshot = { open: false, query: "", kinds: [], activeIndex: 0 };

export class CanvasSearchStore {
  private snapshot: CanvasSearchSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): CanvasSearchSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  open(): void {
    this.apply({ ...this.snapshot, open: true, activeIndex: 0 });
  }

  close(): void {
    this.apply({ ...INITIAL });
  }

  setQuery(query: string): void {
    this.apply({ ...this.snapshot, query, activeIndex: 0 });
  }

  setKinds(kinds: readonly CanvasSearchKind[]): void {
    this.apply({ ...this.snapshot, kinds: [...kinds], activeIndex: 0 });
  }

  setActiveIndex(index: number): void {
    this.apply({ ...this.snapshot, activeIndex: index });
  }

  private apply(next: CanvasSearchSnapshot): void {
    if (
      next.open === this.snapshot.open
      && next.query === this.snapshot.query
      && next.activeIndex === this.snapshot.activeIndex
      && sameKinds(next.kinds, this.snapshot.kinds)
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function sameKinds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((kind, index) => kind === b[index]);
}

/** 页面级单例；随 page scope 生命周期由调用方 close()。 */
export const canvasSearchStore = new CanvasSearchStore();
