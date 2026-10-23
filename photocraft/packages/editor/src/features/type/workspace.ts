import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";

export function applyTypography(this: WorkspaceFeatureContext, params: Record<string, unknown>): EditorResult<EditorViewModel> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const blocked = this.blockingDraft();
    if (blocked) return blocked;
    const frozen = this.frozen();
    if (frozen) return frozen;
    const result = handle.applyTypography(params);
    if (!result.ok) return this.fail(result);
    return this.afterWrite();
  }

export function checkFont(this: WorkspaceFeatureContext, font: string): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    return this.handle.checkFont(font);
  }

/**
 * 文字域写命令（U67/U68/U69）。
 *
 * 与其它域一致：先过共享草稿门禁，再调用内核白名单入口；成功后统一 `afterWrite()` 发布
 * 修订/内容状态。内核返回的 `changed: false`（例如纯查找只移动搜索游标，或选区/路径这类
 * 不进内容身份的写入）仍会刷新视图，但不制造新的 dirty 结论 —— 是否 dirty 一律由内容指纹决定。
 */
export function typeCommand(this: WorkspaceFeatureContext, id: string, params: Record<string, unknown> = {}): EditorResult<EditorViewModel> {
    const handle = this.handle;
    if (!handle) return this.unavailable();
    const blocked = this.blockingDraft();
    if (blocked) return blocked;
    // 共享 `EditorHandle` 的方法清单是冻结文件；本域新增入口只经已装配的
    // `handle.features.type`（同一实例、同一错误边界），不扩充兼容 facade。
    const result = handle.features.type.typeCommand(id, params);
    if (!result.ok) return this.fail(result);
    return this.afterWrite();
  }

/** 文字域只读查询：不改文档、不进历史、不发布内容状态。 */
export function typeQuery(this: WorkspaceFeatureContext, id: string, params: Record<string, unknown> = {}): EditorResult<unknown> {
    if (!this.handle) return this.unavailable();
    return this.handle.features.type.typeQuery(id, params);
  }

export function createSession(context: () => WorkspaceFeatureContext) {
  return {
    applyTypography: (...args: Parameters<OmitThisParameter<typeof applyTypography>>) => applyTypography.apply(context(), args),
    checkFont: (...args: Parameters<OmitThisParameter<typeof checkFont>>) => checkFont.apply(context(), args),
    typeCommand: (...args: Parameters<OmitThisParameter<typeof typeCommand>>) => typeCommand.apply(context(), args),
    typeQuery: (...args: Parameters<OmitThisParameter<typeof typeQuery>>) => typeQuery.apply(context(), args),
  };
}
