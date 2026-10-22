/**
 * 图片编辑定义契约（宿主入口）
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 1.2 / design D4；
 *  change: 2026-10-16-integrate-photocraft-image-editing，任务 2.1–2.2 / design D4；
 *  change: 2026-10-21-extract-photocraft-subproject，任务 2.1 / design D2）。
 *
 * 实现已下沉到 `@woohaa3/photocraft-protocol`（纯包，零宿主依赖）。本模块**只做重导出**，
 * 保留 `@woohaa3/contracts` 原导出位置与符号名，使 Canvas Service、Media Service、frontend
 * 与既有测试不需要改 import：
 *
 * - `ImageEditDocument` 严格联合（旧标注 v1 + PhotoCraft 工程 v1）、上限与内容身份归 protocol；
 * - 宿主侧的资产/存储引用（`StoredAsset`、`ImageEditCompleteRequest`、节点历史身份）仍由
 *   `image-edit-session.ts`、`node-history/*` 等本目录模块拥有，不在迁移范围内。
 *
 * 因此这里没有任何实现副本：迁移后两端不会各自漂移。
 *
 * 重导出**逐条列举**而不是 `export *`：宿主包用 esbuild 打成单文件 bundle，`export *` 从
 * external 包重导出会被降级成运行时属性拷贝，`dist/index.js` 就不会再静态导出这些符号，
 * 消费方拿到 `undefined`。列举后 esbuild 会生成真实 re-export。
 */
export {
  IMAGE_EDIT_ALLOWED_COLORS,
  IMAGE_EDIT_DOCUMENT_VERSION,
  IMAGE_EDIT_LIMITS,
  IMAGE_PROJECT_CONTENT_TYPE,
  IMAGE_PROJECT_DOCUMENT_VERSION,
  IMAGE_PROJECT_ENGINE,
  IMAGE_PROJECT_LIMITS,
  PHOTOCRAFT_ENGINE_COMMIT,
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
} from "@woohaa3/photocraft-protocol";

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
} from "@woohaa3/photocraft-protocol";
