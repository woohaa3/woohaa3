/**
 * 栅格交换域的工作区会话（change: 2026-10-22-add-photocraft-raster-interchange）。
 *
 * 职责：把界面意图翻成内核调用，并**在域内**完成三件共享层不做的事：
 * 1. 草稿门禁（有笔迹/工具草稿时拒绝交付半成品）；
 * 2. 报告解码（内核报告是不可信 JSON，必须是本域认可的形状）；
 * 3. 交付汇总（文件名、MIME、字节数），交给调用方的下载/宿主端口。
 *
 * 明确不做：
 * - **不**替换文档：打开走共享 `openImage`/`openProject` 管线（见 `inspectOpenRaster` 的说明），
 *   否则会绕过视图发布与保存基线；
 * - **不**改动 `Editor` 文档：导出/预览/逐层/资产都是只读快照，返回值声明 `documentChanged: false`；
 * - **不**推进保存基线：交付成功都不等于工程已保存。
 */
import type { EditorResult } from "../../editor-wasm.js";
import { ExportPresetStore } from "./export-presets.js";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { AssetReport, BundleInspection, ExportReport, LayerBundleReport } from "@woohaa3/photocraft-protocol";
import {
  decodeAssetReport,
  decodeBundleInspection,
  decodeExportReport,
  decodeLayerBundleReport,
  deliveryFileName,
  normalizeExportSettings,
  type ExportSettings
} from "@woohaa3/photocraft-protocol";

/** 一次交付的字节 + 类型 + 建议文件名（落盘由调用方负责）。 */
export type InterchangeDelivery<TReport> = {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
  report: TReport;
};

const failure = (code: string, message: string): { ok: false; code: string; message: string } => ({ ok: false, code, message });

/**
 * 内核报告是文本：解析失败也必须变成可报告的失败，而不是抛异常打断调用方。
 * （`JSON.parse` 直接抛会让面板的 `if (!result.ok)` 分支失效。）
 */
function parseReport(text: string): { ok: true; value: unknown } | { ok: false; code: string; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return failure("invalid-report", "内核报告不是合法 JSON");
  }
}

/** 草稿门禁：与共享层同一句提示，避免两个入口给出不同理由。 */
function draftBlocked(context: WorkspaceFeatureContext): { ok: false; code: string; message: string } | null {
  if (!context.hasActiveDraft()) return null;
  const blocking = context.blockingDraft();
  if (blocking && !blocking.ok) return blocking;
  return failure("gesture-active", "请先结算当前草稿再导出");
}

function documentName(context: WorkspaceFeatureContext): string {
  return context.view.document?.name ?? "未命名";
}

/** 解析并校验导出设置（客户端能判定的部分），不猜测内核能力。 */
export function normalizeSettings(settings: unknown): EditorResult<ExportSettings> {
  const normalized = normalizeExportSettings(settings);
  if (!normalized.ok) return failure("invalid-export-settings", normalized.message);
  return { ok: true, value: normalized.value };
}

/** 逐格式矩阵（真实构建）。 */
export function matrix(this: WorkspaceFeatureContext): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.io.interchangeMatrix();
}

/** 通用导出矩阵（可写格式与参数集合）。 */
export function exportOptions(this: WorkspaceFeatureContext): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  return handle.features.io.exportMatrix();
}

/**
 * 打开前的准入结论（预检）。
 *
 * 真正的打开**必须**走共享 `EditorWorkspaceController.openImage`：它负责发布视图、建立基线与
 * 只读来源判定。本域不提供「自己替换文档」的捷径 —— 那会绕过视图与保存基线。因此这里只返回
 * 预检结论与是否可打开；调用方拿到 `ok` 后使用共享打开。
 */
export function inspectOpenRaster(this: WorkspaceFeatureContext, bytes: Uint8Array): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  if (bytes.length === 0) return failure("import-failed", "文件为空");
  const inspection = handle.features.io.inspectRaster(bytes);
  if (!inspection.ok) return inspection;
  const value = inspection.value as Record<string, unknown>;
  return { ok: true, value: { ...value, openable: value.status === "open" || value.status === "read-only" } };
}

/**
 * 宿主文件选择器的 `accept` 值（U05 的「必要公共端口」）。
 *
 * 宿主（dev / Woohaa）不该各自写死 `image/png,image/jpeg,image/webp`：那会把本 change 新开放的
 * 格式挡在选择器外，而内核其实能解码。这里从**同一份内核矩阵**派生出可打开的扩展名与 MIME，
 * 因此新增/暂缓格式只在矩阵里改一次，两个宿主自然同步。
 *
 * 返回 `accept`（供 `<input accept>`）与 `extensions`（供拖放判定），都不含 `.pcraft`：
 * 工程打开是另一条共享管线，不能和栅格打开混在同一个 accept 里。
 */
export function openAccept(this: WorkspaceFeatureContext): EditorResult<{
  accept: string;
  extensions: string[];
  mimes: string[];
}> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const matrix = handle.features.io.interchangeMatrix();
  if (!matrix.ok) return matrix;
  const value = matrix.value as Record<string, unknown>;
  if (!Array.isArray(value.formats)) return failure("invalid-matrix", "内核矩阵缺少 formats");
  const extensions: string[] = [];
  const mimes: string[] = [];
  for (const row of value.formats) {
    if (typeof row !== "object" || row === null) continue;
    const entry = row as Record<string, unknown>;
    // 只列真正可打开的格式：暂缓项放进 accept 只会让用户选中后立刻被拒绝。
    if (entry.status !== "open" && entry.status !== "read-only") continue;
    if (Array.isArray(entry.extensions)) {
      for (const extension of entry.extensions) {
        if (typeof extension === "string" && extension.length > 0 && !extensions.includes(extension)) extensions.push(extension);
      }
    }
    if (typeof entry.mime === "string" && entry.mime.length > 0 && !mimes.includes(entry.mime)) mimes.push(entry.mime);
  }
  // 空结论不能伪装成「全都不支持」以外的意思：让调用方显式看到矩阵没有可用行。
  if (extensions.length === 0) return failure("invalid-matrix", "内核矩阵没有可打开的格式");
  return {
    ok: true,
    value: {
      accept: [...mimes, ...extensions.map((extension) => `.${extension}`)].join(","),
      extensions,
      mimes
    }
  };
}

/** 导出/预览共用：草稿门禁 → 设置校验 → 内核编码 → 报告解码。 */
function encode(
  context: WorkspaceFeatureContext,
  settings: unknown,
  mode: "preview" | "deliver"
): EditorResult<InterchangeDelivery<ExportReport>> {
  const handle = context.handle;
  if (!handle) return context.unavailable();
  const blocked = draftBlocked(context);
  if (blocked) return blocked;
  const normalized = normalizeSettings(settings);
  if (!normalized.ok) return normalized;
  const encoded = mode === "preview"
    ? handle.features.io.previewExport(normalized.value)
    : handle.features.io.exportRaster(normalized.value);
  if (!encoded.ok) return encoded;
  const parsed = parseReport(encoded.value.reportJson);
  if (!parsed.ok) return parsed;
  const report = decodeExportReport(parsed.value);
  if (!report.ok) return failure("invalid-export-report", report.message);
  return {
    ok: true,
    value: {
      fileName: deliveryFileName(documentName(context), report.value.format),
      contentType: typeof report.value.mime === "string" ? report.value.mime : "application/octet-stream",
      bytes: encoded.value.bytes,
      report: report.value
    }
  };
}

/** 真实编码预览：字节就是交付字节，可直接显示。 */
export function previewExport(this: WorkspaceFeatureContext, settings: unknown): EditorResult<InterchangeDelivery<ExportReport>> {
  return encode(this, settings, "preview");
}

/**
 * 导出预检（不编码）：归一化后的设置、目标尺寸与格式能力。
 *
 * 供不想立刻编码的调用方使用（面板显示目标尺寸、宿主先校验再问用户）；与
 * `previewExport` / `exportRaster` 走同一份 `parse_settings`，因此预检通过就一定能编码。
 */
export function inspectExport(this: WorkspaceFeatureContext, settings: unknown): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = draftBlocked(this);
  if (blocked) return blocked;
  const normalized = normalizeSettings(settings);
  if (!normalized.ok) return normalized;
  return handle.features.io.inspectExport(normalized.value);
}

/** 导出交付（不推进保存基线）。 */
export function exportRaster(this: WorkspaceFeatureContext, settings: unknown): EditorResult<InterchangeDelivery<ExportReport>> {
  return encode(this, settings, "deliver");
}

/** 逐层导出计划（不编码）。 */
export function inspectLayerExport(this: WorkspaceFeatureContext, params: unknown = {}): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = draftBlocked(this);
  if (blocked) return blocked;
  return handle.features.io.inspectLayerExport(params);
}

/** 逐层 / Layers to Files 交付（内存 ZIP + report.json）。 */
export function exportLayerBundle(this: WorkspaceFeatureContext, params: unknown = {}): EditorResult<InterchangeDelivery<LayerBundleReport>> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = draftBlocked(this);
  if (blocked) return blocked;
  const encoded = handle.features.io.exportLayerBundle(params);
  if (!encoded.ok) return encoded;
  const parsed = parseReport(encoded.value.reportJson);
  if (!parsed.ok) return parsed;
  const report = decodeLayerBundleReport(parsed.value);
  if (!report.ok) return failure("invalid-report", report.message);
  return {
    ok: true,
    value: {
      fileName: deliveryFileName(`${documentName(this)}-图层`, "zip"),
      contentType: "application/zip",
      bytes: encoded.value.bytes,
      report: report.value
    }
  };
}

/** 单层 Quick Export / Export As（缺省 PNG）。 */
export function exportLayerAs(this: WorkspaceFeatureContext, params: unknown = {}): EditorResult<InterchangeDelivery<ExportReport>> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = draftBlocked(this);
  if (blocked) return blocked;
  const encoded = handle.features.io.exportLayerAs(params);
  if (!encoded.ok) return encoded;
  const parsed = parseReport(encoded.value.reportJson);
  if (!parsed.ok) return parsed;
  const report = decodeExportReport(parsed.value);
  if (!report.ok) return failure("invalid-export-report", report.message);
  const suffix = report.value.layerName ? `-${report.value.layerName}` : "";
  return {
    ok: true,
    value: {
      fileName: deliveryFileName(`${documentName(this)}${suffix}`, report.value.format),
      contentType: typeof report.value.mime === "string" ? report.value.mime : "application/octet-stream",
      bytes: encoded.value.bytes,
      report: report.value
    }
  };
}

/** 按名称资产计划（不编码）。 */
export function inspectImageAssets(this: WorkspaceFeatureContext): EditorResult<unknown> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = draftBlocked(this);
  if (blocked) return blocked;
  return handle.features.io.inspectImageAssets();
}

/** 按名称资产交付（内存 ZIP）。 */
export function exportImageAssets(this: WorkspaceFeatureContext): EditorResult<InterchangeDelivery<AssetReport>> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  const blocked = draftBlocked(this);
  if (blocked) return blocked;
  const encoded = handle.features.io.exportImageAssets();
  if (!encoded.ok) return encoded;
  const parsed = parseReport(encoded.value.reportJson);
  if (!parsed.ok) return parsed;
  const report = decodeAssetReport(parsed.value);
  if (!report.ok) return failure("invalid-report", report.message);
  return {
    ok: true,
    value: {
      fileName: deliveryFileName(`${documentName(this)}-assets`, "zip"),
      contentType: "application/zip",
      bytes: encoded.value.bytes,
      report: report.value
    }
  };
}

/** 复核一个已交付的包。 */
export function inspectBundle(this: WorkspaceFeatureContext, bytes: Uint8Array): EditorResult<BundleInspection> {
  const handle = this.handle;
  if (!handle) return this.unavailable();
  if (bytes.length === 0) return failure("invalid-bundle", "包为空");
  const raw = handle.features.io.inspectIoBundle(bytes);
  if (!raw.ok) return raw;
  const inspection = decodeBundleInspection(raw.value);
  if (!inspection.ok) return failure("invalid-bundle", inspection.message);
  return { ok: true, value: inspection.value };
}

export function createSession(context: () => WorkspaceFeatureContext) {
  return {
    // 文件域只消费此端口；设置的预算、校验与持久化仍由 io 唯一持有。
    exportPresets: () => new ExportPresetStore().all(),
    saveExportPreset: (name: string, settings: unknown) => {
      const decoded = normalizeExportSettings(settings);
      if (!decoded.ok) return { ok: false as const, reason: decoded.message };
      const store = new ExportPresetStore();
      const saved = store.save(name, decoded.value);
      return saved && !store.lastError ? { ok: true as const } : { ok: false as const, reason: store.lastError ?? "保存导出预设失败" };
    },
    removeExportPreset: (name: string) => {
      const store = new ExportPresetStore();
      const removed = store.remove(name);
      return removed && !store.lastError ? { ok: true as const } : { ok: false as const, reason: store.lastError ?? "内置预设不能删除" };
    },
    matrix: (...args: Parameters<OmitThisParameter<typeof matrix>>) => matrix.apply(context(), args),
    exportOptions: (...args: Parameters<OmitThisParameter<typeof exportOptions>>) => exportOptions.apply(context(), args),
    openAccept: (...args: Parameters<OmitThisParameter<typeof openAccept>>) => openAccept.apply(context(), args),
    inspectOpenRaster: (...args: Parameters<OmitThisParameter<typeof inspectOpenRaster>>) => inspectOpenRaster.apply(context(), args),
    inspectExport: (...args: Parameters<OmitThisParameter<typeof inspectExport>>) => inspectExport.apply(context(), args),
    previewExport: (...args: Parameters<OmitThisParameter<typeof previewExport>>) => previewExport.apply(context(), args),
    exportRaster: (...args: Parameters<OmitThisParameter<typeof exportRaster>>) => exportRaster.apply(context(), args),
    inspectLayerExport: (...args: Parameters<OmitThisParameter<typeof inspectLayerExport>>) => inspectLayerExport.apply(context(), args),
    exportLayerBundle: (...args: Parameters<OmitThisParameter<typeof exportLayerBundle>>) => exportLayerBundle.apply(context(), args),
    exportLayerAs: (...args: Parameters<OmitThisParameter<typeof exportLayerAs>>) => exportLayerAs.apply(context(), args),
    inspectImageAssets: (...args: Parameters<OmitThisParameter<typeof inspectImageAssets>>) => inspectImageAssets.apply(context(), args),
    exportImageAssets: (...args: Parameters<OmitThisParameter<typeof exportImageAssets>>) => exportImageAssets.apply(context(), args),
    inspectBundle: (...args: Parameters<OmitThisParameter<typeof inspectBundle>>) => inspectBundle.apply(context(), args),
  };
}
