/** Site Providers retain SettingsService as their single authority, including env locks and advanced fields. */
import { createHash } from "node:crypto";
import type { GenerationProvider, ServiceConnectionSourceAdapter, ServiceConnectionSourceSnapshot, ServiceConnectionPurpose } from "@woohaa3/contracts";
import type { SettingsService } from "../../settings/settings-service.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
    const purposes = new Set<ServiceConnectionPurpose>();
    const protocol = `provider:${options.providerId}` as const;
    const capabilities = (provider?.models ?? []).map(model => {
      const purpose: ServiceConnectionPurpose = model.modelType === "language" ? "text" : model.modelType;
      purposes.add(purpose);
      return { purpose, protocol, modelId: model.providerModelId, imageInput: false, evidence: "adapter" as const };
    });
    const baseUrl = typeof values.baseUrl === "string" ? values.baseUrl : typeof values.baseURL === "string" ? values.baseURL : undefined;
    const assistantProtocol = provider?.serviceConnectionFactory?.assistantProtocol;
    const assistantCapabilities = assistantProtocol ? (provider?.models ?? []).filter(model => model.modelType === "language").map(model => ({
      purpose: "discussion" as const, protocol: assistantProtocol, modelId: model.providerModelId, imageInput: false, evidence: "adapter" as const,
    })) : [];
    return { legacyId: options.providerId, scope: "site", kind: "api", name: options.label,
      endpoints: baseUrl ? [{ protocol, baseUrl }, ...(assistantProtocol ? [{ protocol: assistantProtocol, baseUrl }] : [])] : [], capabilities: [...capabilities, ...assistantCapabilities],
      bindings: provider ? [{ bindingId: `provider:${options.providerId}`, extensionId: options.extensionId, consumer: "provider", consumerId: options.providerId,
        purposes: [...purposes], modelKeys: provider.models.map(model => `${options.providerId}:${model.providerModelId}`) }] : [],
      enabled: provider?.available ?? false, removed: false, locked: fields.some(field => field.lockedBy !== null), credentialConfigured: configured,
      configRevision: Number.parseInt(hash(publicValues).slice(0, 12), 16), credentialEpoch: 0,
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
