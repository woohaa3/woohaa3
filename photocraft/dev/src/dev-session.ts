/**
 * 独立宿主的文档会话
 * （change: 2026-10-21-extract-photocraft-subproject，design D3/D4）。
 *
 * 编辑器核心只要求结构接口；这个会话把唯一基线（打开/保存时的文档内容 hash）与净变化
 * 放在宿主侧，和 Woohaa 适配包对 `ProjectSession` 的用法一致，但不含任何画布/资产类型。
 */
import type { EditorDocumentSession } from "@woohaa3/photocraft-editor";
import type { PhotocraftContentState } from "@woohaa3/photocraft-protocol";

export type DevSessionPhase = "idle" | "editing" | "freezing" | "saving" | "failed";

export class DevDocumentSession implements EditorDocumentSession {
  private baseline: string | null = null;
  private current: string | null = null;
  private dirty = false;
  private phase: DevSessionPhase = "idle";
  private message: string | null = null;

  applyContentState(state: PhotocraftContentState): void {
    this.current = state.documentContentHash;
    // 首次内容状态（打开图片/工程后）就是进入基线；打开不等于修改。
    if (this.baseline === null) this.baseline = state.documentContentHash;
    this.dirty = state.documentContentHash !== this.baseline;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  beginFreeze(): void {
    this.phase = "freezing";
    this.message = null;
  }

  resumeEditing(): void {
    this.phase = "editing";
  }

  beginSave(): void {
    this.phase = "saving";
  }

  commitBaseline(contentHash: string): void {
    this.baseline = contentHash;
    this.current = contentHash;
    this.dirty = false;
    this.phase = "editing";
    this.message = null;
  }

  failSave(message: string): void {
    this.phase = "failed";
    this.message = message;
  }

  establishBaseline(): void {
    if (this.current !== null) {
      this.baseline = this.current;
      this.dirty = false;
    }
    this.phase = "editing";
  }

  status(): { phase: DevSessionPhase; message: string | null; dirty: boolean; baseline: string | null } {
    return { phase: this.phase, message: this.message, dirty: this.dirty, baseline: this.baseline };
  }
}
