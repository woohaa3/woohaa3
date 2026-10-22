/**
 * Seedream（即梦）图片模型的官方 `size` 语义。
 *
 * 即梦/Seedream 的生图接口**没有** `aspect_ratio` 与 `quality` 参数：宽高比与分辨率都只能
 * 通过 `size` 表达。`size` 有两种写法：
 *
 * 1. 分辨率档位（`1K` / `1.5K` / `2K` / `3K` / `4K`）——只声明画质档，宽高比由模型结合
 *    prompt 与参考图决定，也就是面板上的「自适应」；
 * 2. 官方像素值（`WIDTHxHEIGHT`）——用来**固定宽高比**，每个档位有一张官方像素表。
 *
 * 网关（LiteLLM / TokenHub）与 Ark 原生接口共用这一套取值，所以档位、像素表与参考图上限
 * 放在 contracts，Provider 只负责把面板语义翻译到自己的请求字段（原生 Ark 的 `size`、
 * OpenAI 兼容网关的 `size` 都一样，翻译层只查表）。组图、图层拆分、输出格式这类
 * **模型级能力**仍由 Ark 目录（`ark-provider/src/provider/catalog.ts`）声明，不在这里重复。
 *
 * 档位以官方文档为准，但**网关与原生接口的能力并不总是对齐**：5.0 pro 的官方档位是
 * 1K / 1.5K / 2K，经 LiteLLM 网关调用时上游却只放行 1K / 2K（见 `gatewayResolutions`）。
 * 因此 `resolutions` 保留官方语义给原生 Ark 用，网关链路按 `gatewayResolutions` 收窄——
 * 面板与请求映射都取收窄后的档位，避免「面板能选 1.5K、请求被上游挡回」。
 *
 * 数据来自火山方舟图片生成文档的「模型参数」节（Seedream 5.0 pro / flash、5.0 lite、
 * 4.5、4.0 各有一页；`size` 的两种方式、总像素窗口与宽高比范围在那里）：
 * - https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh
 * - https://docs.volcengine.com/docs/ark/seedream-5-0-pro?lang=zh
 * - https://docs.volcengine.com/docs/ark/seedream-4-0-5-0?lang=zh
 * 逐档像素表取自同源文档的镜像（表格可复制），官方页面为 JS 渲染。
 *
 * 4.0 的文档只列了一组像素值、没有按档位拆分，所以它没有「比例 × 档位」组合：只能选档位，
 * 宽高比交给 prompt（与官方推荐的用法一致）。未知版本不猜，落到 Provider 自己的回退。
 */

/** 官方像素表里的宽高比（顺序取自文档表格）。 */
export const SEEDREAM_ASPECT_RATIOS = [
  "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9",
] as const;

export type SeedreamSizePreset = {
  /** 规范 id，仅用于诊断与测试。 */
  id: string;
  /** 精确匹配的模型 id（小写）。 */
  aliases?: readonly string[];
  /** 前缀匹配的模型 id（小写），用于带日期后缀的 id。 */
  prefixes?: readonly string[];
  /** 官方 `size` 档位。 */
  resolutions: readonly string[];
  /**
   * 经 LiteLLM 网关（OpenAI 兼容图片接口）调用时**再收窄**的档位，缺省与官方一致。
   *
   * 被收窄的只有「档位串」：官方方式 2 的像素值不受影响，所以像素表仍按官方数据保留。
   * 目前只有 5.0 pro 需要——上游对 `doubao-seedream-5-0-pro-260628` 返回
   * `size ... must be one of 1K, 2K or a custom WIDTHxHEIGHT value.`。
   */
  gatewayResolutions?: readonly string[];
  defaultResolution: string;
  /**
   * 官方像素表：档位 → 宽高比 → `WIDTHxHEIGHT`。
   *
   * 空对象表示该版本没有按档位给出的比例表（例如 4.0），此时不对外暴露「比例」。
   */
  sizes: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** 该版本可选的宽高比；没有像素表时为空。 */
  aspectRatios: readonly string[];
  /**
   * 显式像素值的总像素窗口（宽 × 高，不是对单边的限制）与宽高比范围。
   *
   * 官方对「方式 2：WIDTHxHEIGHT」的要求，Provider 校验与像素表自检都用它。
   */
  pixelWindow: {
    minTotalPixels: number;
    maxTotalPixels: number;
    minAspectRatio: number;
    maxAspectRatio: number;
  };
  /** 参考图上限（与 Ark 目录一致）。 */
  maxReferenceImages: number;
};

/** 5.0 Pro / 5.0 Flash 的官方像素表（1K / 1.5K / 2K）。 */
const PRO_SIZES = {
  "1K": {
    "1:1": "1024x1024",
    "4:3": "1152x864",
    "3:4": "864x1152",
    "16:9": "1424x800",
    "9:16": "800x1424",
    "3:2": "1248x832",
    "2:3": "832x1248",
    "21:9": "1568x672",
  },
  "1.5K": {
    "1:1": "1536x1536",
    "4:3": "1792x1344",
    "3:4": "1344x1792",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "3:2": "1872x1248",
    "2:3": "1248x1872",
    "21:9": "2352x1008",
  },
  "2K": {
    "1:1": "2048x2048",
    "4:3": "2304x1728",
    "3:4": "1728x2304",
    "16:9": "2848x1600",
    "9:16": "1600x2848",
    "3:2": "2496x1664",
    "2:3": "1664x2496",
    "21:9": "3136x1344",
  },
} as const;

/** 5.0 Lite / 4.5 的 2K 档与 5.0 Pro 相同，单独命名便于阅读。 */
const TWO_K_SIZES = PRO_SIZES["2K"];

/** 5.0 Lite 的 3K 档。 */
const THREE_K_SIZES = {
  "1:1": "3072x3072",
  "4:3": "3456x2592",
  "3:4": "2592x3456",
  "16:9": "4096x2304",
  "9:16": "2304x4096",
  "3:2": "3744x2496",
  "2:3": "2496x3744",
  "21:9": "4704x2016",
} as const;

/**
 * 5.0 Lite / 4.5 的 4K 档。
 *
 * 镜像文档的这张表把 4:3 / 3:4 与 3:2 / 2:3 两行的像素值写反了（4:3 那行给的是竖图
 * 3520x4704）。这里按像素值实际表达的宽高比归位，保证选 4:3 拿到横图；像素值本身
 * 未改动，且都落在官方总像素窗口内（见 `pixelWindow` 与单测）。
 */
const FOUR_K_SIZES = {
  "1:1": "4096x4096",
  "4:3": "4704x3520",
  "3:4": "3520x4704",
  "16:9": "5504x3040",
  "9:16": "3040x5504",
  "3:2": "4992x3328",
  "2:3": "3328x4992",
  "21:9": "6240x2656",
} as const;

const PRO_ASPECT_RATIOS = SEEDREAM_ASPECT_RATIOS;

/**
 * 5.0 Pro：官方档位 1K / 1.5K / 2K，像素表按档位给出。
 *
 * 官方（Ark / BytePlus）给 pro 与 flash 都列了 1.5K，但**经 LiteLLM 网关调用时 pro 只放行
 * 1K / 2K**，所以网关链路收窄到 `gatewayResolutions`；原生 Ark 直连不受此限，仍按官方
 * `resolutions` 提供 1.5K。
 */
const SEEDREAM_5_PRO: SeedreamSizePreset = {
  id: "seedream-5-pro",
  aliases: ["seedream-5-pro", "doubao-seedream-5.0-pro", "doubao-seedream-5-0-pro"],
  prefixes: ["seedream-5-pro", "seedream-image-5-pro", "doubao-seedream-5-0-pro"],
  resolutions: ["1K", "1.5K", "2K"],
  gatewayResolutions: ["1K", "2K"],
  defaultResolution: "2K",
  sizes: PRO_SIZES,
  aspectRatios: PRO_ASPECT_RATIOS,
  pixelWindow: { minTotalPixels: 921_600, maxTotalPixels: 4_624_220, minAspectRatio: 1 / 16, maxAspectRatio: 16 },
  maxReferenceImages: 10,
};

/** 5.0 Flash：1K–2K，像素表与 pro 相同（官方两个版本共用同一张表），网关未收窄。 */
const SEEDREAM_5_FLASH: SeedreamSizePreset = {
  id: "seedream-5-flash",
  aliases: ["seedream-5-flash", "doubao-seedream-5.0-flash", "doubao-seedream-5-0-flash"],
  prefixes: ["seedream-5-flash", "seedream-image-5-flash", "doubao-seedream-5-0-flash"],
  resolutions: ["1K", "1.5K", "2K"],
  defaultResolution: "2K",
  sizes: PRO_SIZES,
  aspectRatios: PRO_ASPECT_RATIOS,
  pixelWindow: { minTotalPixels: 921_600, maxTotalPixels: 4_624_220, minAspectRatio: 1 / 16, maxAspectRatio: 16 },
  maxReferenceImages: 10,
};

/** 5.0 Lite：2K–4K，像素表按档位给出。 */
const SEEDREAM_5_LITE: SeedreamSizePreset = {
  id: "seedream-5-lite",
  aliases: ["seedream-5-lite", "seedream-image-5-lite", "doubao-seedream-5-0-260128"],
  prefixes: ["seedream-5-lite", "seedream-image-5-lite", "doubao-seedream-5-0-lite"],
  resolutions: ["2K", "3K", "4K"],
  defaultResolution: "2K",
  sizes: { "2K": TWO_K_SIZES, "3K": THREE_K_SIZES, "4K": FOUR_K_SIZES },
  aspectRatios: PRO_ASPECT_RATIOS,
  pixelWindow: { minTotalPixels: 3_686_400, maxTotalPixels: 16_777_216, minAspectRatio: 1 / 16, maxAspectRatio: 16 },
  maxReferenceImages: 14,
};

/** 4.5：2K–4K，像素表按档位给出。 */
const SEEDREAM_4_5: SeedreamSizePreset = {
  id: "seedream-4.5",
  aliases: ["seedream-4.5", "seedream-image-4.5", "doubao-seedream-4.5"],
  prefixes: ["seedream-4.5", "seedream-4-5", "seedream-image-4.5", "doubao-seedream-4-5"],
  resolutions: ["2K", "4K"],
  defaultResolution: "2K",
  sizes: { "2K": TWO_K_SIZES, "4K": FOUR_K_SIZES },
  aspectRatios: PRO_ASPECT_RATIOS,
  pixelWindow: { minTotalPixels: 3_686_400, maxTotalPixels: 16_777_216, minAspectRatio: 1 / 16, maxAspectRatio: 16 },
  maxReferenceImages: 14,
};

/** 4.0：1K–4K；文档只给一组像素值，没有「比例 × 档位」组合。 */
const SEEDREAM_4_0: SeedreamSizePreset = {
  id: "seedream-4.0",
  aliases: ["seedream-4.0", "seedream-image-4", "doubao-seedream-4.0"],
  prefixes: ["seedream-4", "seedream-image-4", "doubao-seedream-4"],
  resolutions: ["1K", "2K", "4K"],
  defaultResolution: "2K",
  sizes: {},
  aspectRatios: [],
  pixelWindow: { minTotalPixels: 921_600, maxTotalPixels: 16_777_216, minAspectRatio: 1 / 16, maxAspectRatio: 16 },
  maxReferenceImages: 14,
};

/**
 * 兜底：只认得出「这是即梦」但不知道版本时，仍给分辨率档位，不给比例。
 *
 * 即梦的 `size` 没有通用默认表（各版本档位与像素值都不同），所以这里只保留最宽松的
 * 档位集合；已下线的 3.0 只接受 WIDTHxHEIGHT、没有档位，不在这份数据里建模。
 */
const SEEDREAM_GENERIC: SeedreamSizePreset = {
  id: "seedream",
  prefixes: ["seedream", "doubao-seedream"],
  resolutions: ["1K", "2K", "4K"],
  defaultResolution: "2K",
  sizes: {},
  aspectRatios: [],
  pixelWindow: { minTotalPixels: 921_600, maxTotalPixels: 16_777_216, minAspectRatio: 1 / 16, maxAspectRatio: 16 },
  maxReferenceImages: 14,
};

/** 注册表顺序即匹配优先级：更具体的版本必须排在通用前缀之前。 */
export const SEEDREAM_SIZE_PRESETS: readonly SeedreamSizePreset[] = [
  SEEDREAM_5_LITE,
  SEEDREAM_5_PRO,
  SEEDREAM_5_FLASH,
  SEEDREAM_4_5,
  SEEDREAM_4_0,
  SEEDREAM_GENERIC,
];

/** 按模型 id 匹配即梦版本；未命中返回 undefined（调用方回退到自己的通用取值域）。 */
export function seedreamSizePresetFor(modelId: string): SeedreamSizePreset | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (normalized === "") return undefined;
  return SEEDREAM_SIZE_PRESETS.find((preset) =>
    (preset.aliases?.some((alias) => normalized === alias) ?? false)
    || (preset.prefixes?.some((prefix) => normalized.startsWith(prefix)) ?? false)
  );
}

/**
 * 比例 + 档位 → 官方像素值。
 *
 * 版本没有比例表、比例或档位不在表里时返回 undefined，调用方据此回退到档位（表示
 * 「宽高比交给模型」）。
 */
export function seedreamPixelSize(
  preset: SeedreamSizePreset,
  aspectRatio: unknown,
  resolution: unknown,
): string | undefined {
  const ratio = typeof aspectRatio === "string" ? aspectRatio.trim() : "";
  const tier = typeof resolution === "string" ? resolution.trim() : "";
  if (ratio === "" || tier === "") return undefined;
  const tiers = preset.sizes[tier];
  if (!tiers) return undefined;
  return tiers[ratio];
}

/**
 * 经 LiteLLM 网关调用时可用的档位：声明了 `gatewayResolutions` 的版本以它为准，
 * 其余与官方一致。面板与请求映射都取这里，保证「能选的」与「发得出去的」一致。
 */
export function seedreamGatewayResolutions(preset: SeedreamSizePreset): readonly string[] {
  return preset.gatewayResolutions ?? preset.resolutions;
}

/** 该版本是否有官方比例表（决定面板是否提供「比例」控件）。 */
export function seedreamSupportsAspectRatio(preset: SeedreamSizePreset): boolean {
  return Object.keys(preset.sizes).length > 0;
}
