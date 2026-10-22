/**
 * `@woohaa3/photocraft-woohaa` 公共入口
 * （change: 2026-10-21-extract-photocraft-subproject，design D3/D8；
 *   change: 2026-10-21-add-photocraft-document-workspace，design D1/D3/D8：多文档工作区的注册表、
 *   文件文档呈现、交付端口与关闭结算都在适配包内）。
 *
 * 宿主（`web/frontend`）只从这里装配图片编辑：插件注册、聚焦工作区、工程面板、旧标注转换、
 * 保存回执与多文档工作区都在适配包内；核心编辑器与协议经包依赖引用，不反向读取宿主私有源码。
 */
export { IMAGE_EDITOR_PLUGIN_ID, imageEditorExtension } from "./image-editor-plugin.js";
export type { ImageEditorPluginOptions } from "./image-editor-plugin.js";
export { ProjectEditorPane } from "./project-editor-pane.js";
export type { ProjectEditorPaneProps, ProjectEditorPort } from "./project-editor-pane.js";
export { EditorWorkspaceController } from "./editor-workspace.js";
export type { EditorWorkspaceOptions, SaveInput } from "./editor-workspace.js";
export { ProjectSession } from "./project-session.js";
export type { ProjectSessionInput, ProjectSessionPhase } from "./project-session.js";
export { ImageFocusWorkspace } from "./workspace.js";
export type { ImageWorkspaceOptions } from "./workspace.js";
export { ImageFocusSession } from "./focus-session.js";
export { resolveImageFocusTarget } from "./workspace-target.js";
export type { ImageFocusTarget } from "./workspace-target.js";
export { createImageFocusLoader } from "./loader.js";
export { saveImageProject, buildProjectDocument } from "./project-save.js";
export type {
  ProjectSaveAttempt,
  ProjectSaveDeps,
  ProjectSaveErrorCode,
  ProjectSaveInput,
  ProjectSaveOutcome,
  UploadedObject
} from "./project-save.js";
export { settleProjectReceipt } from "./project-receipt.js";
export type { ProjectReceiptPort } from "./project-receipt.js";
export { annotationAssetId, rasterizeAnnotation } from "./annotation-raster.js";
export type { RasterizableAnnotation } from "./annotation-raster.js";
export { imageEditRequestId, imageEditSessionId } from "./save.js";

// --- 多文档工作区（change: 2026-10-21-add-photocraft-document-workspace） -------------
export { DocumentWorkspaceSession, pendingDraftOf, viewOf, projectDocumentOf, resolveNodeDocumentTarget } from "./document-session.js";
export type { DocumentResource, DocumentWorkspaceDeps, DocumentOpenOutcome, DocumentCloseOutcome, OpenNodeInput, OpenFileInput } from "./document-session.js";
export { FileDocumentWorkspace } from "./file-document-workspace.js";
export type { FileDocumentInput, FileDocumentKind } from "./file-document-workspace.js";
export type { EditorDocumentView, DocumentFocusView, DocumentRect, DocumentDirtyState } from "./document-view.js";
export { DocumentWorkspaceStore, INITIAL_WORKSPACE_UI } from "./workspace-store.js";
export type { WorkspaceUiState } from "./workspace-store.js";
export { DocumentTabs } from "./document-tabs.js";
export type { DocumentTabsProps } from "./document-tabs.js";
export { FileDocumentActionsBar, DocumentPreviewCanvas } from "./file-document-surface.js";
export type { FileDocumentActions, FileDocumentActionsBarProps } from "./file-document-surface.js";
export {
  planCloseDocument,
  planLeave,
  settleSerially,
  settlementItemOf
} from "./document-close.js";
export type {
  ClosePlan,
  DocumentSettlementItem,
  LeavePlan,
  SettlementDecision,
  SettlementOutcome
} from "./document-close.js";
export { settleDocument, closePlanOf } from "./document-settlement.js";
export type { SettlementUi, SettleInput, SettleOutcome } from "./document-settlement.js";
export { canStartDownload, startDownload, browserDownloadPort } from "./file-delivery.js";
export { createBrowserFilePort, decodeImageSize } from "./file-delivery-adapter.js";
export {
  classifyOpenFile,
  validateOpenProjectDocument,
  projectVersionSupported,
  OPEN_FILE_ACCEPT,
  PROJECT_EXTENSION
} from "./open-file.js";
export type { OpenFileClassification, OpenFileKind, OpenProjectDocumentResult } from "./open-file.js";
export {
  DEFAULT_WORKSPACE_POLICY,
  SerialGate,
  canOpenDocument,
  describePolicy,
  shouldProducePreview
} from "./workspace-policy.js";
export type { WorkspacePolicy } from "./workspace-policy.js";
export { createPublishOperation, publishToCanvas, planPublishCommands } from "./publish-node.js";
export type { PublishOperation, PublishPorts, PublishResult, PublishUploadedObject } from "./publish-node.js";
