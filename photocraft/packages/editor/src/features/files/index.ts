import { sections } from "./sections.js";
import { DocumentCopyPanel, DocumentPresetsPanel, FileInfoPanel, NewDocumentPanel, NewDocumentWorkspace } from "./panels.js";

/**
 * 本域装配（change: 2026-10-22-add-photocraft-file-workflows）。
 *
 * 工具为空：本域只提供文件级操作，不新增画布手势工具。面板导出给宿主装配复用
 * （例如在文件菜单或弹层中挂载同一实现），不在域内复制第二份语义。
 */
export const feature = {
  id: "files",
  tools: [],
  sections,
  panels: { DocumentCopyPanel, DocumentPresetsPanel, FileInfoPanel, NewDocumentPanel, NewDocumentWorkspace }
} as const;

/** U02：剪贴板图像读取（宿主可注入自己的受控实现，语义与面板一致）。 */
export { readClipboardImage } from "./clipboard.js";
export type { ClipboardHost, ClipboardImageResult, ClipboardFailureReason } from "./clipboard.js";

/** U02/U03：工程字节的本地交付与副本文件名（浏览器降级实现）。 */
export { downloadBytes, projectFileName } from "./download.js";

/** U04：写入前门禁与请求序号（纯规则；宿主与面板共用同一份判断）。 */
export { RequestSequence, planFileWrite } from "./write-gate.js";
export type { FileWriteBlockCode, FileWriteFacts, FileWritePlan } from "./write-gate.js";

/** U04：导出预设消费端口（实现与存储属 `features/io/`，本域只消费入口）。 */
export { EXPORT_PRESET_UNAVAILABLE, exportPresetFormat, normalizeExportPresetSnapshot, resolveExportPresetPort } from "./export-bridge.js";
export type { ExportPresetEntry, ExportPresetPort, ExportPresetSnapshot } from "./export-bridge.js";
