/**
 * Seedream（即梦）官方 `size` 语义的**形状与纯函数**——这里没有「某个版本有什么」的数据。
 *
 * 每个版本的能力写在它的卡片上（`generation-parameters/cards/image/ark/seedream-*.ts` 的
 * `seedream` 块）：档位、档位 × 宽高比的官方像素表引用、默认档、网关收窄、是否支持透明背景。
 * 卡片是唯一事实来源，本模块只提供：
 *
 * 1. `SeedreamSizePreset`：卡片投影出来的形状，各 Provider（Ark 原生、TokenHub、LiteLLM
 *    网关）与 `image-parameters` 共用；
 * 2. **官方像素表**：同一张 2K 表被 5.0 pro / flash / lite / 4.5 共用，抄进四张卡片就是
 *    四份真相，所以按「档位」收敛在这里一张表，卡片只声明用哪几个档位；
 * 3. 查表与判定函数（比例 + 档位 → 像素、网关收窄档位、是否有比例表、是否支持透明）。
 *
 * 即梦/Seedream 的生图接口**没有** `aspect_ratio` 与 `quality`：宽高比与分辨率都只能通过
 * `size` 表达，两种写法（分辨率档位 / `WIDTHxHEIGHT`）不可混用。
 *
 * 数据来自火山方舟图片生成文档（`size` 的两种方式、总像素窗口、`background` 的模型列表）：
 * - https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh
 * - https://docs.volcengine.com/docs/ark/seedream-5-0-pro?lang=zh
 * 逐档像素表取自同源文档的镜像（表格可复制），官方页面为 JS 渲染。
 */

/** 官方像素表里的宽高比（顺序取自文档表格）。 */
export const SEEDREAM_ASPECT_RATIOS = [
  "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9",
] as const;

/** 官方分辨率档位。 */
export type SeedreamResolutionTier = "1K" | "1.5K" | "2K" | "3K" | "4K";

/**
 * 官方「档位 × 宽高比 → 像素值」表。
 *
 * 档位是全局规范（同一档位在不同版本里是同一张表），所以只在这里维护一份；
 * 卡片用 `seedreamSizeTable(...)` 声明自己用哪几个档位。
 *
 * 5.0 lite / 4.5 的 4K 表：镜像文档把 4:3 / 3:4 与 3:2 / 2:3 两行的像素值写反了
 * （4:3 那行给的是竖图 3520x4704）。这里按像素值实际表达的宽高比归位，保证选 4:3 拿到横图；
 * 像素值本身未改动，且都落在官方总像素窗口内（见各卡片的 `pixelWindow` 与单测）。
 */
export const SEEDREAM_TIER_SIZE_TABLES: Readonly<
  Record<SeedreamResolutionTier, Readonly<Record<string, string>>>
> = {
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
  "3K": {
    "1:1": "3072x3072",
    "4:3": "3456x2592",
    "3:4": "2592x3456",
    "16:9": "4096x2304",
    "9:16": "2304x4096",
    "3:2": "3744x2496",
    "2:3": "2496x3744",
    "21:9": "4704x2016",
  },
  "4K": {
    "1:1": "4096x4096",
    "4:3": "4704x3520",
    "3:4": "3520x4704",
    "16:9": "5504x3040",
    "9:16": "3040x5504",
    "3:2": "4992x3328",
    "2:3": "3328x4992",
    "21:9": "6240x2656",
  },
};

/** 从规范表里取若干档位，供卡片声明 `sizes`。 */
export function seedreamSizeTable(
  ...tiers: readonly SeedreamResolutionTier[]
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const table: Record<string, Readonly<Record<string, string>>> = {};
  for (const tier of tiers) table[tier] = SEEDREAM_TIER_SIZE_TABLES[tier];
  return table;
}

/** 卡片投影出来的即梦版本语义（`seedream-cards` 按 id 查找后交给各 Provider）。 */
export type SeedreamSizePreset = {
  /** 规范 id（取自卡片），仅用于诊断与测试。 */
  id: string;
  /** 精确匹配的模型 id（小写）。卡片自己声明的 `providerModelId` 也会并进来。 */
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
  /** 参考图上限（取自卡片的 `limits.references.image.max`，不另存一份数字）。 */
  maxReferenceImages: number;
  /**
   * 官方「图片透明通道」（`background`）能力：目前只有 5.0 pro / 5.0 flash 支持。
   *
   * 官方要点（文档「background」一节）：取值 `transparent` / `opaque`（默认 `opaque`）；
   * **只在图生图、且只输入 1 张带透明通道的图片时生效**；透明时输出默认 PNG，
   * 与 `output_format: jpeg` 同时出现会被上游直接拒绝。所以面板把透明选项与
   * `outputFormat: png` 联动（`x-pptask-requires`），请求翻译层也强制补 PNG。
   */
  transparentBackground?: boolean;
};

/** 认得出是即梦、但没有任何卡片匹配时的模型 id 前缀。 */
export const SEEDREAM_UNKNOWN_PREFIXES = ["seedream", "doubao-seedream"] as const;

/**
 * 未登记版本（没有任何卡片匹配）的保守取值：只给最宽松的档位，不猜像素表与画幅。
 *
 * 这不是某个模型的事实，而是「识别到即梦但版本未知」这条路径的兜底；真实版本一律走卡片。
 */
export const SEEDREAM_UNKNOWN_VERSION: SeedreamSizePreset = {
  id: "seedream-unknown",
  resolutions: ["1K", "2K", "4K"],
  defaultResolution: "2K",
  sizes: {},
  aspectRatios: [],
  pixelWindow: { minTotalPixels: 921_600, maxTotalPixels: 16_777_216, minAspectRatio: 1 / 16, maxAspectRatio: 16 },
  maxReferenceImages: 14,
};

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

/** 该版本是否支持官方「透明背景」（`background`）：决定面板是否提供「背景」控件、请求是否下发。 */
export function seedreamSupportsTransparentBackground(preset: SeedreamSizePreset): boolean {
  return preset.transparentBackground === true;
}
