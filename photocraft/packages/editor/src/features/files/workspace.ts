import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorFailure, EditorResult } from "../../editor-wasm.js";
import type { EditorHandle } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import type { NewDocumentSpec } from "@woohaa3/photocraft-protocol";
import { validateNewDocumentSpec } from "@woohaa3/photocraft-protocol";
import { loadEditor } from "../../editor-wasm.js";
import { planFileWrite } from "./write-gate.js";
import {
  decodeCreateDocumentReport,
  decodeCreateFromImageReport,
  decodeFileInfo,
  decodePresetList,
  decodeRecentList,
  decodeRestoreReport,
  formToFileInfoPatch,
  kernelParamsFromSpec,
  presetParams,
  recentSettingsParams,
  type CreateDocumentReport,
  type CreateFromImageReport,
  type DocumentPresetEntry
} from "./model.js";

/**
 * 本域工作区会话：把内核调用包成 `EditorResult`，失败原因不吞掉
 * （change: 2026-10-22-add-photocraft-file-workflows，U01–U04）。
 *
 * 新建/复制/恢复都要求**没有未结算草稿**：内容写入前必须过共享门禁，不能与进行中的笔迹/
 * 变换/滤镜竞态。新建与「从图片新建」只用于候选实例（一个编辑会话一个文档槽位）。
 */

function failure(code: string, message: string): EditorFailure {
  return { ok: false, code, message };
}

/**
 * 写入前统一门禁（任务 3.3）。
 *
 * 顺序：导出冻结 / 保存中 → 未确认草稿。草稿原因仍由控制器给出（各草稿有各自的文案与 code），
 * 这里只补上「异步产物正在生成」这一类此前**没有**被本域检查的拒绝原因：此前保存进行中
 * 仍可新建/复制/恢复/写元数据，得到的产物可能与画面不一致。
 */
function blockedWrite(this: WorkspaceFeatureContext): EditorFailure | null {
  const planned = planFileWrite({ phase: this.phase, pendingArtifacts: this.pendingArtifacts });
  if (!planned.ok) return failure(planned.code, planned.message);
  return this.blockingDraft();
}

/** 候选实例上的新建：返回内核真实报告，失败保持空会话。 */
export function createDocument(this: WorkspaceFeatureContext, spec: NewDocumentSpec): EditorResult<CreateDocumentReport> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = blockedWrite.call(this);
  if (blocked) return blocked;
  const result = handle.features.files.createDocument(spec);
  if (!result.ok) return this.fail(result);
  const decoded = decodeCreateDocumentReport(result.value);
  if (!decoded.ok) return this.fail(failure("invalid-message", decoded.error));
  // 内核里已经有文档了，工作区视图必须同步：否则画布/状态栏/标签仍停在「未打开文档」，
  // 而内核文档确实存在，下一次任意写入才会突然出现（`dispatch`/`writeFileInfo` 都走 afterWrite）。
  const written = this.afterWrite();
  return written.ok ? { ok: true, value: decoded.value } : this.fail(written);
}

/** 从图片字节建立文档（剪贴板或用户授权读取）。 */
export function createDocumentFromImage(this: WorkspaceFeatureContext, name: string, bytes: Uint8Array): EditorResult<CreateFromImageReport> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return failure("import-failed", "没有可用的图片字节，请重新复制或选择文件");
  }
  const blocked = blockedWrite.call(this);
  if (blocked) return blocked;
  const result = handle.features.files.createDocumentFromImage(name, bytes);
  if (!result.ok) return this.fail(result);
  const decoded = decodeCreateFromImageReport(result.value);
  if (!decoded.ok) return this.fail(failure("invalid-message", decoded.error));
  // 与 `createDocument` 同理：内核已有文档，视图必须同步，否则界面仍显示「未打开文档」。
  const written = this.afterWrite();
  return written.ok ? { ok: true, value: decoded.value } : this.fail(written);
}

/**
 * U01/U02：把一份新建参数或图片字节先在**独立候选实例**上建成自包含工程字节，
 * 供宿主开成独立文档槽位。
 *
 * 为什么需要这一层：一个编辑会话只有一个文档槽位（`require_no_document`）。已有文档时再
 * 「新建」，正确行为是工作区**另开一个文档/标签**，而宿主的打开路径只接受字节
 * （`session.openFile({ bytes, kind })`）。这里在独立的候选实例上建好文档并序列化成
 * `.pcraft`，宿主就能用既有打开/标签路径落地，既不必给本域开第二份文档状态，也不会把
 * 当前文档挤掉。失败时候选实例被丢弃，当前文档完全不受影响。
 *
 * 交付语义：返回的字节是自包含工程（含层树/资源），不是「另存副本」——它对应一个**新**文档。
 */
async function bytesFromCandidate(
  build: (handle: EditorHandle) => EditorResult<{ report: unknown }>
): Promise<EditorResult<{ bytes: Uint8Array; report: unknown }>> {
  const loaded = await loadEditor();
  if (!loaded.ok) return { ok: false, code: loaded.code, message: loaded.message };
  const handle = loaded.value;
  try {
    const built = build(handle);
    if (!built.ok) return built;
    const project = handle.saveProject();
    if (!project.ok) return { ok: false, code: project.code, message: project.message };
    if (!(project.value instanceof Uint8Array) || project.value.length === 0) {
      return failure("invalid-artifacts", "新文档没有可交付的工程字节");
    }
    return { ok: true, value: { bytes: project.value, report: built.value.report } };
  } finally {
    // 候选实例只为产出字节；真正的编辑会话由宿主在新标签里建立。
    try {
      handle.closeDocument();
    } catch {
      // 关闭失败不掩盖已经成功的结果：字节已复制到 JS 侧。
    }
  }
}

/** U01：新建空白文档 → 自包含工程字节（供宿主另开文档/标签）。 */
export async function createDocumentBytes(
  this: WorkspaceFeatureContext,
  spec: NewDocumentSpec
): Promise<EditorResult<{ bytes: Uint8Array; report: CreateDocumentReport }>> {
  const validated = validateNewDocumentSpec(spec);
  if (!validated.ok) return failure("invalid-params", validated.error);
  const produced = await bytesFromCandidate((handle) => {
    const created = handle.features.files.createDocument(kernelParamsFromSpec(validated.value));
    if (!created.ok) return created;
    const decoded = decodeCreateDocumentReport(created.value);
    return decoded.ok ? { ok: true, value: { report: decoded.value } } : failure("invalid-message", decoded.error);
  });
  if (!produced.ok) return produced;
  return { ok: true, value: { bytes: produced.value.bytes, report: produced.value.report as CreateDocumentReport } };
}

/**
 * U02：从用户授权读取的图像字节建立文档 → 自包含工程字节。
 *
 * 与 [`createDocumentBytes`] 同一条管线：图片只在**候选实例**上解码建文档，当前文档与其
 * 撤销栈完全不受影响。此前「从图像新建 / 从剪贴板新建」只走 `createDocumentFromImage`，
 * 已有文档时必被内核的「一个会话一个文档槽位」拒绝——入口看起来可用，实际只能在空会话成立。
 */
export async function createDocumentFromImageBytes(
  this: WorkspaceFeatureContext,
  name: string,
  bytes: Uint8Array
): Promise<EditorResult<{ bytes: Uint8Array; report: CreateFromImageReport }>> {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return failure("import-failed", "没有可用的图片字节，请重新复制或选择文件");
  }
  if (name.length > 255) return failure("invalid-params", "文档名不能超过 255 个字符");
  const produced = await bytesFromCandidate((handle) => {
    const created = handle.features.files.createDocumentFromImage(name, bytes);
    if (!created.ok) return created;
    const decoded = decodeCreateFromImageReport(created.value);
    return decoded.ok ? { ok: true, value: { report: decoded.value } } : failure("invalid-message", decoded.error);
  });
  if (!produced.ok) return produced;
  return { ok: true, value: { bytes: produced.value.bytes, report: produced.value.report as CreateFromImageReport } };
}

/** 整份复制为自包含工程字节：不改原文档内容/基线。 */
export function duplicateDocument(this: WorkspaceFeatureContext, name = ""): EditorResult<Uint8Array> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  if (!this.view.hasDocument) return failure("no-document", "没有可复制的文档");
  const blocked = blockedWrite.call(this);
  if (blocked) return blocked;
  const result = handle.features.files.duplicateDocumentBytes(name);
  return result.ok ? result : this.fail(result);
}

/**
 * 用工作区持有的基线字节恢复当前文档。
 *
 * 调用方必须先声明基线来源（当前会话可信写入的工程字节，或用户重新选择的工程文件）；
 * 没有基线时不要调用——这里无法凭空取得磁盘最新版本。恢复是一步可撤销的编辑步骤。
 */
export function restoreSavedBaseline(this: WorkspaceFeatureContext, bytes: Uint8Array, baseAssetId = ""): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return failure("load-failed", "没有可恢复的保存基线，请重新选择工程文件");
  }
  const blocked = blockedWrite.call(this);
  if (blocked) return blocked;
  const result = handle.features.files.restoreSavedBaseline(bytes, baseAssetId);
  if (!result.ok) return this.fail(result);
  const decoded = decodeRestoreReport(result.value);
  if (!decoded.ok) return this.fail(failure("invalid-message", decoded.error));
  // 恢复后内容等于基线：推进会话基线，净变化清零。
  return this.afterWrite(true);
}

/** File Info 读取（只读，不推进修订/历史）。 */
export function readFileInfo(this: WorkspaceFeatureContext): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  if (!this.view.hasDocument) return failure("no-document", "没有可读取 File Info 的文档");
  const result = handle.features.files.fileInfo(null);
  if (!result.ok) return this.fail(result);
  const decoded = decodeFileInfo(result.value);
  return decoded.ok ? { ok: true, value: decoded.value } : this.fail(failure("invalid-message", decoded.error));
}

/** File Info 写入：一步可撤销。 */
export function writeFileInfo(this: WorkspaceFeatureContext, form: Record<string, string>): EditorResult<EditorViewModel> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  if (!this.view.hasDocument) return failure("no-document", "没有可写入 File Info 的文档");
  const blocked = blockedWrite.call(this);
  if (blocked) return blocked;
  const patch = formToFileInfoPatch(form);
  if (!patch.ok) return failure("command-failed", patch.error);
  const result = handle.features.files.fileInfo(patch.value);
  if (!result.ok) return this.fail(result);
  const decoded = decodeFileInfo(result.value);
  if (!decoded.ok) return this.fail(failure("invalid-message", decoded.error));
  return this.afterWrite();
}

/** 预设列表（只读）。 */
export function listDocumentPresets(this: WorkspaceFeatureContext): EditorResult<readonly DocumentPresetEntry[]> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const result = handle.features.files.documentPresets("list");
  if (!result.ok) return this.fail(result);
  const decoded = decodePresetList(result.value);
  return decoded.ok ? { ok: true, value: decoded.value } : this.fail(failure("invalid-message", decoded.error));
}

/** 保存预设（名称唯一、设置经共享上限校验）。 */
export function saveDocumentPreset(this: WorkspaceFeatureContext, name: string, spec: NewDocumentSpec): EditorResult<readonly DocumentPresetEntry[]> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const result = handle.features.files.documentPresets("save", { name, settings: presetParams(spec) });
  if (!result.ok) return this.fail(result);
  return listDocumentPresets.call(this);
}

/** 删除预设。 */
export function deleteDocumentPreset(this: WorkspaceFeatureContext, name: string): EditorResult<readonly DocumentPresetEntry[]> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const result = handle.features.files.documentPresets("delete", { name });
  if (!result.ok) return this.fail(result);
  return listDocumentPresets.call(this);
}

/** 最近的新建设置。 */
export function recentDocuments(this: WorkspaceFeatureContext): EditorResult<readonly NewDocumentSpec[]> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const result = handle.features.files.recentDocuments();
  if (!result.ok) return this.fail(result);
  const decoded = decodeRecentList(result.value);
  return decoded.ok ? { ok: true, value: decoded.value } : this.fail(failure("invalid-message", decoded.error));
}

/** 记录一次新建设置（簿记：不进入文档内容，也不制造未保存变化）。 */
export function recordRecentDocument(this: WorkspaceFeatureContext, spec: NewDocumentSpec): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const result = handle.features.files.recordRecentDocument(recentSettingsParams(spec));
  return result.ok ? result : this.fail(result);
}

export function createSession(context: () => WorkspaceFeatureContext) {
  return {
    createDocument: (...args: Parameters<OmitThisParameter<typeof createDocument>>) => createDocument.apply(context(), args),
    createDocumentBytes: (...args: Parameters<OmitThisParameter<typeof createDocumentBytes>>) => createDocumentBytes.apply(context(), args),
    createDocumentFromImage: (...args: Parameters<OmitThisParameter<typeof createDocumentFromImage>>) => createDocumentFromImage.apply(context(), args),
    createDocumentFromImageBytes: (...args: Parameters<OmitThisParameter<typeof createDocumentFromImageBytes>>) => createDocumentFromImageBytes.apply(context(), args),
    duplicateDocument: (...args: Parameters<OmitThisParameter<typeof duplicateDocument>>) => duplicateDocument.apply(context(), args),
    restoreSavedBaseline: (...args: Parameters<OmitThisParameter<typeof restoreSavedBaseline>>) => restoreSavedBaseline.apply(context(), args),
    readFileInfo: (...args: Parameters<OmitThisParameter<typeof readFileInfo>>) => readFileInfo.apply(context(), args),
    writeFileInfo: (...args: Parameters<OmitThisParameter<typeof writeFileInfo>>) => writeFileInfo.apply(context(), args),
    listDocumentPresets: (...args: Parameters<OmitThisParameter<typeof listDocumentPresets>>) => listDocumentPresets.apply(context(), args),
    saveDocumentPreset: (...args: Parameters<OmitThisParameter<typeof saveDocumentPreset>>) => saveDocumentPreset.apply(context(), args),
    deleteDocumentPreset: (...args: Parameters<OmitThisParameter<typeof deleteDocumentPreset>>) => deleteDocumentPreset.apply(context(), args),
    recentDocuments: (...args: Parameters<OmitThisParameter<typeof recentDocuments>>) => recentDocuments.apply(context(), args),
    recordRecentDocument: (...args: Parameters<OmitThisParameter<typeof recordRecentDocument>>) => recordRecentDocument.apply(context(), args)
  };
}
