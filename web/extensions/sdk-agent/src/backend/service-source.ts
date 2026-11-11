import { createHash } from "node:crypto";
import type { ApplicationServiceConnectionFacade, ServiceConnectionProtocol, ServiceConnectionSourceAdapter, ServiceConnectionSourceSnapshot, ServiceConnectionPurpose } from "@woohaa3/contracts";
import { connectionModelCatalogRevision, modelCatalogForRecord, type ConnectionModelCapabilityRecord, type ConnectionService } from "@woohaa3/agent-connections";
import { findSdkAgentAdapter, sdkEngineForAdapter } from "../shared.js";

export function sdkSourceProtocol(adapterId: string): ServiceConnectionProtocol {
  const type = sdkEngineForAdapter(adapterId)?.apiType;
  return type === "anthropic" ? "messages" : type === "gemini" ? "gemini" : type === "openai" ? "responses" : "chat-completions";
}
/** References the original encrypted authority; migration never reads or copies a Key. */
export function createSdkServiceSource(service: ConnectionService): ServiceConnectionSourceAdapter {
  const project = async (owner: string, id: string): Promise<ServiceConnectionSourceSnapshot | null> => {
    const record = await service.get(owner, id);
    const descriptor = record && findSdkAgentAdapter(record.adapterId);
    if (!record || !descriptor || record.serviceConnectionId || record.authMode !== "api-key") return null;
    const protocol = sdkSourceProtocol(record.adapterId);
    const purposes: ServiceConnectionPurpose[] = ["text"];
    return { legacyId: id, scope: "personal", kind: "api", name: record.name,
      endpoints: [{ protocol, baseUrl: record.baseUrl ?? descriptor.officialBaseUrl }],
      capabilities: modelCatalogForRecord(record).models.map((model) => ({ purpose: "text" as const, protocol, modelId: model.id, imageInput: false, evidence: "adapter" as const, reasoning: model.reasoning })),
      bindings: [{ bindingId: `sdk:${id}`, extensionId: "sdk-agent", consumer: "agent", consumerId: id, purposes, modelKeys: record.models ?? [] }],
      enabled: true, removed: false, locked: false,
      credentialConfigured: await service.credentialConfigured({ owner, connectionId: id, purpose: "model-api-key" }),
      configRevision: record.configRevision, credentialEpoch: record.credentialEpoch };
  };
  return { id: "sdk", retainAuthorityOnDispose: true, scope: "personal", get: project,
    list: async owner => (await Promise.all((await service.list(owner)).map(record => project(owner, record.connectionId)))).filter((record): record is ServiceConnectionSourceSnapshot => record !== null),
    readSecret: async (owner, id, expected) => {
      const record = await service.get(owner, id);
      if (!record || record.configRevision !== expected.configRevision || record.credentialEpoch !== expected.credentialEpoch) return null;
      return (await service.readCredential<{ secret: string }>({ owner, connectionId: id, purpose: "model-api-key" }))?.secret ?? null;
    } };
}
export async function sdkSourceFor(port: ApplicationServiceConnectionFacade, owner: string, connectionId: string, service?: Pick<ConnectionService, "get">) {
  const record = await service?.get(owner, connectionId);
  if (record?.serviceConnectionId) return port.get(owner, record.serviceConnectionId);
  // 旧式手填连接按 `consumerId === connectionId` 查找绑定。找不到绑定说明该来源没有声明
  // 助手可用协议，返回 null 由调用方决定如何呈现（可见但不可用），而不是在这里静默丢失。
  return (await port.list(owner)).find(source => source.bindings.some(binding => binding.extensionId === "sdk-agent" && binding.consumerId === connectionId)) ?? null;
}

/** Public Agent versions freeze both the legacy session configuration and its effective source.
 * Mutation handlers keep the raw service so their original CAS contract remains unchanged.
 */
export function withServiceSources(service: ConnectionService, port: ApplicationServiceConnectionFacade): ConnectionService {
  /**
   * Project one stored connection onto its effective service source.
   *
   * A connection whose source is disabled, removed, or missing an `sdk-agent` binding is still
   * returned — with `enabled: false` and a `reason` — instead of disappearing. Hiding it made
   * a real configuration gap ("this provider never declared an assistant protocol") look like
   * "the connection was never created", so the assistant panel silently lost the provider with
   * no way to tell why.
   */
  const project = async (owner: string, record: Awaited<ReturnType<ConnectionService["get"]>>) => {
    if (!record) return null;
    const source = await sdkSourceFor(port, owner, record.connectionId, service);
    if (!source || source.removed) return null;
    const protocol = sdkSourceProtocol(record.adapterId);
    const binding = source.bindings.find(item => item.extensionId === "sdk-agent" && (record.serviceConnectionId
      ? item.consumerId === `shared:${protocol}`
      : item.consumerId === record.connectionId));
    // 所有文本模型都支持工具调用：来源里同一协议下的 text 能力直接就是可用的 Agent 模型。
    const textModels = source.capabilities.filter(capability => capability.purpose === "text" && capability.protocol === protocol);
    const revision = Number.parseInt(createHash("sha256").update(JSON.stringify([record.configRevision, source.serviceConnectionId, source.configRevision, source.credentialEpoch, source.enabled, source.removed])).digest("hex").slice(0, 12), 16);
    const sharedModels: ConnectionModelCapabilityRecord[] = [...new Map(textModels.map((capability) => [capability.modelId, capability])).values()].map((capability) => ({
      id: capability.modelId,
      reasoning: capability.reasoning
        ? { state: capability.reasoning.state, source: capability.reasoning.source, revision: capability.reasoning.revision, ...(capability.reasoning.efforts ? { efforts: capability.reasoning.efforts.map((option) => ({ ...option })) } : {}) }
        : { state: "unknown", source: "provider", revision: "source-unreported" }
    }));
    const shared = record.serviceConnectionId ? { name: source.name, models: sharedModels.map((model) => model.id), modelCatalog: { revision: connectionModelCatalogRevision(sharedModels), models: sharedModels, capturedAt: "" } } : {};
    const projected = {
      ...record,
      ...shared,
      configRevision: revision,
      baseUrl: source.endpoints.find(endpoint => endpoint.protocol === protocol)?.baseUrl ?? record.baseUrl
    };
    if (!source.enabled) return { ...projected, enabled: false, reason: "该服务连接已停用，重新启用后可用于助手" };
    if (!binding?.purposes.includes("text")) {
      return { ...projected, enabled: false, reason: "该服务连接没有声明助手可用的文本协议，无法在助手面板中使用" };
    }
    return projected;
  };
  const ensureShared = async (owner: string) => {
    const existing = await service.list(owner);
    for (const source of await port.list(owner)) {
      if (!source.enabled || source.kind !== "api") continue;
      for (const binding of source.bindings.filter(binding => binding.extensionId === "sdk-agent" && binding.consumerId.startsWith("shared:") && binding.purposes.includes("text"))) {
        const protocol = binding.consumerId.slice("shared:".length);
        const adapterId = ({ responses: "openai-responses", messages: "anthropic-messages", "chat-completions": "compat-chat", gemini: "gemini-agent-adk" } as Record<string, string>)[protocol];
        if (!adapterId || existing.some(record => record.serviceConnectionId === source.serviceConnectionId && record.adapterId === adapterId)) continue;
        await service.configure(owner, { operationId: `auto:${source.serviceConnectionId}:${protocol}`, serviceConnectionId: source.serviceConnectionId,
          adapterId, name: source.name, authMode: "api-key", runCategory: "agent-sdk",
          baseUrl: source.endpoints.find(endpoint => endpoint.protocol === protocol)?.baseUrl, models: [], expectedEpoch: 0, expectedRevision: 0 });
      }
    }
    return service.list(owner);
  };
  return { ...service,
    credentialConfigured: async input => {
      const record = await service.get(input.owner, input.connectionId);
      if (input.purpose !== "model-api-key" || !record) return service.credentialConfigured(input);
      const source = await sdkSourceFor(port, input.owner, record.connectionId, service);
      return !!source?.enabled && !source.removed && source.credentialConfigured && source.bindings.some(binding => binding.extensionId === "sdk-agent" && binding.purposes.includes("text") && binding.consumerId === (record.serviceConnectionId ? `shared:${sdkSourceProtocol(record.adapterId)}` : record.connectionId));
    },
    get: async (owner, id) => project(owner, await service.get(owner, id)),
    list: async owner => (await Promise.all((await ensureShared(owner)).map(record => project(owner, record)))).filter((record): record is NonNullable<typeof record> => !!record),
  };
}
