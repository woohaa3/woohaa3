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
const ALLOWED_OBJECT_KINDS = new Set(["raster", "adjustment", "text", "group", "fill"]);
/**
 * 已发布并能在运行时重编的调整类型。
 *
 * 上游 `Adjustment` 是**外部标记**的枚举（`{"Exposure": {…}}`，无参数类型直接序列化成
 * `"Invert"`），不是内部标记的 `{"kind": "exposure", …}`。接受集合必须与唯一命令门
 * （`rust/crates/editor-core` 的 `features/adjustments` 命令表）一致：门禁放开的类型必须接受，
 * 没放开的必须拒绝，否则会出现「核验通过、运行时拒绝」。范围外的 LUT（`ColorLookup`）与
 * 无法求值的 PSD 块（`Unsupported`）因此继续拒绝。
 */
const ALLOWED_ADJUSTMENT_VARIANTS = new Set([
  "BrightnessContrast",
  "HueSaturation",
  "Curves",
  "Levels",
  "Vibrance",
  "BlackWhite",
  "Exposure",
  "ColorBalance",
  "PhotoFilter",
  "ChannelMixer",
  "Invert",
  "Posterize",
  "Threshold",
  "GradientMap",
  "SelectiveColor"
]);
/** 明确拒绝的对象类型。`fill` 自 U57 起是可保存内容，不再在此列。 */
const REJECTED_OBJECT_KINDS = new Set(["smart", "shape"]);

/**
 * 视频图层的本域预算（与 `rust/crates/editor-core/src/features/animation/limits.rs` 和原生
 * 核验器的 `features/animation/mod.rs` 同值）。共享上限的唯一权威仍是 `project-limits.json`；
 * 这里镜像同一收紧边界，因为原生与进程内核验必须对同一份工程给出相同的接收结论。
 */
const ANIMATION_MAX_FRAMES = 120;
const ANIMATION_MAX_CUMULATIVE_FRAME_PIXELS = 16_777_216;
const ANIMATION_MAX_FPS = 1000;
/** 一帧最多覆盖整块画布预算所需的 tile 数（`maxCanvasPixels` / tile 面积，留足稀疏边角）。 */
const ANIMATION_MAX_FRAME_TILES = 4096;
/** tile 索引上限：与上游 `TileCoord::rect` 的 i32 安全范围一致。 */
const ANIMATION_MAX_TILE_INDEX = 8_388_608;
/** 上游 tile 边长（`photocraft_geom::TILE_SIZE`）。 */
const TILE_SIZE = 256;

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
  // 时间轴挂在 document 上，逐层检查看不到；与原生 `animation::inspect_document` 同口径。
  inspectTimeline(doc.timeline);
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
    // 视频层（change: 2026-10-22-add-photocraft-animation-workflows）：帧栈是**内嵌**内容，
    // 与原生核验器一样接受并做同样的有界收紧；只有文件路径来源才是外部引用。视频层的内容
    // 类型仍是栅格，但原生核验器的 `animation::inspect` 会在 `painting` 之前认领它并把种类
    // 记为 `video-layer` 而不是 `raster`，这里必须同样处理，否则嵌入式核验的摘要比对会不等。
    const video = layer.video;
    if (layer.blend !== undefined) {
      const blend = typeof layer.blend === "string" ? layer.blend.replace(/-/g, "").toLowerCase() : "";
      if (!IMAGE_PROJECT_BLEND_MODES.some(mode => mode.replace(/-/g, "") === blend)
          || (blend === "passthrough" && kind !== "group")) {
        throw new ProjectVerificationError("unsupported-object", "工程包含未开放的混合模式");
      }
    }
    if (!(embeddedSmart && kind === "smart") && (REJECTED_OBJECT_KINDS.has(kind) || !ALLOWED_OBJECT_KINDS.has(kind))) {
      throw new ProjectVerificationError("unsupported-object", `工程包含首期未开放的对象类型：${kind}`);
    }
    if (video === undefined || video === null) {
      objectKinds.add(kind);
    } else if (typeof video !== "object" || Array.isArray(video)) {
      throw new ProjectVerificationError("invalid-manifest", "工程视频图层结构非法");
    } else {
      inspectVideo(video as Record<string, unknown>);
      objectKinds.add("video-layer");
    }
    if (kind === "smart") inspectSmart(content as Record<string, unknown>);
    if (kind === "adjustment") inspectAdjustment(content as Record<string, unknown>);
    if (kind === "fill") inspectFill(content as Record<string, unknown>, patterns);
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
    if (Array.isArray(layer.vector_mask) && layer.vector_mask.length > 0) {
      throw new ProjectVerificationError("unsupported-object", "工程包含矢量路径");
    }
  }
}

/**
 * 视频图层的有界核验（与原生 `project-verify::features::animation` 同口径）。
 *
 * 只收紧：帧栈为空、帧数/累计像素/帧率超本域预算、原始素材与帧栈长度不一致都拒绝。
 * `source` 只作溯源校验（形状合法即可）：帧像素本身已内嵌在 manifest 的 `frames` 里，本核验器
 * 从不读取路径、不访问文件系统，因此与原生核验器一致，不因 `File { path }` 而拒绝。
 */
function inspectVideo(video: Record<string, unknown>): void {
  const frames = video.frames;
  const original = video.original_frames;
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new ProjectVerificationError("unsupported-object", "视频图层的帧栈为空");
  }
  if (frames.length > ANIMATION_MAX_FRAMES) {
    throw new ProjectVerificationError("unsupported-object", `视频图层帧数超过上限：${frames.length} > ${ANIMATION_MAX_FRAMES}`);
  }
  if (typeof video.fps !== "number" || !Number.isFinite(video.fps) || video.fps <= 0 || video.fps > ANIMATION_MAX_FPS) {
    throw new ProjectVerificationError("unsupported-object", `视频图层帧率非法：${String(video.fps)}`);
  }
  if (video.show_altered !== undefined && typeof video.show_altered !== "boolean") {
    throw new ProjectVerificationError("invalid-manifest", "视频图层显示开关非法");
  }
  const source = video.source;
  // 来源只作溯源：帧像素本身已内嵌在 manifest 的 `frames` 里，因此与原生核验器一致，不因
  // `File { path }` 而拒绝（本核验器从不读取该路径、不访问文件系统）。
  if (source !== undefined && source !== null
      && typeof source !== "string" && (typeof source !== "object" || Array.isArray(source))) {
    throw new ProjectVerificationError("invalid-manifest", "视频图层来源结构非法");
  }
  if (original !== undefined && original !== null) {
    if (!Array.isArray(original) || original.length !== frames.length) {
      throw new ProjectVerificationError("unsupported-object", "视频图层原始帧数与帧栈不一致");
    }
  }
  let pixels = 0;
  for (const frame of [...frames, ...(Array.isArray(original) ? original : [])]) {
    pixels += surfacePixels(frame);
    if (pixels > ANIMATION_MAX_CUMULATIVE_FRAME_PIXELS) {
      throw new ProjectVerificationError("unsupported-object", `视频帧累计像素超过上限：${pixels} > ${ANIMATION_MAX_CUMULATIVE_FRAME_PIXELS}`);
    }
  }
}

/**
 * 一帧 `SurfaceM` 的像素面积：按已声明 tile 的包围盒计（与原生 `Surface::tile_bounds` 同口径）。
 *
 * Surface 是稀疏存储，tile 索引可能来自损坏文件，因此先保证索引在 i32 内并夹到画布预算，
 * 再累加——畸形输入只会被拒，不会让这里的算术溢出或分配。
 */
function surfacePixels(raw: unknown): number {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProjectVerificationError("invalid-manifest", "视频帧结构非法");
  }
  const surface = raw as Record<string, unknown>;
  const tiles = surface.tiles;
  if (!Array.isArray(tiles)) throw new ProjectVerificationError("invalid-manifest", "视频帧缺少 tile 列表");
  if (tiles.length > ANIMATION_MAX_FRAME_TILES) {
    throw new ProjectVerificationError("unsupported-object", `视频帧 tile 数超过上限：${tiles.length}`);
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const tile of tiles) {
    if (typeof tile !== "object" || tile === null) throw new ProjectVerificationError("invalid-manifest", "视频帧 tile 结构非法");
    const { tx, ty } = tile as Record<string, unknown>;
    if (typeof tx !== "number" || typeof ty !== "number" || !Number.isInteger(tx) || !Number.isInteger(ty)
        || Math.abs(tx) > ANIMATION_MAX_TILE_INDEX || Math.abs(ty) > ANIMATION_MAX_TILE_INDEX) {
      throw new ProjectVerificationError("unsupported-object", "视频帧 tile 坐标非法");
    }
    x0 = Math.min(x0, tx * TILE_SIZE); y0 = Math.min(y0, ty * TILE_SIZE);
    x1 = Math.max(x1, tx * TILE_SIZE + TILE_SIZE); y1 = Math.max(y1, ty * TILE_SIZE + TILE_SIZE);
  }
  if (!Number.isFinite(x0)) return 0;
  return (x1 - x0) * (y1 - y0);
}

/**
 * 文档级时间轴核验（与原生 `animation::inspect_document` 同口径）。
 *
 * 时长/帧率/播放头/工作区任一越界都拒绝。没有时间轴的旧工程不产生任何贡献。
 */
function inspectTimeline(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProjectVerificationError("invalid-manifest", "工程时间轴结构非法");
  }
  const timeline = raw as Record<string, unknown>;
  const duration = timeline.duration;
  if (typeof duration !== "number" || !Number.isInteger(duration) || duration < 1 || duration > ANIMATION_MAX_FRAMES) {
    throw new ProjectVerificationError("unsupported-object", `时间轴时长超过上限或非法：${String(duration)}（上限 ${ANIMATION_MAX_FRAMES}）`);
  }
  if (typeof timeline.fps !== "number" || !Number.isFinite(timeline.fps) || timeline.fps <= 0 || timeline.fps > ANIMATION_MAX_FPS) {
    throw new ProjectVerificationError("unsupported-object", `时间轴帧率非法：${String(timeline.fps)}`);
  }
  const current = timeline.current;
  if (typeof current !== "number" || !Number.isInteger(current) || current < 0 || current >= duration) {
    throw new ProjectVerificationError("unsupported-object", `时间轴播放头越界：${String(current)} >= ${duration}`);
  }
  // `work_start` 缺省为 0（与上游 `#[serde(default)]` 一致）。
  const workStart = timeline.work_start ?? 0;
  const workEnd = timeline.work_end;
  if (typeof workStart !== "number" || !Number.isInteger(workStart) || typeof workEnd !== "number" || !Number.isInteger(workEnd)
      || workStart >= workEnd || workEnd > duration) {
    throw new ProjectVerificationError("unsupported-object", `时间轴工作区范围非法：${String(workStart)}..${String(workEnd)}（时长 ${duration}）`);
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
  if (adjustment === null || adjustment === undefined) {
    throw new ProjectVerificationError("invalid-manifest", "工程调整层缺少参数");
  }
  // 无参数的调整（`Invert`）序列化成裸字符串；其余是单键对象 `{"<Variant>": {…}}`。
  const variant = typeof adjustment === "string"
    ? adjustment
    : typeof adjustment === "object" && !Array.isArray(adjustment)
      ? Object.keys(adjustment as Record<string, unknown>)[0]
      : undefined;
  if (typeof variant !== "string" || variant.length === 0 || !ALLOWED_ADJUSTMENT_VARIANTS.has(variant)) {
    throw new ProjectVerificationError("unsupported-object", `工程包含未开放的调整类型：${String(variant ?? adjustment)}`);
  }
  // 变体必须是**唯一**键：多键对象既不是本解析器认识的形状，也可能是伪造的白名单命中。
  if (typeof adjustment === "object" && Object.keys(adjustment as Record<string, unknown>).length !== 1) {
    throw new ProjectVerificationError("invalid-manifest", "工程调整层参数结构非法");
  }
  // `Unsupported { psd_key, raw }` 表示上游无法求值的调整：明确拒绝（variant 白名单已挡住，
  // 这里保留判据说明「为什么」而不是让白名单成为唯一防线）。
  const payload = typeof adjustment === "object" ? (adjustment as Record<string, unknown>)[variant] : null;
  if (payload && typeof payload === "object" && !Array.isArray(payload)
      && ((payload as Record<string, unknown>).psd_key !== undefined || (payload as Record<string, unknown>).raw !== undefined)) {
    throw new ProjectVerificationError("unsupported-object", "工程包含无法求值的调整层");
  }
}

/**
 * 填充层（U57）：参数是可重编内容，必须逐字段有界并且图案引用随工程保存。
 *
 * 与原生 `project-verify` 的 `fill_support` 同一组界限；这里只做结构/范围判定，
 * 不合成像素、不加载图案表面。
 */
function inspectFill(content: Record<string, unknown>, patterns: unknown[]): void {
  const fill = content.fill;
  if (typeof fill !== "object" || fill === null || Array.isArray(fill)) {
    throw new ProjectVerificationError("invalid-manifest", "工程填充层缺少参数");
  }
  const record = fill as Record<string, unknown>;
  if (record.kind === "Solid") {
    inspectFillColor(record.alpha);
    return;
  }
  if (record.kind === "Gradient") {
    const stops = record.stops;
    if (!Array.isArray(stops) || stops.length < 2 || stops.length > 1024) {
      throw new ProjectVerificationError("unsupported-object", "工程渐变填充的端点数量非法");
    }
    let previous = Number.NEGATIVE_INFINITY;
    for (const raw of stops) {
      // 上游序列化是 `[位置, 颜色]` 元组。
      if (!Array.isArray(raw) || raw.length !== 2) throw new ProjectVerificationError("invalid-manifest", "工程渐变端点结构非法");
      const at = raw[0];
      if (typeof at !== "number" || !Number.isFinite(at) || at < 0 || at > 1 || at < previous) {
        throw new ProjectVerificationError("unsupported-object", "工程渐变端点位置非法或次序颠倒");
      }
      previous = at;
      inspectFillColorValue(raw[1]);
    }
    const scale = record.scale;
    if (typeof scale !== "number" || !Number.isFinite(scale) || scale < 0.1 || scale > 1.5) {
      throw new ProjectVerificationError("unsupported-object", "工程渐变填充的缩放超出范围");
    }
    const midpoints = record.midpoints;
    if (midpoints !== undefined) {
      if (!Array.isArray(midpoints) || midpoints.length >= Math.max(stops.length, 1)) {
        throw new ProjectVerificationError("unsupported-object", "工程渐变填充的中点数量非法");
      }
      if (!midpoints.every((mid) => typeof mid === "number" && Number.isFinite(mid) && mid >= 0 && mid <= 1)) {
        throw new ProjectVerificationError("unsupported-object", "工程渐变填充的中点超出范围");
      }
    }
    const opacityStops = record.opacity_stops;
    if (opacityStops !== undefined) {
      if (!Array.isArray(opacityStops) || opacityStops.length > 1024) {
        throw new ProjectVerificationError("unsupported-object", "工程渐变填充的透明度端点数量非法");
      }
      for (const raw of opacityStops) {
        if (!Array.isArray(raw) || raw.length !== 2) throw new ProjectVerificationError("invalid-manifest", "工程渐变透明度端点结构非法");
        const [at, alpha] = raw;
        if (typeof at !== "number" || !Number.isFinite(at) || at < 0 || at > 1) {
          throw new ProjectVerificationError("unsupported-object", "工程渐变透明度端点位置非法");
        }
        if (typeof alpha !== "number" || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
          throw new ProjectVerificationError("unsupported-object", "工程渐变透明度端点取值非法");
        }
      }
    }
    return;
  }
  if (record.kind !== "Pattern") {
    throw new ProjectVerificationError("unsupported-object", `工程包含未开放的对象类型：fill/${String(record.kind)}`);
  }
  // 图案必须随工程保存，否则重开后无法渲染。
  const name = record.name;
  const id = record.id;
  if (typeof name !== "string" || !name.trim() || name.length > 200) {
    throw new ProjectVerificationError("invalid-manifest", "工程图案填充的名称非法");
  }
  if (typeof id !== "string" || !id || id.length > 200) {
    throw new ProjectVerificationError("invalid-manifest", "工程图案填充缺少图案引用");
  }
  if (!patterns.some((raw) => typeof raw === "object" && raw !== null && (raw as Record<string, unknown>).id === id)) {
    throw new ProjectVerificationError("missing-resource", `工程图案填充引用了不存在的图案：${id}`);
  }
  const scale = record.scale;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale > 10) {
    throw new ProjectVerificationError("unsupported-object", "工程图案填充的缩放超出范围");
  }
  const angle = record.angle;
  if (angle !== undefined && (typeof angle !== "number" || !Number.isFinite(angle) || angle < -360 || angle > 360)) {
    throw new ProjectVerificationError("unsupported-object", "工程图案填充的角度超出范围");
  }
}

/** 上游 `Color` 的 alpha 是独立字段，`c` 数组按模式定长。 */
function inspectFillColor(alpha: unknown): void {
  if (typeof alpha !== "number" || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new ProjectVerificationError("unsupported-object", "工程填充颜色透明度非法");
  }
}

/** 渐变端点里的颜色同样是 `{mode, c, alpha}`。 */
function inspectFillColorValue(raw: unknown): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProjectVerificationError("invalid-manifest", "工程渐变端点缺少颜色");
  }
  const color = raw as Record<string, unknown>;
  const channels = color.c;
  if (channels !== undefined) {
    if (!Array.isArray(channels) || !channels.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new ProjectVerificationError("unsupported-object", "工程渐变端点颜色通道非法");
    }
  }
  inspectFillColor(color.alpha);
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
