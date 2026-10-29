/**
 * 模型卡片：**一个上游模型的能力声明**。
 *
 * 卡片不实现渲染、不实现请求；它只回答三个问题：
 * 1. 这个模型能用哪些语义参数（`keeps`，未列出的即被剪枝）；
 * 2. 值域比类型预设更窄多少（`narrow`）；
 * 3. 有哪些 `inputSchema` 表达不了的边界（`limits`）。
 *
 * 厂商细节（分辨率档位、时长步长、质量枚举）**不写在这里**：它们由家族表
 * （`families/image` 与 `families/video`）按 `providerModelId` 给出。卡片只声明
 * 「这家接不接这个键」，因此新增一个同家族的新版本 = 复制一份卡片、改 id 与约束。
 */
import type { GenerationModelLimits } from "../model-capabilities.js";

/**
 * 上游厂商。与 `cards/<类型>/<厂商>/` 的目录名一一对应。
 *
 * **只登记我们真的会适配的**：加一个厂商就要能维护它的文档与值域，列进来却不维护，
 * 只会让「模型选择器里有一个永远没人更新的卡片」。
 */
export type PresetVendor = "ark" | "openai" | "google" | "minimax" | "generic";

export type PresetCard = {
  /** 稳定标识，只用于诊断与展示；同一类型内唯一。 */
  id: string;
  title: string;
  /**
   * 承载它的生成 Provider（不是厂商）。
   *
   * 走 LiteLLM 网关的模型 `providerId` 都是 `remote-server`——那是**传输通道**；
   * 厂商在 `vendor` 上，两者不能混。
   */
  providerId: string;
  /** 上游厂商，与目录里的文件夹一一对应。 */
  vendor: PresetVendor;
  /** 上游模型 id（网关里的那个）。家族判定按它匹配。 */
  providerModelId: string;
  /**
   * 官方文档地址（模型页 / API 页）。
   *
   * **必填**：卡片里的档位与边界都是从这页抄下来的，没有链接就无法判断「这条数字过期了没有」。
   * 值域由家族表按 id 给出，家族表里的数字同样以这里为准。
   */
  docs: string;
  modelType: "image" | "video";
  /** 一句话说明这张卡片的差异，展示在模型选择器里。 */
  note?: string;
  /** 保留的语义键；未列出的即被剪枝。 */
  keeps: readonly string[];
  /** 在类型预设之上收窄的值域 / 默认值 / 联动隐藏。 */
  narrow?: Readonly<Record<string, Record<string, unknown>>>;
  /** 追加类型预设里没有的键（用于复刻服务端按类型写死的遗留形状）。 */
  adds?: readonly string[];
  /** 约束；缺省表示这张卡片不声明，前端不展示任何提示。 */
  limits?: GenerationModelLimits;
};

/** 一 MB 的字节数：约束里的 `maxBytesPerItem` 用它换算，避免到处写 `1024 * 1024`。 */
export const MB = 1024 * 1024;

export type CardInput = Omit<PresetCard, "modelType" | "providerId"> & {
  providerId?: string;
};

/** 声明一张图片卡片。 */
export function imageCard(input: CardInput): PresetCard {
  return {
    ...input,
    modelType: "image",
    providerId: input.providerId ?? "remote-server"
  };
}

/** 声明一张视频卡片。 */
export function videoCard(input: CardInput): PresetCard {
  return {
    ...input,
    modelType: "video",
    providerId: input.providerId ?? "remote-server"
  };
}
