/**
 * LiteLLM 系**视频**模型的参数家族与请求字段映射（共享实现）。
 *
 * 与 `image-parameters.ts` 同构，解决同一个问题：面板要按「人怎么想」出控件（时长、比例、
 * 分辨率），上游网关要的是另一套字段（OpenAI Videos 的 `seconds` + 像素 `size`）。
 * 家族判定与翻译必须只有一份，否则同一个 seedance 在本地插件与远端托管两条链路上
 * 会出不同的参数面板。
 *
 * 三条事实决定了这里的形状：
 *
 * 1. **网关走 OpenAI Videos**：`POST /v1/videos` 只认 `prompt` / `model` / `seconds` /
 *    `size`（参考素材另走 `content`）。所以比例与分辨率**都要收敛成像素 `size`**，
 *    没有独立的 `ratio` 字段可发。
 * 2. **时长是个枚举而不是滑块连续值**：各家只接受几个离散值（4/6/8、5/10 …）。滑块
 *    必须按 `step` 对齐，否则面板选出来的值会被上游拒。
 * 3. **模型 id 不可穷举**：网关目录是发现式的，id 带日期后缀与别名。匹配只能按前缀，
 *    未命中一律返回 null，由 Provider 保留服务端下发的自描述 schema——不猜能力。
 */
import { aspectRatioField, resolutionField } from "./parameter-schema.js";

/** 视频参数家族：只描述「面板能选什么」，请求字段翻译见 `videoRequestFields`。 */
export type VideoFamilySpec = {
  /** 稳定 id，仅用于诊断与测试。 */
  id: string;
  /** 人读标题，用在模型名缺失时的兜底展示。 */
  title: string;
  /** 匹配用的前缀（小写）。顺序即优先级，更具体的版本排在通用前缀之前。 */
  prefixes: readonly string[];
  /** 时长区间；`step` 决定面板滑块的步长。 */
  duration: { min: number; max: number; step: number; default: number };
  /** 可用的宽高比。 */
  ratios: readonly string[];
  /** 可用分辨率档位（短边）。 */
  resolutions: readonly string[];
  defaultResolution: string;
  /** 该家族是否接受「自适应」比例（不声明比例，由模型决定）。 */
  adaptiveRatio: boolean;
  /** 参考图上限；0 表示不接受参考图（纯文生视频）。 */
  maxReferenceImages: number;
};

/** 常见画幅。多数视频模型只支持前六种。 */
const RATIOS_STANDARD = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
/** Veo 一类只给横竖两种。 */
const RATIOS_WIDE_TALL = ["16:9", "9:16"] as const;

/**
 * 视频家族表。顺序即匹配优先级。
 *
 * 数值来自各家公开文档的**稳定区间**（不是精确到某个日期的上线档位）：网关更新档位时，
 * 面板最多多一个或少一个选项，不会因为区间写错而把合法请求拦在本地。
 */
export const VIDEO_FAMILIES: readonly VideoFamilySpec[] = [
  {
    id: "seedance-2.5",
    title: "Seedance 2.5",
    prefixes: ["seedance-2.5", "seedance-2-5", "doubao-seedance-2-5"],
    duration: { min: 4, max: 30, step: 1, default: 5 },
    ratios: RATIOS_STANDARD,
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "720p",
    adaptiveRatio: true,
    maxReferenceImages: 30
  },
  {
    id: "seedance-2.0",
    title: "Seedance 2.0",
    prefixes: ["seedance-2", "seedance-2.0", "seedance-2-0", "doubao-seedance-2-0"],
    duration: { min: 4, max: 15, step: 1, default: 5 },
    ratios: RATIOS_STANDARD,
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "720p",
    adaptiveRatio: true,
    maxReferenceImages: 9
  },
  {
    id: "seedance-1.0",
    title: "Seedance 1.0",
    prefixes: ["seedance-1", "seedance-1.0", "seedance", "doubao-seedance"],
    duration: { min: 2, max: 12, step: 1, default: 5 },
    ratios: RATIOS_STANDARD,
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "720p",
    adaptiveRatio: true,
    maxReferenceImages: 2
  },
  {
    id: "veo",
    title: "Veo",
    prefixes: ["veo", "google-veo"],
    duration: { min: 4, max: 8, step: 2, default: 8 },
    ratios: RATIOS_WIDE_TALL,
    resolutions: ["720p", "1080p"],
    defaultResolution: "720p",
    adaptiveRatio: false,
    maxReferenceImages: 1
  },
  {
    id: "minimax-h3",
    title: "MiniMax H3",
    // 变体（Highspeed / Lite / Max）共用同一套字段，差别只在分辨率与时长下限：
    // 这里取最宽的那档，具体卡片可以再收窄。
    prefixes: ["minimax-h3", "minimax_h3", "hailuo-03"],
    duration: { min: 4, max: 15, step: 1, default: 5 },
    ratios: RATIOS_STANDARD,
    resolutions: ["768p", "2k"],
    defaultResolution: "768p",
    adaptiveRatio: true,
    maxReferenceImages: 9
  },
];

/** 按上游模型 id 匹配家族；未命中返回 undefined（Provider 保留服务端 schema）。 */
export function videoFamilyFor(modelId: string): VideoFamilySpec | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (normalized === "") return undefined;
  return VIDEO_FAMILIES.find((family) =>
    family.prefixes.some((prefix) => normalized.startsWith(prefix))
  );
}

/** 短边档位（`720p`）→ 像素短边。 */
const SHORT_SIDE: Readonly<Record<string, number>> = {
  "480p": 480,
  "540p": 540,
  "720p": 720,
  "1080p": 1080,
  "1440p": 1440,
  "2160p": 2160,
  "4k": 2160
};

/**
 * 比例 + 档位 → 像素 `size`（`WIDTHxHEIGHT`，两边都是偶数）。
 *
 * 偶数是为了满足编码器对 YUV420 的要求：奇数宽高会让上游直接拒绝编码。
 */
export function videoPixelSize(ratio: string, resolution: string): string | undefined {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio.trim());
  const shortSide = SHORT_SIDE[resolution.trim().toLowerCase()];
  if (match === null || shortSide === undefined) return undefined;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!(w > 0) || !(h > 0)) return undefined;
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  return w >= h
    ? `${even((shortSide * w) / h)}x${even(shortSide)}`
    : `${even(shortSide)}x${even((shortSide * h) / w)}`;
}

/**
 * 家族专属参数 schema。
 *
 * 与 `imageFamilyParameters` 同形：只声明**语义键**（面板认得），不声明上游字段。
 * 未识别家族返回 null，由调用方保留服务端下发的那份自描述 schema。
 */
export function videoFamilyParameters(modelId: string): {
  schemaVersion: string;
  maxReferenceImages: number;
  properties: Record<string, unknown>;
  defaults: Record<string, unknown>;
} | null {
  const family = videoFamilyFor(modelId);
  if (family === null || family === undefined) return null;

  const properties: Record<string, unknown> = {
    durationSeconds: {
      type: "number",
      title: "时长",
      default: family.duration.default,
      minimum: family.duration.min,
      maximum: family.duration.max,
      step: family.duration.step,
      unit: "秒"
    },
    ...(family.adaptiveRatio
      ? {
          aspectRatio: aspectRatioField({
            ratios: family.ratios,
            adaptive: true,
            fallback: "adaptive",
            title: "比例"
          })
        }
      : {
          aspectRatio: aspectRatioField({
            ratios: family.ratios,
            fallback: family.ratios[0],
            title: "比例"
          })
        }),
    resolution: resolutionField({
      tiers: family.resolutions,
      fallback: family.defaultResolution,
      title: "分辨率"
    })
  };

  return {
    schemaVersion: `litellm-${family.id}-video/v1`,
    maxReferenceImages: family.maxReferenceImages,
    properties,
    defaults: {
      durationSeconds: family.duration.default,
      aspectRatio: family.adaptiveRatio ? "adaptive" : family.ratios[0],
      resolution: family.defaultResolution
    }
  };
}

/**
 * 面板语义 → OpenAI Videos 的请求字段。
 *
 * - `durationSeconds` → `seconds`（并夹到家族区间、按 step 对齐）；
 * - `aspectRatio` + `resolution` → 像素 `size`；自适应时不发 `size`，让上游按提示词决定。
 *
 * 只发上游认识的字段：多塞一个 `ratio` 之类的键会让严格的网关直接 400。
 */
export function videoRequestFields(
  modelId: string,
  parameters: Record<string, unknown>
): Record<string, string | number> {
  const family = videoFamilyFor(modelId);
  if (family === undefined) return passThrough(parameters);

  const fields: Record<string, string | number> = {};

  const requested = Number(parameters.durationSeconds ?? parameters.duration ?? parameters.seconds);
  const duration = Number.isFinite(requested)
    ? clampToStep(requested, family.duration)
    : family.duration.default;
  fields.seconds = duration;

  const ratio = readText(parameters.aspectRatio ?? parameters.ratio ?? parameters.aspect_ratio);
  const resolution = readText(parameters.resolution);
  if (ratio !== undefined && !isAdaptive(ratio)) {
    const safeRatio = family.ratios.includes(ratio) ? ratio : family.ratios[0]!;
    const safeResolution = resolution && family.resolutions.includes(resolution)
      ? resolution
      : family.defaultResolution;
    const size = videoPixelSize(safeRatio, safeResolution);
    if (size !== undefined) fields.size = size;
  }
  return fields;
}

/** 未识别家族时原样保留服务端转发的字段（服务端最了解它自己的上游）。 */
function passThrough(parameters: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  return out;
}

function clampToStep(
  value: number,
  range: { min: number; max: number; step: number; default: number }
): number {
  const bounded = Math.min(range.max, Math.max(range.min, value));
  const stepped = range.min + Math.round((bounded - range.min) / range.step) * range.step;
  return Number.isInteger(stepped) ? stepped : range.default;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isAdaptive(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "auto" || normalized === "adaptive";
}
