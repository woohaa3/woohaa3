import type { FeatureHandleContext } from "../contracts.js";
import { editorPhase } from "../../ports.js";
import { type EditorResult } from "../../editor-wasm.js";

export function openImage(this: FeatureHandleContext, name: string, assetId: string, bytes: Uint8Array): EditorResult<unknown> {
  return editorPhase("image-editor.open-image", () => this.call((i) => i.openImage(name, assetId, bytes)));
}

export function openProject(this: FeatureHandleContext, bytes: Uint8Array, baseAssetId: string): EditorResult<unknown> {
  return editorPhase("image-editor.open-project", () => this.call((i) => i.openProject(bytes, baseAssetId)));
}

export function hasDocument(this: FeatureHandleContext): boolean {
  return this.instance.hasDocument();
}

export function closeDocument(this: FeatureHandleContext): EditorResult<unknown> {
  return editorPhase("image-editor.close-document", () => this.call((i) => JSON.parse(i.closeDocument())));
}

/** U01：在空会话上新建空白文档；参数与内核 `file.new` 同形。 */
export function createDocument(this: FeatureHandleContext, params: unknown): EditorResult<unknown> {
  return editorPhase("image-editor.create-document", () => this.call((i) => JSON.parse(i.createDocument(JSON.stringify(params)))));
}

/** U02：用用户授权读取的图片字节建立文档（空会话）。 */
export function createDocumentFromImage(this: FeatureHandleContext, name: string, bytes: Uint8Array): EditorResult<unknown> {
  return editorPhase("image-editor.create-document-from-image", () => this.call((i) => JSON.parse(i.createDocumentFromImage(name, bytes))));
}

/** U02：整份复制为自包含 `.pcraft` 字节（不改变原文基线）。 */
export function duplicateDocumentBytes(this: FeatureHandleContext, name = ""): EditorResult<Uint8Array> {
  return editorPhase("image-editor.duplicate-document", () => this.call((i) => i.duplicateDocumentBytes(name)));
}

/** U03：用工作区持有的基线字节恢复当前文档（一步可撤销）。 */
export function restoreSavedBaseline(this: FeatureHandleContext, bytes: Uint8Array, baseAssetId = ""): EditorResult<unknown> {
  return editorPhase("image-editor.restore-baseline", () => this.call((i) => JSON.parse(i.restoreSavedBaseline(bytes, baseAssetId))));
}

/** U04：File Info；无写入字段时只读。 */
export function fileInfo(this: FeatureHandleContext, params: unknown = null): EditorResult<unknown> {
  return editorPhase("image-editor.file-info", () => this.call((i) => JSON.parse(i.fileInfo(JSON.stringify(params ?? null)))));
}

/** U04：新建预设（`list` / `save` / `delete`）。 */
export function documentPresets(this: FeatureHandleContext, action: "list" | "save" | "delete", params: unknown = null): EditorResult<unknown> {
  return editorPhase("image-editor.document-presets", () => this.call((i) => JSON.parse(i.documentPresets(action, JSON.stringify(params ?? null)))));
}

/** U04：最近的新建设置（最新在前）。 */
export function recentDocuments(this: FeatureHandleContext): EditorResult<unknown> {
  return editorPhase("image-editor.recent-documents", () => this.call((i) => JSON.parse(i.recentDocuments())));
}

/** U04：记录一次新建设置（去重、最新在前、有界）。 */
export function recordRecentDocument(this: FeatureHandleContext, settings: unknown): EditorResult<unknown> {
  return editorPhase("image-editor.record-recent-document", () => this.call((i) => JSON.parse(i.recordRecentDocument(JSON.stringify(settings)))));
}

export function createHandle(context: () => FeatureHandleContext) {
  return {
    openImage: (...args: Parameters<OmitThisParameter<typeof openImage>>) => openImage.apply(context(), args),
    openProject: (...args: Parameters<OmitThisParameter<typeof openProject>>) => openProject.apply(context(), args),
    hasDocument: (...args: Parameters<OmitThisParameter<typeof hasDocument>>) => hasDocument.apply(context(), args),
    closeDocument: (...args: Parameters<OmitThisParameter<typeof closeDocument>>) => closeDocument.apply(context(), args),
    createDocument: (...args: Parameters<OmitThisParameter<typeof createDocument>>) => createDocument.apply(context(), args),
    createDocumentFromImage: (...args: Parameters<OmitThisParameter<typeof createDocumentFromImage>>) => createDocumentFromImage.apply(context(), args),
    duplicateDocumentBytes: (...args: Parameters<OmitThisParameter<typeof duplicateDocumentBytes>>) => duplicateDocumentBytes.apply(context(), args),
    restoreSavedBaseline: (...args: Parameters<OmitThisParameter<typeof restoreSavedBaseline>>) => restoreSavedBaseline.apply(context(), args),
    fileInfo: (...args: Parameters<OmitThisParameter<typeof fileInfo>>) => fileInfo.apply(context(), args),
    documentPresets: (...args: Parameters<OmitThisParameter<typeof documentPresets>>) => documentPresets.apply(context(), args),
    recentDocuments: (...args: Parameters<OmitThisParameter<typeof recentDocuments>>) => recentDocuments.apply(context(), args),
    recordRecentDocument: (...args: Parameters<OmitThisParameter<typeof recordRecentDocument>>) => recordRecentDocument.apply(context(), args)
  };
}
