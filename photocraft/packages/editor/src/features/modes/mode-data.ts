/**
 * 图像模式与调色板的域数据：参数目标、上限、计划解码、工具与导出矩阵
 * （change: 2026-10-22-add-photocraft-image-mode-workflows，design D1/D3）。
 *
 * 纯数据与纯函数，不接触 DOM、不复制文档模型。像素、颜色表与油墨的权威表示在 Rust 内核
 * （`rust/crates/editor-core/src/features/modes/`）；这里只解释内核返回的**有界** JSON。
 */

/** 模式目标 id（与 Rust `mode::TARGETS` 一致，顺序即菜单顺序）。 */
export const IMAGE_MODE_TARGETS = ["rgb", "grayscale", "bitmap", "indexed", "duotone"] as const;
export type ImageModeTarget = (typeof IMAGE_MODE_TARGETS)[number];
export type ImageModeId = ImageModeTarget;

/** 模式 id → 界面名（面板与导出说明共用，避免两处各写一套）。 */
export const MODE_LABELS: Record<ImageModeId, string> = {
  rgb: "RGB 颜色",
  grayscale: "灰度",
  bitmap: "位图",
  indexed: "索引色",
  duotone: "双色调"
};

export const BITMAP_METHODS = ["diffusion", "threshold", "pattern", "halftone"] as const;
export const HALFTONE_SHAPES = ["round", "ellipse", "line", "square", "diamond", "cross"] as const;
export const INDEXED_PALETTES = ["selective", "perceptual", "adaptive", "exact", "systemMac", "systemWindows", "web", "uniform"] as const;
export const INDEXED_FORCED = ["blackWhite", "none", "primaries", "web"] as const;
export const INDEXED_DITHER = ["diffusion", "none", "pattern", "noise"] as const;
export const DUOTONE_TYPES = ["monotone", "duotone", "tritone", "quadtone"] as const;
export const COLOR_TABLE_PRESETS = ["custom", "blackBody", "grayscale", "spectrum", "systemMac", "systemWindows", "web"] as const;

/** 上限：域内参数边界，不改变工程资源预算。 */
export const IMAGE_MODE_LIMITS = {
  maxPreviewSide: 1024,
  maxTableColors: 256,
  maxInks: 4,
  maxInkCurvePoints: 64,
  maxInkNameLength: 64,
  /** 报告备注条数上限：内核按转换最多给几条，多余说明结构异常。 */
  maxReportNotes: 16
} as const;

export type ImageModeAvailability = { id: ImageModeTarget; label: string; available: boolean; reason: string | null };
export type ImageModeInk = { name: string; color: string; curve: [number, number][] };
export type ImageModeColorTable = { colors: string[]; transparent: number | null };

/** 只读模式信息（`modeInfo` 解码结果）。 */
export type ImageModeInfo = {
  mode: ImageModeId | null;
  rawMode: string;
  depth: number;
  colorTable: ImageModeColorTable | null;
  duotone: { inks: ImageModeInk[] } | null;
  layers: number;
  targets: ImageModeAvailability[];
  revision: number;
  contentHash: string;
  readOnly: boolean;
  trap: { available: boolean; requires: "cmyk"; reason: string };
};

export type ImageModeReport = {
  target: ImageModeTarget | "color-table";
  label: string;
  fromMode: ImageModeId | null;
  toMode: ImageModeId | null;
  depth: number;
  layersBefore: number;
  layersAfter: number;
  flattened: boolean;
  dropped: Record<string, number>;
  lossy: boolean;
  colorCount: number | null;
  colors: string[] | null;
  transparentIndex: number | null;
  inks: { name: string; color: string }[] | null;
  notes: string[];
  changed: boolean;
};

/** 一次转换/颜色表计划：报告 + 源像素预览 + 基线快照。 */
export type ImageModePlan = {
  report: ImageModeReport;
  preview: { width: number; height: number; pixels: Uint8Array };
  baseRevision: number;
  baseContentHash: string;
  changed: boolean;
  committed?: boolean;
  /**
   * 计划所属文档（宿主文档 id + 代际），由工作区在计划返回时写入。
   * 确认时若不一致就说明这份计划来自已销毁或已替换的文档
   * （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.3）。
   */
  owner?: ImageModePlanOwner;
};

/** 计划归属：宿主文档 id 与文档代际。 */
export type ImageModePlanOwner = { documentId: string | null; generation: number };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isModeId = (value: unknown): value is ImageModeId => typeof value === "string" && (IMAGE_MODE_TARGETS as readonly string[]).includes(value);
const isHex = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/.test(value);
const isTableIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value < IMAGE_MODE_LIMITS.maxTableColors;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
/**
 * 按码点计数上界：内核用 `chars().count()` 量字符数，用 UTF-16 `length` 会比内核更严
 * （64 个 emoji 在内核合法、在前端被拒）。大字符串不预先分配数组，逐个计数超限即停。
 */
const withinCodePoints = (value: string, limit: number): boolean => {
  let count = 0;
  for (const _ of value) {
    if (++count > limit) return false;
  }
  return true;
};
/** 非空文本，字符数（码点）有上界。 */
const isBoundedText = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length > 0 && withinCodePoints(value, limit);
/** 短文本字段（枚举名、目标名、油墨名）。 */
const isShortText = (value: unknown): value is string => isBoundedText(value, 64);
/** 说明/原因文本的上界：与报告备注同一尺度。 */
const isNoteText = (value: unknown): value is string => isBoundedText(value, 300);

/** 解码只读模式信息；结构非法返回 null（不渲染半截面板）。 */
export function decodeModeInfo(input: unknown): ImageModeInfo | null {
  // `rawMode`（如 `Cmyk`）会直接显示在「不在本次范围」提示里，必须有界。
  if (!isRecord(input) || !isShortText(input.rawMode)) return null;
  const mode = input.mode === null || input.mode === undefined ? null : isModeId(input.mode) ? input.mode : undefined;
  if (mode === undefined) return null;
  if (typeof input.depth !== "number" || !Number.isInteger(input.depth)) return null;
  if (!isCount(input.layers) || !isCount(input.revision)) return null;
  if (typeof input.contentHash !== "string" || typeof input.readOnly !== "boolean") return null;
  if (!Array.isArray(input.targets) || input.targets.length !== IMAGE_MODE_TARGETS.length) return null;
  const targets: ImageModeAvailability[] = [];
  for (const raw of input.targets) {
    if (!isRecord(raw) || !IMAGE_MODE_TARGETS.includes(raw.id as ImageModeTarget)) return null;
    // 五个目标各出现一次：重复 id 会让面板拿不到某个目标的真实可用性。
    if (targets.some((entry) => entry.id === raw.id)) return null;
    if (!isShortText(raw.label) || typeof raw.available !== "boolean") return null;
    // 不可用原因与陷印原因都原样渲染成提示文本。
    if (raw.reason !== null && !isNoteText(raw.reason)) return null;
    targets.push({ id: raw.id as ImageModeTarget, label: raw.label, available: raw.available, reason: raw.reason as string | null });
  }
  const hasTable = input.colorTable !== null && input.colorTable !== undefined;
  const table = hasTable ? decodeColorTable(input.colorTable) : null;
  if (hasTable && !table) return null;
  const hasDuotone = input.duotone !== null && input.duotone !== undefined;
  const duotone = hasDuotone ? decodeDuotone(input.duotone) : null;
  if (hasDuotone && !duotone) return null;
  if (!isRecord(input.trap) || typeof input.trap.available !== "boolean") return null;
  if (input.trap.requires !== "cmyk" || !isNoteText(input.trap.reason)) return null;
  return {
    mode,
    rawMode: input.rawMode,
    depth: input.depth,
    colorTable: table,
    duotone,
    layers: input.layers,
    targets,
    revision: input.revision,
    contentHash: input.contentHash,
    readOnly: input.readOnly,
    trap: { available: input.trap.available, requires: "cmyk", reason: input.trap.reason }
  };
}

export function decodeColorTable(input: unknown): ImageModeColorTable | null {
  if (!isRecord(input) || !Array.isArray(input.colors)) return null;
  if (input.colors.length < 1 || input.colors.length > IMAGE_MODE_LIMITS.maxTableColors) return null;
  if (!input.colors.every(isHex)) return null;
  const raw = input.transparent;
  if (raw !== null && raw !== undefined) {
    if (!isTableIndex(raw) || raw >= input.colors.length) return null;
    return { colors: input.colors as string[], transparent: raw };
  }
  return { colors: input.colors as string[], transparent: null };
}

export function decodeDuotone(input: unknown): { inks: ImageModeInk[] } | null {
  if (!isRecord(input) || !Array.isArray(input.inks)) return null;
  if (input.inks.length < 1 || input.inks.length > IMAGE_MODE_LIMITS.maxInks) return null;
  const inks: ImageModeInk[] = [];
  for (const raw of input.inks) {
    if (!isRecord(raw) || !isBoundedText(raw.name, IMAGE_MODE_LIMITS.maxInkNameLength)) return null;
    if (!isHex(raw.color)) return null;
    if (!Array.isArray(raw.curve) || raw.curve.length > IMAGE_MODE_LIMITS.maxInkCurvePoints) return null;
    const curve: [number, number][] = [];
    for (const point of raw.curve) {
      if (!Array.isArray(point) || point.length !== 2) return null;
      const [density, output] = point;
      if (typeof density !== "number" || typeof output !== "number") return null;
      if (!Number.isFinite(density) || !Number.isFinite(output)) return null;
      if (density < 0 || density > 100 || output < 0 || output > 100) return null;
      curve.push([density, output]);
    }
    inks.push({ name: raw.name, color: raw.color, curve });
  }
  return { inks };
}

/** base64 → 字节（预览像素）；非法长度或字符返回 null。 */
export function decodeBase64(text: unknown): Uint8Array | null {
  if (typeof text !== "string" || text.length === 0 || text.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 给定字节数对应的标准 base64 长度（含补位）。 */
export function base64LengthFor(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/** 解码一次计划；预览必须是完整的 RGBA8 行优先像素。 */
export function decodeModePlan(input: unknown): ImageModePlan | null {
  if (!isRecord(input) || !isRecord(input.report) || !isRecord(input.preview)) return null;
  const report = decodeModeReport(input.report);
  if (!report) return null;
  const { width, height } = input.preview;
  if (typeof width !== "number" || typeof height !== "number" || !Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 1 || height < 1 || width > IMAGE_MODE_LIMITS.maxPreviewSide || height > IMAGE_MODE_LIMITS.maxPreviewSide) return null;
  // 解码前先按声明的尺寸核对长度：避免为超大载荷分配内存（预算前移，不是解码后才发现不符）。
  if (typeof input.preview.pixelsBase64 !== "string"
    || input.preview.pixelsBase64.length !== base64LengthFor(width * height * 4)) return null;
  const pixels = decodeBase64(input.preview.pixelsBase64);
  if (!pixels || pixels.length !== width * height * 4) return null;
  if (!isCount(input.baseRevision) || typeof input.baseContentHash !== "string" || typeof input.changed !== "boolean") return null;
  if (input.committed !== undefined && typeof input.committed !== "boolean") return null;
  return {
    report,
    preview: { width, height, pixels },
    baseRevision: input.baseRevision,
    baseContentHash: input.baseContentHash,
    changed: input.changed,
    ...(input.committed === undefined ? {} : { committed: input.committed })
  };
}

export function decodeModeReport(input: unknown): ImageModeReport | null {
  if (!isRecord(input)) return null;
  const target = input.target === "color-table"
    ? "color-table"
    : IMAGE_MODE_TARGETS.includes(input.target as ImageModeTarget) ? (input.target as ImageModeTarget) : null;
  if (!target || !isShortText(input.label)) return null;
  const modeOf = (value: unknown): ImageModeId | null | undefined =>
    value === null || value === undefined ? null : isModeId(value) ? value : undefined;
  const fromMode = modeOf(input.fromMode);
  const toMode = modeOf(input.toMode);
  if (fromMode === undefined || toMode === undefined) return null;
  // 位深只可能是内核的三种采样位深；不设上界的话一个超大数字也会被当成合法报告。
  if (![8, 16, 32].includes(input.depth as number)) return null;
  for (const key of ["layersBefore", "layersAfter"] as const) {
    if (!isCount(input[key])) return null;
  }
  if (typeof input.flattened !== "boolean" || typeof input.lossy !== "boolean" || typeof input.changed !== "boolean") return null;
  if (!isRecord(input.dropped)) return null;
  const dropped: Record<string, number> = {};
  for (const [kind, count] of Object.entries(input.dropped)) {
    if (!["raster", "group", "adjustment", "fill", "text", "shape", "smart"].includes(kind)) return null;
    if (!isCount(count)) return null;
    dropped[kind] = count;
  }
  // 备注条数与单条长度都要有界：这是从内核 JSON 直接进 DOM 的文本。
  if (!Array.isArray(input.notes) || input.notes.length > IMAGE_MODE_LIMITS.maxReportNotes) return null;
  if (!input.notes.every(isNoteText)) return null;
  let colorCount: number | null = null;
  if (input.colorCount !== null && input.colorCount !== undefined) {
    if (!isCount(input.colorCount) || input.colorCount > IMAGE_MODE_LIMITS.maxTableColors) return null;
    colorCount = input.colorCount;
  }
  let colors: string[] | null = null;
  if (input.colors !== null && input.colors !== undefined) {
    // 颜色表条目上限与内核一致：不设上限时报告可以塞进任意长数组。
    if (!Array.isArray(input.colors) || input.colors.length > IMAGE_MODE_LIMITS.maxTableColors) return null;
    if (!input.colors.every(isHex)) return null;
    colors = input.colors as string[];
  }
  let transparentIndex: number | null = null;
  if (input.transparentIndex !== null && input.transparentIndex !== undefined) {
    if (!isTableIndex(input.transparentIndex)) return null;
    transparentIndex = input.transparentIndex;
  }
  let inks: { name: string; color: string }[] | null = null;
  if (input.inks !== null && input.inks !== undefined) {
    inks = decodeInkSummary(input.inks);
    if (!inks) return null;
  }
  // 颜色数必须与实际颜色表一致（内核同时报两者，不一致说明结构被篡改）。
  if (colorCount !== null && colors !== null && colorCount !== colors.length) return null;
  return {
    target,
    label: input.label,
    fromMode,
    toMode,
    depth: input.depth as number,
    layersBefore: input.layersBefore as number,
    layersAfter: input.layersAfter as number,
    flattened: input.flattened,
    dropped,
    lossy: input.lossy,
    colorCount,
    colors,
    transparentIndex,
    inks,
    notes: input.notes as string[],
    changed: input.changed
  };
}

function decodeInkSummary(input: unknown): { name: string; color: string }[] | null {
  if (!Array.isArray(input) || input.length > IMAGE_MODE_LIMITS.maxInks) return null;
  const inks: { name: string; color: string }[] = [];
  for (const raw of input) {
    // 油墨名与颜色都会原样渲染进报告（`ReportLines`）；名称上界必须与 `decodeDuotone`、
    // 内核 `parse_inks` 一致，否则一份被篡改的响应能把任意长文本塞进 DOM。
    if (!isRecord(raw) || !isBoundedText(raw.name, IMAGE_MODE_LIMITS.maxInkNameLength)) return null;
    if (!isHex(raw.color)) return null;
    inks.push({ name: raw.name, color: raw.color });
  }
  return inks;
}

// ------------------------------------------------------------------ 工具与导出矩阵

/** 编辑器工具 id（与 `features/index.ts` 的工具清单一致）。 */
export const MODE_TOOL_IDS = ["move", "marquee", "lasso", "wand", "quick", "brush", "eraser", "text", "clone", "heal", "retouch", "pen"] as const;
export type ModeToolId = (typeof MODE_TOOL_IDS)[number];

/**
 * 各模式的工具支持矩阵（本域是唯一 owner）。
 *
 * 权威契约是 `packages/protocol/src/features/modes/gate-fixtures.json`，内核
 * `features/modes/gate.rs` 与本函数必须逐项一致（两端测试共读那份 fixture）。
 *
 * 实测依据（见 verification.md）：
 * - 灰度与双色调会把彩色写入收敛成灰阶（`nonGray=0`），不破坏不变量，因此**全部工具放开**；
 *   早期版本按「双色调关闭文字/路径」写，实测文字可安全使用，属错误声明，已改。
 * - 索引色与位图存的是元数据，像素仍是 8 位通道；抗锯齿边缘本身就会出表，内核也不量化，
 *   因此一切写像素颜色的工具都会被内核真正拒绝。
 */
const MODE_TOOL_MATRIX: Record<ImageModeId, readonly ModeToolId[]> = {
  rgb: MODE_TOOL_IDS,
  grayscale: MODE_TOOL_IDS,
  indexed: ["move", "marquee", "lasso", "wand", "quick", "pen"],
  bitmap: ["move", "marquee", "lasso", "wand", "quick", "pen"],
  duotone: MODE_TOOL_IDS
};

const TOOL_REASONS: Partial<Record<ImageModeId, string>> = {
  bitmap: "位图只有黑白两点，写像素颜色的工具会被内核拒绝；请先转换为灰度或 RGB",
  indexed: "索引色只能表达颜色表内的颜色，写像素颜色的工具会被内核拒绝；请先转换为 RGB"
};

/**
 * 工具支持判定结果。
 *
 * `assessed=false` 表示**本域不判定**：`null` 模式是 CMYK／Lab 等不在本次范围的颜色模型，实测那些
 * 文档上绘制与文字都能正常提交（见 verification.md），因此既不能说「可用」（越权替别的域承诺），
 * 也不能说「关闭」（那是假的）。面板据此不显示关闭清单，只说本域不判定。
 */
export type ModeToolSupport = { enabled: boolean; assessed: boolean; reason: string | null };

/** 某工具在当前模式下是否可用；`null` 模式（范围外颜色模型）返回未判定。 */
export function modeToolAvailability(mode: ImageModeId | null, tool: ModeToolId): ModeToolSupport {
  if (!mode) return { enabled: false, assessed: false, reason: "当前色彩模型不在本次模式范围，本域不判定工具支持" };
  if (MODE_TOOL_MATRIX[mode].includes(tool)) return { enabled: true, assessed: true, reason: null };
  return { enabled: false, assessed: true, reason: TOOL_REASONS[mode] ?? "该工具不支持当前图像模式" };
}

/**
 * 某模式下**本域已判定**不可用的工具 id（面板用来一次性说明）。
 *
 * 范围外的颜色模型不贡献条目：把它们列成「建议保持关闭」会让用户以为内核会拒绝，实测不会。
 */
export function unsupportedModeTools(mode: ImageModeId | null): ModeToolId[] {
  return MODE_TOOL_IDS.filter(tool => {
    const support = modeToolAvailability(mode, tool);
    return support.assessed && !support.enabled;
  });
}

/**
 * 导出矩阵：哪些导出目标能表达当前模式。
 *
 * 索引色写出 8 位调色板 PNG；双色调按油墨渲染为 RGB；位图与灰度写出灰度 PNG。
 * **PSD 只对 RGB/U8 开放**：共享 PSD 导出在预检阶段就拒绝非 RGB 文档
 * （`PSD 导出只支持 RGB/U8 文档`，见 `features/io/psd.rs::inspect_psd_export`），
 * 因此灰度/位图/索引色/双色调一律关闭并说明，不能在这里承诺一个命令必然失败的入口。
 *
 * `null` 模式是 CMYK／Lab 等范围外颜色模型：实测它们能保存工程、导出 RGB PNG，只有 PSD 被
 * 共享预检拒绝。所以 PNG/工程返回「本域不判定颜色模式」而不是假装关闭；PSD 仍按真实预检说明。
 */
export type ModeExportTarget = "png" | "psd" | "project";
export type ModeExportSupport = { enabled: boolean; assessed: boolean; reason: string | null };

export function modeExportAvailability(mode: ImageModeId | null, target: ModeExportTarget): ModeExportSupport {
  if (!mode) {
    if (target === "psd") return { enabled: false, assessed: true, reason: "PSD 导出只支持 RGB/U8 文档；当前色彩模型不在本次模式范围" };
    return { enabled: true, assessed: false, reason: "当前色彩模型不在本次模式范围，导出由共享编码器决定（PNG 实测可用）" };
  }
  if (target === "project") return { enabled: true, assessed: true, reason: null };
  if (target === "png") {
    if (mode === "duotone") return { enabled: true, assessed: true, reason: "双色调按油墨渲染为 RGB PNG" };
    if (mode === "indexed") return { enabled: true, assessed: true, reason: "索引色写出 8 位调色板 PNG" };
    return { enabled: true, assessed: true, reason: null };
  }
  if (mode === "rgb") return { enabled: true, assessed: true, reason: null };
  return {
    enabled: false,
    assessed: true,
    reason: `PSD 导出目前只支持 RGB/U8 文档，${MODE_LABELS[mode]}请改用 PNG 或工程保存`
  };
}

/** 计划参数：只拼本目标的键，避免把界面上的无关字段传给内核。 */
export type ModeParams = Record<string, unknown>;
