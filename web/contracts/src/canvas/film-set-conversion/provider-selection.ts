/**
 * 多个转换提供方（capability）的**选择/路由**纯函数
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 2.1 / design D6）。
 *
 * 统一后端按 capability 收集所有已激活扩展声明的转换提供方，用这里的选择规则把
 * `modelKey`/来源种类映射到**唯一**提供方与生成端口：
 *
 * - 显式 `modelKey` 只解析其所属提供方（`<providerId>:<providerModelId>` 前缀匹配），
 *   不存在即拒绝，**绝不**静默换 Provider/模型；
 * - 未指定 `modelKey` 时按提供方登记顺序选择第一个**声明支持该来源**的候选；没有候选
 *   返回 `null`（能力未知 → 不开放一键调用）；
 * - 能力判定由**服务端门禁**（`filmSetConversionCapabilityRejectionCode`）根据候选声明的
 *   能力完成：即使某个显式模型不能承担该来源，也返回其能力声明，让门禁给出精确原因
 *   （如 `model-not-vision-capable`），而不是笼统的「未配置」；
 * - 生成端口按同一规则在**每次调用时**路由，避免缓存过期把请求交给错误的 Provider。
 *
 * 纯函数、无 provider SDK 依赖；宿主与测试都可直接使用。
 */
import type {
  FilmSetConversionGenerator,
  FilmSetConversionMediaReader
} from "./generator.js";
import type { FilmSetConversionAdapterCapabilities } from "./capabilities.js";
import type {
  FilmSetConversionModelCandidate,
  FilmSetConversionProvider
} from "./provider.js";
import type { FilmSetConversionSourceKind } from "./types.js";

/** 聚合后的转换提供方集合视图（服务端门禁与生成端口共同使用）。 */
export type FilmSetConversionProviderSet = {
  /** 全部可用候选（含各提供方默认模型；未配置的提供方不贡献候选）。 */
  listModels(): readonly FilmSetConversionModelCandidate[];
  /**
   * 解析本次实际使用的模型与能力；无可承担该来源的候选返回 `null`。
   *
   * 显式 `modelKey` 只在其所属提供方内解析（不跨 Provider 猜测），并返回该模型声明的
   * 能力（是否真能承担来源由服务端门禁判定并给出精确错误码）。
   */
  resolveCapabilities(input: {
    modelKey?: string;
    sourceKind: FilmSetConversionSourceKind;
  }): { modelKey: string; capabilities: FilmSetConversionAdapterCapabilities } | null;
  /**
   * 用注入的媒体读取端口构造**路由生成端口**：每次调用按 `input.modelKey` 选择提供方；
   * 没有任何提供方能承担时返回 `null`。
   */
  createGenerator(input: { media: FilmSetConversionMediaReader }): FilmSetConversionGenerator | null;
};

/** 提供方身份与 modelKey 归属（`<providerId>:<providerModelId>` 前缀或候选列表）。 */
function providerOwnsModelKey(provider: FilmSetConversionProvider, modelKey: string): boolean {
  if (modelKey.startsWith(`${provider.providerId}:`)) return true;
  return provider.listModels().some((model) => model.modelKey === modelKey);
}

/**
 * 选择候选：显式 `modelKey` 优先（只在其所属提供方内匹配），否则按登记顺序取第一个
 * 声明支持该来源的候选；都没有时退化为第一个候选（让门禁给出精确拒绝原因）。
 */
function selectCandidate(
  ordered: readonly FilmSetConversionProvider[],
  input: { modelKey?: string; sourceKind: FilmSetConversionSourceKind }
): FilmSetConversionModelCandidate | null {
  if (input.modelKey) {
    for (const provider of ordered) {
      const match = provider.listModels().find((model) => model.modelKey === input.modelKey);
      if (match) return match;
      // Owner-scoped assistant catalogs are read through the conversation directory, never
      // copied into a process-global conversion list. Execution revalidates their binding.
      if (providerOwnsModelKey(provider, input.modelKey)) {
        const resolved = provider.resolveCapabilities(input);
        if (resolved?.modelKey === input.modelKey) return { ...resolved, label: input.modelKey, supports: [input.sourceKind] };
      }
    }
    return null;
  }
  for (const provider of ordered) {
    const supporting = provider.listModels().find((model) => model.supports.includes(input.sourceKind));
    if (supporting) return supporting;
  }
  return ordered.flatMap((provider) => provider.listModels())[0] ?? null;
}

function providerForCandidate(
  ordered: readonly FilmSetConversionProvider[],
  candidate: FilmSetConversionModelCandidate
): FilmSetConversionProvider | null {
  return ordered.find((provider) => providerOwnsModelKey(provider, candidate.modelKey)) ?? null;
}

export function createFilmSetConversionProviderSet(
  providers: readonly FilmSetConversionProvider[] | (() => readonly FilmSetConversionProvider[])
): FilmSetConversionProviderSet {
  // 支持惰性来源：宿主在扩展激活之后才能解析 capability，且提供方集合会随启停变化，
  // 因此每次调用都重新读取当前集合（不做进程级缓存）。
  const readProviders = (): readonly FilmSetConversionProvider[] =>
    (typeof providers === "function" ? providers() : providers)
      .filter((provider) => provider.providerId.trim() !== "");
  return {
    listModels: () => readProviders().flatMap((provider) => provider.listModels()),
    resolveCapabilities: (input) => {
      const candidate = selectCandidate(readProviders(), input);
      if (!candidate) return null;
      return { modelKey: candidate.modelKey, capabilities: candidate.capabilities };
    },
    createGenerator: ({ media }) => {
      // 每个提供方的生成器惰性构造一次（媒体读取端口在进程内共享）。
      const generators = new WeakMap<FilmSetConversionProvider, FilmSetConversionGenerator | null>();
      const generatorFor = (provider: FilmSetConversionProvider): FilmSetConversionGenerator | null => {
        if (!generators.has(provider)) {
          generators.set(provider, provider.createGenerator({ media }));
        }
        return generators.get(provider) ?? null;
      };
      return async (generationInput) => {
        const ordered = readProviders();
        if (ordered.length === 0) {
          return { ok: false, code: "model-not-configured", message: "尚未配置支持视觉输入的转换模型", retryable: true };
        }
        const candidate = selectCandidate(ordered, {
          modelKey: generationInput.modelKey,
          sourceKind: generationInput.frozenSource.kind
        });
        const provider = candidate ? providerForCandidate(ordered, candidate) : null;
        if (!provider) {
          return { ok: false, code: "model-not-configured", message: "所选转换模型不可用，请重新选择", retryable: false };
        }
        const generator = generatorFor(provider);
        if (!generator) {
          return { ok: false, code: "model-not-configured", message: "所选 Provider 未提供转换执行器，请重新选择", retryable: false };
        }
        return generator(generationInput);
      };
    }
  };
}
