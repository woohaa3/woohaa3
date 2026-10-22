import { agentConversationAdapterCapabilityId, agentConnectionProviderCapabilityId,
  type AgentConversationAdapter, type AgentConnectionProvider, type FilmSetConversionProvider } from "@woohaa3/contracts";
import type { AgentAdapterRegistryHost } from "./agent-adapter-registry.js";

/** Project registered site candidate ports into the existing directory and ledger.
 * A candidate-only adapter cannot run ordinary chat/tools; dispatchDeliveryTurn owns its runner.
 * Existing full conversation adapters always retain their own owner/connection provider.
 */
export function candidateAssistantDirectory(host: AgentAdapterRegistryHost, providers: () => readonly FilmSetConversionProvider[]): AgentAdapterRegistryHost {
  let revision = Date.now();
  const versions = new WeakMap<FilmSetConversionProvider, number>();
  const entries = () => providers().filter(provider => provider.assistantAdapterId && !host.hasCapability(agentConversationAdapterCapabilityId(provider.assistantAdapterId))).map(provider => {
    let version = versions.get(provider);
    if (version === undefined) { version = ++revision; versions.set(provider, version); }
    const adapterId = provider.assistantAdapterId!;
    const adapterCapability = agentConversationAdapterCapabilityId(adapterId);
    const connectionCapability = agentConnectionProviderCapabilityId(`candidate-${provider.providerId}`);
    const models = () => provider.listModels().flatMap(candidate => candidate.assistant?.adapterId === adapterId ? [{ id: candidate.assistant.model, label: candidate.label }] : []);
    const adapter: AgentConversationAdapter = { id: adapterId,
      capabilities: () => ({ discussion: false, tools: false, targets: [], models: "remote" }),
      authorization: async () => models().length ? "ready" : "unavailable",
      models: async () => ({ models: models() }),
      run: async () => ({ status: "failed", error: { code: "capability-unsupported", message: "此连接仅支持素材候选交付，请从素材创建入口提交" } }) };
    const connections: AgentConnectionProvider = { id: `candidate-${provider.providerId}`, listConnections: async ({ owner }) => {
      if (!owner || !models().length) return [];
      const ready = { state: "ready" as const };
      return [{ connectionId: `candidate:${provider.providerId}`, adapterId, extensionId: provider.providerId, name: `${provider.providerId} · 素材交付`,
        runCategory: "http-sdk", authMode: "api-key", configRevision: version!, credentialEpoch: version!,
        status: { transport: ready, credential: ready, modelAccess: ready, tools: { state: "unavailable", reason: "候选交付不使用写工具" } },
        ready: true, credentialConfigured: true, capabilities: { discussion: false, tools: false, imageInput: true, structuredResult: true, cancel: true, resume: false },
        models: models().map(model => ({ ...model, source: "remote-catalog" as const, accountAuthorized: true })) }];
    }, getConnection: async ({ owner, connectionId }) => (await connections.listConnections({ owner })).find(connection => connection.connectionId === connectionId) ?? null };
    return { adapterCapability, connectionCapability, adapter, connections,
      owner: { extensionId: provider.providerId, configVersion: version, mode: "public" as const } };
  });
  const find = (id: string) => entries().find(entry => entry.adapterCapability === id || entry.connectionCapability === id);
  return {
    hasCapability: id => host.hasCapability(id) || Boolean(find(id)),
    resolveCapabilityOwner: id => host.hasCapability(id) ? host.resolveCapabilityOwner?.(id) ?? null : find(id)?.owner ?? null,
    resolveCapability: id => host.hasCapability(id) ? host.resolveCapability(id) : (() => { const entry = find(id); return entry?.adapterCapability === id ? entry.adapter : entry?.connections; })(),
    snapshot: () => [...(host.snapshot?.() ?? []), ...entries().map(entry => ({ extensionId: entry.owner.extensionId, capabilities: [entry.adapterCapability, entry.connectionCapability] }))],
  };
}
