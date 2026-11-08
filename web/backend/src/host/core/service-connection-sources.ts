/** Site Providers retain SettingsService as their single authority, including env locks and advanced fields. */
import { createHash } from "node:crypto";
import type {
  GenerationProvider,
  ServiceConnectionCapability,
  ServiceConnectionEndpoint,
  ServiceConnectionProtocol,
  ServiceConnectionSourceAdapter,
  ServiceConnectionSourceSnapshot,
  ServiceConnectionPurpose
} from "@woohaa3/contracts";
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

export function createSiteProviderSource(options: {
  providerId: string; extensionId: string; label: string; prefix: string;
  settings: SettingsService; provider: () => GenerationProvider | undefined;
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
    const capabilities = (provider?.models ?? []).map(model => {
      const purpose: ServiceConnectionPurpose = model.modelType === "language" ? "text" : model.modelType;
      purposes.add(purpose);
      return { purpose, protocol, modelId: model.providerModelId, imageInput: false, evidence: "adapter" as const };
    });
    const baseUrl = typeof values.baseUrl === "string" ? values.baseUrl : typeof values.baseURL === "string" ? values.baseURL : undefined;
    const assistantProtocol = factory?.assistantProtocol;
    const assistantModels = assistantProtocol ? (provider?.models ?? []).filter(model => model.modelType === "language") : [];
    // Per-model evidence only: a provider that cannot prove tools for a model must not project
    // target execution. Catalog absence of evidence is treated as unsupported.
    const assistantCapabilities: ServiceConnectionCapability[] = assistantModels.flatMap(model => {
      const evidence = provider?.languageCapabilities?.(model.providerModelId);
      const discussion: ServiceConnectionCapability = {
        purpose: "discussion", protocol: assistantProtocol!, modelId: model.providerModelId,
        imageInput: evidence?.imageInput === true, evidence: "adapter"
      };
      return [
        discussion,
        ...(evidence?.tools === true ? [{ purpose: "target-execution" as const, protocol: assistantProtocol!, modelId: model.providerModelId, imageInput: false, evidence: "adapter" as const }] : [])
      ];
    });
    // A trusted assistant protocol is executable Agent evidence for discussion (and, per model,
    // target execution). The stable binding lets the SDK Agent bridge project this source without
    // an explicit admin opt-in.
    const assistantPurposes: ServiceConnectionPurpose[] = [
      "discussion",
      ...(assistantCapabilities.some(capability => capability.purpose === "target-execution") ? ["target-execution" as const] : [])
    ];
    const assistantBinding = assistantProtocol && assistantModels.length ? {
      bindingId: `provider-assistant:${options.providerId}`, extensionId: "sdk-agent", consumer: "agent" as const,
      consumerId: `shared:${assistantProtocol}`, purposes: assistantPurposes,
      modelKeys: assistantModels.map(model => model.providerModelId),
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
      models: (provider?.models ?? []).map(model => model.providerModelId)
    };
    return { legacyId: options.providerId, scope: "site", kind: "api", name: options.label,
      endpoints, capabilities: [...capabilities, ...assistantCapabilities],
      bindings: provider ? [{ bindingId: `provider:${options.providerId}`, extensionId: options.extensionId, consumer: "provider", consumerId: options.providerId,
        purposes: [...purposes], modelKeys: provider.models.map(model => `${options.providerId}:${model.providerModelId}`) }, ...(assistantBinding ? [assistantBinding] : [])] : [],
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
