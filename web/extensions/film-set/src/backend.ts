import { createFilmSetCanvasContentRuntime } from "./backend/content-runtime.js";
export { FilmSetNodeService,
  readFilmSet,
  resolveNodeModelSource,
  defaultCameraForCreate,
  DEFAULT_MOTION_SCRIPT } from "./backend/service.js";
export type { FilmSetNodeServiceDependencies,
  FilmSetNodeOutcome,
  ModelSourceInput,
  CreateFilmSetInput,
  CreateFilmSetFromNodeInput,
  EditModelInput,
  ConfirmAdaptationInput,
  CommitFilmSetInput,
  ReadFilmSetOutcome } from "./backend/service.js";
export { FilmSetImportService } from "./backend/film-set-import.js";
export type {
  FilmSetImportServiceDependencies,
  ImportFilmSetContentInput,
  ImportFilmSetContentOutcome,
  FilmSetImportRequestItem
} from "./backend/film-set-import.js";
export { FilmSetItemService, filmSetItemTransformOp } from "./backend/film-set-item.js";
export type {
  FilmSetItemServiceDependencies,
  FilmSetItemCommandInput,
  FilmSetItemCommandOutcome
} from "./backend/film-set-item.js";

export { FilmSetConversionService, conversionCommandId, buildModelCopyCandidate } from "./backend/film-set-conversion.js";
export type {
  FilmSetConversionServiceDependencies,
  FilmSetConversionSubmitOutcome,
  FilmSetConversionCancelOutcome,
  FilmSetConversionGenerator,
  FilmSetConversionGenerationInput,
  FilmSetConversionGenerationResult
} from "./backend/film-set-conversion.js";
export { InMemoryFilmSetConversionRegistry } from "./backend/conversion-registry.js";
export type { FilmSetConversionRegistry } from "@woohaa3/contracts";

export { prepareFilmSetNativeMedia } from "./backend/media-frame.js";
export type { FilmSetNativeMediaFrame, FilmSetMediaReader } from "./backend/media-frame.js";

export { probeFilmSetVideoDuration, extractFilmSetVideoFrames, videoRangeFitsBudget } from "./backend/video-frames.js";
export type { FilmSetVideoFrame } from "./backend/video-frames.js";

export { createFilmSetConversionMediaReader, FILM_SET_CONVERSION_MAX_ASSET_BYTES } from "./backend/conversion-media.js";
export type { FilmSetConversionAssetReader, FilmSetConversionMediaReaderOptions } from "./backend/conversion-media.js";

export { nativeFilmSetFrame } from "./backend/native-frame.js";
export { prepareFilmSetHistoryFrame } from "./backend/history-frame.js";
export { filmSetCanvasContentRuntime } from "./backend/content-runtime.js";
export { filmSetMcpRuntime } from "./backend/mcp-runtime.js";
export { filmSetFrameRuntime } from "./backend/frame-runtime.js";

/**
 * 画布内容扩展工厂（`extension.json` 的 `canvasContent.factory`）：返回预览/历史帧 + 转片场端口。
 *
 * 宿主在装配 canvas-service 时调用；工厂无副作用，返回同一个不可变端口对象。
 */
export { createFilmSetCanvasContentRuntime };

export { compileMotionTracks, previewAnimationMetadata, previewIdentityMatches } from "./backend/preview-identity.js";

export { prepareFilmSetPreviewFrame } from "./backend/preview-frame.js";
