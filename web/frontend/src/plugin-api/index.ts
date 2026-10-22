/**
 * 宿主公共平台端口
 * （change: 2026-10-21-extract-photocraft-subproject，design D3）。
 *
 * `@woohaa3/photocraft-woohaa` 适配包不能读取 frontend 私有源码；它只经这个显式 facade
 * 使用宿主已有的装配能力：Cordis 插件定义、画布 store/导航、聚焦布局与过渡、Dialog Host
 * 类型与共享媒体栅格化。这里**不是**给业务扩展的新 API，也不扩大现有边界：每个导出都已有
 * 明确 owner，新增消费者必须在 `web/tooling` 门禁里归类。
 */
import type {} from "../cordis/context.js";

export { definePlugin } from "../cordis/plugin.js";
export { useOptionalService } from "../cordis/react.js";

export type { DialogsService, EditCompleteResult } from "../cordis/contracts.js";

export { IMAGE_EDIT_SERVICE } from "../cordis/plugins/service-keys.js";
export type { ImageEditService } from "../cordis/plugins/service-keys.js";

export { woohaa3CanvasStore, workingCanvasOf } from "../cordis/services/canvas-state/index.js";

export { isAllowedNodeHistoryPreviewUrl, resolveCanonicalMediaUrl } from "../cordis/plugins/media-preview/media-preview.js";

export { MediaOperationBoundary } from "../cordis/plugins/canvas-runtime/media-operation-boundary.js";
export {
  BEVY_TEXTURE_MAX_DIMENSION,
  defaultRasterCanvasFactory,
  rasterizeDrawable
} from "../cordis/plugins/canvas-runtime/media-raster.js";

export { drawShape } from "../cordis/services/media-annotation/geometry.js";
export type { ContentRect, DrawableShape } from "../cordis/services/media-annotation/geometry.js";

export { FocusWorkspace, useFocusLayout } from "../cordis/focus/workspace.js";
export { RuntimeProvider } from "../cordis/react.js";
export { focusLayout } from "../cordis/focus/layout.js";
export { FocusHeader } from "../cordis/focus/header.js";
export {
  createLocalTransitionRunner,
  interpolateViewport,
  nodeImageRect,
  overviewImageView
} from "../cordis/focus/media-transition.js";
export type { FocusTransitionPort, ViewportTransitionRequest } from "../cordis/focus/media-transition.js";
export type { FocusLayoutConfig } from "../cordis/focus/layout.js";
export type { CanvasFocusKind } from "../cordis/navigation/contracts.js";
export type { CanvasRuntimeService } from "../cordis/contracts.js";
export type { FrontendRuntime } from "../cordis/kernel.js";

export { DialogService } from "../cordis/services/dialogs/service.js";
export { DialogHost } from "../cordis/services/dialogs/DialogHost.js";
export type { DialogRendererProps } from "../cordis/services/dialogs/renderer-registry.js";
export type {
  DialogDefinition,
  DialogEditingOwner,
  DialogInstance
} from "../cordis/services/dialogs/types.js";

export { measureInteractionPhase } from "../cordis/performance/interaction-phase-profiler.js";
export { measurePhotocraft, photocraftPreview } from "../cordis/performance/photocraft-performance.js";
export { appPublicUrl } from "../cordis/services/app-base-path.js";
export { createRemoteClient } from "../cordis/plugins/node-history/history-adapters.js";
export { ImageFocusStore } from "../cordis/plugins/canvas-runtime/image-focus-store.js";

export { runtimeComponents, imageEditorReadiness } from "../cordis/services/runtime-components.js";
export type { EditorReadiness } from "../cordis/services/runtime-components.js";
