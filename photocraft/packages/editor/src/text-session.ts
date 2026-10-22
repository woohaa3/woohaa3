/** 文字草稿的帧调度和输入法门禁；不持有文档或自行排版。 */
import type { EditorWorkspaceController } from "./editor-workspace.js";

export type TextDraft = {
  text: string;
  font: "Inter" | "Noto Sans SC";
  size: number;
  color: string;
  fauxBold: boolean;
  align: "left" | "center" | "right";
};
export type TextPlacement = { layer: number } | { x: number; y: number; box?: [number, number, number, number] };
type TextPort = Pick<EditorWorkspaceController, "beginText" | "previewText" | "commitText" | "cancelText">;

export class TextSession {
  private frame: number | null = null;
  private pending: TextDraft | null = null;
  private generation = 0;
  active = false;
  composing = false;

  constructor(private readonly controller: TextPort, private readonly refresh: () => void,
    private readonly error: (message: string) => void, private readonly onInfo: (info: unknown) => void) {}

  begin(placement: TextPlacement): boolean {
    if (this.active) return false;
    const result = this.controller.beginText(placement);
    if (!result.ok) { this.error(result.message); return false; }
    this.generation++;
    this.active = true;
    this.composing = false;
    this.onInfo(result.value);
    return true;
  }

  preview(draft: TextDraft): void {
    if (!this.active) return;
    this.pending = { ...draft };
    if (this.frame !== null) return;
    const generation = this.generation;
    this.frame = requestAnimationFrame(() => {
      // 即使取消后的回调迟到，也不能消费下一个会话的待输入内容。
      if (generation !== this.generation || !this.active) return;
      this.frame = null;
      this.flush();
    });
  }

  compositionStart(): void {
    if (!this.active) return;
    this.composing = true;
    this.stopFrame();
  }

  compositionEnd(draft: TextDraft): void {
    if (!this.active) return;
    this.composing = false;
    this.preview(draft);
  }

  private stopFrame(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.generation++;
  }

  private flush(): boolean {
    this.stopFrame();
    if (!this.pending) return true;
    const result = this.controller.previewText(this.pending);
    if (!result.ok) { this.error(result.message); return false; }
    this.pending = null;
    this.onInfo(result.value);
    this.refresh();
    return true;
  }

  commit(): boolean {
    if (!this.active) return false;
    if (this.composing) { this.error("请先完成输入法选词，再确认文字"); return false; }
    if (!this.flush()) return false;
    const result = this.controller.commitText();
    if (!result.ok) { this.error(result.message); return false; }
    this.active = false;
    this.generation++;
    this.refresh();
    return true;
  }

  /** 点击/导航前补齐未到下一帧的输入，避免使用上一版布局。 */
  synchronize(): boolean {
    return this.active && !this.composing && this.flush();
  }

  cancel(): void {
    this.stopFrame();
    this.generation++;
    this.pending = null;
    this.composing = false;
    if (!this.active) return;
    this.active = false;
    this.controller.cancelText();
    this.refresh();
  }
}
