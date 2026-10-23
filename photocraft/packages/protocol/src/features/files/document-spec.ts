/**
 * 新建文档尺寸预设（本域纯数据）
 * （change: 2026-10-22-add-photocraft-file-workflows，U01）。
 *
 * 只描述**新建**时可选的长宽比/尺寸条目；真正的文档由内核按同一参数创建，界面不复制文档模型。
 * 所有值都是像素/ppi 的有界整数，写入前再经 `validateNewDocumentSpec` 复核。
 */

/** 新建参数上限：与内核一致（`photocraft_project_verify` 的共享上限），不在此抬高。 */
export const NEW_DOCUMENT_LIMITS = {
  maxSide: 8192,
  maxPixels: 8192 * 8192,
  minResolution: 1,
  maxResolution: 30_000,
  maxNameChars: 255,
  /** 预设数量上限（与引擎 `document_preset_cmds::MAX_PRESETS` 一致）。 */
  maxPresets: 256,
  /** 最近设置条目上限（与引擎一致）。 */
  maxRecent: 20
} as const;

/** 本运行时真正支持的模式与位深；其他组合在创建前就拒绝。 */
export const NEW_DOCUMENT_MODES = ["rgb"] as const;
export const NEW_DOCUMENT_DEPTHS = [8] as const;

export type NewDocumentBackground = "white" | "black" | "transparent" | `#${string}`;

/** 通过校验的新建参数（界面与内核同形）。 */
export type NewDocumentSpec = {
  width: number;
  height: number;
  resolution: number;
  mode: "rgb";
  depth: 8;
  background: NewDocumentBackground;
  name: string;
};

export type NewDocumentSpecResult =
  | { ok: true; value: NewDocumentSpec }
  | { ok: false; error: string };

/** 预设：名称 + 同一套新建设置（显示单位不参与文档创建，故不保存）。 */
export type DocumentPreset = { name: string; settings: NewDocumentSpec };

/** 一个尺寸预设候选（界面下拉/网格用；不写入文档）。 */
export type SizePreset = {
  id: string;
  label: string;
  width: number;
  height: number;
  /** 预设自带的打印分辨率；省略表示沿用表单当前值。 */
  resolution?: number;
};

/**
 * 覆盖常见交付尺寸的固定预设。
 *
 * 打印类预设必须连分辨率一起给出：只设像素会让「A4 300ppi」变成 72ppi 的 2480×3508 文档，
 * 尺寸对但打印密度错，属于会误导用户的假预设。屏幕交付不写 DPI，避免把显示偏好写进文档。
 */
export const SIZE_PRESETS: readonly SizePreset[] = [
  { id: "square-1080", label: "方形 1080", width: 1080, height: 1080 },
  { id: "social-1200x630", label: "社交横图 1200×630", width: 1200, height: 630 },
  { id: "story-1080x1920", label: "竖屏 1080×1920", width: 1080, height: 1920 },
  { id: "hd-1920x1080", label: "全高清 1920×1080", width: 1920, height: 1080 },
  { id: "a4-300", label: "A4 300ppi 2480×3508", width: 2480, height: 3508, resolution: 300 },
  { id: "print-3000", label: "印刷 3000×2000", width: 3000, height: 2000 },
] as const;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isSide(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= NEW_DOCUMENT_LIMITS.maxSide;
}

function isResolution(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= NEW_DOCUMENT_LIMITS.minResolution && value <= NEW_DOCUMENT_LIMITS.maxResolution;
}

/**
 * 校验并规范化新建参数。
 *
 * 与内核 `file.new` 的拒绝条件一致（尺寸/像素总量/分辨率/RGB-8/背景/名称），但**不**补默认值：
 * 界面必须显式给出宽高，缺省由调用方先填，避免把「看起来能用」的空输入提交成文档。
 */
export function validateNewDocumentSpec(input: unknown): NewDocumentSpecResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "新建参数必须是对象" };
  const value = input as Record<string, unknown>;
  const { width, height } = value;
  if (!isSide(width) || !isSide(height)) {
    return { ok: false, error: `宽高必须是 1–${NEW_DOCUMENT_LIMITS.maxSide} 的整数像素` };
  }
  if (!Number.isInteger(width) || !Number.isInteger(height)) return { ok: false, error: "宽高必须是整数像素" };
  if (width * height > NEW_DOCUMENT_LIMITS.maxPixels) {
    return { ok: false, error: `像素总量不能超过 ${NEW_DOCUMENT_LIMITS.maxPixels}` };
  }
  const resolution = value.resolution ?? 72;
  if (!isResolution(resolution)) {
    return { ok: false, error: `分辨率必须是 ${NEW_DOCUMENT_LIMITS.minResolution}–${NEW_DOCUMENT_LIMITS.maxResolution} ppi` };
  }
  const mode = value.mode ?? "rgb";
  if (mode !== "rgb") return { ok: false, error: `当前只支持 RGB 模式（收到 ${String(mode)}）` };
  const depth = value.depth ?? 8;
  if (depth !== 8) return { ok: false, error: `当前只支持 8 位/通道（收到 ${String(depth)}）` };
  const background = value.background ?? "white";
  if (background !== "white" && background !== "black" && background !== "transparent"
    && !(typeof background === "string" && HEX.test(background))) {
    return { ok: false, error: "背景只能是 white、black、transparent 或 #rrggbb" };
  }
  const rawName = value.name ?? "未命名";
  if (typeof rawName !== "string") return { ok: false, error: "文档名必须是字符串" };
  const name = rawName.trim();
  if (name.length > NEW_DOCUMENT_LIMITS.maxNameChars) {
    return { ok: false, error: `文档名不能超过 ${NEW_DOCUMENT_LIMITS.maxNameChars} 个字符` };
  }
  return {
    ok: true,
    value: {
      width,
      height,
      resolution,
      mode: "rgb",
      depth: 8,
      background: background as NewDocumentBackground,
      name: name.length === 0 ? "未命名" : name
    }
  };
}

/** 上次用于新建的设置是否可以直接重放（尺寸仍在当前上限内）。 */
export function canReplayDocumentSpec(input: unknown): boolean {
  return validateNewDocumentSpec(input).ok;
}

/** 预设名称规范化：去空白、1–255 字符；空白返回 null。 */
export function normalizePresetName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const name = input.trim();
  return name.length === 0 || name.length > NEW_DOCUMENT_LIMITS.maxNameChars ? null : name;
}
