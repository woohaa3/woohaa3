/** Generic persisted image-edit snapshots and stable media identities.
 * Editor-specific versions, formats and archive validation belong to extensions.
 * The legacy annotation envelope remains readable for existing saved canvases.
 */
import { isBoundedId, isFiniteNumber, isJsonObject } from "../validation.js";
import { fnv1a64Hex } from "./content-hash.js";

export * from "./image-edit-types.js";
import {
  IMAGE_EDIT_DOCUMENT_VERSION, IMAGE_PROJECT_DOCUMENT_VERSION,
  type ImageEditDocument, type LegacyImageEditDocument, type ImageProjectDocument,
  type ImageEditProjectObjectRef, type ImageEditPoint, type ImageEditShape, type ImageEditTool
} from "./image-edit-types.js";

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
  maxCanvasSide: 8192, maxCanvasPixels: 8192 * 8192,
  maxProjectBytes: 64 * 1024 * 1024, maxSourceAssetIds: 64,
  maxSerializedBytes: 256 * 1024
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
  if (!isBoundedId(input.engine)) return { ok: false, error: "工程定义引擎不受支持" };
  const engineVersion = input.engineVersion;
  if (typeof engineVersion !== "string" || engineVersion.length === 0 || engineVersion.length > 200) {
    return { ok: false, error: "工程定义引擎版本不受支持" };
  }
  if (!isNonNegativeIntegerSafe(input.formatVersion) || input.formatVersion < 1) {
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
    engine: input.engine,
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
  if (typeof input.contentType !== "string" || !/^application\/[a-z0-9][a-z0-9.+-]{0,126}$/.test(input.contentType)) return null;
  if (!isNonNegativeIntegerSafe(input.size) || input.size === 0) return null;
  if (input.size > IMAGE_PROJECT_LIMITS.maxProjectBytes) return null;
  return { storageKey, checksum: input.checksum, contentType: input.contentType, size: input.size };
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
