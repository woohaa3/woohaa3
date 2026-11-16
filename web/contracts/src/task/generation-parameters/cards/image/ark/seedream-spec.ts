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
 * 官方像素表的分组。
 *
 * **同一个档位在不同版本里不是同一张表**：官方文档按模型族各给一张「分辨率 × 宽高比」
 * 映射表，2K 尤其不能混——5.5 / 5.0 pro / flash 的 2K 4:3 是 2368x1776，5.0 lite / 4.5
 * 的 2K 4:3 是 2304x1728。所以表按族分组，不能只按档位收敛成一张全局部。
 *
 * - `pro`：Seedream 5.5、5.0 pro / flash，档位 1K / 1.5K / 2K
 * - `lite`：Seedream 5.0 lite、4.5，档位 2K / 3K / 4K（4.5 只用 2K / 4K）
 * - `4.0`：Seedream 4.0，档位 1K / 2K / 4K；2K / 4K 与 `lite` 相同，只有 1K 是单独一套
 *   （16:9 = 1280x720、21:9 = 1512x648，比 pro 的 1424x800 / 1568x672 更窄）
 */
export type SeedreamSizeTableFamily = "pro" | "lite" | "4.0";

const PRO_TIERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
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
    "4:3": "2368x1776",
    "3:4": "1776x2368",
    "16:9": "2816x1584",
    "9:16": "1584x2816",
    "3:2": "2496x1664",
    "2:3": "1664x2496",
    "21:9": "3136x1344",
  },
};

/** 5.0 lite / 4.5 共用的 2K / 3K / 4K 表。 */
const LITE_TIERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
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

/** 4.0 只有 1K 与上面两族不同；2K / 4K 直接复用 `lite`。 */
const FOUR_TIERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "1K": {
    "1:1": "1024x1024",
    "4:3": "1152x864",
    "3:4": "864x1152",
    "16:9": "1280x720",
    "9:16": "720x1280",
    "3:2": "1248x832",
    "2:3": "832x1248",
    "21:9": "1512x648",
  },
  "2K": LITE_TIERS["2K"]!,
  "4K": LITE_TIERS["4K"]!,
};

/**
 * 官方「族 × 档位 × 宽高比 → 像素值」表。
 *
 * 表按族分组（见 `SeedreamSizeTableFamily`）：同一档位在不同族里可以是不同像素值，
 * 卡片用 `seedreamSizeTable(family, ...tiers)` 声明自己用哪一族的哪几个档位。
 *
 * 5.0 lite / 4.5 的 4K 表：镜像文档把 4:3 / 3:4 与 3:2 / 2:3 两行的像素值写反了
 * （4:3 那行给的是竖图 3520x4704）。这里按像素值实际表达的宽高比归位，保证选 4:3 拿到横图；
 * 像素值本身未改动，且都落在官方总像素窗口内（见各卡片的 `pixelWindow` 与单测）。
 */
export const SEEDREAM_SIZE_TABLES: Readonly<
  Record<SeedreamSizeTableFamily, Readonly<Record<string, Readonly<Record<string, string>>>>>
> = {
  pro: PRO_TIERS,
  lite: LITE_TIERS,
  "4.0": FOUR_TIERS,
};

/** 从某一族的规范表里取若干档位，供卡片声明 `sizes`。 */
export function seedreamSizeTable(
  family: SeedreamSizeTableFamily,
  ...tiers: readonly SeedreamResolutionTier[]
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const table: Record<string, Readonly<Record<string, string>>> = {};
  const tiersOfFamily = SEEDREAM_SIZE_TABLES[family];
  for (const tier of tiers) {
    const pixels = tiersOfFamily[tier];
    if (pixels === undefined) {
      throw new Error(`Seedream ${family} has no official size table for tier ${tier}`);
    }
    table[tier] = pixels;
  }
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
  /**
   * 该版本的请求字段与高级能力。缺省一律按“最保守”理解：不下发可选项、不猜高级参数。
   *
   * 这些开关与数值都来自官方「图片生成 API」文档的模型参数表（按版本逐行列出）；
   * 卡片是它们唯一存放处，Provider 只负责读。
   */
  features?: SeedreamFeatureFlags;
};

/**
 * 即梦各版本在**请求字段层面**的差异。
 *
 * 很多字段不是“填了就有用”，而是“这个版本压根不认”：传过去直接 400。
 * 例如 `output_format` 只有 5.x 认，4.5 / 4.0 传了就报
 * `the parameter output_format is not supported by the current model`；
 * `optimize_prompt_options.mode=fast` 只有 5.0 pro 与 4.0 认。
 */
export type SeedreamFeatureFlags = {
  /**
   * 是否接受 `output_format` 请求字段。
   *
   * `false`（4.5 / 4.0）时**一个字符都不能发**：模型只出 JPEG，传 `jpeg` 也照样 400。
   */
  outputFormatParameter?: boolean;
  /** 允许的提示词优化模式；缺省只允许 `standard`（`fast` 只有某些版本有）。 */
  promptOptimizeModes?: readonly ("standard" | "fast")[];
  /**
   * 图层拆分的高级参数 `layer_decomposition_options`。
   *
   * 只有 5.5 认这个对象；5.0 pro / flash 只能光一个 `layer_decomposition: true`，
   * 传了 `layer_decomposition_options` 会被拒绝。
   */
  layerDecompositionOptions?: {
    minImages: number;
    maxImages: number;
    defaultMaxImages: number;
    /** 是否支持 `text_recognition`（规整文字图层的富文本 OCR）。 */
    textRecognition: boolean;
  };
  /** 支持联网搜索（`tools: [{ type: "web_search" }]`），目前只有 5.0 lite。 */
  webSearch?: boolean;
  /** 支持流式输出（`stream: true`），5.0 lite / 4.5 / 4.0 有。 */
  streaming?: boolean;
  /**
   * 透明背景是否也能从**文生图**发起。
   *
   * `false` / 缺省：官方只允许“图生图 && 只输入 1 张带透明通道的图片”（5.0 pro / flash）。
   * `true`：文生图与图生图都能出原生 RGBA（5.5）。
   */
  transparentBackgroundFromText?: boolean;
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

/**
 * 该版本是否接受 `output_format` 请求字段。
 *
 * 缺省为 `false`（保守）：未登记的版本宁可不发这个字段，也不要让上游 400。
 */
export function seedreamSupportsOutputFormatParameter(preset: SeedreamSizePreset): boolean {
  return preset.features?.outputFormatParameter === true;
}

/** 该版本允许的提示词优化模式；缺省只有 `standard`。 */
export function seedreamPromptOptimizeModes(
  preset: SeedreamSizePreset
): readonly ("standard" | "fast")[] {
  const modes = preset.features?.promptOptimizeModes;
  return modes && modes.length > 0 ? modes : ["standard"];
}

/** 该版本的图层拆分高级参数；缺省表示不认 `layer_decomposition_options`。 */
export function seedreamLayerDecompositionOptions(
  preset: SeedreamSizePreset
): SeedreamFeatureFlags["layerDecompositionOptions"] {
  return preset.features?.layerDecompositionOptions;
}

/** 透明背景是否也能从文生图发起（目前只有 5.5）。 */
export function seedreamTransparentBackgroundFromText(preset: SeedreamSizePreset): boolean {
  return preset.features?.transparentBackgroundFromText === true;
}
