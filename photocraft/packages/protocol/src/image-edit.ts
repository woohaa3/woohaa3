/**
 * 图片编辑定义的受限结构化契约
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 1.2 / design D4；
 *  change: 2026-10-16-integrate-photocraft-image-editing，任务 2.1–2.2 / design D4）。
 *
 * 本模块是纯函数、无副作用、JSON-only 的 contract：定义图片聚焦编辑的版本化
 * `ImageEditDocument` 严格联合（旧标注 v1 完整保留 + 新增 PhotoCraft 工程 v1）、归一化
 * shape/点、数量/尺寸/字节上限与稳定内容身份，供 Frontend、Canvas Service 与测试共用同一份
 * 语义。
 *
 * 关键约束（跨端共用）：
 * - canonical 只保存**稳定资产引用**（baseAssetId / project.storageKey / sourceAssetIds）与
 *   可编辑定义，绝不保存图片 bytes、Blob、data/object URL、临时签名 URL、草稿栈或编辑 UI 状态；
 * - 标注点相对**原始图片内容**归一化到 `[0, 1]`，线宽以**源像素**表达，缩放/DPR 不改变身份；
 * - 工程分支只保存**文档内容 hash** 与对象 metadata，不内嵌文档树、字体或像素；
 * - 未知版本、混合分支、非法工具/颜色/数值、超限点集或越界引用一律拒绝；
 * - 内容身份纳入 base 资产、尺寸、版本化定义与输出/工程身份；相同输出 bytes 不因 checksum
 *   合并编辑版本，同 PNG 不同图层结构仍可区分。
 */
import { isBoundedId, isFiniteNumber, isJsonObject } from "./validation.js";
import { fnv1a64Hex } from "./content-hash.js";

/** 旧标注编辑定义契约版本；结构变化必须升版本。 */
export const IMAGE_EDIT_DOCUMENT_VERSION = "woohaa-image-edit-v1" as const;
export type ImageEditDocumentVersion = typeof IMAGE_EDIT_DOCUMENT_VERSION;

/** PhotoCraft 工程编辑定义契约版本。 */
export const IMAGE_PROJECT_DOCUMENT_VERSION = "woohaa-image-project-v1" as const;
export type ImageProjectDocumentVersion = typeof IMAGE_PROJECT_DOCUMENT_VERSION;

/** 受支持的图片编辑引擎标识。 */
export const IMAGE_PROJECT_ENGINE = "photocraft" as const;

/**
 * 宿主编辑能力版本。上游提交仍由 PHOTOCRAFT_ENGINE_COMMIT 单独核对；
 * 分组产物使用新标识，旧应用不能将其按扁平文档继续改写。
 */
export const PHOTOCRAFT_ENGINE_VERSION = "4e7a17cd5d5723313f459753663d0d155f047e19+woohaa-patterns-v1" as const;

/** 受支持的引擎版本集合：未知/过新引擎只读，不静默降级。 */
export const SUPPORTED_PHOTOCRAFT_ENGINE_VERSIONS: readonly string[] = [
  "4e7a17cd5d5723313f459753663d0d155f047e19",
  "4e7a17cd5d5723313f459753663d0d155f047e19+woohaa-groups-v1",
  "4e7a17cd5d5723313f459753663d0d155f047e19+woohaa-blends-v1",
  "4e7a17cd5d5723313f459753663d0d155f047e19+woohaa-fill-v1",
  "4e7a17cd5d5723313f459753663d0d155f047e19+woohaa-styles-v1",
  PHOTOCRAFT_ENGINE_VERSION
];

/**
 * 受支持的 `.pcraft` 文档格式版本集合（上游 `photocraft-format::FORMAT_VERSION`）。
 * 过新的格式版本被拒绝，工程保持只读。
 */
export const SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS: readonly number[] = [1];

/** 工程媒体类型：只在受控工程上传/读取链路使用。 */
export const IMAGE_PROJECT_CONTENT_TYPE = "application/vnd.woohaa.photocraft-project" as const;

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
 * PhotoCraft 工程编辑定义（`woohaa-image-project-v1`，design D4）。
 *
 * 只保存稳定引用与身份，**不**内嵌文档树、字体或像素。`canvasWidth`/`canvasHeight` 是裁剪后
 * 的当前画布尺寸，允许不等于原始来源尺寸；`outputAssetId`（节点字段）继续指向合成 PNG。
 */
export type ImageProjectDocument = {
  version: ImageProjectDocumentVersion;
  /** 固定引擎标识。 */
  engine: typeof IMAGE_PROJECT_ENGINE;
  /** 固定上游提交；未知版本只读。 */
  engineVersion: string;
  /** `.pcraft` 文档格式版本。 */
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

/** 是否为旧标注分支。 */
export function isLegacyImageEditDocument(doc: ImageEditDocument): doc is LegacyImageEditDocument {
  return doc.version === IMAGE_EDIT_DOCUMENT_VERSION;
}

/** 是否为工程分支。 */
export function isImageProjectDocument(doc: ImageEditDocument): doc is ImageProjectDocument {
  return doc.version === IMAGE_PROJECT_DOCUMENT_VERSION;
}

/** 数量、点、尺寸、线宽与序列化总大小上限（design D4）。 */
export const IMAGE_EDIT_LIMITS = {
  maxShapes: 128,
  maxPointsPerShape: 2048,
  maxSerializedBytes: 256 * 1024,
  minSourceDimension: 1,
  maxSourceDimension: 8192,
  maxSourcePixels: 8192 * 8192,
  minWidthInSourcePixels: 1,
  maxWidthInSourcePixels: 64
} as const;

/**
 * 工程分支上限（首期范围 notes/scope.md「首期资源上限」）。
 *
 * 这些是**输入拒绝边界**，不是性能保证。
 */
export const IMAGE_PROJECT_LIMITS = {
  /** 单个编辑画布/置入图单边上限。 */
  maxCanvasSide: 8192,
  /** 画布/置入图像素总量上限。 */
  maxCanvasPixels: 8192 * 8192,
  /** 文档层数上限（含背景、文字与调整层）。 */
  maxLayers: 64,
  /** 图案资源数量、单边及累计像素上限。 */
  maxPatterns: 64,
  maxPatternSide: 1024,
  maxPatternPixels: 4 * 1024 * 1024,
  /** 单工程压缩字节上限（64 MiB）；部署限制更低时取更低值。 */
  maxProjectBytes: 64 * 1024 * 1024,
  /** 工程解压后资源字节上限（256 MiB）。 */
  maxDecompressedResourceBytes: 256 * 1024 * 1024,
  /** 工程结构条目上限。 */
  maxEntries: 4096,
  /** 文档层级上限。 */
  maxDocumentDepth: 16,
  /** 单条目解压后上限。 */
  maxEntryDecompressedBytes: 128 * 1024 * 1024,
  /** 可引用的来源资产数量上限。 */
  maxSourceAssetIds: 64,
  /** 选区羽化范围（源像素）。 */
  maxFeatherSourcePixels: 100,
  /** 笔刷尺寸范围（源像素）。 */
  minBrushSizeSourcePixels: 1,
  maxBrushSizeSourcePixels: 512,
  /** 工程定义序列化字节上限。 */
  maxSerializedBytes: 256 * 1024,
  /**
   * PSD 交换预算（change: 2026-10-22-complete-photocraft-webui-editing，任务 1.4 / design D6）。
   *
   * 原始输入与单次导出各限 64 MiB；候选工程仍须满足既有保存预算。
   */
  maxPsdInputBytes: 64 * 1024 * 1024,
  maxPsdOutputBytes: 64 * 1024 * 1024,
  /** 跨文档图层载荷（`LayerTransferBundle`）原始字节与层数预算（design D5）。 */
  maxLayerTransferBytes: 64 * 1024 * 1024,
  maxLayerTransferLayers: 64,
  /** ABR／笔刷库预算（design D4）：单文件、单次导入、库总数、笔尖单边、累计像素与解码字节。 */
  maxAbrFileBytes: 32 * 1024 * 1024,
  maxAbrPresetsPerImport: 256,
  maxBrushLibraryPresets: 256,
  maxBrushTipSide: 1024,
  maxBrushResourcePixels: 16 * 1024 * 1024,
  maxBrushDecodedBytes: 128 * 1024 * 1024,
  /** 参数滤镜与选区修改的半径上限（源像素）。 */
  maxFilterRadius: 1000,
  maxSelectionRadius: 500,
  /** 直方图采样像素上限（与画布像素上限同量级，避免额外大分配）。 */
  maxHistogramSamples: 8192 * 8192,
  /** 工作区同时打开的文档数（含子文档）；运行政策，不写入工程格式。 */
  maxOpenDocuments: 8,
  /**
   * 矢量载荷预算（change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.2）。
   *
   * 与 `rust/project-limits.json` 同名同值，由 `contract-fixture.test.ts` 与
   * `limits_agree.rs` 双向核对；**解码前**按 manifest 计数累计，超限整份拒绝。
   */
  maxVectorSavedPaths: 256,
  maxVectorSubpaths: 4096,
  maxVectorKnotsPerSubpath: 4096,
  maxVectorPathPoints: 32768
} as const;

/** 受控色板（design D4：颜色从允许色板选择）。 */
export const IMAGE_EDIT_ALLOWED_COLORS = [
  "#ff8a1f",
  "#ff3b30",
  "#ffd23f",
  "#2f80ff",
  "#ffffff"
] as const;

const ALLOWED_COLOR_SET = new Set<string>(IMAGE_EDIT_ALLOWED_COLORS);

/** 归一化精度：坐标保留 1e-4，线宽保留 1e-3，避免浮点噪声改变身份。 */
const POINT_PRECISION = 1e4;
const WIDTH_PRECISION = 1e3;

/** 64 位小写 hex（工程对象的字节 checksum，SHA-256）。 */
const HEX64 = /^[0-9a-f]{64}$/;
/** 16 位小写 hex（规范文档内容指纹，FNV-1a 64；与 `fnv1a64Hex` 一致，浏览器/Rust 可复现）。 */
const HEX16 = /^[0-9a-f]{16}$/;

export type ImageEditValidationResult =
  | { ok: true; value: ImageEditDocument }
  | { ok: false; error: string };

/** 归一化单个点：四舍五入到固定精度（不改变有效范围）。 */
export function normalizeImageEditPoint(point: ImageEditPoint): ImageEditPoint {
  return {
    x: Math.round(point.x * POINT_PRECISION) / POINT_PRECISION,
    y: Math.round(point.y * POINT_PRECISION) / POINT_PRECISION
  };
}

/** 归一化线宽：四舍五入到固定精度。 */
export function normalizeImageEditWidth(width: number): number {
  return Math.round(width * WIDTH_PRECISION) / WIDTH_PRECISION;
}

/**
 * shape sanitizer（严格模式）：任何非法工具/颜色/线宽/点集返回 `null`。
 *
 * 未知字段被丢弃；坐标越界、非有限数值或点数超限视为非法（拒绝整个文档）。
 */
export function sanitizeImageEditShape(input: unknown): ImageEditShape | null {
  if (!isJsonObject(input)) return null;
  const id = isBoundedId(input.id) ? input.id : null;
  if (!id) return null;
  const tool: ImageEditTool | null = input.tool === "pen" || input.tool === "rect" ? input.tool : null;
  if (!tool) return null;
  const color = typeof input.color === "string" && ALLOWED_COLOR_SET.has(input.color) ? input.color : null;
  if (!color) return null;
  const rawWidth = input.widthInSourcePixels;
  if (
    !isFiniteNumber(rawWidth) ||
    rawWidth < IMAGE_EDIT_LIMITS.minWidthInSourcePixels ||
    rawWidth > IMAGE_EDIT_LIMITS.maxWidthInSourcePixels
  ) {
    return null;
  }
  const widthInSourcePixels = normalizeImageEditWidth(rawWidth);
  const rawPoints = Array.isArray(input.points) ? input.points : null;
  if (!rawPoints) return null;
  if (rawPoints.length > IMAGE_EDIT_LIMITS.maxPointsPerShape) return null;
  const points: ImageEditPoint[] = [];
  for (const raw of rawPoints) {
    const point = sanitizeImageEditPoint(raw);
    if (!point) return null;
    points.push(point);
  }
  if (tool === "rect") {
    if (points.length !== 2) return null;
  } else if (points.length < 2) {
    return null;
  }
  return { id, tool, color, widthInSourcePixels, points };
}

/** 归一化内容坐标点：分量必须是 `[0, 1]` 的有限数值。 */
export function sanitizeImageEditPoint(input: unknown): ImageEditPoint | null {
  if (!isJsonObject(input)) return null;
  const { x, y } = input;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return normalizeImageEditPoint({ x, y });
}

/** 读取受支持的原始像素尺寸；非法返回 null。 */
function readSourceDimension(input: unknown): number | null {
  if (!isNonNegativeIntegerSafe(input)) return null;
  if (input < IMAGE_EDIT_LIMITS.minSourceDimension) return null;
  if (input > IMAGE_EDIT_LIMITS.maxSourceDimension) return null;
  return Math.floor(input);
}

/** 读取受支持的当前画布尺寸；非法返回 null。 */
function readCanvasDimension(input: unknown): number | null {
  if (!isNonNegativeIntegerSafe(input)) return null;
  if (input < 1) return null;
  if (input > IMAGE_PROJECT_LIMITS.maxCanvasSide) return null;
  return Math.floor(input);
}

function isNonNegativeIntegerSafe(input: unknown): input is number {
  return typeof input === "number" && Number.isInteger(input) && input >= 0;
}

/**
 * 解析 v1 标注分支（严格）。成功时返回带规范化 point/width 的新对象（不修改入参）。
 */
function decodeLegacyImageEditDocument(input: Record<string, unknown>): ImageEditValidationResult {
  const baseAssetId = isBoundedId(input.baseAssetId) ? input.baseAssetId : null;
  if (!baseAssetId) return { ok: false, error: "imageEdit 缺少合法 baseAssetId" };
  if (input.project !== undefined) return { ok: false, error: "imageEdit 混合了标注与工程分支" };
  const sourceWidth = readSourceDimension(input.sourceWidth);
  const sourceHeight = readSourceDimension(input.sourceHeight);
  if (sourceWidth === null || sourceHeight === null) return { ok: false, error: "imageEdit 源尺寸非法" };
  if (sourceWidth * sourceHeight > IMAGE_EDIT_LIMITS.maxSourcePixels) {
    return { ok: false, error: "imageEdit 源像素超过上限" };
  }
  const rawShapes = Array.isArray(input.shapes) ? input.shapes : null;
  if (!rawShapes) return { ok: false, error: "imageEdit shapes 必须是数组" };
  if (rawShapes.length > IMAGE_EDIT_LIMITS.maxShapes) {
    return { ok: false, error: `imageEdit shapes 超过 ${IMAGE_EDIT_LIMITS.maxShapes} 上限` };
  }
  const shapes: ImageEditShape[] = [];
  const seen = new Set<string>();
  for (const raw of rawShapes) {
    const shape = sanitizeImageEditShape(raw);
    if (!shape) return { ok: false, error: "imageEdit 包含非法或超限 shape" };
    if (seen.has(shape.id)) return { ok: false, error: `imageEdit shape id 重复：${shape.id}` };
    seen.add(shape.id);
    shapes.push(shape);
  }
  const value: LegacyImageEditDocument = {
    version: IMAGE_EDIT_DOCUMENT_VERSION,
    baseAssetId,
    sourceWidth,
    sourceHeight,
    shapes
  };
  if (serializedByteLength(value) > IMAGE_EDIT_LIMITS.maxSerializedBytes) {
    return { ok: false, error: "imageEdit 序列化超过字节上限" };
  }
  return { ok: true, value };
}

/**
 * 解析工程分支（严格，design D4）。
 *
 * 未知引擎/格式版本、非法数值、越界引用、混合分支或非工程 MIME 一律拒绝。
 */
function decodeImageProjectDocument(input: Record<string, unknown>): ImageEditValidationResult {
  if (input.shapes !== undefined) return { ok: false, error: "工程定义不得携带 shapes" };
  if (input.engine !== IMAGE_PROJECT_ENGINE) return { ok: false, error: "工程定义引擎不受支持" };
  const engineVersion = input.engineVersion;
  if (typeof engineVersion !== "string" || !SUPPORTED_PHOTOCRAFT_ENGINE_VERSIONS.includes(engineVersion)) {
    return { ok: false, error: "工程定义引擎版本不受支持" };
  }
  if (!isNonNegativeIntegerSafe(input.formatVersion) || !SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS.includes(input.formatVersion)) {
    return { ok: false, error: "工程定义格式版本不受支持" };
  }
  const baseAssetId = isBoundedId(input.baseAssetId) ? input.baseAssetId : null;
  if (!baseAssetId) return { ok: false, error: "工程定义缺少合法 baseAssetId" };
  const sourceWidth = readSourceDimension(input.sourceWidth);
  const sourceHeight = readSourceDimension(input.sourceHeight);
  if (sourceWidth === null || sourceHeight === null) return { ok: false, error: "工程定义来源尺寸非法" };
  if (sourceWidth * sourceHeight > IMAGE_EDIT_LIMITS.maxSourcePixels) {
    return { ok: false, error: "工程定义来源像素超过上限" };
  }
  const canvasWidth = readCanvasDimension(input.canvasWidth);
  const canvasHeight = readCanvasDimension(input.canvasHeight);
  if (canvasWidth === null || canvasHeight === null) return { ok: false, error: "工程定义画布尺寸非法" };
  if (canvasWidth * canvasHeight > IMAGE_PROJECT_LIMITS.maxCanvasPixels) {
    return { ok: false, error: "工程定义画布像素超过上限" };
  }
  const documentContentHash = input.documentContentHash;
  if (typeof documentContentHash !== "string" || !HEX16.test(documentContentHash)) {
    return { ok: false, error: "工程定义文档内容 hash 非法" };
  }
  const project = decodeImageEditProjectObjectRef(input.project);
  if (!project) return { ok: false, error: "工程定义缺少合法工程对象 metadata" };
  const sourceAssetIds = decodeSourceAssetIds(input.sourceAssetIds);
  if (!sourceAssetIds) return { ok: false, error: "工程定义来源资产引用非法" };
  if (!sourceAssetIds.includes(baseAssetId)) {
    return { ok: false, error: "工程定义来源资产引用缺少 baseAssetId" };
  }
  const value: ImageProjectDocument = {
    version: IMAGE_PROJECT_DOCUMENT_VERSION,
    engine: IMAGE_PROJECT_ENGINE,
    engineVersion,
    formatVersion: input.formatVersion,
    baseAssetId,
    sourceWidth,
    sourceHeight,
    canvasWidth,
    canvasHeight,
    documentContentHash,
    project,
    sourceAssetIds
  };
  if (serializedByteLength(value) > IMAGE_PROJECT_LIMITS.maxSerializedBytes) {
    return { ok: false, error: "工程定义序列化超过字节上限" };
  }
  return { ok: true, value };
}

/** 校验工程对象稳定 metadata。 */
export function decodeImageEditProjectObjectRef(input: unknown): ImageEditProjectObjectRef | null {
  if (!isJsonObject(input)) return null;
  const storageKey = typeof input.storageKey === "string" ? input.storageKey : "";
  if (!/^sha256-[0-9a-f]{64}$/.test(storageKey)) return null;
  if (typeof input.checksum !== "string" || !HEX64.test(input.checksum)) return null;
  if (input.contentType !== IMAGE_PROJECT_CONTENT_TYPE) return null;
  if (!isNonNegativeIntegerSafe(input.size) || input.size === 0) return null;
  if (input.size > IMAGE_PROJECT_LIMITS.maxProjectBytes) return null;
  return { storageKey, checksum: input.checksum, contentType: IMAGE_PROJECT_CONTENT_TYPE, size: input.size };
}

/** 校验来源资产引用列表：有界、去重、稳定顺序（保持入参顺序）。 */
export function decodeSourceAssetIds(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length === 0 || input.length > IMAGE_PROJECT_LIMITS.maxSourceAssetIds) return null;
  const seen = new Set<string>();
  const value: string[] = [];
  for (const raw of input) {
    if (!isBoundedId(raw)) return null;
    if (seen.has(raw)) return null;
    seen.add(raw);
    value.push(raw);
  }
  return value;
}

/**
 * 严格解析/归一化 `ImageEditDocument` 严格联合（canonical 边界，不受信任输入）。
 *
 * - 只接受两个已知版本；混合分支（同时带 shapes 与 project）一律拒绝；
 * - 未知工具/颜色、非法数值、超限点集、越界引用或总字节超限 → 失败；
 * - 成功时返回带规范化 point/width 的新对象（不修改入参）。
 */
export function decodeImageEditDocument(input: unknown): ImageEditValidationResult {
  if (!isJsonObject(input)) return { ok: false, error: "imageEdit 必须是对象" };
  if (input.version === IMAGE_EDIT_DOCUMENT_VERSION) return decodeLegacyImageEditDocument(input);
  if (input.version === IMAGE_PROJECT_DOCUMENT_VERSION) return decodeImageProjectDocument(input);
  return { ok: false, error: "imageEdit 版本不受支持" };
}

/** 是否为合法的零 shape 编辑结果（表示清除全部标记回到原图）。 */
export function isEmptyImageEditDocument(doc: ImageEditDocument): boolean {
  return isLegacyImageEditDocument(doc) && doc.shapes.length === 0;
}

/** 读取编辑定义的 shape 列表（工程分支没有 shapes，返回空数组）。 */
export function imageEditShapesOf(doc: ImageEditDocument): readonly ImageEditShape[] {
  return isLegacyImageEditDocument(doc) ? doc.shapes : [];
}

/**
 * 规范化后的 shape 指纹（不含 base/尺寸/输出）。
 *
 * 同一标注内容在不同缩放/DPR/请求重试下映射同一 hash；输出 bytes 相同但 shape 不同的
 * 编辑版本因此互不冒充。工程分支没有 shapes，返回空 shape 指纹（其身份由
 * `imageEditDefinitionHash` / `imageEditContentIdentity` 的工程分支承担）。
 */
export function imageEditShapesHash(doc: { shapes?: readonly ImageEditShape[] }): string {
  return fnv1a64Hex(canonicalShapes(doc.shapes ?? []));
}

/**
 * 图片编辑定义身份（不依赖输出字节）：v1 为 base/尺寸/shapes；工程为引擎/格式版本、
 * base/来源/画布尺寸与文档内容 hash。
 */
export function imageEditDefinitionHash(doc: ImageEditDocument): string {
  if (isImageProjectDocument(doc)) {
    return fnv1a64Hex(
      [
        "project",
        doc.engine,
        doc.engineVersion,
        String(doc.formatVersion),
        doc.baseAssetId,
        `${doc.sourceWidth}x${doc.sourceHeight}`,
        `${doc.canvasWidth}x${doc.canvasHeight}`,
        doc.documentContentHash
      ].join("\u0000")
    );
  }
  return fnv1a64Hex(
    [
      doc.baseAssetId,
      `${doc.sourceWidth}x${doc.sourceHeight}`,
      canonicalShapes(doc.shapes)
    ].join("\u0000")
  );
}

/**
 * 图片编辑内容身份（design D4）：`base 身份/尺寸/定义身份/输出身份`。
 *
 * 与纯媒体身份（`media:<storageKey>`）刻意分离：相同图片 bytes 对应不同可编辑定义时
 * 不被合并；纯媒体版本继续使用既有稳定媒体身份。工程分支还纳入工程对象稳定身份，使同 PNG
 * 不同图层结构可区分。
 */
export function imageEditContentIdentity(input: {
  baseStorageKey: string;
  sourceWidth: number;
  sourceHeight: number;
  shapes: readonly ImageEditShape[];
  outputStorageKey: string;
}): string {
  return [
    "image-edit",
    input.baseStorageKey,
    `${input.sourceWidth}x${input.sourceHeight}`,
    fnv1a64Hex(canonicalShapes(input.shapes)),
    input.outputStorageKey
  ].join(":");
}

/** 从已解码编辑定义与稳定 metadata 派生内容身份（v1 与工程分支统一入口）。 */
export function imageEditDocumentContentIdentity(input: {
  document: ImageEditDocument;
  baseStorageKey: string;
  outputStorageKey: string;
}): string {
  const doc = input.document;
  if (isImageProjectDocument(doc)) {
    return [
      "image-project",
      input.baseStorageKey,
      `${doc.sourceWidth}x${doc.sourceHeight}`,
      `${doc.canvasWidth}x${doc.canvasHeight}`,
      doc.engineVersion,
      String(doc.formatVersion),
      doc.documentContentHash,
      doc.project.storageKey,
      input.outputStorageKey
    ].join(":");
  }
  return imageEditContentIdentity({
    baseStorageKey: input.baseStorageKey,
    sourceWidth: doc.sourceWidth,
    sourceHeight: doc.sourceHeight,
    shapes: doc.shapes,
    outputStorageKey: input.outputStorageKey
  });
}

/**
 * 比较进入基线与当前编辑内容是否有**净变化**（design D4/D5）。
 *
 * - v1：与原语义一致（切工具、颜色偏好、zoom 与 undo 栈不是内容）；
 * - 工程：以文档内容 hash 为准，转换 v1、创建背景或初始化工程不算净变化；
 * - 纯媒体归一化为「无定义」；跨分支（v1 ↔ 工程）恒为净变化。
 */
export function imageEditHasNetChange(
  baseline: ImageEditDocument | null,
  current: ImageEditDocument | null
): boolean {
  if (baseline === null && current === null) return false;
  const left = baseline;
  const right = current;
  if ((left === null) !== (right === null)) {
    // 一侧无定义：只有两侧都「无内容」才不算变化。
    const content = left ?? right;
    if (!content) return false;
    if (isImageProjectDocument(content)) return true;
    return content.shapes.length > 0;
  }
  if (!left || !right) return false;
  if (isImageProjectDocument(left) !== isImageProjectDocument(right)) return true;
  if (isImageProjectDocument(left) && isImageProjectDocument(right)) {
    return imageEditDefinitionHash(left) !== imageEditDefinitionHash(right);
  }
  const leftLegacy = left as LegacyImageEditDocument;
  const rightLegacy = right as LegacyImageEditDocument;
  if (imageEditShapesHash({ shapes: leftLegacy.shapes }) !== imageEditShapesHash({ shapes: rightLegacy.shapes })) {
    return true;
  }
  // 无 shape 内容：纯媒体与零 shape 编辑等价，不算净变化。
  if (leftLegacy.shapes.length === 0) return false;
  // 相同非空 shapes：原图/尺寸不同仍算内容变化（不同原图）。
  return (
    leftLegacy.baseAssetId !== rightLegacy.baseAssetId ||
    leftLegacy.sourceWidth !== rightLegacy.sourceWidth ||
    leftLegacy.sourceHeight !== rightLegacy.sourceHeight
  );
}

function canonicalShapes(shapes: readonly ImageEditShape[]): string {
  return shapes
    .map((shape) => {
      const points = shape.points
        .map((point) => `${normalizeImageEditPoint(point).x},${normalizeImageEditPoint(point).y}`)
        .join(";");
      return `${shape.id}|${shape.tool}|${shape.color}|${normalizeImageEditWidth(shape.widthInSourcePixels)}|${points}`;
    })
    .join("\n");
}

/** 序列化 UTF-8 字节长度（无 TextEncoder 时保守估算）。 */
function serializedByteLength(value: unknown): number {
  const text = JSON.stringify(value);
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
