/** Persisted image edit envelopes. Engine implementation belongs to extensions. */
/** 旧标注编辑定义契约版本；结构变化必须升版本。 */
export const IMAGE_EDIT_DOCUMENT_VERSION = "woohaa-image-edit-v1" as const;
export type ImageEditDocumentVersion = typeof IMAGE_EDIT_DOCUMENT_VERSION;

/** 编辑器工程编辑定义契约版本。 */
export const IMAGE_PROJECT_DOCUMENT_VERSION = "woohaa-image-project-v1" as const;
export type ImageProjectDocumentVersion = typeof IMAGE_PROJECT_DOCUMENT_VERSION;

/** 允许的标注工具。 */
export type ImageEditTool = "pen" | "rect";

/** 相对**原始图片内容**归一化坐标（不含 letterbox），分量位于 `[0, 1]`。 */
export type ImageEditPoint = {
  x: number;
  y: number;
};

/** 一条图片标注 shape（design D4）。 */
export type ImageEditShape = {
  id: string;
  tool: ImageEditTool;
  color: string;
  /** 以源像素表达的线宽（1–64），不随显示缩放变化。 */
  widthInSourcePixels: number;
  /** pen：≥2 个点；rect：恰好 2 个点（起点、终点）。 */
  points: ImageEditPoint[];
};

/**
 * 旧标注编辑定义（`woohaa-image-edit-v1`，design D4：完整保留其语义与限制）。
 *
 * 仅保存当前内容；完整历史集合由 canvas-node-generation-history 持有。
 * `sourceWidth`/`sourceHeight` 为统一方向（EXIF 归一化）后的原始像素尺寸。
 */
export type LegacyImageEditDocument = {
  version: ImageEditDocumentVersion;
  /** 同画布稳定原图资产引用（StoredAsset.id）。 */
  baseAssetId: string;
  sourceWidth: number;
  sourceHeight: number;
  /** 有序 shapes：顺序即绘制顺序（后画先覆盖）。 */
  shapes: ImageEditShape[];
};

/** 工程对象的稳定 metadata（bytes 仍归 Media Service）。 */
export type ImageEditProjectObjectRef = {
  storageKey: string;
  checksum: string;
  contentType: string;
  size: number;
};

/**
 * 编辑器工程编辑定义（`woohaa-image-project-v1`，design D4）。
 *
 * 只保存稳定引用与身份，**不**内嵌文档树、字体或像素。`canvasWidth`/`canvasHeight` 是裁剪后
 * 的当前画布尺寸，允许不等于原始来源尺寸；`outputAssetId`（节点字段）继续指向合成 PNG。
 */
export type ImageProjectDocument = {
  version: ImageProjectDocumentVersion;
  /** 固定引擎标识。 */
  engine: string;
  /** 引擎自身版本标识，兼容性由扩展决定。 */
  engineVersion: string;
  /** 编辑器原生 文档格式版本。 */
  formatVersion: number;
  /** 同画布稳定原图资产引用。 */
  baseAssetId: string;
  /** 原始来源尺寸（裁剪前，方向归一）。 */
  sourceWidth: number;
  sourceHeight: number;
  /** 当前画布尺寸（裁剪后）。 */
  canvasWidth: number;
  canvasHeight: number;
  /** 规范文档内容 hash（64 位小写 hex）；排除选区/取景/活动层/工具/撤销栈/打包时间。 */
  documentContentHash: string;
  /** 工程对象稳定 metadata。 */
  project: ImageEditProjectObjectRef;
  /** 使用到的稳定资产引用（含 baseAssetId；去重、稳定顺序、有界）。 */
  sourceAssetIds: string[];
};

/** 严格版本化编辑定义联合：两个分支互斥，禁止同时携带 shapes 与 project。 */
export type ImageEditDocument = LegacyImageEditDocument | ImageProjectDocument;
