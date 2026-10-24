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
export * from "./layer-display-name.js";
export * from "./layer-layout-controls.js";
export * from "./layer-style-contour-editor.js";
export * from "./layer-style-editor.js";
export * from "./layer-style-pattern-library.js";
export * from "./layer-thumbnail.js";
export * from "./layer-transform-ui.js";
export * from "./live-stroke-preview.js";
export * from "./marquee-tool-group.js";
export * from "./new-layer-dialog.js";
export * from "./normalize-image.js";
export * from "./paint-tool-state.js";
export * from "./pattern-preset-store.js";
export * from "./brush-library-state.js";
export * from "./brush-panels.js";
export * from "./editor-tool-panels.js";
export * from "./photo-editor-app.js";
export * from "./photo-editor-canvas.js";
export * from "./photo-editor-chrome.js";
export * from "./photo-editor-context-menu.js";
export * from "./photo-editor-menu.js";
export * from "./photo-editor-panels.js";
export * from "./photo-editor-shortcuts.js";
export * from "./photo-editor-tool-options.js";
export * from "./photo-editor-tools.js";
export * from "./smart-object-panel.js";
export * from "./vector-tools-panel.js";
export * from "./view-aids-overlay.js";
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

// 宿主 codec 端口注册点（change: 2026-10-22-add-photocraft-animation-workflows）。
// 宿主在装配时把 WebCodecs/容器实现交给编辑器；编辑器自身不实现编解码（见 features/animation/codec.ts）。
export { animationCodecPort, setAnimationCodecPort, ANIMATION_CONTAINERS, negotiateAnimationContainer } from "./features/animation/codec.js";
export type { AnimationContainer, AnimationNegotiation } from "./features/animation/codec.js";

// 文件域的写入前置规则与请求序号（change: 2026-10-22-add-photocraft-file-workflows）。
// 宿主工作区装配必须与域会话共用**同一份**判断（导出/保存中拒绝写入、只有最新呈现请求
// 可以改变呈现），因此公开这一个子模块；不把域装配表（`feature`）导出去。
export { RequestSequence, planFileWrite } from "./features/files/write-gate.js";
export type { FileWriteBlockCode, FileWriteFacts, FileWritePlan } from "./features/files/write-gate.js";
