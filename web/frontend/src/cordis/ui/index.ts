
// 统一应用主题（change: unify-application-theme-tokens）：Provider + 默认/哨兵 preset。
export { AppThemeService } from "../services/theme/index.js";
export type { ThemeServiceOptions, ThemePresetRegistry } from "../services/theme/index.js";
export {
  APP_THEME_BUILTIN_PRESETS,
  APP_THEME_BUILTIN_PRESET_IDS,
  appThemeAppearance,
  builtinAppTheme,
  darkAppTheme,
  defaultAppTheme,
  sentinelAppTheme,
  SENTINEL_THEME_PRESET
} from "@woohaa3/contracts";
export type { AppThemeSnapshot, AppThemeTokens } from "@woohaa3/contracts";

// 执行面板（Execution Panel）
export { ExecutionPanel, ExecutionPanelShell, ExecutionPanelModelNav } from "../plugins/task-execution/execution-panel/ExecutionPanel.js";
export { FullscreenPanelHost } from "../plugins/task-execution/execution-panel/fullscreen-panel-host.js";
export type { FullscreenPanelHostProps } from "../plugins/task-execution/execution-panel/fullscreen-panel-host.js";
export type { ExecutionPanelTaskKind, ExecutionPanelModelNavProps } from "../plugins/task-execution/execution-panel/ExecutionPanel.js";
export * from "../plugins/task-execution/execution-panel/types.js";
export { canRunExecution,
	executionRunSnapshot,
	isExecutionBlocked,
	isExecutionBusy, } from "../plugins/task-execution/execution-panel/run-snapshot.js";

// 3D 模型参数面板（change: add-showcase-history-model-panels）
export { ModelParameterPanel,
	modelPromptGuide } from "../plugins/task-execution/model-parameter-panel.js";
export type { ModelParameterPanelProps } from "../plugins/task-execution/model-parameter-panel.js";

// 画布焦点总线（mitt）
export { canvasBus,
	currentFocus,
	currentRuntime,
	onCanvasFocus,
	onCanvasHover, } from "../plugins/canvas-shell/canvas-bus.js";
export type { CanvasBus,
	CanvasBusEvents,
	CanvasFocus,
	CanvasNodeKind,
	CanvasRuntimeInfo, } from "../plugins/canvas-shell/canvas-bus.js";
export { useCanvasEvent,
	useCanvasFocus,
	useCanvasHover,
	useCanvasRuntime, } from "../plugins/canvas-shell/useCanvasFocus.js";

// 画布上下文菜单（右键短点击）
export { CanvasContextMenu } from "../plugins/canvas-menu/canvas-context-menu.js";
export type { CanvasContextMenuProps, CanvasContextMenuItem } from "../plugins/canvas-menu/canvas-context-menu.js";

// Frontend Dialog system（change: add-frontend-dialog-system）
export { DialogHost, useDialogHost } from "../services/dialogs/DialogHost.js";
export { DialogService } from "../services/dialogs/service.js";
export type { DialogServiceOptions } from "../services/dialogs/service.js";
export { DialogHostStore } from "../services/dialogs/host-store.js";
export type { DialogHostSnapshot } from "../services/dialogs/host-store.js";
export { DialogRegistry, objectPayload } from "../services/dialogs/registry.js";
export type { DialogRenderer, DialogRendererProps } from "../services/dialogs/renderer-registry.js";
export {
  MEDIA_PREVIEW_DIALOG_ID,
  mediaPreviewDefinition,
  resolveImagePreview,
  resolveCanonicalMediaUrl,
  isAllowedMediaUrl
} from "../plugins/media-preview/media-preview.js";
export { ALERT_DIALOG_ID, alertDefinition, registerAlertAction } from "../services/dialogs/alert-dialog.js";
export type { AlertPayload, AlertAction } from "../services/dialogs/alert-dialog.js";
export * from "../services/dialogs/stack.js";

// 提示词片段（change: add-prompt-snippet-library）与任务活动（change: 2026-10-09）：
// 业务实现已迁至独立 browser-local extension 包（change: 2026-10-10-extract-optional-feature-extensions）。
// 宿主 UI façade 不再转出这些业务类型/实现；消费方改用
// `@woohaa3/extension-prompt-snippets/frontend` 与 `@woohaa3/extension-task-activity/frontend`。

// 单图替换确认 dialog（change: add-paste-import-workflows）
export {
  PASTE_REPLACE_DIALOG_ID,
  replaceConfirmDefinition,
  createReplaceConfirmRenderer
} from "../plugins/paste-import/replace-dialog.js";
export type { ReplaceConfirmPayload, ReplaceChoice, ReplaceResolver } from "../plugins/paste-import/replace-dialog.js";

// 视频截帧 / 编辑标记 dialogs（change: port-video-editing-dialogs）
export { createFrameCaptureRenderer } from "../plugins/video-capture/frame-capture-dialog.js";
export type { FrameCaptureStorySeed } from "../plugins/video-capture/frame-capture-dialog.js";
export { createVideoEditRenderer } from "../plugins/video-capture/video-edit-dialog.js";
export type { VideoEditStorySeed } from "../plugins/video-capture/video-edit-dialog.js";
export {
  VIDEO_FRAME_CAPTURE_DIALOG_ID,
  VIDEO_EDIT_DIALOG_ID
} from "../plugins/video-capture/ids.js";
export {
  frameCaptureDefinition,
  videoEditDefinition,
  validateVideoDialogPayload
} from "../plugins/video-capture/definitions.js";
export type {
  VideoDialogPayload,
  CapturedFrameEntry,
  FrameAddReceipt
} from "../plugins/video-capture/types.js";
// 共享视频截帧主体（change: 2026-10-10-add-video-node-focus-workspace）：Dialog 与聚焦复用。
export {
  useCaptureSession,
  CapturePlaybackControls,
  CaptureButtons,
  CaptureFrameList,
  CaptureFooterActions
} from "../plugins/video-capture/capture-shell.js";
export type { CaptureSession, CaptureInitialState, CaptureKind } from "../plugins/video-capture/capture-shell.js";
export type { FrameCaptureSource, CaptureState } from "../plugins/video-capture/capture-source.js";
export { videoElementSource } from "../plugins/video-capture/capture-frames.js";

// 右下角统一控件面板（change: unify-canvas-corner-controls）
export { CanvasControlPanel, CanvasControlStatus } from "../host.js";
export type { ControlPanelAction } from "../host.js";
export { syncStatusView } from "../sync-status.js";
export type { SyncStatusView, SyncStatusTone, SyncStatusInput } from "../sync-status.js";
// MCP 指引文案（AI 面板 MCP tab 与节点级工具复用）
export { mcpHintView, mcpCanvasPrompt, cameraMcpGuide, MCP_HINT_PREFIX, MCP_HINT_INSTALL_LABEL, MCP_HINT_CANVAS_LABEL } from "../mcp-hint.js";
export type { McpHintView } from "../mcp-hint.js";
export { CanvasZoomControls } from "../plugins/canvas-shell/canvas-zoom-controls.js";
export type { CanvasZoomControlsProps } from "../plugins/canvas-shell/canvas-zoom-controls.js";
// 生产 UI primitives（change: adopt-radix-lucide-canvas-ui，design D1）：
// 唯一允许 Plugin/Dialog renderer/Showcase 消费 Radix/Lucide 的公共入口。

// 画布「全部生成历史」只读弹窗（change: add-canvas-generation-history-dialog）
export { CanvasHistoryBrowser, createCanvasHistoryRenderer } from "../plugins/node-history/canvas-history-browser.js";
export { CanvasHistoryController } from "../plugins/node-history/canvas-history-controller.js";
export type {
  CanvasHistoryClient,
  CanvasHistoryFilter,
  CanvasHistoryState
} from "../plugins/node-history/canvas-history-controller.js";
export { HistoryPreview } from "../plugins/node-history/preview.js";
export type { HistoryPreviewProps } from "../plugins/node-history/preview.js";
export { CANVAS_HISTORY_DIALOG_ID } from "../plugins/node-history/plugin.js";

// 作品查找面板与撤销/重做工具（change: 2026-10-09-improve-canvas-workflow）
export { CanvasSearchPanel } from "./CanvasSearchPanel.js";
export type { CanvasSearchPanelProps } from "./CanvasSearchPanel.js";
export { CanvasSearchStore, canvasSearchStore } from "../services/canvas-search-store.js";
export { CanvasUndoControls } from "../plugins/canvas-shell/canvas-undo-controls.js";
export { NodeHistoryPanel } from "../plugins/node-history/panel.js";
export type { NodeHistoryPanelProps } from "../plugins/node-history/panel.js";
export { NodeHistoryController } from "../plugins/node-history/controller.js";
export type { NodeHistoryClient, NodeHistoryPanelState } from "../plugins/node-history/controller.js";
// 任务活动浮层业务实现已迁至独立 browser-local extension 包
// （change: 2026-10-10-extract-optional-feature-extensions）：消费方改用
// `@woohaa3/extension-task-activity/frontend`。
export type {
  DialogInstance,
  DialogVariant,
  DialogSize,
  DialogDefinition,
  OpenDialogRequest,
  OpenDialogResult,
  DialogHostApi,
  PayloadValidator
} from "../services/dialogs/types.js";
