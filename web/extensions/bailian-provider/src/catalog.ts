/**
 * 百炼生图模型目录（手写，不是发现来的）。
 *
 * 为什么不发现：DashScope 没有免鉴权的模型列表接口，所有管理面接口都要 Key，且返回的是
 * 全品类（含文本、向量、语音）的部署信息，按「生图」筛选仍要一张能力表才能出参数面板。
 * 所以这里按官方文档登记**能力数字**，执行路径只有一条。
 *
 * 事实来源（2026-11-06 核对）：
 * - 生图总览 <https://help.aliyun.com/zh/model-studio/text-to-image>
 * - Qwen-Image 文生图 <https://help.aliyun.com/zh/model-studio/qwen-image-api>
 * - Qwen-Image 编辑 <https://help.aliyun.com/zh/model-studio/qwen-image-edit-api>
 * - 通义万相 <https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference>
 * - Z-Image <https://help.aliyun.com/zh/model-studio/z-image-api-reference>
 *
 * 只登记**生图**。任何模型的参数支持范围以这里为准：文档没写的开关不做成控件，避免把
 * 上游会 400 的组合暴露给用户。
 *
 * 上游的 `n`（万相 1–4、Qwen 1–6、Z-Image 固定 1）**不进目录**：面板只请求一张，理由见
 * `assets/README.md` 的「为什么面板没有数量」。
 */

/** 官方推荐像素表：比例 → 分辨率档 → `宽*高`。 */
export type SizeTable = Readonly<Record<string, Readonly<Record<string, string>>>>;

export type BailianModelSpec = {
  /** DashScope 的 model 名。 */
  id: string;
  title: string;
  /** 比例取值域（按 UI 优先顺序）。 */
  aspectRatios: readonly string[];
  /** 分辨率档位；`[]` 表示该模型没有档位概念（只按比例出图）。 */
  resolutions: readonly string[];
  defaultAspectRatio: string;
  defaultResolution: string;
  /**
   * 比例 + 档位 → 像素 `size`。
   *
   * 尺寸是文档的「推荐分辨率」，不是唯一合法值：上游接受一个像素总量区间，这里只挑
   * 官方列出的那一组，保证出图不踩边界。
   */
  sizes: SizeTable;
  /** 不传 `size` 时的兜底值（模型自己的默认分辨率）。 */
  fallbackSize: string;
  /**
   * 带参考图（图生图）时的分辨率上限。
   *
   * 万相 2.7 Pro 的 4K 档只对纯文生图开放：一旦带参考图，上游只接受 2048*2048 以内，
   * 所以面板给了 4K 也要压回上限档，不能把注定 400 的组合发出去。
   */
  referenceResolutionCap?: string;
  /** 参考图上限；`0` 表示只能文生图。 */
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
 * 万相 2.7 的像素表。
 *
 * 官方只给一张表，4K 档只对 `wan2.7-image-pro` 的文生图有效（非文生图与 2.7-image 都封顶
 * 2048*2048），所以 pro 与普通版分成两张表：普通版没有 4K 档。
 */
const WAN_27_2K_SIZES: SizeTable = {
  "1:1": { "2K": "2048*2048" },
  "16:9": { "2K": "2688*1536" },
  "9:16": { "2K": "1536*2688" },
  "4:3": { "2K": "2368*1728" },
  "3:4": { "2K": "1728*2368" }
};

const WAN_27_1K_SIZES: SizeTable = {
  "1:1": { "1K": "1280*1280" },
  "16:9": { "1K": "1696*960" },
  "9:16": { "1K": "960*1696" },
  "4:3": { "1K": "1472*1104" },
  "3:4": { "1K": "1104*1472" }
};

/** 万相 pro 的 4K 档（仅文生图）。 */
const WAN_27_4K_SIZES: SizeTable = {
  "1:1": { "4K": "4096*4096" },
  "16:9": { "4K": "4096*2304" },
  "9:16": { "4K": "2304*4096" },
  "4:3": { "4K": "4096*3072" },
  "3:4": { "4K": "3072*4096" }
};

const WAN_27_PRO_SIZES: SizeTable = mergeSizeTables(WAN_27_4K_SIZES, WAN_27_2K_SIZES, WAN_27_1K_SIZES);

const WAN_27_SIZES: SizeTable = mergeSizeTables(WAN_27_2K_SIZES, WAN_27_1K_SIZES);

/** Qwen-Image 系列：同一张推荐表，`1:1` 就是模型默认的 2048*2048。 */
const QWEN_IMAGE_SIZES: SizeTable = {
  "1:1": { "2K": "2048*2048" },
  "16:9": { "2K": "2688*1536" },
  "9:16": { "2K": "1536*2688" },
  "4:3": { "2K": "2368*1728" },
  "3:4": { "2K": "1728*2368" }
};

/** Z-Image 只有 1K 档：官方推荐 1024*1024 到 1536*1536 三个总量。 */
const Z_IMAGE_SIZES: SizeTable = {
  "1:1": { "1K": "1280*1280" },
  "2:3": { "1K": "1024*1536" },
  "3:2": { "1K": "1536*1024" },
  "3:4": { "1K": "1104*1472" },
  "4:3": { "1K": "1472*1104" },
  "9:16": { "1K": "864*1536" },
  "16:9": { "1K": "1536*864" },
  "21:9": { "1K": "1680*720" }
};

const WAN_SHARED = {
  aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
  // 万相 2.7 不支持 negative_prompt / prompt_extend（文档明确：要提质请开 thinking_mode）。
  supportsNegativePrompt: false,
  negativePromptLimit: 0,
  supportsPromptExtend: false,
  promptExtendDefault: false
} as const;

const QWEN_20_SHARED = {
  aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
  resolutions: ["2K"],
  defaultResolution: "2K",
  // qwen-image-2.0 系列接受 negative_prompt（≤500 字符）与 prompt_extend（默认开）。
  supportsNegativePrompt: true,
  negativePromptLimit: 500,
  supportsPromptExtend: true,
  promptExtendDefault: true
} as const;

/**
 * 目录。顺序即设置页与面板里的顺序：旗舰在前，便宜的在后。
 *
 * 带日期后缀的快照版（`qwen-image-2.0-pro-2026-06-22` 等）不登记：别名指向最新快照，
 * 单独列出只会让面板出现一堆等价选项。
 */
export const BAILIAN_IMAGE_MODELS: readonly BailianModelSpec[] = [
  {
    id: "wan2.7-image-pro",
    title: "万相 2.7 Pro",
    ...WAN_SHARED,
    resolutions: ["1K", "2K", "4K"],
    defaultResolution: "2K",
    defaultAspectRatio: "1:1",
    sizes: WAN_27_PRO_SIZES,
    fallbackSize: "2048*2048",
    referenceResolutionCap: "2K",
    maxReferenceImages: 9
  },
  {
    id: "wan2.7-image",
    title: "万相 2.7",
    ...WAN_SHARED,
    resolutions: ["1K", "2K"],
    defaultResolution: "2K",
    defaultAspectRatio: "1:1",
    sizes: WAN_27_SIZES,
    fallbackSize: "2048*2048",
    maxReferenceImages: 9
  },
  {
    id: "qwen-image-3.0-pro",
    title: "Qwen-Image 3.0 Pro",
    ...QWEN_20_SHARED,
    // 3.0 支持 prompt_extend（还有 prompt_extend_mode，取值 direct / agent，本期不暴露）。
    // `negative_prompt` 只在 2.0 系列的 API 参考里逐项列出，3.0 没有，所以不开。
    supportsNegativePrompt: false,
    negativePromptLimit: 0,
    supportsPromptExtend: true,
    promptExtendDefault: true,
    defaultAspectRatio: "1:1",
    sizes: QWEN_IMAGE_SIZES,
    fallbackSize: "2048*2048",
    maxReferenceImages: 10
  },
  {
    id: "qwen-image-2.1-pro",
    title: "Qwen-Image 2.1 Pro",
    ...QWEN_20_SHARED,
    // 生图总览明确写「2.1 系列不支持 negative_prompt」。
    supportsNegativePrompt: false,
    negativePromptLimit: 0,
    supportsPromptExtend: true,
    promptExtendDefault: true,
    defaultAspectRatio: "1:1",
    sizes: QWEN_IMAGE_SIZES,
    fallbackSize: "2048*2048",
    maxReferenceImages: 10
  },
  {
    id: "qwen-image-2.1-turbo",
    title: "Qwen-Image 2.1 Turbo",
    ...QWEN_20_SHARED,
    supportsNegativePrompt: false,
    negativePromptLimit: 0,
    supportsPromptExtend: true,
    promptExtendDefault: true,
    defaultAspectRatio: "1:1",
    sizes: QWEN_IMAGE_SIZES,
    fallbackSize: "2048*2048",
    maxReferenceImages: 10
  },
  {
    id: "qwen-image-2.0-pro",
    title: "Qwen-Image 2.0 Pro",
    ...QWEN_20_SHARED,
    defaultAspectRatio: "1:1",
    sizes: QWEN_IMAGE_SIZES,
    fallbackSize: "2048*2048",
    // 2.0 系列一次最多三张参考图（2.1 / 3.0 才是 10 张）。
    maxReferenceImages: 3
  },
  {
    id: "qwen-image-2.0",
    title: "Qwen-Image 2.0",
    ...QWEN_20_SHARED,
    defaultAspectRatio: "1:1",
    sizes: QWEN_IMAGE_SIZES,
    fallbackSize: "2048*2048",
    maxReferenceImages: 3
  },
  {
    id: "z-image-turbo",
    title: "Z-Image Turbo",
    aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "16:9", "9:16", "21:9"],
    resolutions: ["1K"],
    defaultResolution: "1K",
    defaultAspectRatio: "1:1",
    sizes: Z_IMAGE_SIZES,
    fallbackSize: "1024*1536",
    // 只能文生图，`n` 固定 1（文档：n 仅支持 1）。
    maxReferenceImages: 0,
    supportsNegativePrompt: false,
    negativePromptLimit: 0,
    supportsPromptExtend: true,
    // 文案里写明「开启会增加费用」，所以默认关。
    promptExtendDefault: false
  }
];

export function findBailianModel(modelId: string): BailianModelSpec | undefined {
  return BAILIAN_IMAGE_MODELS.find((model) => model.id === modelId);
}

function mergeSizeTables(...tables: readonly SizeTable[]): SizeTable {
  const merged: Record<string, Record<string, string>> = {};
  for (const table of tables) {
    for (const [ratio, tiers] of Object.entries(table)) {
      merged[ratio] = { ...merged[ratio], ...tiers };
    }
  }
  return merged;
}
