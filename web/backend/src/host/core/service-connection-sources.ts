/** Site Providers retain SettingsService as their single authority, including env locks and advanced fields. */
import { createHash } from "node:crypto";
import type {
  AgentReasoningCapability,
  GenerationModelDefinition,
  GenerationProvider,
  ServiceConnectionCapability,
  ServiceConnectionEndpoint,
  ServiceConnectionProtocol,
  ServiceConnectionSourceAdapter,
  ServiceConnectionSourceSnapshot,
  ServiceConnectionPurpose
} from "@woohaa3/contracts";
import type { GenerationModelStoreSnapshot } from "@woohaa3/application-service";
import { agentReasoningRevision, isAgentReasoningEffort } from "@woohaa3/contracts";
import type { SettingsService } from "../../settings/settings-service.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Provider-contributed fixed endpoints win over the generic configured base URL.
 *
 * RunningHub's language endpoint is on a different host than its media task API, so a single
 * `baseUrl` cannot describe both. The provider declares the per-protocol mapping; core never
 * recognizes a provider id.
 */
function endpointFor(factory: GenerationProvider["serviceConnectionFactory"], protocol: ServiceConnectionProtocol, configured: string | undefined): string | undefined {
  return factory?.endpoints?.[protocol] ?? configured;
}

/**
 * 一个 Provider 里「可以当作助手模型」的模型集合。
 *
 * 唯一判定处：助手目录投影（本文件）与任务目录（task 的 `resolveModelSelection`）必须对
 * 「哪些模型算启用」给出同一个答案。此前这里直接取 Provider 注册表的全部语言模型，绕过
 * 站点运营策略，结果是设置页里没启用的模型照样出现在画布助手的模型下拉里。
 *
 * 规则与任务目录一致：
 * - 只看 language 模态；
 * - `server` 权威的 Provider（远端托管生成）由自己的目录决定，不受本机策略过滤；
 * - 其余走站点策略：策略未初始化时视为启用；已初始化时只保留 `enabled && !tombstone`，
 *   策略里没有该行的模型视为未启用。
 */
export function enabledAssistantModels(
  provider: GenerationProvider | undefined,
  policy: GenerationModelStoreSnapshot | undefined
): readonly GenerationModelDefinition[] {
  const language = (provider?.models ?? []).filter(model => model.modelType === "language");
  if (provider === undefined) return [];
  const authority = provider.selectionAuthority ?? "local";
  if (authority === "server") return language;
  // 没有策略快照（独立装配 / 旧宿主）时不假装知道：按未初始化语义全开。
  if (policy === undefined || !policy.initialized) return language;
  const policyByKey = new Map(policy.models.map(model => [model.modelKey, model]));
  return language.filter(model => {
    const row = policyByKey.get(`${provider.providerId}:${model.providerModelId}`);
    return row !== undefined && row.enabled && row.tombstone !== true;
  });
}

/** Provider 的能力事实 → Agent 目录同一份 reasoning 事实；布尔能力不扩展档位。 */
function reasoningOf(model: GenerationModelDefinition): AgentReasoningCapability | undefined {
  const facts = model.capabilityFacts?.reasoning;
  if (!facts) return undefined;
  const efforts = (facts.efforts ?? []).filter(isAgentReasoningEffort);
  const revision = agentReasoningRevision(model.providerModelId, facts.supported, efforts.join(","));
  return facts.supported
    ? { state: "supported", source: "provider", revision, ...(efforts.length ? { efforts: efforts.map((id) => ({ id })) } : {}) }
    : { state: "unsupported", source: "provider", revision };
}

/** 目录身份 → 上游模型 ID；Provider 未声明映射时两者相同。 */
function toUpstreamModelId(mapper: ((modelId: string) => string) | undefined, modelId: string): string {
  return mapper ? mapper(modelId) : modelId;
}

export function createSiteProviderSource(options: {
  providerId: string; extensionId: string; label: string; prefix: string;
  settings: SettingsService; provider: () => GenerationProvider | undefined;
  /**
   * 站点运营策略快照：助手模型按它过滤，与任务目录同一份判据。
   * 缺省时按「策略未初始化」处理（全开），供不关心启停的装配使用。
   */
  policy?: () => GenerationModelStoreSnapshot;
}): ServiceConnectionSourceAdapter {
  const snapshot = async (): Promise<ServiceConnectionSourceSnapshot | null> => {
    const fields = options.settings.describe().filter(field => field.key.startsWith(`${options.prefix}.`));
    if (!fields.length) return null;
    const values = options.settings.section(options.prefix);
    const configured = fields.some(field => field.secret && field.configured);
    // An empty template is not a configured service connection.
    if (!configured && !options.provider()?.available) return null;
    const publicValues = Object.fromEntries(fields.filter(field => !field.secret).map(field => [field.key, values[field.key.slice(options.prefix.length + 1)]]));
    const secretValues = fields.filter(field => field.secret).map(field => values[field.key.slice(options.prefix.length + 1)]);
    const provider = options.provider();
    const factory = provider?.serviceConnectionFactory;
    const purposes = new Set<ServiceConnectionPurpose>();
    const protocol = `provider:${options.providerId}` as const;
    const capabilities = (provider?.models ?? []).flatMap(model => {
      if (model.modelType === "motion") return [];
      const purpose: ServiceConnectionPurpose = model.modelType === "language" ? "text" : model.modelType;
      purposes.add(purpose);
      return [{ purpose, protocol, modelId: model.providerModelId, imageInput: false, evidence: "adapter" as const, ...(reasoningOf(model) ? { reasoning: reasoningOf(model) } : {}) }];
    });
    const baseUrl = typeof values.baseUrl === "string" ? values.baseUrl : typeof values.baseURL === "string" ? values.baseURL : undefined;
    const assistantProtocol = factory?.assistantProtocol;
    // 助手模型必须与任务目录同一判据：站点策略里没启用的模型不进助手下拉。
    const assistantModels = assistantProtocol ? enabledAssistantModels(provider, options.policy?.()) : [];
    // 所有文本模型都支持工具调用：assistant 协议下的语言模型统一投影为 text 能力；
    // vision 证据仍用于图片输入。
    const assistantCapabilities: ServiceConnectionCapability[] = assistantModels.map(model => {
      const evidence = provider?.languageCapabilities?.(model.providerModelId);
      return {
        // 助手通道把模型名原样发给上游：目录身份若带来源前缀（如 RunningHub 的 `llm/`），
        // 必须换成上游认识的 ID，否则上游 404 拒绝本轮。
        purpose: "text", protocol: assistantProtocol!, modelId: toUpstreamModelId(factory?.upstreamModelId, model.providerModelId),
        imageInput: evidence?.imageInput === true, evidence: "adapter", ...(reasoningOf(model) ? { reasoning: reasoningOf(model) } : {})
      };
    });
    // 带可信 assistant 协议的来源可直接被 SDK Agent 桥接投影，无需管理员逐模型开启。
    const assistantPurposes: ServiceConnectionPurpose[] = ["text"];
    const assistantBinding = assistantProtocol && assistantModels.length ? {
      bindingId: `provider-assistant:${options.providerId}`, extensionId: "sdk-agent", consumer: "agent" as const,
      consumerId: `shared:${assistantProtocol}`, purposes: assistantPurposes,
      // 与上方能力证据同一口径：来源授权按上游 ID 匹配，binding 不能保留目录身份。
      modelKeys: assistantModels.map(model => toUpstreamModelId(factory?.upstreamModelId, model.providerModelId)),
    } : null;
    const endpoints: ServiceConnectionEndpoint[] = [];
    for (const declared of factory?.protocols ?? []) {
      const endpoint = endpointFor(factory, declared, baseUrl);
      if (endpoint) endpoints.push({ protocol: declared, baseUrl: endpoint });
    }
    if (assistantProtocol) {
      const endpoint = endpointFor(factory, assistantProtocol, baseUrl);
      if (endpoint && !endpoints.some(item => item.protocol === assistantProtocol)) endpoints.push({ protocol: assistantProtocol, baseUrl: endpoint });
    }
    // Endpoint and catalog revisions participate in the source revision: a provider that adds a
    // language catalog or moves an endpoint must not keep a stale model projection just because
    // the Key bytes did not change.
    const revisionInput = {
      values: publicValues,
      endpoints,
      catalogRevision: provider?.catalogRevision ?? 0,
      models: (provider?.models ?? []).map(model => model.providerModelId),
      // 启停策略也是来源内容的一部分：用户在下拉里关掉一个模型后，投影必须跟着变，
      // 否则连接仍带着旧的 modelKeys，助手照样能选到已关闭的模型。
      assistantModels: assistantModels.map(model => model.providerModelId)
    };
    return { legacyId: options.providerId, scope: "site", kind: "api", name: options.label,
      endpoints, capabilities: [...capabilities, ...assistantCapabilities],
      bindings: provider ? [{ bindingId: `provider:${options.providerId}`, extensionId: options.extensionId, consumer: "provider", consumerId: options.providerId,
        purposes: [...purposes], modelKeys: provider.models.filter(model => model.modelType !== "motion").map(model => `${options.providerId}:${model.providerModelId}`) }, ...(assistantBinding ? [assistantBinding] : [])] : [],
      enabled: provider?.available ?? false, removed: false, locked: fields.some(field => field.lockedBy !== null), credentialConfigured: configured,
      configRevision: Number.parseInt(hash(revisionInput).slice(0, 12), 16), credentialEpoch: 0,
      credentialFingerprint: hash(secretValues) };
  };
  return { id: `site:${options.providerId}`, scope: "site", list: async () => { const value = await snapshot(); return value ? [value] : []; },
    get: async (_owner, id) => id === options.providerId ? snapshot() : null,
    readSecret: async (_owner, id, expected) => {
      const source = await snapshot();
      if (!source || id !== options.providerId || source.configRevision !== expected.configRevision || source.credentialEpoch !== expected.credentialEpoch) return null;
      const value = options.settings.section(options.prefix).apiKey;
      return typeof value === "string" && value.trim() ? value : null;
    } };
}
