import { createHash } from "node:crypto";
import type { ApplicationServiceConnectionFacade, ServiceConnectionProtocol, ServiceConnectionSourceAdapter, ServiceConnectionSourceSnapshot, ServiceConnectionPurpose } from "@woohaa3/contracts";
import type { ConnectionService } from "@woohaa3/agent-connections";
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
    const purposes: ServiceConnectionPurpose[] = ["discussion", "target-execution"];
    return { legacyId: id, scope: "personal", kind: "api", name: record.name,
      endpoints: [{ protocol, baseUrl: record.baseUrl ?? descriptor.officialBaseUrl }],
      capabilities: (record.models ?? []).flatMap(modelId => [
        { purpose: "discussion" as const, protocol, modelId, imageInput: false, evidence: "adapter" as const },
        ...(record.modelCapabilities?.[modelId]?.tools === true ? [{ purpose: "target-execution" as const, protocol, modelId, imageInput: false, evidence: "adapter" as const }] : []),
      ]),
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
export async function sdkSourceFor(port: ApplicationServiceConnectionFacade, owner: string, connectionId: string, service?: ConnectionService) {
  const record = await service?.get(owner, connectionId);
  if (record?.serviceConnectionId) return port.get(owner, record.serviceConnectionId);
  return (await port.list(owner)).find(source => source.bindings.some(binding => binding.extensionId === "sdk-agent" && binding.consumerId === connectionId)) ?? null;
}

/** Public Agent versions freeze both the legacy session configuration and its effective source.
 * Mutation handlers keep the raw service so their original CAS contract remains unchanged.
 */
export function withServiceSources(service: ConnectionService, port: ApplicationServiceConnectionFacade): ConnectionService {
  const project = async (owner: string, record: Awaited<ReturnType<ConnectionService["get"]>>) => {
    if (!record) return null;
    const source = await sdkSourceFor(port, owner, record.connectionId, service);
    // A disabled, removed or opted-out source stops projecting its Agent connection; conversation history stays.
    if (!source || !source.enabled || source.removed) return null;
    const binding = source.bindings.find(item => item.extensionId === "sdk-agent" && (record.serviceConnectionId
      ? item.consumerId === `shared:${sdkSourceProtocol(record.adapterId)}`
      : item.consumerId === record.connectionId));
    if (!binding?.purposes.includes("discussion")) return null;
    const revision = Number.parseInt(createHash("sha256").update(JSON.stringify([record.configRevision, source.serviceConnectionId, source.configRevision, source.credentialEpoch, source.enabled, source.removed])).digest("hex").slice(0, 12), 16);
    // Provider-declared assistant bindings are full Agent connections (discussion + target execution).
    // Self-filled protocol bindings remain discussion-only, so keep their explicit tools:false evidence.
    const providerDeclared = source.bindings.some(item => item.bindingId.startsWith("provider-assistant:"));
    const shared = record.serviceConnectionId ? { name: source.name, models: source.capabilities.filter(capability => capability.purpose === "discussion" && capability.protocol === sdkSourceProtocol(record.adapterId)).map(capability => capability.modelId),
      ...(providerDeclared ? {} : { modelCapabilities: Object.fromEntries(source.capabilities.filter(capability => capability.purpose === "discussion").map(capability => [capability.modelId, { tools: false }])) }) } : {};
    return { ...record, ...shared, configRevision: revision,
      baseUrl: source.endpoints.find(endpoint => endpoint.protocol === sdkSourceProtocol(record.adapterId))?.baseUrl ?? record.baseUrl };
  };
  const ensureShared = async (owner: string) => {
    const existing = await service.list(owner);
    for (const source of await port.list(owner)) {
      if (!source.enabled || source.kind !== "api") continue;
      for (const binding of source.bindings.filter(binding => binding.extensionId === "sdk-agent" && binding.consumerId.startsWith("shared:") && binding.purposes.includes("discussion"))) {
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
      return !!source?.enabled && !source.removed && source.credentialConfigured && source.bindings.some(binding => binding.extensionId === "sdk-agent" && binding.purposes.includes("discussion") && binding.consumerId === (record.serviceConnectionId ? `shared:${sdkSourceProtocol(record.adapterId)}` : record.connectionId));
    },
    get: async (owner, id) => project(owner, await service.get(owner, id)),
    list: async owner => (await Promise.all((await ensureShared(owner)).map(record => project(owner, record)))).filter((record): record is NonNullable<typeof record> => !!record),
  };
}
