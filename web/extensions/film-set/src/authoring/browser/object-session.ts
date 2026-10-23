/**
 * 片场对象聚焦编辑会话
 * （change: 2026-10-09-add-film-set-object-motion-and-editing，任务 4.1–4.4 / design D5/D6）。
 *
 * 持有对象模式下的**浏览器本地**状态：编辑目标模式（整体/对象）、当前选中 itemId、拖动
 * preview、对象列表。它不写 ServerCanvas / Y.Doc；完成时经注入的 `submitItemOp` 提交**一次**
 * 稳定 itemId 定位的权威操作，取消恢复确认值。播放中开始编辑先暂停（由宿主在 `beginEdit`
 * 前调用 `pausePlayback`）。
 */
import { applyFilmSetItemTransform, cloneFilmSetLocalTransform, decodeFilmSetLocalTransform, encodeFilmSetPartId, filmSetItemById, isFilmSetMediaItem, type FilmSetContent, type FilmSetItem, type FilmSetItemPatchOp, type FilmSetLocalTransform } from "@woohaa3/contracts";
import { FilmSetObjectState, INITIAL, type FilmSetObjectEntry, type FilmSetOperationOutcome } from "../../state/browser/object-state.js";

/** 编辑目标模式：整体（默认）或对象。 */

export type FilmSetObjectSessionDeps = {
  /** 读取最新权威内容（working projection 优先）。 */
  readContent: (nodeId: string) => FilmSetContent;
  /** 当前片场是否可写（只读/历史时禁用所有持久化动作）。 */
  isWritable: () => boolean;
  /** 播放中开始编辑前暂停播放头。 */
  pausePlayback?: () => void;
  /**
   * 提交一次对象级权威操作。可同步返回布尔/结果，或返回带 `settled` 的异步回执。
   * 由宿主经 `canvasEdit.record`（页面受保护操作记录）提交。
   */
  submitItemOp: (input: { nodeId: string; itemId: string; op: FilmSetItemPatchOp; label: string }) =>
    | boolean
    | { ok: boolean; reason?: string; handle?: { settled: Promise<{ state: string; error: string | null }> } }
    | Promise<{ ok: boolean; reason?: string }>;
};

export class FilmSetObjectSession extends FilmSetObjectState {
  private submission = 0;
  constructor(private readonly deps: FilmSetObjectSessionDeps) { super(); }

  setTool(tool: import("@woohaa3/contracts").ObjectGizmoTool): void {
    if (tool === this.state.tool) return;
    this.editBase = null;
    this.state = { ...this.state, tool, preview: null, pointer: null, feedback: { epoch: this.state.feedback.epoch + 1 } };
    this.emit();
  }
  setHover(handle: import("@woohaa3/contracts").GizmoHandleName | null): void {
    if (this.state.feedback.active || this.state.feedback.hover === (handle ?? undefined)) return;
    this.state = { ...this.state, feedback: { epoch: this.state.feedback.epoch, ...(handle ? { hover: handle } : {}) } };
    this.emit();
  }
  setActive(handle: import("@woohaa3/contracts").GizmoHandleName | null, pointer: { x: number; y: number } | null = null): void {
    this.state = { ...this.state, pointer, feedback: { epoch: this.state.feedback.epoch + 1, ...(handle ? { active: handle } : {}) } };
    this.emit();
  }
  setPointer(pointer: { x: number; y: number }): void { this.state = { ...this.state, pointer }; }
  dragReadout(): string | null {
    const { preview, feedback } = this.state;
    const base = this.editBase;
    if (!preview || !base || !feedback.active) return null;
    if (feedback.active === "yaw-ring") return `Y 旋转 ${signed((preview.yaw - base.yaw) * 180 / Math.PI, 1)}°`;
    if (feedback.active === "scale") return `等比缩放 ${(preview.scale / base.scale).toFixed(2)}×`;
    const delta = (["x", "y", "z"] as const).map(axis => `${axis.toUpperCase()} ${signed(preview.offset[axis] - base.offset[axis], 2)}`);
    return feedback.active === "center" ? delta.join("  ") : delta[["x", "y", "z"].indexOf(feedback.active)] ?? null;
  }

  /** 进入片场聚焦（整体与对象工具同时可用）。 */
  enter(nodeId: string): void {
    ++this.submission;
    this.editBase = null;
    this.state = { ...INITIAL, nodeId };
    this.emit();
  }

  /** 退出聚焦：清理 selection/preview。 */
  exit(): void {
    ++this.submission;
    this.editBase = null;
    this.state = { ...INITIAL };
    this.emit();
  }

  /** 对象列表（稳定顺序，含整体入口以外的所有 items）。 */
  objects(): FilmSetObjectEntry[] {
    const nodeId = this.state.nodeId;
    if (!nodeId) return [];
    const content = this.deps.readContent(nodeId);
    return content.items.map((item) => ({
      itemId: item.id,
      kind: item.kind,
      name: item.name,
      editable: true
    }));
  }

  /** 当前选中对象（缺失/已删除返回 null）。 */
  selectedItem(): FilmSetItem | null {
    const nodeId = this.state.nodeId;
    const itemId = this.state.selectedItemId;
    if (!nodeId || !itemId) return null;
    return filmSetItemById(this.deps.readContent(nodeId), itemId) ?? null;
  }

  /** 选择对象（session-only）；item 不存在时清空选择。 */
  select(itemId: string | null): void {
    if (!this.state.nodeId) return;
    this.editBase = null;
    if (itemId === null) {
      this.state = { ...this.state, selectedItemId: null, preview: null, pointer: null, feedback: { epoch: this.state.feedback.epoch + 1 } };
      this.emit();
      return;
    }
    const selected = filmSetItemById(this.deps.readContent(this.state.nodeId), itemId);
    if (!selected) {
      this.state = { ...this.state, selectedItemId: null, preview: null, pointer: null, feedback: { epoch: this.state.feedback.epoch + 1 } };
      this.emit();
      return;
    }
    this.state = { ...this.state, selectedItemId: itemId, preview: null, pointer: null, feedback: { epoch: this.state.feedback.epoch + 1 } };
    this.emit();
  }

  /**
   * 开始一次对象摆放编辑：播放中先暂停，冻结确认值为 preview 基线。
   * 返回是否成功开始（无选中对象/不可写时 false）。
   */
  beginEdit(): boolean {
    if (!this.state.nodeId || !this.deps.isWritable() || this.state.pendingItemId !== null) return false;
    const item = this.selectedItem();
    if (!item) return false;
    ++this.submission;
    this.deps.pausePlayback?.();
    this.editBase = cloneFilmSetLocalTransform(item.localTransform);
    this.state = { ...this.state, preview: cloneFilmSetLocalTransform(item.localTransform), error: null };
    this.emit();
    return true;
  }

  /** 推进 preview（调用方已完成逆换算）。 */
  updatePreview(transform: FilmSetLocalTransform): void {
    if (!this.state.preview) return;
    const decoded = decodeFilmSetLocalTransform(transform);
    if (!decoded.ok) return;
    this.state = { ...this.state, preview: decoded.value };
    this.emit();
  }

  /** 结束并提交一次 itemId 定位的摆放操作；无净变化或不可写时不提交。 */
  endEdit(): void {
    const preview = this.state.preview;
    const item = this.selectedItem();
    const base = this.editBase;
    this.editBase = null;
    this.state = { ...this.state, preview: null, pointer: null, feedback: { epoch: this.state.feedback.epoch + 1 } };
    if (!preview || !item) {
      this.emit();
      return;
    }
    if (!this.deps.isWritable() || base && !sameTransform(item.localTransform, base) || equivalentTransform(preview, item.localTransform)) {
      this.emit();
      return;
    }
    if (this.state.pendingItemId === item.id) {
      this.emit();
      return;
    }
    const result = this.submit({ kind: "transform", localTransform: preview, ...(base ? { expectedLocalTransform: base } : {}) });
    if (!result && !this.state.error) this.state = { ...this.state, error: "摆放提交失败" };
    this.emit();
  }

  /** 取消编辑：丢弃 preview，不提交。 */
  cancelEdit(): void {
    this.editBase = null;
    if (!this.state.preview && !this.state.feedback.active && !this.state.feedback.hover) return;
    this.state = { ...this.state, preview: null, pointer: null, feedback: { epoch: this.state.feedback.epoch + 1 } };
    this.emit();
  }

  /** 删除选中对象；成功后清空选择（空片场保持可用，不补地面）。 */
  deleteSelected(): boolean {
    const item = this.selectedItem();
    if (!item) return false;
    if (this.state.pendingItemId === item.id) return false;
    const targetId = item.id;
    const result = this.submit({ kind: "delete" }, this.deletionLabel(item), (outcome) => {
      if (outcome.state === "rejected") {
        // 权威拒绝：恢复最新有效选择（目标仍存在且会话未切换时）；不从旧场景覆盖 canonical。
        if (this.state.nodeId && filmSetItemById(this.deps.readContent(this.state.nodeId), targetId)) {
          this.state = { ...this.state, selectedItemId: targetId };
        }
      }
    });
    if (result) {
      // 乐观移除对象（working projection 可提前消失），committed 前不宣称成功。
      this.state = { ...this.state, selectedItemId: null, preview: null, pointer: null, feedback: { epoch: this.state.feedback.epoch + 1 } };
    } else if (!this.state.error) {
      this.state = { ...this.state, error: "删除失败" };
    }
    this.emit();
    return result;
  }

  /** 等比缩放选中对象（正有限）。 */
  setSelectedScale(scale: number): boolean {
    const item = this.selectedItem();
    if (!item || !Number.isFinite(scale) || scale <= 0) return false;
    if (scale === item.localTransform.scale) return true;
    if (this.state.pendingItemId === item.id) return false;
    const result = this.submit({
      kind: "transform",
      localTransform: { ...cloneFilmSetLocalTransform(item.localTransform), scale }
    });
    this.emit();
    return result;
  }

  /**
   * 本地应用一份对象操作到内容（供 preview/求和；不写权威状态）。
   */
  applyLocally(op: FilmSetItemPatchOp): FilmSetContent | null {
    const nodeId = this.state.nodeId;
    const item = this.selectedItem();
    if (!nodeId || !item) return null;
    if (op.kind === "transform") {
      const result = applyFilmSetItemTransform({
        content: this.deps.readContent(nodeId),
        itemId: item.id,
        localTransform: op.localTransform
      });
      return result.ok ? result.value : null;
    }
    return null;
  }

  /** 选中项的运行时根 id（组合作用域）；用于命中/显示。 */
  selectedRootId(): string | null {
    const item = this.selectedItem();
    return item ? encodeFilmSetPartId(item.id, "") : null;
  }

  /** 权威内容变化后清理失效选择（远端删除/切换）。 */
  reconcile(): void {
    if (!this.state.nodeId) return;
    if (!this.deps.isWritable()) { this.cancelEdit(); this.setTool("move"); return; }
    const itemId = this.state.selectedItemId;
    if (!itemId) return;
    const selected = filmSetItemById(this.deps.readContent(this.state.nodeId), itemId);
    if (this.state.pendingItemId === itemId) {
      // pending 目标：等结算，不因乐观消失而清空 invocation 身份。
      return;
    }
    if (this.state.preview && this.editBase && selected && !sameTransform(selected.localTransform, this.editBase)) {
      this.state = { ...this.state, preview: null, pointer: null, feedback: { epoch: this.state.feedback.epoch + 1 }, error: "对象摆放已更新，请重新拖动" };
      this.editBase = null;
      this.emit();
    }
    if (!selected) {
      this.state = { ...this.state, selectedItemId: null, preview: null, pointer: null, feedback: { epoch: this.state.feedback.epoch + 1 } };
      this.emit();
    }
  }

  private submit(op: FilmSetItemPatchOp, label?: string, onOutcome?: (outcome: FilmSetOperationOutcome) => void): boolean {
    const nodeId = this.state.nodeId;
    const item = this.selectedItem();
    if (!nodeId || !item || !this.deps.isWritable() || this.state.pendingItemId !== null) return false;
    const token = ++this.submission;
    const actionLabel = label ?? itemActionLabel(op, item.name);
    const targetId = item.id;
    const settle = (outcome: FilmSetOperationOutcome) => {
      // 迟到回执不污染新 scope：仅当仍是同一 submission / node / 目标时结算。
      if (token !== this.submission || this.state.nodeId !== nodeId || this.state.pendingItemId !== targetId) return;
      this.state = {
        ...this.state,
        pendingItemId: null,
        ...(outcome.state === "rejected" ? { preview: null, error: outcome.error ?? "对象操作被拒绝" } : {})
      };
      onOutcome?.(outcome);
      this.emit();
    };
    const result = this.deps.submitItemOp({ nodeId, itemId: item.id, op, label: actionLabel });
    if (typeof result === "boolean") return result;
    this.state = { ...this.state, pendingItemId: targetId };
    if (result instanceof Promise) {
      void result.then(outcome => settle(outcome.ok ? { state: "committed" } : { state: "rejected", error: outcome.reason ?? "对象操作提交失败" })).catch(() => this.markUnknown(token));
      return true;
    }
    if (!result.ok) {
      this.state = { ...this.state, pendingItemId: null, error: result.reason ?? "对象操作提交失败" };
      return false;
    }
    if (!result.handle) { settle({ state: "committed" }); return true; }
    void result.handle?.settled.then(handle => {
      if (handle.state === "rejected") settle({ state: "rejected", error: handle.error });
      else if (handle.state === "committed") settle({ state: "committed" });
      // Unknown results retain the original invocation identity and keep conflicting edits blocked.
      else this.markUnknown(token);
    }).catch(() => this.markUnknown(token));
    return true;
  }

  private markUnknown(token: number): void {
    if (token !== this.submission) return;
    this.state = { ...this.state, error: "操作结果尚未确认，请等待同步" };
    this.emit();
  }

  private deletionLabel(item: FilmSetItem): string {
    return `删除片场对象 ${item.name}`;
  }

}

function sameTransform(left: FilmSetLocalTransform, right: FilmSetLocalTransform): boolean {
  return (
    left.offset.x === right.offset.x &&
    left.offset.y === right.offset.y &&
    left.offset.z === right.offset.z &&
    left.scale === right.scale &&
    left.yaw === right.yaw
  );
}

/** 供撤销提示与 journal 的中文动作标签。 */
function itemActionLabel(op: FilmSetItemPatchOp, name: string): string {
  switch (op.kind) {
    case "delete": return `删除片场对象 ${name}`;
    case "transform": return `移动片场对象 ${name}`;
    default: return `修改片场对象 ${name}`;
  }
}

/** 从画布读取片场内容（非法/缺失返回空集合）。 */
export { isFilmSetMediaItem };

export { readFilmSetContentForSession } from "../../state/browser/object-state.js";
function signed(value: number, digits: number): string { return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`; }
export type { FilmSetObjectEntry, FilmSetObjectSessionState, FilmSetOperationOutcome } from "../../state/browser/object-state.js";

function equivalentTransform(left: FilmSetLocalTransform, right: FilmSetLocalTransform): boolean {
  return [left.offset.x-right.offset.x,left.offset.y-right.offset.y,left.offset.z-right.offset.z,left.yaw-right.yaw,left.scale-right.scale]
    .every(delta => Math.abs(delta) <= 1e-9);
}
