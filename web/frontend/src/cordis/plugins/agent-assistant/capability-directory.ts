import type { AgentConnectionView, ServiceConnectionPurpose, ServiceConnectionView } from "@woohaa3/contracts";
import { serviceSourceState } from "./service-directory.js";

export type CapabilityKind = "agent" | "image" | "video" | "audio" | "model3d" | "hosting";
export type ActiveCapability = Exclude<CapabilityKind, "model3d" | "hosting">;
export type CapabilitySupplier = {
  id: string; name: string; status: string; configured: boolean; local: boolean;
  sourceId?: string; connectionId?: string; models: string[];
};

const matches = (purpose: ServiceConnectionPurpose, kind: ActiveCapability) => kind === "agent"
  ? purpose === "discussion" || purpose === "target-execution" || purpose === "candidate"
  : purpose === kind;

/** Count service identities, never models or consumer bindings. */
export function capabilitySuppliers(kind: ActiveCapability, local: readonly AgentConnectionView[], sources: readonly ServiceConnectionView[], remote: readonly AgentConnectionView[] = []): CapabilitySupplier[] {
  const rows: CapabilitySupplier[] = sources.filter(source => !source.removed && (
    source.capabilities.some(capability => matches(capability.purpose, kind)) ||
    source.bindings.some(binding => binding.purposes.some(purpose => matches(purpose, kind)))
  )).map(source => ({
    id: source.serviceConnectionId, sourceId: source.serviceConnectionId, name: source.name,
    status: serviceSourceState(source).label, configured: source.credentialConfigured, local: false,
    models: [...new Set(source.capabilities.filter(capability => matches(capability.purpose, kind)).map(capability => capability.modelId))],
  }));
  if (kind !== "agent") return rows;
  const bound = new Set(sources.flatMap(source => source.bindings.filter(binding => binding.consumer !== "provider").map(binding => binding.consumerId)));
  for (const connection of [...local, ...remote.filter(connection => !bound.has(connection.connectionId))]) {
    const isLocal = local.includes(connection);
    rows.push({
      id: `agent:${connection.connectionId}`, connectionId: connection.connectionId, name: connection.name, local: isLocal,
      configured: connection.ready || connection.status.credential.state === "ready",
      status: connection.ready ? "可用" : connection.reason || (connection.credentialConfigured === false ? "待配置密钥" : "待检查"),
      models: [],
    });
  }
  return rows;
}
