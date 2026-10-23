import type { WorkspaceFeatureContext, VectorDocumentToken } from "../workspace-context.js";
import type { EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";

/**
 * 提交一条矢量命令。
 *
 * 门禁顺序固定为：无文档 → 文档代际 → 草稿门禁 → 冻结窗口 → 内核 → `afterWrite`。
 * `token` 由手势开始时捕获：会话已结束或文档已切换时命令被丢弃，绝不写入后来活动文档
 * （change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.3）。
 */
export function vectorCommand(this: WorkspaceFeatureContext, id: string, params: unknown, token?: VectorDocumentToken): EditorResult<EditorViewModel> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    if (token) {
      const current = this.vectorToken();
      if (current.generation !== token.generation || current.session !== token.session) {
        return { ok: false, code: "stale", message: "文档已切换，已放弃这次矢量编辑" };
      }
    }
    // 矢量手势的草稿在域内（React 状态），不能拦住自己的提交；其它草稿照常拦截。
    const blocked = this.blockingDraftExceptVector();
    if (blocked) return blocked;
    // 冻结窗口与 `dispatch` 同一判定：保存/导出取走产物后不能再改文档。
    if (this.writesFrozen()) return { ok: false, code: "frozen", message: "导出期间不接受内容修改" };
    const result = handle.vectorCommand(id, params);
    if (!result.ok) return this.fail(result);
    return this.afterWrite();
  }

export function vectorSnapshot(this: WorkspaceFeatureContext, ): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    return this.handle.vectorSnapshot();
  }

/** 形状预设库快照：只读工具状态，不制造文档 dirty。 */
export function vectorPresets(this: WorkspaceFeatureContext, ): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    return this.handle.features.vectors.vectorPresets();
  }

/** 拖绘几何预览：纯计算，不触发 afterWrite（不推进修订/历史）。 */
export function vectorDrawParams(this: WorkspaceFeatureContext, input: unknown): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    return this.handle.features.vectors.vectorDrawParams(input);
  }

export function createSession(context: () => WorkspaceFeatureContext) {
  return {
    vectorCommand: (...args: Parameters<OmitThisParameter<typeof vectorCommand>>) => vectorCommand.apply(context(), args),
    vectorSnapshot: (...args: Parameters<OmitThisParameter<typeof vectorSnapshot>>) => vectorSnapshot.apply(context(), args),
    vectorPresets: (...args: Parameters<OmitThisParameter<typeof vectorPresets>>) => vectorPresets.apply(context(), args),
    vectorDrawParams: (...args: Parameters<OmitThisParameter<typeof vectorDrawParams>>) => vectorDrawParams.apply(context(), args),
  };
}
