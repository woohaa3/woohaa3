/** 将连续变换合并到每帧预览；确认前不发布正式修订。 */
import type { EditorWorkspaceController } from "../../editor-workspace.js";

export class TransformSession {
  private frame: number | null = null;
  private pending: readonly number[] | null = null;
  private generation=0;
  active = false;

  constructor(private readonly controller: EditorWorkspaceController,
    private readonly refresh: () => void, private readonly error: (message: string) => void) {}

  begin(selectionOnly = false): boolean {
    if (this.active) return true;
    const result = selectionOnly ? this.controller.beginTransform(true) : this.controller.beginTransform();
    if (!result.ok) { this.error(result.message); return false; }
    this.active = true;
    this.generation++;
    return true;
  }

  beginMove(params: { x: number; y: number; autoSelect: boolean; duplicate: boolean }): boolean {
    if (this.active) return false;
    const result = this.controller.beginMove(params);
    if (!result.ok) { this.error(result.message); return false; }
    this.active = result.value;
    this.generation++;
    return this.active;
  }

  preview(matrix: readonly number[]): void {
    if (!this.active) return;
    this.pending = [...matrix];
    const generation=this.generation;
    if (this.frame === null) this.frame = requestAnimationFrame(() => {
      if (!this.active || generation!==this.generation) return;
      this.frame = null; this.flush();
    });
  }

  private flush(): boolean {
    if (this.frame !== null) { cancelAnimationFrame(this.frame); this.frame = null; }
    this.generation++;
    if (!this.pending) return true;
    const result = this.controller.previewTransform(this.pending);
    if (!result.ok) { this.error(result.message); return false; }
    this.pending = null;
    this.refresh();
    return true;
  }

  commit(): boolean {
    if (!this.active || !this.flush()) return false;
    const result = this.controller.commitTransform();
    if (!result.ok) { this.error(result.message); return false; }
    this.active = false;
    this.generation++;
    this.refresh();
    return true;
  }

  cancel(): void {
    this.generation++;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.pending = null;
    if (!this.active) return;
    this.controller.cancelTransform();
    this.active = false;
    this.refresh();
  }
}
