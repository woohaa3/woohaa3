/**
 * 模型卡片：**一个上游模型的能力声明**。
 *
 * 卡片不实现渲染、不实现请求；它只回答三个问题：
 * 1. 这个模型能用哪些语义参数（`keeps`，未列出的即被剪枝）；
 * 2. 值域比类型预设更窄多少（`narrow`）；
 * 3. 有哪些 `inputSchema` 表达不了的边界（`limits`）。
 *
 * **卡片是模型能力的唯一来源**：厂商参数族的具体数字（分辨率档位、官方像素表、是否支持
 * 透明背景、网关是否收窄）也挂在卡片上，放在厂商专属的可选块里（目前是 `seedream` 与
 * `alibaba`）。家族（`../image-parameters`）与各 Provider（Ark 原生、百炼、TokenHub、
 * LiteLLM 网关）都通过这些块读取值域，不再各自维护一份「哪个版本有什么」的表。
 *
 * **块的键是研发厂商，不是承载通道**：`alibaba` 覆盖万相 / Qwen-Image / Z-Image，它们都能经
 * 百炼、网关或任何转发方调用；通道写在 `providerId` 上。所以同一张卡片换个通道不改块名。
 *
 * 因此新增一个同家族的新版本 = 加一份卡片、写清它的数字，不用改 Provider。
 */
import type { GenerationModelLimits } from "../model-capabilities.js";
import type { CanvasReferencePolicy } from "../reference-policy.js";
import type { SeedreamSizePreset } from "./cards/image/ark/seedream-spec.js";
import type { AlibabaSizePreset } from "./cards/image/alibaba/alibaba-spec.js";
import type { PresetModelType } from "./types.js";

/**
 * 上游厂商。与 `cards/<类型>/<厂商>/` 的目录名一一对应。
 *
 * **只登记我们真的会适配的**：加一个厂商就要能维护它的文档与值域，列进来却不维护，
 * 只会让「模型选择器里有一个永远没人更新的卡片」。
 */
export type PresetVendor = "ark" | "openai" | "google" | "minimax" | "alibaba" | "agnes" | "generic";

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
   * 通用值域由家族表按 id 给出；厂商专属块（如 `seedream`）里的数字以这页为准。
   */
  docs: string;
  modelType: PresetModelType;
  /** 一句话说明这张卡片的差异，展示在模型选择器里。 */
  note?: string;
  /**
   * 身份一致性参考策略；缺省 optional。
   *
   * 这是模型级配置来源，节点设置 `nodeData.referencePolicy` 优先。身份敏感模型卡片
   * （角色/商品系列常用的参考编辑模型）可声明 `identity-required`，不在面板里硬编码。
   */
  referencePolicy?: CanvasReferencePolicy;
  /** 保留的语义键；未列出的即被剪枝。 */
  keeps: readonly string[];
  /** 在类型预设之上收窄的值域 / 默认值 / 联动隐藏。 */
  narrow?: Readonly<Record<string, Record<string, unknown>>>;
  /**
   * 即梦（Seedream）版本语义：官方 `size` 档位、像素表引用、默认档、网关收窄、透明背景。
   *
   * `id` 与参考图上限不在这里——它们分别由卡片的 `id` 与 `limits` 给出，避免同一份
   * 数字写两遍。家族与三家 Provider 通过 `seedreamSizePresetFor` 读这里。
   */
  seedream?: Omit<SeedreamSizePreset, "id" | "maxReferenceImages">;
  /**
   * 百炼（Model Studio / DashScope）模型语义：比例、档位、官方像素表、带参考图时的档位上限、
   * 负向提示词与智能改写。
   *
   * 同样不存 `id` 与参考图上限（分别取自卡片的 `id` 与 `limits`）。家族与百炼 Provider 通过
   * `alibabaSizePresetFor` 读这里。
   */
  alibaba?: Omit<AlibabaSizePreset, "id" | "maxReferenceImages">;
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

/** 声明一张音频卡片。 */
export function audioCard(input: CardInput): PresetCard {
  return {
    ...input,
    modelType: "audio",
    providerId: input.providerId ?? "remote-server"
  };
}
