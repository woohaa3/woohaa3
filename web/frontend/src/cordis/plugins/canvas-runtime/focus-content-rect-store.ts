/**
 * Canvas Runtime 的聚焦 content rect 持有器
 * （change: refactor-frontend-file-size；从 `host.ts` 拆出以遵守文件体积守卫）。
 *
 * 只持右侧实际占用宽度、聚焦内容矩形与订阅者；不写规范状态。
 */
import type { FocusContentRect } from "../../focus/types.js";

export class FocusContentRectStore {
  private contentRight = 0;
  private rect: FocusContentRect | null = null;
  private readonly listeners = new Set<() => void>();

  contentRectRight(): number {
    return this.contentRight;
  }

  setContentRight(right: number): boolean {
    const next = Number.isFinite(right) ? Math.max(0, right) : 0;
    if (this.contentRight === next) return false;
    this.contentRight = next;
    return true;
  }

  get(): FocusContentRect | null {
    return this.rect;
  }

  set(rect: FocusContentRect | null): boolean {
    if (JSON.stringify(rect) === JSON.stringify(this.rect)) return false;
    this.rect = rect;
    return true;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }
}
