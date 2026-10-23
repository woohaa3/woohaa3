/**
 * 逐工具冻结设置
 * （change: 2026-10-22-add-photocraft-painting-color-workflows，U27–U36 / design D1）。
 *
 * 设计 D1 要求：**笔迹开始时冻结整笔设置**。不同绘画工具（画笔/铅笔/颜色替换/背景橡皮/
 * 魔术橡皮/渐变/油漆桶/吸管）各自记忆自己的参数，切换工具不互相污染，也不借用画笔的设置。
 *
 * 本模块只做纯状态与编解码：没有 React、没有 WASM、没有文档。界面把状态编成命令参数；
 * 内核仍然是唯一执行者与校验者。
 */
import {
  DEFAULT_BACKGROUND_ERASER,
  DEFAULT_BUCKET,
  DEFAULT_COLOR_REPLACEMENT,
  DEFAULT_EYEDROPPER,
  DEFAULT_GRADIENT,
  DEFAULT_MAGIC_ERASER,
  DEFAULT_PENCIL,
  type BackgroundEraserSettings,
  type BucketSettings,
  type ColorReplacementSettings,
  type EyedropperSettings,
  type GradientSettings,
  type MagicEraserSettings,
  type PencilSettings,
  type SymmetryMode,
  type SymmetrySettings
} from "./tool-modes.js";
import type { PaintBlendMode } from "./blend-modes.js";

/** 本域自有的绘画工具 id（与 `features/painting/index.ts` 的工具贡献一致）。 */
export type PaintingToolId =
  | "brush"
  | "pencil"
  | "colorReplacement"
  | "eraser"
  | "backgroundEraser"
  | "magicEraser"
  | "gradient"
  | "bucket"
  | "eyedropper";

export const PAINTING_TOOL_IDS: readonly PaintingToolId[] = [
  "brush",
  "pencil",
  "colorReplacement",
  "eraser",
  "backgroundEraser",
  "magicEraser",
  "gradient",
  "bucket",
  "eyedropper"
];

/** 每个工具记住的设置；共同字段（尺寸/硬度/不透明度/流量）不重复存两套。 */
export type PaintingToolSettings = {
  pencil: PencilSettings;
  colorReplacement: ColorReplacementSettings;
  backgroundEraser: BackgroundEraserSettings;
  magicEraser: MagicEraserSettings;
  gradient: GradientSettings;
  bucket: BucketSettings;
  eyedropper: EyedropperSettings;
  /** 对称是文档级工具状态，凡绘画工具共用。 */
  symmetry: SymmetrySettings;
  /** 绘画混合模式（画笔/铅笔/颜色替换/背景橡皮共用一档；渐变与桶各有自己的设置）。 */
  blendMode: PaintBlendMode;
};

export function defaultPaintingToolSettings(center: [number, number] = [0, 0]): PaintingToolSettings {
  return {
    pencil: { ...DEFAULT_PENCIL },
    colorReplacement: { ...DEFAULT_COLOR_REPLACEMENT },
    backgroundEraser: { ...DEFAULT_BACKGROUND_ERASER },
    magicEraser: { ...DEFAULT_MAGIC_ERASER },
    gradient: { ...DEFAULT_GRADIENT, stops: DEFAULT_GRADIENT.stops.map((stop) => ({ ...stop })) },
    bucket: { ...DEFAULT_BUCKET },
    eyedropper: { ...DEFAULT_EYEDROPPER },
    symmetry: { mode: "vertical", center: [center[0], center[1]], rotation: 0 },
    blendMode: "normal"
  };
}

/**
 * 工具切换时的设置读取：未知/非本域工具回落到画笔。
 *
 * 返回**副本**，因此面板改草稿不会直接改到已冻结的上一笔设置。
 */
export function settingsForTool(current: PaintingToolSettings, tool: string): PaintingToolSettings[keyof Omit<PaintingToolSettings, "symmetry" | "blendMode">] | null {
  switch (tool) {
    case "pencil": return { ...current.pencil };
    case "colorReplacement": return { ...current.colorReplacement };
    case "backgroundEraser": return { ...current.backgroundEraser };
    case "magicEraser": return { ...current.magicEraser };
    case "gradient": return { ...current.gradient, stops: current.gradient.stops.map((stop) => ({ ...stop })), transparency: current.gradient.transparency.map((stop) => ({ ...stop })) };
    case "bucket": return { ...current.bucket };
    case "eyedropper": return { ...current.eyedropper };
    default: return null;
  }
}

/** 工具是否有本模块管理的专用设置面板。 */
export function hasDedicatedSettings(tool: string): tool is Exclude<PaintingToolId, "brush" | "eraser"> {
  return tool !== "brush" && tool !== "eraser" && (PAINTING_TOOL_IDS as readonly string[]).includes(tool);
}

/**
 * 一次笔迹的冻结快照：开始笔迹时取一份，结束前不再读界面状态。
 *
 * 这样即使面板在拖动中被改动，已开始的这一笔仍按开始时的设置落笔（design D1）。
 */
export type FrozenStrokeSettings<T> = { readonly tool: string; readonly settings: T; readonly blendMode: string };

export function freezeStroke<T>(tool: string, settings: T, blendMode: string): FrozenStrokeSettings<T> {
  return Object.freeze({ tool, settings: structuredClone(settings), blendMode });
}

/** 对称设置可编辑字段的钳制（中心必须在文档内，旋转归一化到 0–360）。 */
export function normalizeSymmetry(settings: SymmetrySettings, width: number, height: number): SymmetrySettings {
  const clampAxis = (value: number, limit: number) => Number.isFinite(value) ? Math.min(Math.max(value, 0), Math.max(limit, 0)) : limit / 2;
  const rotation = Number.isFinite(settings.rotation) ? ((settings.rotation % 360) + 360) % 360 : 0;
  return {
    mode: settings.mode,
    center: [clampAxis(settings.center[0], width), clampAxis(settings.center[1], height)],
    rotation
  };
}

/** 对称按钮的显示名（面板与可访问名称共用一份）。 */
export const SYMMETRY_LABELS: Record<SymmetryMode, string> = {
  vertical: "垂直对称",
  horizontal: "水平对称",
  dual: "双轴对称",
  diagonal: "对角对称"
};

/** 工具预设可保存的工具 id（与内核 `is_supported_tool` 的白名单一致）。 */
export const TOOL_PRESET_TOOLS: readonly string[] = [
  "brush",
  "pencil",
  "eraser",
  "backgroundEraser",
  "magicEraser",
  "colorReplacement",
  "gradient",
  "bucket",
  "eyedropper",
  "clone",
  "cloneStamp",
  "heal",
  "healing",
  "retouch"
];
