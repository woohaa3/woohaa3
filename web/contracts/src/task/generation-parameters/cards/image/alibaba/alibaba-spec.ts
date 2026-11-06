/**
 * 阿里（万相 / Qwen-Image / Z-Image）生图官方 `size` 语义的**形状与纯函数**——这里没有
 * 「某个版本有什么」的数据。
 *
 * 每个模型的能力写在它的卡片上（`generation-parameters/cards/image/alibaba/alibaba-*.ts` 的
 * `alibaba` 块）：比例、档位、默认比例与档位、像素表引用、参考图上限、负向提示词与智能改写。
 * 卡片是唯一事实来源，本模块只提供：
 *
 * 1. `AlibabaSizePreset`：卡片投影出来的形状，百炼 Provider 与 `image-parameters` 共用；
 * 2. **官方像素表**：同一张表被多个型号共用（万相 2.7 的两张表、Qwen-Image 全系、Z-Image），
 *    抄进每张卡片就是多份真相，所以按「档位」收敛在这里，卡片只声明用哪几个档位；
 * 3. 查表函数（比例 + 档位 → 像素）。
 *
 * 与即梦的关键差异：百炼通道的 `size` 用 `宽*高`（星号），不是 `WIDTHxHEIGHT`；而且这套 API
 * **没有** `aspect_ratio` 参数，宽高比同样只能通过 `size` 表达。所以像素表里存的就是最终要发
 * 的串，不做二次格式化。
 *
 * 事实来源（2026-11-06 核对）：
 * - 生图总览 <https://help.aliyun.com/zh/model-studio/text-to-image>
 * - Qwen-Image 生图与编辑 API 参考
 *   <https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference>
 *   （3.0 / 2.1 系列；2.0 系列仍只在旧文生图页
 *   <https://help.aliyun.com/zh/model-studio/qwen-image-api>）
 * - 通义万相 <https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference>
 * - Z-Image <https://help.aliyun.com/zh/model-studio/z-image-api-reference>
 */

/** 官方推荐像素表：比例 → 分辨率档 → `宽*高`。 */
export type AlibabaSizeTable = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** 万相 / Qwen-Image 共用的比例取值域（官方推荐的五个）。 */
export const ALIBABA_WAN_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;

/** Z-Image 的比例域多出 2:3 / 3:2 / 21:9。 */
export const ALIBABA_Z_IMAGE_ASPECT_RATIOS = [
  "1:1", "2:3", "3:2", "3:4", "4:3", "16:9", "9:16", "21:9",
] as const;

/**
 * 万相 2.7 的 2K 表。
 *
 * 官方只给一张表，4K 档只对 `wan2.7-image-pro` 的文生图有效（带参考图与 2.7-image 都封顶
 * 2048*2048），所以 pro 与普通版分成两张表：普通版没有 4K 档。
 */
const WAN_27_2K_SIZES: AlibabaSizeTable = {
  "1:1": { "2K": "2048*2048" },
  "16:9": { "2K": "2688*1536" },
  "9:16": { "2K": "1536*2688" },
  "4:3": { "2K": "2368*1728" },
  "3:4": { "2K": "1728*2368" }
};

const WAN_27_1K_SIZES: AlibabaSizeTable = {
  "1:1": { "1K": "1280*1280" },
  "16:9": { "1K": "1696*960" },
  "9:16": { "1K": "960*1696" },
  "4:3": { "1K": "1472*1104" },
  "3:4": { "1K": "1104*1472" }
};

/** 万相 pro 的 4K 档（仅纯文生图）。 */
const WAN_27_4K_SIZES: AlibabaSizeTable = {
  "1:1": { "4K": "4096*4096" },
  "16:9": { "4K": "4096*2304" },
  "9:16": { "4K": "2304*4096" },
  "4:3": { "4K": "4096*3072" },
  "3:4": { "4K": "3072*4096" }
};

/** Qwen-Image 系列：同一张推荐表，`1:1` 就是模型默认的 2048*2048。 */
const QWEN_IMAGE_SIZES: AlibabaSizeTable = {
  "1:1": { "2K": "2048*2048" },
  "16:9": { "2K": "2688*1536" },
  "9:16": { "2K": "1536*2688" },
  "4:3": { "2K": "2368*1728" },
  "3:4": { "2K": "1728*2368" }
};

/** Z-Image 只有 1K 档：官方推荐 1024*1024 到 1536*1536 三个总量。 */
const Z_IMAGE_SIZES: AlibabaSizeTable = {
  "1:1": { "1K": "1280*1280" },
  "2:3": { "1K": "1024*1536" },
  "3:2": { "1K": "1536*1024" },
  "3:4": { "1K": "1104*1472" },
  "4:3": { "1K": "1472*1104" },
  "9:16": { "1K": "864*1536" },
  "16:9": { "1K": "1536*864" },
  "21:9": { "1K": "1680*720" }
};

/** 同一张比例表按档位合并（`mergeSizeTables` 不覆盖同名比例，先给优先）。 */
function combineSizeTables(
  ...tables: readonly AlibabaSizeTable[]
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const merged: Record<string, Record<string, string>> = {};
  for (const table of tables) {
    for (const [ratio, tiers] of Object.entries(table)) {
      merged[ratio] = { ...tiers, ...merged[ratio] };
    }
  }
  return merged;
}

/** 万相 pro：三档全开（4K 仅纯文生图，靠 `referenceResolutionCap` 收口）。 */
export const ALIBABA_WAN_PRO_SIZES = combineSizeTables(
  WAN_27_4K_SIZES,
  WAN_27_2K_SIZES,
  WAN_27_1K_SIZES
);

/** 万相 2.7 普通版：没有 4K 档。 */
export const ALIBABA_WAN_SIZES = combineSizeTables(WAN_27_2K_SIZES, WAN_27_1K_SIZES);

/** Qwen-Image 全系：只有 2K 档。 */
export const ALIBABA_QWEN_SIZES = QWEN_IMAGE_SIZES;

/** Z-Image：只有 1K 档，但比例最全。 */
export const ALIBABA_Z_IMAGE_SIZES = Z_IMAGE_SIZES;

/** 卡片投影出来的阿里模型语义（`alibaba-cards` 按 id 查找后交给 Provider）。 */
export type AlibabaSizePreset = {
  /** 规范 id（取自卡片），仅用于诊断与测试。 */
  id: string;
  /** 比例取值域（按 UI 优先顺序）。 */
  aspectRatios: readonly string[];
  /** 分辨率档位。 */
  resolutions: readonly string[];
  defaultAspectRatio: string;
  defaultResolution: string;
  /**
   * 是否提供「自适应」比例（`auto`）。
   *
   * 只有 Qwen-Image 全系成立：官方写明「不指定 `size` 时，模型根据提示词自动推荐分辨率」，
   * 所以面板给一档自适应、请求里**省略** `size` 就是官方语义。万相与 Z-Image 的 `size` 虽
   * 也是可选，但省略时退化成固定默认（万相是正方形，Z-Image 是 1024*1536），不是按提示词
   * 推荐，所以它们不给这个选项——给了就是在骗用户。
   */
  supportsAdaptiveAspectRatio: boolean;
  /**
   * 比例 + 档位 → 像素 `size`（`宽*高`）。
   *
   * 尺寸是文档的「推荐分辨率」，不是唯一合法值：上游接受一个像素总量区间，这里只挑官方列出
   * 的那一组，保证出图不踩边界。
   */
  sizes: AlibabaSizeTable;
  /** 不传 `size` 时的兜底值（模型自己的默认分辨率）。 */
  fallbackSize: string;
  /**
   * 带参考图（图生图）时的分辨率上限。
   *
   * 万相 2.7 Pro 的 4K 档只对纯文生图开放：一旦带参考图，上游只接受 2048*2048 以内，所以
   * 面板给了 4K 也要压回上限档，不能把注定 400 的组合发出去。
   */
  referenceResolutionCap?: string;
  /** 参考图上限（取自卡片的 `limits.references.image.max`，不另存一份数字）。 */
  maxReferenceImages: number;
  /** 是否接受 `negative_prompt`。 */
  supportsNegativePrompt: boolean;
  /** 负向提示词长度上限（字符）；`0` 表示不支持。 */
  negativePromptLimit: number;
  /** 是否接受 `prompt_extend`（智能改写）。 */
  supportsPromptExtend: boolean;
  /** `prompt_extend` 的默认值（仅 `supportsPromptExtend` 时有意义）。 */
  promptExtendDefault: boolean;
};

/**
 * 比例 + 档位 → 官方像素值。
 *
 * 表的第一个维度是**比例**（`sizes[ratio][tier]`，与即梦的 `sizes[tier][ratio]` 相反），
 * 因为阿里官方文档就是按比例列出的。
 * 比例或档位不在表里时返回 undefined，调用方回退到 `fallbackSize`。
 */
export function alibabaPixelSize(
  preset: AlibabaSizePreset,
  aspectRatio: unknown,
  resolution: unknown
): string | undefined {
  const ratio = typeof aspectRatio === "string" ? aspectRatio.trim() : "";
  const tier = typeof resolution === "string" ? resolution.trim() : "";
  if (ratio === "" || tier === "") return undefined;
  return preset.sizes[ratio]?.[tier];
}

/**
 * 带参考图时允许的最高档位：`referenceResolutionCap` 之后（含）都算可用。
 *
 * 用它把面板给的档位收窄到上游接受的范围，同时让「选了 4K 但带参考图」退到 2K 而不是发一个
 * 注定 400 的 `size`。
 */
export function clampAlibabaResolution(
  preset: AlibabaSizePreset,
  resolution: unknown,
  hasReferences: boolean
): string {
  const tier = typeof resolution === "string" && resolution.trim() !== ""
    ? resolution.trim()
    : preset.defaultResolution;
  const cap = preset.referenceResolutionCap;
  if (!hasReferences || cap === undefined) return tier;
  const order = preset.resolutions;
  const capIndex = order.indexOf(cap);
  const tierIndex = order.indexOf(tier);
  // 表里没有这个档位（或者它本来就不高于上限）时原样返回，交给查表兜底。
  if (capIndex < 0 || tierIndex < 0 || tierIndex <= capIndex) return tier;
  return cap;
}
