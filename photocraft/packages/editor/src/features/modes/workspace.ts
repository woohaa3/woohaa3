import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorResult } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import type {
  ImageModeInfo,
  ImageModePlan,
  ImageModePlanOwner,
  ImageModeTarget,
  ModeParams
} from "./mode-data.js";

/**
 * 本域工作区会话：只做门禁与归属，不复制文档/历史
 * （change: 2026-10-22-add-photocraft-image-mode-workflows，design D1/D3、任务 3.3）。
 *
 * 模式转换是「计划 → 应用」：计划在独立会话里算好候选与预览，正式文档不动；应用时把计划里的
 * `baseRevision`/`baseContentHash` 传回内核，内核重算并核对基线，不一致即拒绝。因此本域不需要
 * 新增自己的草稿字段：未结算的候选只活在面板状态里，不构成共享 `blockingDraft()` 的一种。
 *
 * 归属有三层，缺一层就有一种真实可复现的错配：
 *
 * 1. **修订**——同一文档的后续编辑；
 * 2. **内容指纹**——切到另一份修订号相同的文档（两份新文档都可能是修订 1）；
 * 3. **文档代际**——关闭后重开同一节点、或权威内容被替换：新文档又可能是修订 1、内容指纹也
 *    相同，数值上完全匹配，旧计划却来自已销毁的会话。代际由宿主持有并在重建时递增。
 *
 * 另外两条与保存生命周期绑定的门禁：
 *
 * - 冻结/保存进行中不接受任何新的内容修改（否则会把「正在冻结的修订」写脏）；
 * - `blockingDraft()` 里有任何未结算草稿（笔迹、文字、变换、滤镜、构图…）时先拒绝，
 *   因为模式转换会替换整个文档，不能与半笔草稿交错。
 */

/** 计划附带归属后的内部类型。 */
type OwnedPlan = ImageModePlan & { owner: ImageModePlanOwner };

function guard(context: WorkspaceFeatureContext): EditorResult<never> | null {
  if (!context.handle) return context.unavailable();
  // 冻结/保存进行中：此时文档正在被序列化，任何写入都会让「已冻结的修订」与内容不一致。
  if (context.saving) {
    return { ok: false, code: "frozen", message: "正在保存，请等待保存完成后再修改图像模式" };
  }
  // 其他工具的草稿必须先结算：模式转换会替换整个文档，不能与半笔草稿交错。
  const blocking = context.blockingDraft();
  if (blocking) return { ok: false, code: blocking.code, message: blocking.message };
  if (context.hasActiveDraft()) return { ok: false, code: "gesture-active", message: "请先结算当前草稿再修改图像模式" };
  return null;
}

/**
 * 当前文档的内容指纹。
 *
 * 只靠修订号认不出「切到另一份修订号相同的文档」：两份新文档都可能是修订 1。因此计划的基线与
 * 当前指纹必须同时对上，旧计划才不会把另一份文档的结果展示成当前文档的结果（应用侧内核还会
 * 再核对一次，这里只负责尽早给出可读的过期提示）。
 */
function currentContentHash(context: WorkspaceFeatureContext): string | null {
  const result = context.handle?.contentHash();
  return result?.ok ? result.value : null;
}

/** 计划是否属于当前文档：代际 → 修订 → 内容指纹，逐层收紧。 */
function baselineIsCurrent(context: WorkspaceFeatureContext, plan: ImageModePlan): boolean {
  const owner = context.owner;
  // 代际不一致：计划来自已销毁/已替换的文档。即使修订与指纹碰巧相同也必须拒绝。
  if (plan.owner && plan.owner.generation !== owner.generation) return false;
  if (plan.owner && plan.owner.documentId !== owner.documentId) return false;
  const document = context.view.document;
  if (!document || plan.baseRevision !== document.revision) return false;
  const hash = currentContentHash(context);
  return hash === null || plan.baseContentHash === hash;
}

/** 给计划盖上当前文档归属；确认时据此判定它是否仍然有效。 */
function own(context: WorkspaceFeatureContext, plan: ImageModePlan): OwnedPlan {
  return { ...plan, owner: { documentId: context.owner.documentId, generation: context.owner.generation } };
}

export function modeInfo(this: WorkspaceFeatureContext): EditorResult<ImageModeInfo> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.modes.modeInfo();
}

export function planMode(this: WorkspaceFeatureContext, target: ImageModeTarget, params: ModeParams = {}): EditorResult<ImageModePlan> {
  const blocked = guard(this);
  if (blocked) return blocked;
  const document = this.view.document;
  if (!document) return this.unavailable();
  const result = this.handle?.features.modes.planMode(target, { ...params, maxSide: 256 });
  if (!result || !result.ok) return result ?? this.unavailable();
  // 计划的基线必须就是当前文档的修订与内容；否则说明刷新期间文档已经变化或换了文档。
  if (!baselineIsCurrent(this, result.value)) {
    return { ok: false, code: "stale", message: "文档已变化，请重新预览" };
  }
  return { ok: true, value: own(this, result.value) };
}

export function applyMode(this: WorkspaceFeatureContext, target: ImageModeTarget, plan: ImageModePlan, params: ModeParams = {}): EditorResult<EditorViewModel> {
  const blocked = guard(this);
  if (blocked) return blocked;
  const handle = this.handle;
  if (!handle) return this.unavailable();
  if (!plan.changed) return { ok: false, code: "no-change", message: "这次转换没有变化，不需要提交" };
  // 晚到的计划：切文档、重开同一节点或修订前进之后都不能再提交（内核应用时还会再核一次）。
  if (!baselineIsCurrent(this, plan)) {
    return { ok: false, code: "stale", message: "文档已变化，请重新预览后再确认" };
  }
  const result = handle.features.modes.applyMode(target, {
    ...params,
    baseRevision: plan.baseRevision,
    baseContentHash: plan.baseContentHash
  });
  if (!result.ok) return result;
  return this.afterWrite();
}

export function planColorTable(this: WorkspaceFeatureContext, params: ModeParams = {}): EditorResult<ImageModePlan> {
  const blocked = guard(this);
  if (blocked) return blocked;
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const result = handle.features.modes.planColorTable({ ...params, maxSide: 256 });
  if (!result.ok) return result;
  if (!baselineIsCurrent(this, result.value)) {
    return { ok: false, code: "stale", message: "文档已变化，请重新预览颜色表" };
  }
  return { ok: true, value: own(this, result.value) };
}

export function applyColorTable(this: WorkspaceFeatureContext, plan: ImageModePlan, params: ModeParams = {}): EditorResult<EditorViewModel> {
  const blocked = guard(this);
  if (blocked) return blocked;
  const handle = this.handle;
  if (!handle) return this.unavailable();
  if (!plan.changed) return { ok: false, code: "no-change", message: "颜色表没有变化，不需要提交" };
  if (!baselineIsCurrent(this, plan)) {
    return { ok: false, code: "stale", message: "文档已变化，请重新预览后再确认" };
  }
  const result = handle.features.modes.applyColorTable({
    ...params,
    baseRevision: plan.baseRevision,
    baseContentHash: plan.baseContentHash
  });
  if (!result.ok) return result;
  return this.afterWrite();
}

export function createSession(context: () => WorkspaceFeatureContext) {
  return {
    modeInfo: (...args: Parameters<OmitThisParameter<typeof modeInfo>>) => modeInfo.apply(context(), args),
    planMode: (...args: Parameters<OmitThisParameter<typeof planMode>>) => planMode.apply(context(), args),
    applyMode: (...args: Parameters<OmitThisParameter<typeof applyMode>>) => applyMode.apply(context(), args),
    planColorTable: (...args: Parameters<OmitThisParameter<typeof planColorTable>>) => planColorTable.apply(context(), args),
    applyColorTable: (...args: Parameters<OmitThisParameter<typeof applyColorTable>>) => applyColorTable.apply(context(), args),
  };
}
