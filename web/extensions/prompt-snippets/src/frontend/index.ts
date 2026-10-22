/**
 * Prompt Snippets extension 前端入口（扫描约定入口）
 * （change: 2026-10-10-extract-optional-feature-extensions，任务 4.1/4.2 / design D1/D2/D7）。
 *
 * `web/extensions/prompt-snippets/src/frontend/index.ts` 是构建期可信扫描入口：扫描器只读取
 * `descriptor`。`descriptor.plugin()` 是无副作用工厂；宿主按**当前 origin 的浏览器本地选择**
 * 在 Canvas page scope 装配完整 Cordis plugin（见 `./plugin.js`）。入口本身是 optional 且可由
 * 用户配置，MUST NOT 声明 required 或伪装成服务端站点配置。
 *
 * 除 descriptor 外，本入口转出包内业务实现的**公共浏览器面**（catalog/materials/dialogs/renderer），
 * 供 Frontend/Showcase 消费者按公开路径消费，不直接 import 包内私有相对路径。
 *
 * 仅导入 `./plugin.js` 与 `./style.css`：CSS 由消费方打包器（Vite）按相对 import 加载，包构建
 * 以 copy loader 保留。
 */
import type { ExtensionFrontendDescriptor } from "@woohaa3/frontend/extension-api";
import { PROMPT_SNIPPETS_FRONTEND_METADATA } from "./metadata.js";
import { promptSnippetsExtension } from "./plugin.js";
import "./style.css";

export { promptSnippetsExtension, PROMPT_SNIPPET_SOURCE_KEY, SAVE_SNIPPET_MENU_ID } from "./plugin.js";
export { PROMPT_SNIPPETS_FRONTEND_METADATA } from "./metadata.js";
export { createSnippetCatalog, CATALOG_PAGE_SIZE } from "./catalog.js";
export type { CatalogFilter, CatalogState, CatalogStatus, MutationResult, SnippetCatalog, TagState } from "./catalog.js";
export { collectMaterialCandidates, resolveMaterialPreview } from "./materials.js";
export type { MaterialCandidate, MaterialPreview, MaterialPreviewStatus } from "./materials.js";
export { createMaterialPreviewStore, useMaterialPreviews } from "./preview.js";
export type { MaterialPreviewStore } from "./preview.js";
export {
  SNIPPET_DELETE_DIALOG_ID,
  SNIPPET_EDITOR_DIALOG_ID,
  SNIPPET_LIBRARY_DIALOG_ID,
  SNIPPET_TAG_DELETE_DIALOG_ID,
  snippetDeleteDefinition,
  snippetEditorDefinition,
  snippetLibraryDefinition,
  snippetTagDeleteDefinition
} from "./dialogs.js";
export type { SnippetDeletePayload, SnippetEditorPayload, SnippetLibraryPayload, TagDeletePayload } from "./dialogs.js";
export { createLibraryRenderer } from "./library-dialog.js";
export type { LibraryActions } from "./library-dialog.js";
export { createEditorRenderer } from "./editor-dialog.js";
export type { EditorActions } from "./editor-dialog.js";
export { createDeleteConfirmRenderer, createTagDeleteConfirmRenderer } from "./delete-dialog.js";

/** 构建期扫描读取的入口描述。`plugin()` 无副作用；浏览器本地可选装配（`browser-local`）。 */
export const descriptor: ExtensionFrontendDescriptor = {
  ...PROMPT_SNIPPETS_FRONTEND_METADATA,
  plugin: () => promptSnippetsExtension()
};
