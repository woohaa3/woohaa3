/**
 * `@woohaa3/photocraft-protocol` 公共入口
 * （change: 2026-10-21-extract-photocraft-subproject，design D2）。
 *
 * 纯编辑能力、内容身份与格式核验契约。**只依赖包内纯数据与纯函数**：不 import 宿主
 * contracts、frontend、services 或任何内部目录，因此可在只含本子项目的副本中构建与测试。
 *
 * 导出来源：
 * - `image-edit`：`ImageEditDocument` 严格联合、引擎/能力/格式版本、上限、内容身份；
 * - `image-project-content`：规范文档内容折叠与样式/图案/智能对象核验；
 * - `image-project-editor`：命令注册表、内容状态、导出摘要解码；
 * - `content-hash`：FNV-1a 64（与 Rust 内核逐字节一致）。
 *
 * **值导出必须逐条列出**，不能只写 `export *`：esbuild 在打包宿主包时把 `export *` 从
 * external 包降级成运行时属性拷贝，宿主的 `dist/index.js` 就不会再导出这些符号（消费者拿到
 * `undefined`）。逐条列举让 esbuild 生成真实的静态 re-export。类型用 `export type *`。
 */
export { fnv1a64Hex } from "./content-hash.js";

export {
  IMAGE_EDIT_ALLOWED_COLORS,
  IMAGE_EDIT_DOCUMENT_VERSION,
  IMAGE_EDIT_LIMITS,
  IMAGE_PROJECT_CONTENT_TYPE,
  IMAGE_PROJECT_DOCUMENT_VERSION,
  IMAGE_PROJECT_ENGINE,
  IMAGE_PROJECT_LIMITS,
  PHOTOCRAFT_ENGINE_VERSION,
  SUPPORTED_PHOTOCRAFT_ENGINE_VERSIONS,
  SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS,
  decodeImageEditDocument,
  decodeImageEditProjectObjectRef,
  decodeSourceAssetIds,
  imageEditContentIdentity,
  imageEditDefinitionHash,
  imageEditDocumentContentIdentity,
  imageEditHasNetChange,
  imageEditShapesHash,
  imageEditShapesOf,
  isEmptyImageEditDocument,
  isImageProjectDocument,
  isLegacyImageEditDocument,
  normalizeImageEditPoint,
  normalizeImageEditWidth,
  sanitizeImageEditPoint,
  sanitizeImageEditShape
} from "./image-edit.js";

export type {
  ImageEditDocument,
  ImageEditDocumentVersion,
  ImageEditPoint,
  ImageEditProjectObjectRef,
  ImageEditShape,
  ImageEditTool,
  ImageEditValidationResult,
  ImageProjectDocument,
  ImageProjectDocumentVersion,
  LegacyImageEditDocument
} from "./image-edit.js";

export {
  IMAGE_PROJECT_ADJUSTMENT_KINDS,
  IMAGE_PROJECT_BLEND_MODES,
  IMAGE_PROJECT_LAYER_KINDS,
  canonicalizeImageProjectContent,
  imageProjectContentHash,
  isImageProjectAdjustmentKind,
  isImageProjectBlendMode,
  isImageProjectLayerKind,
  isSupportedImageProjectEffects,
  isSupportedImageProjectPatterns
} from "./image-project-content.js";

export type {
  ImageProjectAdjustmentContent,
  ImageProjectAdjustmentKind,
  ImageProjectAdjustmentParameters,
  ImageProjectBlendMode,
  ImageProjectClippingPathSummary,
  ImageProjectContent,
  ImageProjectLayer,
  ImageProjectLayerKind,
  ImageProjectMaskSummary,
  ImageProjectNamedPathSummary,
  ImageProjectPixelSummary,
  ImageProjectLevelsChannel,
  ImageProjectShapeSummary,
  ImageProjectSmartSummary,
  ImageProjectTextContent,
  ImageProjectTransform,
  ImageProjectVectorMaskSummary,
  ImageProjectWorkPathSummary
} from "./image-project-content.js";

export {
  VECTOR_LIMITS,
  VECTOR_PATH_OPS,
  VECTOR_SHAPE_KINDS,
  decodeVectorShapeParams,
  decodeVectorShapePresetLibrary,
  vectorPathWithinBudget,
  vectorPresetSnapshotWithinBudget
} from "./features/vectors/index.js";

export type {
  VectorPathOp,
  VectorShapeKind,
  VectorShapeParams,
  VectorShapePresetEntry,
  VectorShapePresetLibrary
} from "./features/vectors/index.js";

export {
  PHOTOCRAFT_CAPABILITIES,
  PHOTOCRAFT_DELIVERED_STAGES,
  PHOTOCRAFT_DISABLED_FEATURES,
  PHOTOCRAFT_ENGINE_COMMIT,
  PHOTOCRAFT_NON_GOALS,
  PHOTOCRAFT_REJECTIONS,
  PHOTOCRAFT_STAGES,
  PHOTOCRAFT_STAGE_CAPABILITIES,
  PHOTOCRAFT_UNDELIVERED_CAPABILITIES,
  checkPhotocraftCapabilities,
  decodeContentState,
  decodeExportResult,
  decodePhotocraftCommands,
  decodePhotocraftError,
  isPhotocraftCapabilityEnabled,
  isPhotocraftCommandDispatchable,
  isPhotocraftFeatureAllowed,
  isPhotocraftStageDelivered,
  photocraftCapabilityManifest,
  photocraftCapabilityStage,
  photocraftFeatureDisabledReason,
  verifyPhotocraftHandshake
} from "./image-project-editor.js";

// 绘画域共享契约：混合模式、采样/对称/预设的边界与校验。
// 这里是包公共入口（共享 barrel），因此只加**一行再导出**，不复制任何校验实现；
// 域内模块仍从 `./features/painting/workflow.js` 取真源。
export * from "./features/painting/workflow.js";

export type {
  PhotocraftArtifactSummary,
  PhotocraftCapability,
  PhotocraftCapabilityHandshake,
  PhotocraftCommand,
  PhotocraftContentState,
  PhotocraftDisabledFeature,
  PhotocraftEditorError,
  PhotocraftExportResult,
  PhotocraftNonGoal,
  PhotocraftRejection,
  PhotocraftStage
} from "./image-project-editor.js";

// 时间轴与浏览器视频工作流（change: 2026-10-22-add-photocraft-animation-workflows）。
export {
  ANIMATION_CAPABILITIES,
  animationCodecAvailability,
  animationFrameBytes,
  isAnimationCodecPort
} from "./features/animation/index.js";
export {
  animationContentKey,
  canonicalizeAnimationContent,
  hasAnimationContent
} from "./features/animation/content.js";

export type {
  AnimationContent,
  AnimationContentFrame,
  AnimationContentLayer,
  AnimationContentTimeline,
  AnimationContentVideo
} from "./features/animation/content.js";

export type {
  AnimationCodecPort,
  AnimationCodecSupport,
  AnimationDecodeRequest,
  AnimationDeliveryPlan,
  AnimationEncodeRequest,
  AnimationFrameBudget,
  AnimationFrameFlush,
  AnimationFrameImport,
  AnimationNavigation,
  AnimationTimeline,
  AnimationTimelineInfo,
  AnimationVideoLayer
} from "./features/animation/index.js";

// 文档创建、来源与关闭结算（change: 2026-10-22-add-photocraft-file-workflows）。
// 本域只追加**数据契约**：能力 id 仍由共享集成维护，这里不放宽命令门。
export {
  FILE_INFO_COPYRIGHT_STATES,
  FILE_INFO_FIELDS,
  FILE_INFO_FORMATS,
  FILE_INFO_FORMAT_SUPPORT,
  FILE_INFO_LIMITS,
  NEW_DOCUMENT_DEPTHS,
  NEW_DOCUMENT_LIMITS,
  NEW_DOCUMENT_MODES,
  SIZE_PRESETS,
  DOCUMENT_PRESET_STORE_VERSION,
  addDocumentPreset,
  canReopenRecent,
  canReplayDocumentSpec,
  createLocalDocumentPresetStorage,
  decodeDocumentPresetStore,
  describeFileInfoLoss,
  emptyDocumentPresetStore,
  encodeDocumentPresetStore,
  fileInfoFormatOf,
  normalizePresetName,
  parseDocumentPresetStore,
  planCloseAll,
  planCloseOthers,
  recordRecentDocument,
  removeDocumentPreset,
  requestDocumentSlot,
  runClosePlan,
  validateFileInfoPatch,
  validateNewDocumentSpec,
  MAX_RECENT_FILES,
  MAX_RECENT_FILE_BYTES,
  MAX_RECENT_TOTAL_BYTES,
  RECENT_FILE_STORE_VERSION,
  decodeRecentFileStore,
  emptyRecentFileStore,
  encodeRecentFileStore,
  heldBytesAfterSave,
  parseRecentFileStore,
  planReopenRecent,
  recordRecentFile,
  removeRecentFile,
  reopenRecentLabel
} from "./features/files/index.js";

export type {
  CloseFailure,
  CloseOutcome,
  ClosePlan,
  CloseStep,
  CloseTarget,
  DecodePresetStoreResult,
  DecodeRecentFileStoreResult,
  DocumentPreset,
  DocumentPresetStorage,
  DocumentPresetStore,
  FileInfo,
  FileInfoCamera,
  FileInfoField,
  FileInfoFormat,
  FileInfoLoss,
  FileInfoPatchResult,
  NewDocumentBackground,
  NewDocumentSpec,
  NewDocumentSpecResult,
  RecentFileEntry,
  RecentFileStore,
  ReopenRecentResult,
  SizePreset
} from "./features/files/index.js";

/**
 * 填充层与图层工作流的面板参数契约（U57–U64）。
 *
 * 这些是**域内纯声明**：界限与内核同一组数字，但不代表能力已登记；能力清单仍由
 * `image-project-editor.ts` 的契约表与 Rust `capability.rs` 共同拥有。
 */
export {
  LAYER_EFFECT_KINDS,
  LAYER_FILL_KINDS,
  LAYER_FILL_LIMITS,
  LAYER_FILTER_COMBINATION_NOTE,
  LAYER_KNOCKOUTS,
  MAX_LAYER_COMPS,
  blendingParamError,
  isBlendIfList,
  isBlendIfRange,
  isGradientStops,
  layerCompParamError,
  layerFillCommandParams,
  layerFillParamError,
  layerFilterActive,
  layerFilterParamError,
  layerStylePresetParamError,
  STYLE_PRESET_ACTIONS,
  mattingParamError
} from "./features/layers/workflows.js";

export type {
  BlendIfEntry,
  BlendIfRange,
  LayerFillKind,
  LayerKnockout,
  LayerLabelColor,
  StylePresetAction
} from "./features/layers/workflows.js";

/**
 * 填充层的规范内容与身份（U57）。
 *
 * 与 Rust `features/layers/content.rs::fill_content` /
 * `identity.rs::canonicalize_fill` 逐字节一致；宿主据此判断「改填充参数」是否是净变化。
 */
export {
  IMAGE_PROJECT_GRADIENT_STYLES,
  canonicalizeFillContent,
  fillPatternReference,
  isContentHash16
} from "./features/layers/fill-content.js";

export type {
  ImageProjectFillContent,
  ImageProjectGradientOpacityStop,
  ImageProjectGradientStop,
  ImageProjectGradientStyle
} from "./features/layers/fill-content.js";

// 栅格交换域（change: 2026-10-22-add-photocraft-raster-interchange）。
//
// 域实现在 `./features/io/index.ts`；这里是本包唯一公共入口，按上面「值导出逐条列出」的约定
// 追加，不改动既有导出行。新增值/类型必须与 io 域的导出保持同名同源，不得另建副本。
export {
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_WEB_SETTINGS,
  EXPORT_FORMATS,
  EXPORT_METADATA_POLICIES,
  INTERCHANGE_BUDGETS,
  INTERCHANGE_CAPABILITIES,
  OPEN_RASTER_ACCEPT,
  OPEN_RASTER_EXTENSIONS,
  OPEN_RASTER_MIMES,
  WEB_FORMATS,
  decodeAssetReport,
  decodeBundleInspection,
  decodeExportPresets,
  decodeExportReport,
  decodeLayerBundleReport,
  deliveryFileName,
  normalizeExportSettings
} from "./features/io/index.js";

export type {
  AssetFile,
  AssetReport,
  BundleInspection,
  DecodeResult,
  ExportFormatId,
  ExportMatrixRow,
  ExportMetadataPolicy,
  ExportPreset,
  ExportReport,
  ExportSettings,
  InterchangeBudgets,
  InterchangeCapability,
  InterchangeMatrix,
  LayerBundleFile,
  LayerBundleReport,
  WebFormatId
} from "./features/io/index.js";
