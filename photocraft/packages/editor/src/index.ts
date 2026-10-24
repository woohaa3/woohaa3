/**
 * `@woohaa3/photocraft-editor` 公共入口
 * （change: 2026-10-21-extract-photocraft-subproject，design D3/D6）。
 *
 * 编辑器核心只经端口依赖宿主：文档会话、保存、对话框、插桩与静态资源地址都由
 * `EditorWorkspaceOptions` / `EditorDialogPort` / `setEditorInstrumentation` 注入。
 * UI primitives 在 `@woohaa3/photocraft-editor/ui`，样式在 `@woohaa3/photocraft-editor/styles.css`。
 */
export * from "./ports.js";
export * from "./session.js";
export * from "./viewport.js";

export * from "./editor-artifacts.js";
export * from "./editor-display.js";
export * from "./document-workspace.js";
export * from "./editor-entry.js";
export * from "./editor-panel-layout.js";
export * from "./editor-view-model.js";
export * from "./editor-wasm.js";
export * from "./editor-workspace.js";

export * from "./adjustment-range.js";
export * from "./adjustment-session.js";
export * from "./contour-preset-store.js";
export * from "./frame-edit-session.js";
export * from "./layer-layout-controls.js";
export * from "./layer-style-contour-editor.js";
export * from "./layer-style-editor.js";
export * from "./layer-style-pattern-library.js";
export * from "./layer-thumbnail.js";
export * from "./layer-transform-ui.js";
export * from "./live-stroke-preview.js";
export * from "./tool-slot-button.js";
export * from "./toolbar-slots.js";
export * from "./new-layer-dialog.js";
export * from "./normalize-image.js";
export * from "./paint-dispatch.js";
export * from "./paint-tool-state.js";
export * from "./pattern-preset-store.js";
export * from "./photo-editor-app.js";
export * from "./photo-editor-canvas.js";
export * from "./photo-editor-chrome.js";
export * from "./photo-editor-context-menu.js";
export * from "./photo-editor-menu.js";
export * from "./photo-editor-panels.js";
export * from "./photo-editor-shortcuts.js";
export * from "./photo-editor-tool-options.js";
export * from "./photo-editor-tools.js";
export * from "./rgb-curve-editor.js";
export * from "./selection-autopan.js";
export * from "./selection-gesture.js";
export * from "./source-detail-preview.js";
export * from "./style-positioning.js";
export * from "./text-geometry.js";
export * from "./text-input-overlay.js";
export * from "./text-session.js";
export * from "./transform.js";
export * from "./transform-layer.js";
export * from "./transform-session.js";

export * from "./zoom-levels.js";

export * from "./document-settlement-prompt.js";

export {usePasteboardAppearance} from "./pasteboard-appearance.js";

export {browserScreenModeWindow,type EditorScreenModeWindowPort} from "./screen-mode-window.js";

export type {InfoReadout,InfoRequest} from "./info-readout.js";

export type {PixelGridRegion,PixelGridSegment} from "./pixel-grid-data.js";

export type {HistogramReadout,HistogramChannel} from "./histogram-data.js";

export type {NavigatorFrame,NavigatorAction} from "./navigator-geometry.js";

export {useNotificationPreferences,readNotifications,publishNotifications,normalizeNotifications,type NotificationPreferences} from "./notification-preferences.js";
