/**
 * 图片工程（`.pcraft`）有界内容核验
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 2.3 / design D5）。
 *
 * Media 的受限工程 ingest 先做**结构核验**再做内容寻址写入：只接受本应用生成的自包含工程。
 * 核验覆盖：
 * - ZIP 容器：签名、条目数、加密/压缩方法、中央目录边界；
 * - 有界解压：单条目、总解压字节与清单大小上限（拒绝压缩炸弹）；
 * - manifest：格式版本、画布尺寸/像素、层数与层级；
 * - 引用完整性：tile/blob 引用必须是 64 位 hex 且存在于容器内（拒绝外链/缺资源）；
 * - 首期能力：拒绝未开放对象类型、智能滤镜命令、外部文件链接与脚本/插件对象。
 *
 * 关键约束：
 * - 只读内存字节，绝不落盘、绝不请求外部地址、绝不执行工程内任何内容；
 * - 核验失败返回稳定原因，不产生可被节点关联的合法工程 metadata；
 * - 核验与写入共用同一份上限常量（`IMAGE_PROJECT_LIMITS`，来自 `@woohaa3/photocraft-protocol`）。
 *
 * 归属（change: 2026-10-21-extract-photocraft-subproject，任务 3.1 / design D5）：本模块已迁入
 * PhotoCraft 的 Node 核验包。Media 只经公共入口调用，仍拥有上传路由、认证、部署更低上限、
 * 内容寻址、错误映射与引用保留；接收政策没有因此放宽。
 */
import { inflateRawSync } from "node:zlib";
import {
  IMAGE_PROJECT_CONTENT_TYPE,
  IMAGE_PROJECT_LIMITS,
  SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS,
  isSupportedImageProjectEffects,
  isSupportedImageProjectPatterns,
  IMAGE_PROJECT_BLEND_MODES
} from "@woohaa3/photocraft-protocol";

/** 工程媒体类型：Media 与本核验器共用同一常量，避免两处字面量漂移。 */
export { IMAGE_PROJECT_CONTENT_TYPE } from "@woohaa3/photocraft-protocol";

export type ProjectVerificationErrorCode =
  | "not-a-zip"
  | "corrupt-container"
  | "encrypted-entry"
  | "unsupported-compression"
  | "too-many-entries"
  | "compressed-too-large"
  | "decompressed-too-large"
  | "entry-too-large"
  | "missing-manifest"
  | "invalid-manifest"
  | "unsupported-format-version"
  | "canvas-too-large"
  | "too-many-layers"
  | "too-deep"
  | "path-traversal"
  | "missing-resource"
  | "external-reference"
  | "unsupported-object"
  | "unsupported-content-type";

export class ProjectVerificationError extends Error {
  readonly code: ProjectVerificationErrorCode;

  constructor(code: ProjectVerificationErrorCode, message: string) {
    super(message);
    this.name = "ProjectVerificationError";
    this.code = code;
  }
}

/** 核验通过后的安全摘要（不含文档内容与像素）。 */
export type ProjectVerificationSummary = {
  formatVersion: number;
  generator: string;
  canvasWidth: number;
  canvasHeight: number;
  layerCount: number;
  depth: number;
  entryCount: number;
  decompressedBytes: number;
  /** 工程内使用的对象类型（首期白名单子集）。 */
  objectKinds: string[];
};

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const EOCD_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;

/** 首期允许的 manifest 对象类型（上游 `ContentM` 的 serde tag）。 */
const ALLOWED_OBJECT_KINDS = new Set(["raster", "adjustment", "text", "group"]);
/** 首期允许的调整层类型。 */
const ALLOWED_ADJUSTMENT_IDS = new Set(["brightnessContrast", "hueSaturation", "curves"]);
/** 明确拒绝的对象类型。 */
const REJECTED_OBJECT_KINDS = new Set(["smart", "shape", "fill"]);

type ZipEntry = {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  flags: number;
  localHeaderOffset: number;
};

/**
 * 有界核验一份工程字节；失败抛出 `ProjectVerificationError`（稳定 code + 原因）。
 *
 * @param bytes 工程 ZIP 字节（内存）
 * @param options.maxBytes 部署更低的压缩上限（取更小值）
 */
export function verifyPhotocraftProject(
  bytes: Uint8Array,
  options: { maxBytes?: number } = {}
): ProjectVerificationSummary {
  return inspectProject(bytes, options, false);
}

/** 仅检查嵌入 Smart 工程的外层结构；必须另经原生工具核验源树才能接收。 */
export function inspectEmbeddedPhotocraftProject(bytes: Uint8Array, options: { maxBytes?: number } = {}): ProjectVerificationSummary {
  return inspectProject(bytes, options, true);
}

function inspectProject(bytes: Uint8Array, options: { maxBytes?: number }, embeddedSmart: boolean): ProjectVerificationSummary {
  const maxCompressed = Math.min(options.maxBytes ?? IMAGE_PROJECT_LIMITS.maxProjectBytes, IMAGE_PROJECT_LIMITS.maxProjectBytes);
  if (bytes.byteLength === 0) throw new ProjectVerificationError("not-a-zip", "工程内容为空");
  if (bytes.byteLength > maxCompressed) {
    throw new ProjectVerificationError("compressed-too-large", `工程压缩字节超过上限：${bytes.byteLength} > ${maxCompressed}`);
  }
  const entries = readCentralDirectory(bytes);
  if (entries.length > IMAGE_PROJECT_LIMITS.maxEntries) {
    throw new ProjectVerificationError("too-many-entries", `工程条目超过 ${IMAGE_PROJECT_LIMITS.maxEntries}`);
  }
  const byName = new Map<string, ZipEntry>();
  let declaredTotal = 0;
  for (const entry of entries) {
    assertSafeEntryName(entry.name);
    if (byName.has(entry.name)) continue;
    byName.set(entry.name, entry);
    if (entry.flags & 0x1) throw new ProjectVerificationError("encrypted-entry", `工程包含加密条目：${entry.name}`);
    if (entry.compression !== 0 && entry.compression !== 8) {
      throw new ProjectVerificationError("unsupported-compression", `工程包含不支持的压缩方法：${entry.name}`);
    }
    if (entry.uncompressedSize > IMAGE_PROJECT_LIMITS.maxEntryDecompressedBytes) {
      throw new ProjectVerificationError("entry-too-large", `工程单条目解压后超过上限：${entry.name}`);
    }
    declaredTotal += entry.uncompressedSize;
  }
  if (declaredTotal > IMAGE_PROJECT_LIMITS.maxDecompressedResourceBytes) {
    throw new ProjectVerificationError(
      "decompressed-too-large",
      `工程解压后资源字节超过上限：${declaredTotal} > ${IMAGE_PROJECT_LIMITS.maxDecompressedResourceBytes}`
    );
  }
  const manifestEntry = byName.get("manifest.json");
  if (!manifestEntry) throw new ProjectVerificationError("missing-manifest", "工程缺少 manifest.json");
  const manifestBytes = readEntry(bytes, manifestEntry, {
    maxBytes: IMAGE_PROJECT_LIMITS.maxEntryDecompressedBytes
  });
  const manifest = parseManifest(manifestBytes);
  const summary = inspectManifest(manifest, embeddedSmart);
  assertResourcesPresent(byName, manifest);
  return {
    ...summary,
    entryCount: entries.length,
    decompressedBytes: declaredTotal
  };
}

/** 供 ingest 直接判定：`application/vnd.woohaa.photocraft-project` 且核验通过。 */
export function verifyPhotocraftProjectForIngest(
  bytes: Uint8Array,
  contentType: string,
  options: { maxBytes?: number } = {}
): ProjectVerificationSummary {
  if (contentType !== IMAGE_PROJECT_CONTENT_TYPE) {
    throw new ProjectVerificationError("unsupported-content-type", `不是工程媒体类型：${contentType || "(空)"}`);
  }
  return verifyPhotocraftProject(bytes, options);
}

function assertSafeEntryName(name: string): void {
  if (name.length === 0 || name.length > 1024) throw new ProjectVerificationError("corrupt-container", "工程条目名非法");
  if (name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:/.test(name)) {
    throw new ProjectVerificationError("path-traversal", `工程条目使用绝对路径：${name}`);
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new ProjectVerificationError("path-traversal", `工程条目包含路径穿越：${name}`);
  }
  if (name.includes("\\")) throw new ProjectVerificationError("path-traversal", `工程条目包含反斜杠路径：${name}`);
}

/** 只读中央目录（有界），不解压任何内容。 */
function readCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // EOCD 位于文件末尾，注释最长 65535 字节。
  const searchStart = Math.max(0, bytes.byteLength - EOCD_MIN_BYTES - MAX_COMMENT_BYTES);
  let eocd = -1;
  for (let offset = bytes.byteLength - EOCD_MIN_BYTES; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIG) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new ProjectVerificationError("not-a-zip", "工程不是合法的 ZIP 容器");
  const entryCount = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const centralSize = view.getUint32(eocd + 12, true);
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    throw new ProjectVerificationError("corrupt-container", "不支持 ZIP64 工程");
  }
  if (centralOffset + centralSize > bytes.byteLength) {
    throw new ProjectVerificationError("corrupt-container", "工程中央目录越界");
  }
  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.byteLength) throw new ProjectVerificationError("corrupt-container", "工程中央目录被截断");
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_SIG) {
      throw new ProjectVerificationError("corrupt-container", "工程中央目录条目签名非法");
    }
    const flags = view.getUint16(cursor + 8, true);
    const compression = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    if (nameLength === 0 || nameLength > 1024) {
      throw new ProjectVerificationError("corrupt-container", "工程条目名长度非法");
    }
    const nameStart = cursor + 46;
    if (nameStart + nameLength > bytes.byteLength) {
      throw new ProjectVerificationError("corrupt-container", "工程条目名越界");
    }
    const name = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.push({ name, compression, compressedSize, uncompressedSize, flags, localHeaderOffset });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 有界读取并解压单个条目。 */
function readEntry(bytes: Uint8Array, entry: ZipEntry, options: { maxBytes: number }): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localHeaderOffset;
  if (offset + 30 > bytes.byteLength) throw new ProjectVerificationError("corrupt-container", "工程条目本地头越界");
  if (view.getUint32(offset, true) !== ZIP_LOCAL_SIG) {
    throw new ProjectVerificationError("corrupt-container", "工程条目本地头签名非法");
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.byteLength) throw new ProjectVerificationError("corrupt-container", "工程条目数据越界");
  const raw = bytes.subarray(dataStart, dataEnd);
  let out: Uint8Array;
  if (entry.compression === 0) {
    out = raw;
  } else {
    try {
      // 有界解压：先按声明长度 + 少量冗余解码，再核对实际长度，避免解压炸弹。
      out = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.min(options.maxBytes, IMAGE_PROJECT_LIMITS.maxEntryDecompressedBytes) }));
    } catch {
      throw new ProjectVerificationError("corrupt-container", `工程条目解压失败：${entry.name}`);
    }
  }
  if (out.byteLength > options.maxBytes) {
    throw new ProjectVerificationError("entry-too-large", `工程条目解压后超过上限：${entry.name}`);
  }
  if (entry.uncompressedSize !== 0 && out.byteLength !== entry.uncompressedSize) {
    throw new ProjectVerificationError("corrupt-container", `工程条目声明长度与实际不符：${entry.name}`);
  }
  return out;
}

function parseManifest(bytes: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ProjectVerificationError("invalid-manifest", "工程 manifest.json 不是合法 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProjectVerificationError("invalid-manifest", "工程 manifest.json 结构非法");
  }
  return parsed as Record<string, unknown>;
}

type ManifestInspection = Omit<ProjectVerificationSummary, "entryCount" | "decompressedBytes">;

/** 检查 manifest 的版本、画布、层数与对象类型；返回可公开的安全摘要。 */
function inspectManifest(manifest: Record<string, unknown>, embeddedSmart = false): ManifestInspection {
  const formatVersion = manifest.format_version;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new ProjectVerificationError("invalid-manifest", "工程缺少合法 format_version");
  }
  if (!SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS.includes(formatVersion)) {
    throw new ProjectVerificationError("unsupported-format-version", `工程格式版本不受支持：${formatVersion}`);
  }
  const generator = typeof manifest.generator === "string" ? manifest.generator.slice(0, 200) : "";
  const document = manifest.document;
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new ProjectVerificationError("invalid-manifest", "工程缺少 document");
  }
  const doc = document as Record<string, unknown>;
  if (!isSupportedImageProjectPatterns(doc.patterns)) throw new ProjectVerificationError("unsupported-object", "工程图案资源超限或格式不受支持");
  const size = doc.size;
  if (typeof size !== "object" || size === null) throw new ProjectVerificationError("invalid-manifest", "工程缺少画布尺寸");
  const width = readDimension((size as Record<string, unknown>).width);
  const height = readDimension((size as Record<string, unknown>).height);
  if (width === null || height === null) throw new ProjectVerificationError("invalid-manifest", "工程画布尺寸非法");
  if (width > IMAGE_PROJECT_LIMITS.maxCanvasSide || height > IMAGE_PROJECT_LIMITS.maxCanvasSide) {
    throw new ProjectVerificationError("canvas-too-large", `工程画布单边超过上限：${width}x${height}`);
  }
  if (width * height > IMAGE_PROJECT_LIMITS.maxCanvasPixels) {
    throw new ProjectVerificationError("canvas-too-large", `工程画布像素超过上限：${width}x${height}`);
  }
  const layers = doc.layers;
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new ProjectVerificationError("invalid-manifest", "工程缺少图层");
  }
  const objectKinds = new Set<string>();
  const counters = { count: 0, depth: 0 };
  inspectLayers(layers, 1, counters, objectKinds,(doc.patterns as unknown[]|undefined)??[], embeddedSmart);
  if (counters.count > IMAGE_PROJECT_LIMITS.maxLayers) {
    throw new ProjectVerificationError("too-many-layers", `工程层数超过上限：${counters.count} > ${IMAGE_PROJECT_LIMITS.maxLayers}`);
  }
  if (counters.depth > IMAGE_PROJECT_LIMITS.maxDocumentDepth) {
    throw new ProjectVerificationError("too-deep", `工程文档层级超过上限：${counters.depth} > ${IMAGE_PROJECT_LIMITS.maxDocumentDepth}`);
  }
  return {
    formatVersion,
    generator,
    canvasWidth: width,
    canvasHeight: height,
    layerCount: counters.count,
    depth: counters.depth,
    objectKinds: [...objectKinds].sort()
  };
}

function readDimension(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  return value;
}

/** 递归检查图层树：层数、层级、对象类型、智能滤镜与外部链接。 */
function inspectLayers(
  layers: unknown[],
  depth: number,
  counters: { count: number; depth: number },
  objectKinds: Set<string>,
  patterns: unknown[],
  embeddedSmart = false
): void {
  if (depth > IMAGE_PROJECT_LIMITS.maxDocumentDepth) {
    throw new ProjectVerificationError("too-deep", "工程文档层级超过上限");
  }
  counters.depth = Math.max(counters.depth, depth);
  for (const raw of layers) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ProjectVerificationError("invalid-manifest", "工程图层结构非法");
    }
    const layer = raw as Record<string, unknown>;
    counters.count += 1;
    if (counters.count > IMAGE_PROJECT_LIMITS.maxLayers) {
      throw new ProjectVerificationError("too-many-layers", `工程层数超过上限：${IMAGE_PROJECT_LIMITS.maxLayers}`);
    }
    if (layer.fill_opacity !== undefined && (typeof layer.fill_opacity !== "number" || !Number.isFinite(layer.fill_opacity) || layer.fill_opacity < 0 || layer.fill_opacity > 1)) {
      throw new ProjectVerificationError("unsupported-object", "工程填充不透明度无效");
    }
    if (layer.effects !== undefined && !isSupportedImageProjectEffects(layer.effects,patterns)) {
      throw new ProjectVerificationError("unsupported-object", "工程包含未开放或超限的图层样式");
    }
    const content = layer.content;
    if (typeof content !== "object" || content === null || Array.isArray(content)) {
      throw new ProjectVerificationError("invalid-manifest", "工程图层缺少内容");
    }
    const kind = (content as Record<string, unknown>).kind;
    if (typeof kind !== "string") throw new ProjectVerificationError("invalid-manifest", "工程图层缺少内容类型");
    if (layer.blend !== undefined) {
      const blend = typeof layer.blend === "string" ? layer.blend.replace(/-/g, "").toLowerCase() : "";
      if (!IMAGE_PROJECT_BLEND_MODES.some(mode => mode.replace(/-/g, "") === blend)
          || (blend === "passthrough" && kind !== "group")) {
        throw new ProjectVerificationError("unsupported-object", "工程包含未开放的混合模式");
      }
    }
    objectKinds.add(kind);
    if (!(embeddedSmart && kind === "smart") && (REJECTED_OBJECT_KINDS.has(kind) || !ALLOWED_OBJECT_KINDS.has(kind))) {
      throw new ProjectVerificationError("unsupported-object", `工程包含首期未开放的对象类型：${kind}`);
    }
    if (kind === "smart") inspectSmart(content as Record<string, unknown>);
    if (kind === "adjustment") inspectAdjustment(content as Record<string, unknown>);
    if (kind === "raster") inspectRasterSources(content as Record<string, unknown>);
    if (kind === "group") {
      const group = content as Record<string, unknown>;
      if (group.artboard != null) {
        throw new ProjectVerificationError("unsupported-object", "工程包含画板");
      }
      if (!Array.isArray(group.children) || typeof group.expanded !== "boolean") {
        throw new ProjectVerificationError("invalid-manifest", "工程分组结构非法");
      }
      if (group.children.length > 0) inspectLayers(group.children, depth + 1, counters, objectKinds,patterns,embeddedSmart);
    }
    // 智能滤镜（任意命令）一律拒绝：它们能指向上游行为而非首期子集。
    if (layer.smart_filters !== undefined || (kind !== "smart" && (content as Record<string, unknown>).smart_filters !== undefined)) {
      throw new ProjectVerificationError("unsupported-object", "工程包含智能滤镜");
    }
    // 视频/外部文件链接拒绝（工程必须自包含）。
    if (layer.video !== undefined && layer.video !== null) {
      throw new ProjectVerificationError("external-reference", "工程包含外部视频引用");
    }
    if (Array.isArray(layer.vector_mask) && layer.vector_mask.length > 0) {
      throw new ProjectVerificationError("unsupported-object", "工程包含矢量路径");
    }
  }
}

function inspectSmart(content: Record<string, unknown>): void {
  const source = content.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new ProjectVerificationError("invalid-manifest", "智能对象缺少源");
  const value = source as Record<string, unknown>;
  if (value.kind !== "embedded") throw new ProjectVerificationError("external-reference", "智能对象只允许嵌入原生源");
  if (typeof value.file_name !== "string" || value.file_name.length > 200 || !value.file_name.trim()
      || /[\\/:\u0000-\u001f\u007f-\u009f]/.test(value.file_name) || !/^.+\.pcraft$/i.test(value.file_name)
      || !value.file_name.slice(0,-7).trim() || typeof value.blob !== "string" || !/^[0-9a-f]{64}$/.test(value.blob)) {
    throw new ProjectVerificationError("invalid-manifest", "智能对象源名或资源引用非法");
  }
  const transform = content.transform;
  const matrix = transform && typeof transform === "object" && !Array.isArray(transform) ? (transform as Record<string,unknown>).m : null;
  if (!Array.isArray(matrix) || matrix.length !== 6 || !matrix.every(n=>typeof n === "number" && Number.isFinite(n))) throw new ProjectVerificationError("unsupported-object", "智能对象仿射非法");
  const determinant = matrix[0]*matrix[3]-matrix[1]*matrix[2];
  if (!Number.isFinite(determinant) || Math.abs(determinant)<1e-12
      || !Array.isArray(content.smart_filters) || content.smart_filters.length !== 0
      || ["psd_raw","filter_mask","warp","stack_mode","perspective"].some(key=>content[key] != null)
      || (content.filters_enabled !== undefined && typeof content.filters_enabled !== "boolean")) {
    throw new ProjectVerificationError("unsupported-object", "智能对象包含未开放参数或不可逆仿射");
  }
}

function inspectAdjustment(content: Record<string, unknown>): void {
  const adjustment = content.adjustment;
  if (typeof adjustment !== "object" || adjustment === null) {
    throw new ProjectVerificationError("invalid-manifest", "工程调整层缺少参数");
  }
  const record = adjustment as Record<string, unknown>;
  const id = record.kind ?? record.id ?? record.type;
  if (typeof id !== "string" || !ALLOWED_ADJUSTMENT_IDS.has(id)) {
    throw new ProjectVerificationError("unsupported-object", `工程包含首期未开放的调整类型：${String(id)}`);
  }
  // `Unsupported { psd_key, raw }` 表示上游无法求值的调整：明确拒绝。
  if (record.psd_key !== undefined || record.raw !== undefined) {
    throw new ProjectVerificationError("unsupported-object", "工程包含无法求值的调整层");
  }
}

/** 像素层只允许内嵌来源；链接文件（智能对象）一律拒绝。 */
function inspectRasterSources(content: Record<string, unknown>): void {
  const sources = content.sources ?? content.source;
  if (sources === undefined || sources === null) return;
  const list = Array.isArray(sources) ? sources : [sources];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const source = raw as Record<string, unknown>;
    const kind = source.kind;
    if (kind === "linked") {
      throw new ProjectVerificationError("external-reference", "工程包含外部文件链接");
    }
    if (typeof source.path === "string" && source.path.length > 0) {
      throw new ProjectVerificationError("external-reference", "工程包含外部文件路径");
    }
  }
}

/** tile/blob 引用必须是 64 位 hex 且存在于容器内（缺资源或外链都拒绝）。 */
function assertResourcesPresent(byName: Map<string, ZipEntry>, manifest: Record<string, unknown>): void {
  const hashes = new Set<string>();
  for (const name of byName.keys()) {
    const match = /^(?:tiles|blobs)\/([0-9a-f]{64})\.zst$/.exec(name);
    if (match) hashes.add(match[1]);
  }
  const referenced = new Set<string>();
  collectHashes(manifest, referenced);
  for (const hash of referenced) {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new ProjectVerificationError("invalid-manifest", "工程引用非法资源 hash");
    }
    if (!hashes.has(hash)) {
      throw new ProjectVerificationError("missing-resource", `工程缺少必需资源：${hash}`);
    }
  }
}

/** 收集 manifest 中出现的所有 64 位 hex 资源引用（有界）。 */
function collectHashes(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 64 || out.size > IMAGE_PROJECT_LIMITS.maxEntries) return;
  if (typeof value === "string") {
    if (/^[0-9a-f]{64}$/.test(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectHashes(entry, out, depth + 1);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value as Record<string, unknown>)) collectHashes(entry, out, depth + 1);
  }
}

/** 工程媒体类型是否受支持（用于 ingest 前置判定）。 */
export function isPhotocraftProjectContentType(contentType: string): boolean {
  return contentType === IMAGE_PROJECT_CONTENT_TYPE;
}
