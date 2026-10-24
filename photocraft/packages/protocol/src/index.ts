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
export {IMAGE_PROJECT_LAYER_LABELS} from "./image-project-content.js";
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
  ImageProjectContent,
  ImageProjectLayer,
  ImageProjectLayerKind,
  ImageProjectMaskSummary,
  ImageProjectPixelSummary,
  ImageProjectSmartSummary,
  ImageProjectTextContent,
  ImageProjectTransform
} from "./image-project-content.js";

export {
  PHOTOCRAFT_CAPABILITIES,
  PHOTOCRAFT_DISABLED_FEATURES,
  PHOTOCRAFT_ENGINE_COMMIT,
  PHOTOCRAFT_REJECTIONS,
  checkPhotocraftCapabilities,
  decodeContentState,
  decodeExportResult,
  decodePhotocraftCommands,
  decodePhotocraftError,
  isPhotocraftCapabilityEnabled,
  isPhotocraftCommandDispatchable,
  isPhotocraftFeatureAllowed,
  photocraftCapabilityManifest
} from "./image-project-editor.js";

export type {
  PhotocraftArtifactSummary,
  PhotocraftCapability,
  PhotocraftCommand,
  PhotocraftContentState,
  PhotocraftDisabledFeature,
  PhotocraftEditorError,
  PhotocraftExportResult,
  PhotocraftRejection
} from "./image-project-editor.js";
