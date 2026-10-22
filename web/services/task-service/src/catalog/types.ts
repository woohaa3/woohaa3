/**
 * 服务端任务能力的抽象（change: add-image-text-node-execution，design D12 / D14）。
 *
 * 两个正交能力，各自可注入替身：
 * - `TaskCatalogProvider`：注册表 + 静态描述（catalog 用，不发网络请求）；
 * - `TaskRuntime`（见 `runtime.ts`）：受管执行（任务用）。
 *
 * 把"执行"从 provider 视图里拆出来，是因为执行已经托管给运行时（D14）：
 * 网关提交任务、拿终态，不再自己调 provider。
 */
import type { CanvasTaskModelType, GenerationModelCapabilityFacts } from "@woohaa3/contracts";

/** `PptaskDescription` 的结构子集（避免网关直接依赖 pptask 类型）。 */
export type DescribedModel = {
  providerId: string;
  modelId: string;
  modelType: string;
  title?: string;
  inputSchema?: Record<string, unknown>;
  defaultInput?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  /** 模型级 prompt 要求与取消能力（change: 2026-10-04-...，任务 3.4 / design D4/D6）。 */
  promptRequirement?: "required" | "optional" | "none";
  cancel?: "local" | "remote" | "unsupported";
  /** 模型事实能力（Provider 声明；目录校验后透传）。 */
  capabilityFacts?: GenerationModelCapabilityFacts;
};

/** Provider 自己的资源条目（注册表为它发行 modelKey）。 */
export type ProviderCatalogEntry = {
  providerModelId: string;
  modelType: CanvasTaskModelType;
};

/** Provider 自己的 catalog 视图：按原始 providerModelId 描述（不发行 modelKey）。 */
export type ProviderCatalog = {
  listModels(): ProviderCatalogEntry[];
  describe(providerModelId: string): Promise<DescribedModel>;
};

/** 注册表对外暴露的 catalog：按 opaque modelKey 描述。 */
export type TaskCatalogProvider = {
  /**
   * provider 的模型注册表（modelKey + provider 身份 + 类型）。
   *
   * catalog 的**默认启用集合**来自它 —— 站点不用环境变量列举模型（design D12）：
   * 能力数据由 provider 自己拥有，配置只做启用/覆盖。
   * （change: add-pluggable-model-interactions，任务 1.3：增加 modelKey。）
   */
  listModels(): Array<{
    modelKey: string;
    providerId: string;
    providerModelId: string;
    modelType: CanvasTaskModelType;
  }>;
  /** 按 opaque modelKey 描述模型。 */
  describe(modelKey: string): Promise<DescribedModel>;
};
