import type { AgentConnectionView, ServiceConnectionPurpose, ServiceConnectionView } from "@woohaa3/contracts";
import { serviceSourceState } from "./service-directory.js";

export type CapabilityKind = "agent" | "image" | "video" | "audio" | "model3d" | "hosting";
export type ActiveCapability = Exclude<CapabilityKind, "model3d" | "hosting">;
export type CapabilitySupplier = {
  id: string; name: string; status: string; configured: boolean; local: boolean;
  sourceId?: string; connectionId?: string; usable?: boolean; models: string[];
};

const matches = (purpose: ServiceConnectionPurpose, kind: ActiveCapability) => kind === "agent"
  ? purpose === "text"
  : purpose === kind;

/** Count service identities, never models or consumer bindings. */
export function capabilitySuppliers(kind: ActiveCapability, local: readonly AgentConnectionView[], sources: readonly ServiceConnectionView[], remote: readonly AgentConnectionView[] = []): CapabilitySupplier[] {
  const connections = kind === "agent" ? [...local, ...remote] : [];
  const rows: CapabilitySupplier[] = sources.filter(source => !source.removed && (
    source.capabilities.some(capability => matches(capability.purpose, kind)) ||
    source.bindings.some(binding => binding.purposes.some(purpose => matches(purpose, kind)))
  )).map(source => {
    // One service source is one supplier identity even when several protocol connections project from it.
    // Older adapters bind the Agent consumer directly to a connectionId instead of carrying a source id.
    const boundTo = (item: AgentConnectionView) => source.bindings.some(binding => binding.consumer !== "provider" && binding.consumerId === item.connectionId);
    const connection = connections.find(item => item.serviceConnectionId === source.serviceConnectionId && item.ready) ??
      connections.find(item => item.serviceConnectionId === source.serviceConnectionId) ??
      connections.find(item => boundTo(item) && item.ready) ?? connections.find(boundTo);
    const state = serviceSourceState(source);
    return {
      id: source.serviceConnectionId, sourceId: source.serviceConnectionId, name: source.name,
      // A projected connection can be blocked by endpoint/runtime policy even with a saved credential.
      status: connection && !connection.ready ? connection.reason ?? state.label : state.label,
      configured: source.credentialConfigured, local: false,
      ...(connection ? { connectionId: connection.connectionId, usable: connection.ready } : {}),
      models: [...new Set(source.capabilities.filter(capability => matches(capability.purpose, kind)).map(capability => capability.modelId))],
    };
  });
  if (kind !== "agent") return rows;
  const bound = new Set(sources.flatMap(source => source.bindings.filter(binding => binding.consumer !== "provider").map(binding => binding.consumerId)));
  const sourceIds = new Set(sources.map(source => source.serviceConnectionId));
  for (const connection of [...local, ...remote.filter(connection => !bound.has(connection.connectionId) && (!connection.serviceConnectionId || !sourceIds.has(connection.serviceConnectionId)))]) {
    const isLocal = local.includes(connection);
    rows.push({
      id: `agent:${connection.connectionId}`, connectionId: connection.connectionId, name: connection.name, local: isLocal,
      configured: connection.ready || connection.status.credential.state === "ready",
      status: connection.ready ? "可用" : connection.reason || (connection.credentialConfigured === false ? "待配置密钥" : "待检查"),
      usable: connection.ready,
      models: [],
    });
  }
  return rows;
}
