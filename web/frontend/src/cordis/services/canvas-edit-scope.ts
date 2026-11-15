import {
  DEFAULT_CANVAS_EDIT_SCOPE,
  normalizeCanvasEditScope,
  type CanvasEditScope,
  type CanvasEditScopeCategory,
  type CanvasScopeMode
} from "@woohaa3/contracts";

export class CanvasEditScopeStore {
  private canvasId: string | null = null;
  private value: CanvasEditScope = { ...DEFAULT_CANVAS_EDIT_SCOPE };
  private revision = 0;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CanvasEditScope => this.value;
  getRevision = (): number => this.revision;

  bindCanvas(canvasId: string | null): void {
    if (canvasId === this.canvasId) return;
    this.canvasId = canvasId;
    this.value = { ...DEFAULT_CANVAS_EDIT_SCOPE };
    this.emit();
  }

  setMode(category: CanvasEditScopeCategory, mode: CanvasScopeMode): void {
    if (this.value[category] === mode) return;
    this.value = { ...this.value, [category]: mode };
    this.emit();
  }

  setScope(value: unknown): void {
    const next = normalizeCanvasEditScope(value);
    if (next["2d"] === this.value["2d"] && next["3d"] === this.value["3d"]) return;
    this.value = next;
    this.emit();
  }

  reset(): void {
    this.setScope(DEFAULT_CANVAS_EDIT_SCOPE);
  }

  private emit(): void {
    this.revision += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

export const canvasEditScopeStore = new CanvasEditScopeStore();
