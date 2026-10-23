/**
 * U50–U56 构图工作流的纯参数规划（change: 2026-10-22-add-photocraft-composition-workflows）。
 *
 * 这里只做**纯函数**：把界面上的比例、锚点、单位、网格与描边位置编译成内核参数，并给出
 * 可读的校验结果。像素与结构变更全部由内核执行；本文件不持有文档、历史或草稿状态。
 *
 * 能力可用性来自内核自报的 `workflowManifestJson()`：命令白名单、宿主端口与「尚未接通」
 * 的真实原因都在内核侧判定，界面只按 `allowed` 决定是否渲染入口。
 */

/**
 * 参数编译失败的判定。
 *
 * 编译函数返回 `Record<string, unknown> | { error: string }`，而 `Record<string, unknown>`
 * 自带索引签名，`"error" in value` 收窄不到错误分支，需要用显式守卫。
 */
export function isParamError(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && typeof (value as { error?: unknown }).error === "string";
}

/** 一个工作流入口：`id` 是界面稳定 id，`command` 是最终落到的上游命令。 */
export type CompositionWorkflow = {
  id: string;
  group: string;
  label: string;
  command: string | null;
  allowed: boolean;
  reason: string | null;
};

export const COMPOSITION_WORKFLOW_GROUPS = [
  { id: "crop", label: "裁剪与透视" },
  { id: "size", label: "图像与画布尺寸" },
  { id: "trim", label: "裁边与旋转" },
  { id: "transform", label: "变换与变形" },
  { id: "fill", label: "填充与描边" },
  { id: "photo", label: "照片合并" },
  { id: "structure", label: "画板、框架与切片" }
] as const;

const GROUP_IDS = COMPOSITION_WORKFLOW_GROUPS.map((group) => group.id);

/**
 * 解析内核返回的工作流清单。
 *
 * 结构非法时返回 `null`（调用方显示「无法读取能力清单」而不是渲染半截入口）。
 */
export function parseWorkflowManifest(input: unknown): CompositionWorkflow[] | null {
  if (!Array.isArray(input)) return null;
  const workflows: CompositionWorkflow[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id || record.id.length > 120) return null;
    if (seen.has(record.id)) return null;
    if (typeof record.label !== "string" || !record.label || record.label.length > 200) return null;
    if (typeof record.group !== "string" || !GROUP_IDS.includes(record.group as (typeof GROUP_IDS)[number])) return null;
    if (record.command !== null && (typeof record.command !== "string" || !record.command)) return null;
    if (typeof record.allowed !== "boolean") return null;
    if (record.reason !== null && typeof record.reason !== "string") return null;
    // 未开放却没有原因，等于让界面显示一个无法解释的禁用按钮。
    if (!record.allowed && !record.reason) return null;
    seen.add(record.id);
    workflows.push({
      id: record.id,
      group: record.group,
      label: record.label,
      command: record.command as string | null,
      allowed: record.allowed,
      reason: (record.reason as string | null) ?? null
    });
  }
  return workflows;
}

/** 按分组索引，保持内核顺序。 */
export function workflowsByGroup(workflows: readonly CompositionWorkflow[], group: string): CompositionWorkflow[] {
  return workflows.filter((workflow) => workflow.group === group);
}

// ---------------------------------------------------------------- 裁剪

/** 画布裁剪框（文档像素）与可选目标尺寸。 */
export type CropFrame = { x: number; y: number; width: number; height: number };
export type CropOptions = {
  frame: CropFrame;
  /** 拉直角度（度）；0 表示不旋转。 */
  angle?: number;
  /** 删除裁剪掉的像素；false 时保留画布外内容（Reveal All 可恢复）。 */
  deleteCroppedPixels?: boolean;
  /** 内容识别填充旋转/扩展后露出的区域。 */
  contentAware?: boolean;
  targetWidth?: number;
  targetHeight?: number;
  resolution?: number;
  resample?: ResampleMethod;
};

export const RESAMPLE_METHODS = [
  "automatic",
  "preserveDetails",
  "bicubicSmoother",
  "bicubicSharper",
  "bicubicAutomatic",
  "bicubic",
  "nearest",
  "bilinear",
  "lanczos",
  "none"
] as const;
export type ResampleMethod = (typeof RESAMPLE_METHODS)[number];

/** Photoshop 常见的裁剪比例预设（宽 / 高）。 */
export const CROP_RATIOS = [
  { id: "free", label: "自由", ratio: null },
  { id: "original", label: "原始比例", ratio: "original" },
  { id: "1:1", label: "1 : 1", ratio: 1 },
  { id: "4:3", label: "4 : 3", ratio: 4 / 3 },
  { id: "3:2", label: "3 : 2", ratio: 3 / 2 },
  { id: "16:9", label: "16 : 9", ratio: 16 / 9 },
  { id: "2:3", label: "2 : 3", ratio: 2 / 3 },
  { id: "9:16", label: "9 : 16", ratio: 9 / 16 },
  { id: "5:4", label: "5 : 4", ratio: 5 / 4 }
] as const;

/** 比例解析：`original` 取文档比例，`null` 表示自由。 */
export function resolveCropRatio(ratio: number | "original" | null | undefined, document: { width: number; height: number }): number | null {
  if (ratio === null || ratio === undefined) return null;
  if (ratio === "original") return document.height > 0 ? document.width / document.height : null;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

/**
 * 按比例调整裁剪框：保持中心与面积近似，避免每次切换比例就跳到左上角。
 *
 * 结果始终落在文档矩形内（裁剪框可以越界扩展画布，但比例预设不允许一上来就扩边）。
 */
export function fitCropFrame(frame: CropFrame, ratio: number | null, document: { width: number; height: number }): CropFrame {
  const width = Math.max(1, Math.round(frame.width));
  const height = Math.max(1, Math.round(frame.height));
  if (ratio === null) return { x: frame.x, y: frame.y, width, height };
  const centerX = frame.x + width / 2;
  const centerY = frame.y + height / 2;
  // 以当前面积为准换算目标宽高（宽 = sqrt(area × ratio)）。
  const area = width * height;
  let nextWidth = Math.sqrt(area * ratio);
  let nextHeight = nextWidth / ratio;
  const maxWidth = Math.max(1, document.width);
  const maxHeight = Math.max(1, document.height);
  if (nextWidth > maxWidth) {
    nextWidth = maxWidth;
    nextHeight = nextWidth / ratio;
  }
  if (nextHeight > maxHeight) {
    nextHeight = maxHeight;
    nextWidth = nextHeight * ratio;
  }
  nextWidth = Math.max(1, Math.round(nextWidth));
  nextHeight = Math.max(1, Math.round(nextHeight));
  const x = Math.round(centerX - nextWidth / 2);
  const y = Math.round(centerY - nextHeight / 2);
  return {
    x: Math.max(0, Math.min(x, maxWidth - nextWidth)),
    y: Math.max(0, Math.min(y, maxHeight - nextHeight)),
    width: nextWidth,
    height: nextHeight
  };
}

/** 裁剪参数：只有合法字段进入内核参数，避免把界面状态透传成命令参数。 */
export function cropParams(options: CropOptions): Record<string, unknown> | { error: string } {
  const { frame } = options;
  if (![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite)) return { error: "裁剪框必须是有限数值" };
  if (frame.width < 1 || frame.height < 1) return { error: "裁剪宽高至少为 1 像素" };
  const params: Record<string, unknown> = {
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    width: Math.round(frame.width),
    height: Math.round(frame.height)
  };
  const angle = options.angle ?? 0;
  if (!Number.isFinite(angle) || Math.abs(angle) > 3600) return { error: "拉直角度必须在 ±3600° 内" };
  const normalized = ((angle % 360) + 360) % 360;
  if (normalized > 1e-9 && Math.abs(normalized - 360) > 1e-9) params.angle = normalized > 180 ? normalized - 360 : normalized;
  if (options.deleteCroppedPixels !== undefined) params.deleteCroppedPixels = options.deleteCroppedPixels;
  if (options.contentAware !== undefined) params.contentAware = options.contentAware;
  const hasWidth = options.targetWidth !== undefined;
  const hasHeight = options.targetHeight !== undefined;
  if (hasWidth !== hasHeight) return { error: "目标宽度与目标高度必须同时给出" };
  if (hasWidth) {
    if (!Number.isFinite(options.targetWidth) || !Number.isFinite(options.targetHeight)
      || (options.targetWidth as number) < 1 || (options.targetHeight as number) < 1) {
      return { error: "目标尺寸至少为 1 × 1 像素" };
    }
    if (options.resample === "none") return { error: "给出目标尺寸时必须重采样" };
    params.targetWidth = Math.round(options.targetWidth as number);
    params.targetHeight = Math.round(options.targetHeight as number);
  }
  if (options.resolution !== undefined) {
    if (!Number.isFinite(options.resolution) || options.resolution < 1 || options.resolution > 10_000) {
      return { error: "分辨率必须在 1–10000 ppi 之间" };
    }
    params.resolution = options.resolution;
  }
  if (options.resample !== undefined) {
    if (!RESAMPLE_METHODS.includes(options.resample)) return { error: "不支持的重采样算法" };
    if (options.resample === "none" && hasWidth) return { error: "给出目标尺寸时必须重采样" };
    params.resample = options.resample;
  }
  return params;
}

/** 透视裁剪的四个角（左上、右上、右下、左下，文档像素）。 */
export type PerspectiveCorners = [[number, number], [number, number], [number, number], [number, number]];

/** 四边形有向面积的两倍（屏幕坐标 y 向下，顺时针为正）。 */
export function quadArea2(corners: PerspectiveCorners): number {
  let area = 0;
  for (let index = 0; index < 4; index += 1) {
    const [x0, y0] = corners[index];
    const [x1, y1] = corners[(index + 1) % 4];
    area += x0 * y1 - x1 * y0;
  }
  return area;
}

/**
 * 四角是否构成可用的透视四边形：有限、顺时针、每个转角明显非平角、面积 ≥ 1 像素。
 *
 * 与内核 `photocraft_algo::transform::convex_quad` 同判据，界面因此能在拖动时提前提示。
 */
export function isValidPerspectiveQuad(corners: PerspectiveCorners): boolean {
  if (corners.flat().some((value) => !Number.isFinite(value))) return false;
  for (let index = 0; index < 4; index += 1) {
    const a = corners[index];
    const b = corners[(index + 1) % 4];
    const c = corners[(index + 2) % 4];
    const e1 = [b[0] - a[0], b[1] - a[1]];
    const e2 = [c[0] - b[0], c[1] - b[1]];
    const cross = e1[0] * e2[1] - e1[1] * e2[0];
    if (!Number.isFinite(cross) || cross <= 1e-3 * Math.hypot(e1[0], e1[1]) * Math.hypot(e2[0], e2[1])) return false;
  }
  return quadArea2(corners) >= 2;
}

/** 透视裁剪参数；输出尺寸省略时由四边形平均边长决定（与内核一致）。 */
export function perspectiveCropParams(corners: PerspectiveCorners, options: {
  width?: number;
  height?: number;
  resolution?: number;
  interpolation?: "bicubic" | "bilinear" | "nearest";
} = {}): Record<string, unknown> | { error: string } {
  if (!isValidPerspectiveQuad(corners)) return { error: "四个角必须构成顺时针凸四边形" };
  const params: Record<string, unknown> = { corners };
  for (const key of ["width", "height"] as const) {
    const value = options[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 1) return { error: "输出尺寸至少为 1 像素" };
    params[key] = Math.round(value);
  }
  if (options.resolution !== undefined) {
    if (!Number.isFinite(options.resolution) || options.resolution < 1 || options.resolution > 10_000) {
      return { error: "分辨率必须在 1–10000 ppi 之间" };
    }
    params.resolution = options.resolution;
  }
  if (options.interpolation !== undefined) params.interpolation = options.interpolation;
  return params;
}

// ---------------------------------------------------------------- 尺寸

/** 打印尺寸单位（显示用；内核只接受像素与 ppi）。 */
export const PRINT_UNITS = [
  { id: "px", label: "像素", perInch: null },
  { id: "in", label: "英寸", perInch: 1 },
  { id: "cm", label: "厘米", perInch: 2.54 },
  { id: "mm", label: "毫米", perInch: 25.4 }
] as const;
export type PrintUnit = (typeof PRINT_UNITS)[number]["id"];

/** 像素 ↔ 打印单位换算：`px = value × ppi × perInch`。 */
export function printSizeToPixels(value: number, unit: PrintUnit, resolution: number): number | null {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(resolution) || resolution <= 0) return null;
  const entry = PRINT_UNITS.find((candidate) => candidate.id === unit);
  if (!entry || entry.perInch === null) return null;
  return (value * resolution) / entry.perInch;
}

/** 像素 → 打印单位（显示文档的实际打印尺寸）。 */
export function pixelsToPrintSize(pixels: number, unit: PrintUnit, resolution: number): number | null {
  if (!Number.isFinite(pixels) || !Number.isFinite(resolution) || resolution <= 0) return null;
  const entry = PRINT_UNITS.find((candidate) => candidate.id === unit);
  if (!entry || entry.perInch === null) return null;
  return (pixels / resolution) * entry.perInch;
}

export type ImageSizeOptions = {
  width?: number;
  height?: number;
  percent?: number;
  resolution?: number;
  /** 只改分辨率时按新 DPI 重采样像素以保持打印尺寸。 */
  keepPrintSize?: boolean;
  resample?: ResampleMethod;
};

export function imageSizeParams(options: ImageSizeOptions): Record<string, unknown> | { error: string } {
  const params: Record<string, unknown> = {};
  for (const key of ["width", "height"] as const) {
    const value = options[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 1) return { error: "宽高至少为 1 像素" };
    params[key] = Math.round(value);
  }
  if (options.percent !== undefined) {
    if (!Number.isFinite(options.percent) || options.percent <= 0) return { error: "百分比必须为正数" };
    params.percent = options.percent;
  }
  if (options.resolution !== undefined) {
    if (!Number.isFinite(options.resolution) || options.resolution < 1 || options.resolution > 10_000) {
      return { error: "分辨率必须在 1–10000 ppi 之间" };
    }
    params.resolution = options.resolution;
  }
  if (options.resample !== undefined) {
    if (!RESAMPLE_METHODS.includes(options.resample)) return { error: "不支持的重采样算法" };
    params.resample = options.resample;
  }
  if (options.keepPrintSize) {
    if (options.resolution === undefined) return { error: "保持打印尺寸需要先给出分辨率" };
    params.keepPrintSize = true;
  }
  return params;
}

export const CANVAS_ANCHORS = [
  "topLeft", "top", "topRight", "left", "center", "right", "bottomLeft", "bottom", "bottomRight"
] as const;
export type CanvasAnchor = (typeof CANVAS_ANCHORS)[number];

export const EXTENSION_COLORS = ["background", "foreground", "white", "black", "transparent"] as const;
export type ExtensionColor = (typeof EXTENSION_COLORS)[number] | `#${string}`;

export type CanvasSizeOptions = {
  width: number;
  height: number;
  relative?: boolean;
  anchor?: CanvasAnchor;
  extensionColor?: ExtensionColor;
};

export function canvasSizeParams(options: CanvasSizeOptions): Record<string, unknown> | { error: string } {
  if (!Number.isFinite(options.width) || !Number.isFinite(options.height)) return { error: "画布尺寸必须是有限数值" };
  const relative = options.relative === true;
  if (!relative && (options.width < 1 || options.height < 1)) return { error: "画布尺寸至少为 1 × 1 像素" };
  if (relative && options.width <= -1e6 || relative && options.height <= -1e6) return { error: "相对增减超出范围" };
  const anchor = options.anchor ?? "center";
  if (!CANVAS_ANCHORS.includes(anchor)) return { error: "不支持的画布锚点" };
  const extension = options.extensionColor ?? "background";
  if (typeof extension !== "string") return { error: "扩展颜色必须是颜色名或 #rrggbb" };
  const named = (EXTENSION_COLORS as readonly string[]).includes(extension);
  const hex = /^#[0-9a-fA-F]{6}$/.test(extension);
  if (!named && !hex) return { error: "扩展颜色必须是 background|foreground|white|black|transparent|#rrggbb" };
  return {
    width: relative ? options.width : Math.round(options.width),
    height: relative ? options.height : Math.round(options.height),
    relative,
    anchor,
    extensionColor: extension
  };
}

// ---------------------------------------------------------------- 裁边与旋转

export const TRIM_BASIS = ["transparent", "topLeft", "bottomRight"] as const;
export type TrimBasis = (typeof TRIM_BASIS)[number];

export type TrimOptions = { basedOn?: TrimBasis; top?: boolean; bottom?: boolean; left?: boolean; right?: boolean };

export function trimParams(options: TrimOptions = {}): Record<string, unknown> | { error: string } {
  const basedOn = options.basedOn ?? "transparent";
  if (!TRIM_BASIS.includes(basedOn)) return { error: "裁边依据必须是 transparent|topLeft|bottomRight" };
  return {
    basedOn,
    top: options.top ?? true,
    bottom: options.bottom ?? true,
    left: options.left ?? true,
    right: options.right ?? true
  };
}

export function rotateArbitraryParams(angle: number, options: {
  direction?: "cw" | "ccw";
  interpolation?: "bicubic" | "bilinear" | "nearest";
} = {}): Record<string, unknown> | { error: string } {
  if (!Number.isFinite(angle) || Math.abs(angle) >= 360) return { error: "角度必须在 ±360° 之间" };
  return { angle, direction: options.direction ?? "cw", ...(options.interpolation ? { interpolation: options.interpolation } : {}) };
}

/** 旋转后的画布尺寸（与内核 `mode_cmds::rotated_size` 同式），用于界面提示与预算预警。 */
export function rotatedCanvasSize(size: { width: number; height: number }, degrees: number): { width: number; height: number } {
  const radians = (degrees * Math.PI) / 180;
  const sin = Math.abs(Math.sin(radians));
  const cos = Math.abs(Math.cos(radians));
  return {
    width: Math.max(1, Math.ceil(size.width * cos + size.height * sin - 1e-6)),
    height: Math.max(1, Math.ceil(size.width * sin + size.height * cos - 1e-6))
  };
}

// ---------------------------------------------------------------- 变换与变形

export const WARP_STYLES = [
  "none", "arc", "arcLower", "arcUpper", "arch", "bulge", "shellLower", "shellUpper",
  "flag", "wave", "fish", "rise", "fisheye", "inflate", "squeeze", "twist"
] as const;
export type WarpStyle = (typeof WARP_STYLES)[number];

export type WarpStyleOptions = {
  style: WarpStyle;
  bend?: number;
  hDistort?: number;
  vDistort?: number;
  vertical?: boolean;
  interpolation?: "bicubic" | "bilinear" | "nearest";
};

export function warpStyleParams(options: WarpStyleOptions): Record<string, unknown> | { error: string } {
  if (!WARP_STYLES.includes(options.style)) return { error: "不支持的变形样式" };
  const params: Record<string, unknown> = { style: options.style };
  for (const key of ["bend", "hDistort", "vDistort"] as const) {
    const value = options[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < -100 || value > 100) return { error: `${key} 必须在 -100–100 之间` };
    params[key] = value;
  }
  if (options.vertical !== undefined) params.vertical = options.vertical;
  if (options.interpolation) params.interpolation = options.interpolation;
  return params;
}

/** `us`/`vs` 是块边界（0…1 严格递增，1–64 块），控制点数是 `(3c+1) × (3r+1)`。 */
export type WarpMesh = { us: number[]; vs: number[]; points: [number, number][] };

/** 网格是否合法（与内核 `BezierMesh::is_valid` + 块数上限同判据）。 */
export function isValidWarpMesh(mesh: WarpMesh): boolean {
  const axis = (values: number[]) => values.length >= 2
    && values.length <= 65 // 1–64 块
    && values[0] === 0
    && values[values.length - 1] === 1
    && values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    && values.every((value, index) => index === 0 || value > values[index - 1]);
  if (!axis(mesh.us) || !axis(mesh.vs)) return false;
  const expected = (3 * (mesh.us.length - 1) + 1) * (3 * (mesh.vs.length - 1) + 1);
  if (mesh.points.length !== expected) return false;
  return mesh.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
}

/**
 * 变形网格的**变形框**：上游 `edit.transform.*` 的 `rect` 是 `[x0,y0,x1,y1]`（两个角），
 * 与 `cropParams` 的 `[x,y,w,h]` 不是一套约定。这里用显式类型避免两处混用。
 */
export type TransformRect = [number, number, number, number];

/** 角点框是否合法（有限且 x1>x0、y1>y0）。 */
export function isValidTransformRect(rect: TransformRect): boolean {
  return rect.every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1];
}

export function warpMeshParams(mesh: WarpMesh, options: {
  rect?: TransformRect;
  interpolation?: "bicubic" | "bilinear" | "nearest";
} = {}): Record<string, unknown> | { error: string } {
  if (!isValidWarpMesh(mesh)) return { error: "变形网格必须满足 1–64 块、块边界 0–1 递增，控制点数为 (3c+1)×(3r+1)" };
  const params: Record<string, unknown> = { mesh };
  if (options.rect) {
    if (!isValidTransformRect(options.rect)) return { error: "变形框必须是 x1>x0、y1>y0 的角点 [x0,y0,x1,y1]" };
    params.rect = options.rect;
  }
  if (options.interpolation) params.interpolation = options.interpolation;
  return params;
}

/** 网格分割：每边 1–64 块，或 `default` 表示单块。 */
/**
 * 网格分割参数。
 *
 * `warp` 是**当前正在编辑的变形**：上游 `edit.transform.warpGrid` 要么内联拿到它，要么去读活动
 * 智能对象上已存的变形。界面的变形会话持有这份对象，因此这里始终显式传下去，避免出现
 * 「点网格分割却报参数错误」。
 */
export function warpGridParams(
  size: number | "default",
  warp?: unknown
): Record<string, unknown> | { error: string } {
  if (size !== "default" && (!Number.isInteger(size) || size < 1 || size > 64)) {
    return { error: "网格分割必须是 1–64 的整数或 default" };
  }
  const out: Record<string, unknown> = { size: size === "default" ? "default" : size };
  if (warp !== undefined && warp !== null) out.warp = warp;
  return out;
}

/**
 * 操控变形的钉点：`at` 是钉住的源点（不写 `to` 表示钉住不动），`to` 是拖动后的目标点。
 *
 * 上游的钉点字段是 `{src,dst}`，这里编译成那个形状——界面仍用「位置 / 拖到」的说法。
 */
export type PuppetPin = { at: [number, number]; to?: [number, number]; rotate?: number; depth?: number };

export const PUPPET_MODES = ["rigid", "normal", "distort"] as const;
export const PUPPET_DENSITY = ["fewer", "normal", "more"] as const;

export function puppetWarpParams(pins: readonly PuppetPin[], options: {
  mode?: (typeof PUPPET_MODES)[number];
  density?: (typeof PUPPET_DENSITY)[number];
  /** 网格扩张（像素），-200–200。 */
  expansion?: number;
  interpolation?: "bicubic" | "bilinear" | "nearest";
} = {}): Record<string, unknown> | { error: string } {
  if (pins.length === 0) return { error: "操控变形至少需要一个钉点" };
  if (pins.length > 512) return { error: "钉点数量超过 512" };
  const compiled: Record<string, unknown>[] = [];
  for (const pin of pins) {
    if (![pin.at, pin.to ?? []].flat().every((value) => Number.isFinite(value))) return { error: "钉点坐标必须是有限数值" };
    const entry: Record<string, unknown> = { src: pin.at, dst: pin.to ?? pin.at };
    if (pin.rotate !== undefined) {
      if (!Number.isFinite(pin.rotate) || Math.abs(pin.rotate) > 360) return { error: "钉点旋转必须在 ±360° 内" };
      entry.rotate = pin.rotate;
    }
    // 深度是钉点的叠放层级（整数）；给非整数会被内核静默丢弃，这里直接拒绝。
    if (pin.depth !== undefined) {
      if (!Number.isInteger(pin.depth) || Math.abs(pin.depth) > 2_147_483_647) return { error: "钉点深度必须是整数" };
      entry.depth = pin.depth;
    }
    compiled.push(entry);
  }
  const params: Record<string, unknown> = { pins: compiled };
  if (options.mode !== undefined) {
    if (!PUPPET_MODES.includes(options.mode)) return { error: "操控变形模式必须是 rigid|normal|distort" };
    params.mode = options.mode;
  }
  if (options.density !== undefined) {
    if (!PUPPET_DENSITY.includes(options.density)) return { error: "网格密度必须是 fewer|normal|more" };
    params.density = options.density;
  }
  if (options.expansion !== undefined) {
    if (!Number.isFinite(options.expansion) || options.expansion < -200 || options.expansion > 200) return { error: "网格扩张必须在 -200–200 之间" };
    params.expansion = options.expansion;
  }
  if (options.interpolation !== undefined) params.interpolation = options.interpolation;
  return params;
}

export const PERSPECTIVE_STRAIGHTEN = ["horizontal", "vertical", "auto"] as const;

/**
 * 透视变形的单个平面：把 `quad`（拖动后的四角）编译成一个 `{src,dst}` 平面。
 *
 * 与上次的 `image.perspectiveCrop` 不同，这里**不改画布**，只把源框映射到四角；源框默认整幅画布。
 */
export function perspectiveWarpParams(quad: PerspectiveCorners, options: {
  /** 源框角点 `[x0,y0,x1,y1]`（与上游 `rect` 同义）；省略时为整幅画布。 */
  rect?: TransformRect;
  straighten?: (typeof PERSPECTIVE_STRAIGHTEN)[number];
  interpolation?: "bicubic" | "bilinear" | "nearest";
  layer?: number;
} = {}): Record<string, unknown> | { error: string } {
  if (!isValidPerspectiveQuad(quad)) return { error: "四个角必须构成顺时针凸四边形" };
  const params: Record<string, unknown> = { quad };
  if (options.rect) {
    if (!isValidTransformRect(options.rect)) return { error: "源框必须是 x1>x0、y1>y0 的角点 [x0,y0,x1,y1]" };
    params.rect = options.rect.map((value) => Math.round(value));
  }
  if (options.straighten !== undefined) {
    if (!PERSPECTIVE_STRAIGHTEN.includes(options.straighten)) return { error: "透视拉直必须是 horizontal|vertical|auto" };
    params.straighten = options.straighten;
  }
  if (options.interpolation !== undefined) params.interpolation = options.interpolation;
  if (options.layer !== undefined) {
    if (!Number.isInteger(options.layer) || options.layer < 0) return { error: "图层 id 非法" };
    params.layer = options.layer;
  }
  return params;
}

/**
 * 网格分割/移除：`at` 是分割点（文档坐标）；省略时上游取该块的中间。
 *
 * `removeWarpSplit` 与三个分割命令共用同一参数形状，只是 `id` 不同。
 */
/**
 * 拆分变形参数。与 `warpGridParams` 一样必须带上当前正在编辑的变形：没有它上游只能去读活动
 * 智能对象，普通像素层上一定失败。
 */
/**
 * 网格分割参数。
 *
 * `at` 是**文档坐标**（不是归一化参数）：上游 `split_warp` 拿这个点去 `param_at` 反解块内参数，
 * 因此界面上双击哪个画布位置，就切在哪个位置。省略 `at` 表示切在块中点。
 */
export function warpSplitParams(
  at?: [number, number],
  warp?: unknown
): Record<string, unknown> | { error: string } {
  const out: Record<string, unknown> = {};
  if (at !== undefined) {
    if (!Array.isArray(at) || at.length !== 2 || !at.every((value) => Number.isFinite(value))) {
      return { error: "分割点必须是有限坐标 [x,y]" };
    }
    out.at = at;
  }
  if (warp !== undefined && warp !== null) out.warp = warp;
  return out;
}

// ---------------------------------------------------------------- 填充、描边与渐隐

export const FILL_CONTENTS = ["foreground", "background", "color", "contentAware", "pattern", "history", "black", "gray", "white"] as const;
export type FillContents = (typeof FILL_CONTENTS)[number];

export type FillOptions = {
  contents?: FillContents;
  color?: string;
  pattern?: string;
  scale?: number;
  angle?: number;
  mode?: string;
  opacity?: number;
  preserveTransparency?: boolean;
  colorAdaptation?: boolean;
};

export const FILL_BLEND_MODES = [
  "normal", "multiply", "screen", "overlay", "softLight", "hardLight",
  "darken", "lighten", "difference", "color", "luminosity", "dissolve"
] as const;
export type FillBlendMode = (typeof FILL_BLEND_MODES)[number];

export function fillParams(options: FillOptions = {}): Record<string, unknown> | { error: string } {
  const contents = options.contents ?? "color";
  if (!FILL_CONTENTS.includes(contents)) return { error: "不支持的填充内容" };
  const params: Record<string, unknown> = { contents };
  if (contents === "color") {
    if (!options.color || !/^#[0-9a-fA-F]{6}$/.test(options.color)) return { error: "填充颜色必须是 #rrggbb" };
    params.color = options.color;
  }
  if (contents === "pattern" && !options.pattern) return { error: "图案填充需要选择图案" };
  if (contents === "pattern") params.pattern = options.pattern;
  if (options.scale !== undefined) {
    if (!Number.isFinite(options.scale) || options.scale < 1 || options.scale > 1600) return { error: "图案缩放必须在 1–1600% 之间" };
    params.scale = options.scale;
  }
  if (options.angle !== undefined) {
    if (!Number.isFinite(options.angle) || Math.abs(options.angle) > 360) return { error: "图案角度必须在 ±360° 内" };
    params.angle = options.angle;
  }
  if (options.mode !== undefined) {
    if (!FILL_BLEND_MODES.includes(options.mode as FillBlendMode)) return { error: "不支持的混合模式" };
    params.mode = options.mode;
  }
  if (options.opacity !== undefined) {
    if (!Number.isFinite(options.opacity) || options.opacity < 0 || options.opacity > 100) return { error: "不透明度必须在 0–100 之间" };
    params.opacity = options.opacity;
  }
  if (options.preserveTransparency !== undefined) params.preserveTransparency = options.preserveTransparency;
  if (options.colorAdaptation !== undefined) params.colorAdaptation = options.colorAdaptation;
  return params;
}

export type StrokeOptions = {
  width?: number;
  location?: "inside" | "center" | "outside";
  color?: string;
  opacity?: number;
  mode?: FillBlendMode;
  preserveTransparency?: boolean;
};

/** 描边宽度按 Photoshop 向上取整到整像素。 */
export function strokeParams(options: StrokeOptions = {}): Record<string, unknown> | { error: string } {
  const width = options.width ?? 1;
  if (!Number.isFinite(width) || width < 1 || width > 250) return { error: "描边宽度必须在 1–250 像素之间" };
  const location = options.location ?? "center";
  if (!["inside", "center", "outside"].includes(location)) return { error: "描边位置必须是 inside|center|outside" };
  const params: Record<string, unknown> = { width: Math.ceil(width), location };
  if (options.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(options.color)) return { error: "描边颜色必须是 #rrggbb" };
    params.color = options.color;
  }
  if (options.opacity !== undefined) {
    if (!Number.isFinite(options.opacity) || options.opacity < 0 || options.opacity > 100) return { error: "不透明度必须在 0–100 之间" };
    params.opacity = options.opacity;
  }
  if (options.mode !== undefined) {
    if (!FILL_BLEND_MODES.includes(options.mode)) return { error: "不支持的混合模式" };
    params.mode = options.mode;
  }
  if (options.preserveTransparency !== undefined) params.preserveTransparency = options.preserveTransparency;
  return params;
}

export function fadeParams(opacity: number, mode?: FillBlendMode): Record<string, unknown> | { error: string } {
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) return { error: "渐隐不透明度必须在 0–100 之间" };
  if (mode !== undefined && !FILL_BLEND_MODES.includes(mode)) return { error: "不支持的混合模式" };
  return mode ? { opacity, mode } : { opacity };
}

// ---------------------------------------------------------------- 照片合并

export const PHOTO_LAYOUTS = ["auto", "perspective", "cylindrical", "spherical", "collage", "reposition"] as const;
export type PhotoLayout = (typeof PHOTO_LAYOUTS)[number];

export function autoAlignParams(options: {
  projection?: PhotoLayout;
  reference?: number;
  geometricCorrection?: boolean;
  registration?: "auto" | "features" | "intensity";
} = {}): Record<string, unknown> | { error: string } {
  const projection = options.projection ?? "auto";
  if (!PHOTO_LAYOUTS.includes(projection)) return { error: "不支持的投影方式" };
  const params: Record<string, unknown> = { projection };
  if (options.reference !== undefined) {
    if (!Number.isInteger(options.reference) || options.reference < 0) return { error: "参考图层 id 非法" };
    params.reference = options.reference;
  }
  if (options.geometricCorrection !== undefined) params.geometricCorrection = options.geometricCorrection;
  if (options.registration !== undefined) params.registration = options.registration;
  return params;
}

export function autoBlendParams(options: {
  method?: "panorama" | "stack";
  seamlessTones?: boolean;
  haloControl?: number;
  depthMap?: boolean;
} = {}): Record<string, unknown> | { error: string } {
  const method = options.method ?? "panorama";
  if (!["panorama", "stack"].includes(method)) return { error: "自动混合方式必须是 panorama|stack" };
  const params: Record<string, unknown> = { method };
  if (options.seamlessTones !== undefined) params.seamlessTones = options.seamlessTones;
  if (options.haloControl !== undefined) {
    if (!Number.isFinite(options.haloControl) || options.haloControl < 0 || options.haloControl > 8) return { error: "光晕控制必须在 0–8 之间" };
    params.haloControl = options.haloControl;
  }
  if (options.depthMap !== undefined) params.depthMap = options.depthMap;
  return params;
}

/** Photomerge 只接受已打开文档：浏览器不能读取任意文件夹。 */
export function photomergeParams(options: {
  layout?: PhotoLayout;
  blend?: boolean;
  vignetteRemoval?: boolean;
  geometricCorrection?: boolean;
  contentAwareFill?: boolean;
  focalLength?: number;
} = {}): Record<string, unknown> | { error: string } {
  const layout = options.layout ?? "auto";
  if (!PHOTO_LAYOUTS.includes(layout)) return { error: "不支持的版面" };
  const params: Record<string, unknown> = { useOpenDocuments: true, layout };
  for (const key of ["blend", "vignetteRemoval", "geometricCorrection", "contentAwareFill"] as const) {
    const value = options[key];
    if (value !== undefined) params[key] = value;
  }
  if (options.focalLength !== undefined) {
    if (!Number.isFinite(options.focalLength) || options.focalLength < 0 || options.focalLength > 2000) return { error: "焦距必须在 0–2000 mm 之间" };
    params.focalLength = options.focalLength;
  }
  return params;
}

// ---------------------------------------------------------------- 画板、框架与切片

export const ARTBOARD_BACKGROUNDS = ["white", "black", "transparent", "custom"] as const;
export type ArtboardBackground = (typeof ARTBOARD_BACKGROUNDS)[number];

export type ArtboardOptions = {
  frame?: CropFrame;
  preset?: string;
  name?: string;
  background?: ArtboardBackground;
  color?: string;
  moveContents?: boolean;
};

export function artboardParams(options: ArtboardOptions = {}): Record<string, unknown> | { error: string } {
  const params: Record<string, unknown> = {};
  if (options.frame) {
    const { x, y, width, height } = options.frame;
    if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return { error: "画板尺寸至少为 1 × 1 像素" };
    Object.assign(params, { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
  }
  if (options.preset !== undefined) params.preset = options.preset;
  if (options.name !== undefined) {
    if (!options.name.trim() || options.name.length > 200) return { error: "画板名称必须是 1–200 个字符" };
    params.name = options.name;
  }
  const background = options.background ?? "white";
  if (!ARTBOARD_BACKGROUNDS.includes(background)) return { error: "不支持的画板背景" };
  params.background = background;
  if (background === "custom") {
    if (!options.color || !/^#[0-9a-fA-F]{6}$/.test(options.color)) return { error: "自定义画板背景需要 #rrggbb 颜色" };
    params.color = options.color;
  }
  if (options.moveContents !== undefined) params.moveContents = options.moveContents;
  return params;
}

export function frameParams(options: CropFrame & { shape?: "rectangle" | "ellipse"; name?: string }): Record<string, unknown> | { error: string } {
  const { x, y, width, height } = options;
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return { error: "框架尺寸至少为 1 × 1 像素" };
  const shape = options.shape ?? "rectangle";
  if (!["rectangle", "ellipse"].includes(shape)) return { error: "框架形状必须是 rectangle|ellipse" };
  const params: Record<string, unknown> = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), shape };
  if (options.name !== undefined) {
    if (!options.name.trim() || options.name.length > 200) return { error: "框架名称必须是 1–200 个字符" };
    params.name = options.name;
  }
  return params;
}

export const SLICE_KINDS = ["image", "noImage", "table"] as const;
export type SliceKind = (typeof SLICE_KINDS)[number];

export type SliceOptions = {
  frame: CropFrame;
  name?: string;
  kind?: SliceKind;
  url?: string;
  alt?: string;
  background?: "none" | `#${string}`;
};

export function sliceParams(options: SliceOptions): Record<string, unknown> | { error: string } {
  const { x, y, width, height } = options.frame;
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return { error: "切片尺寸至少为 1 × 1 像素" };
  const params: Record<string, unknown> = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  if (options.name !== undefined) {
    if (!options.name.trim() || options.name.length > 200) return { error: "切片名称必须是 1–200 个字符" };
    params.name = options.name;
  }
  if (options.kind !== undefined) {
    if (!SLICE_KINDS.includes(options.kind)) return { error: "切片类型必须是 image|noImage|table" };
    params.kind = options.kind;
  }
  if (options.url !== undefined) {
    if (options.url.length > 1024) return { error: "切片链接超过 1024 个字符" };
    params.url = options.url;
  }
  if (options.alt !== undefined) {
    if (options.alt.length > 1024) return { error: "替代文本超过 1024 个字符" };
    params.alt = options.alt;
  }
  if (options.background !== undefined) {
    if (options.background !== "none" && !/^#[0-9a-fA-F]{6}$/.test(options.background)) return { error: "切片背景必须是 none 或 #rrggbb" };
    params.background = options.background;
  }
  return params;
}

/** 参考线网格能产生的切片数（竖线 + 1）×（横线 + 1），用于提交前提示结构预算。 */
export function guideSliceCount(vertical: readonly number[], horizontal: readonly number[]): number {
  return (vertical.length + 1) * (horizontal.length + 1);
}
