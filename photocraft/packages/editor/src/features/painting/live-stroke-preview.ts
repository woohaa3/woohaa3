/** 按动画帧合并增量采样；临时像素仍由同一编辑内核合成。 */
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import type { EditorResult } from "../../editor-wasm.js";
import { strokePoints, type DocumentPoint } from "../../photo-editor-tools.js";

export class LiveStrokePreview {
  private active = false;
  private retouch = false;
  private pending: DocumentPoint[] = [];
  private frame: number | null = null;

  constructor(
    private readonly controller: EditorWorkspaceController,
    private readonly refresh: () => void,
    private readonly message: (message: string | null) => void,
    private readonly refreshStroke:()=>void=refresh
  ) {}

  begin(params: Record<string, unknown>, retouchCommand?: string): boolean {
    this.cancel();
    this.retouch = !!retouchCommand;
    if (!this.check(retouchCommand ? this.controller.beginRetouch(retouchCommand, params) : this.controller.beginStroke(params))) return false;
    this.active = true;
    if (this.retouch && !this.check(this.controller.appendRetouch([]))) return false;
    this.schedule();
    return true;
  }

  append(points: DocumentPoint[]): void {
    if (!this.active) return;
    this.pending.push(...points);
    this.schedule();
  }

  finish(): boolean {
    if (!this.active) return false;
    this.stopFrame();
    if (!this.flush()) return false;
    this.active = false;
    const success = this.check(this.retouch ? this.controller.commitRetouch() : this.controller.commitStroke());
    if (success) this.message(null);
    return success;
    // 提交失败也恢复正式文档；成功后的常规修订 effect 负责刷新。
  }

  cancel(): void {
    this.stopFrame();
    this.pending = [];
    if (!this.active) return;
    this.active = false;
    if (this.retouch) this.controller.cancelRetouch();
    else this.controller.cancelStroke();
    this.refresh();
  }

  private schedule(): void {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.active && this.flush()) this.refreshStroke();
    });
  }

  private flush(): boolean {
    const points = this.pending;
    this.pending = [];
    return points.length === 0 || this.check(this.retouch ? this.controller.appendRetouch(strokePoints(points)) : this.controller.appendStroke(strokePoints(points)));
  }

  private check(result: EditorResult<unknown>): boolean {
    if (result.ok) return true;
    const wasActive = this.active;
    this.cancel();
    if (!wasActive) this.refresh();
    this.message(result.message);
    return false;
  }

  private stopFrame(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }
}
