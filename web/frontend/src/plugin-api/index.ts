/** Generic internal platform facade. Installed extensions use extension-api. */
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

export { appPublicUrl } from "../cordis/services/app-base-path.js";
export { createRemoteClient } from "../cordis/plugins/node-history/history-adapters.js";
export { ImageFocusStore } from "../cordis/plugins/canvas-runtime/image-focus-store.js";

export { runtimeComponents } from "../cordis/services/runtime-components.js";
