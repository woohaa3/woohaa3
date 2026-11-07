/**
 * 百炼生图模型目录：**从契约层的卡片读出来的视图**，不是另一份真相。
 *
 * 卡片住在 `@woohaa3/contracts` 的 `task/generation-parameters/cards/image/alibaba/`——目录按
 * **研发厂商**归类，万相、Qwen-Image、Z-Image 都是阿里的模型，百炼只是承载它们的通道。比例、
 * 档位、官方像素表、带参考图时的档位上限、负向提示词与智能改写都写在那里。家族
 * （`image-parameters`）与这个 Provider 都从卡片读，所以「新增一个模型」= 加一张卡片，
 * 本文件不用动。
 *
 * 为什么目录仍然是**手写**而不是发现来的：百炼**有**模型列表接口
 * （`GET /api/v1/models`，需 API Key，`capabilities=IG` 可只看生图），但它只返回 id、名称、
 * 模态这类身份事实，给不出档位、官方像素表、参考图上限、有没有负向提示词——而这些才决定参数
 * 面板长什么样。所以卡片里的能力数字按官方文档登记，`discovery.ts` 只用发现结果做对账
 * （卡片登记的模型上游还在不在、有没有新模型没卡片），执行路径只有一条。
 *
 * 事实来源（2026-11-06 核对）：
 * - 生图总览 <https://help.aliyun.com/zh/model-studio/text-to-image>
 * - Qwen-Image 生图与编辑 API 参考
 *   <https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference>
 * - 通义万相 <https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference>
 * - Z-Image <https://help.aliyun.com/zh/model-studio/z-image-api-reference>
 * - 模型列表 <https://help.aliyun.com/zh/model-studio/models>（`GET /api/v1/models`）
 *
 * 只登记**生图**。任何模型的参数支持范围以卡片为准：卡片没保的开关不做成控件，避免把
 * 上游会 400 的组合暴露给用户。
 *
 * 上游的 `n`（万相 1–4、Qwen 1–6、Z-Image 固定 1）**不进目录**：面板只请求一张，理由见
 * `assets/README.md` 的「为什么面板没有数量」。
 */
import {
  alibabaSizePresetFor,
  ALIBABA_CARDS,
  type AlibabaSizePreset
} from "@woohaa3/contracts";

/**
 * 执行路径要的模型形状：卡片投影（`AlibabaSizePreset`）加上展示用的标题。
 *
 * 有意不重新声明像素表 / 比例 / 开关：那些字段全部直接来自卡片，写成 `Pick` 就不会出现
 * 「这张表看着能改，其实改了不生效」。
 */
export type BailianModelSpec = AlibabaSizePreset & {
  /** 设置页与模型选择器里的名字。 */
  title: string;
  /** 卡片的一句话差异说明（可选）。 */
  note?: string;
  /** 官方文档地址（卡片必填，这里透传以便设置页直接跳转）。 */
  docs: string;
};

/** 卡片 → 执行路径的模型形状。 */
function specOfCard(card: (typeof ALIBABA_CARDS)[number]): BailianModelSpec | undefined {
  const spec = alibabaSizePresetFor(card.providerModelId);
  if (spec === undefined) return undefined;
  return {
    ...spec,
    title: card.title,
    docs: card.docs,
    ...(card.note === undefined ? {} : { note: card.note })
  };
}

/**
 * 目录。顺序即设置页与面板里的顺序（旗舰在前，便宜的在后），由卡片目录决定。
 *
 * 带日期后缀的快照版（`qwen-image-2.0-pro-2026-06-22` 等）不登记：卡片只写稳定 id，
 * 单独列出只会让面板出现一堆等价选项。
 */
export const BAILIAN_IMAGE_MODELS: readonly BailianModelSpec[] = ALIBABA_CARDS.flatMap(
  (card) => {
    const spec = specOfCard(card);
    return spec === undefined ? [] : [spec];
  }
);

/**
 * 按模型 id 精确查找。
 *
 * 不做前缀兜底：`qwen-image-*` 横跨三代且参数能力不同（2.0 有负向提示词，2.1 / 3.0 没有），
 * 猜错版本会发出上游不认的 `parameters`。
 */
export function findBailianModel(modelId: string): BailianModelSpec | undefined {
  return BAILIAN_IMAGE_MODELS.find((model) => model.id === modelId);
}
