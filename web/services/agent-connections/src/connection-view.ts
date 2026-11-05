/**
 * 连接公开视图投影与状态证据
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 1.3/1.5 / design D3）。
 *
 * 把扩展私有的连接元数据投影为**不含秘密**的 `AgentConnectionView`：
 * - 四类证据（transport/credential/modelAccess/tools）分开记录；`ready` 只在当前动作
 *   所需证据为 `ready` 时成立，保存 Key 不等于模型可调用；
 * - `credentialConfigured` 只表示「已保存」，不回读明文；
 * - 模型来源区分 `remote-catalog` / `user-provided` / `builtin`，手填模型不标账号已授权。
 */
import type {
  AgentConnectionRuntime,
  AgentConnectionCapabilities,
  AgentConnectionModel,
  AgentConnectionStatus,
  AgentConnectionStatusEvidence,
  AgentConnectionStatusKind,
  AgentConnectionView,
  AgentModelCapabilitySource
} from "@woohaa3/contracts";
import type { ConnectionMetadataRecord } from "./metadata.js";

export function emptyStatusEvidence(): AgentConnectionStatusEvidence {
  return { state: "unknown", checkedAt: null };
}

export function emptyStatus(): AgentConnectionStatus {
  return {
    transport: emptyStatusEvidence(),
    credential: emptyStatusEvidence(),
    modelAccess: emptyStatusEvidence(),
    tools: emptyStatusEvidence()
  };
}

export function statusEvidence(
  state: AgentConnectionStatusEvidence["state"],
  input: { checkedAt?: string | null; reason?: string } = {}
): AgentConnectionStatusEvidence {
  return {
    state,
    checkedAt: input.checkedAt ?? null,
    ...(input.reason ? { reason: input.reason } : {})
  };
}

export function isReady(
  status: AgentConnectionStatus,
  required: readonly AgentConnectionStatusKind[] = ["transport"]
): boolean {
  return required.every((kind) => status[kind].state === "ready");
}

/** 连接声明的能力；缺省全部 false（不冒称能力）。 */
export function noCapabilities(): AgentConnectionCapabilities {
  return { discussion: false, imageInput: false, tools: false, structuredResult: false, cancel: false, resume: false };
}

export type ConnectionProjectionInput = {
  record: ConnectionMetadataRecord;
  runtime?: AgentConnectionRuntime;
  extensionId: string;
  capabilities: AgentConnectionCapabilities;
  models: readonly AgentConnectionModel[];
  modelsError?: string;
  status: AgentConnectionStatus;
  /** 当前动作要求的证据；缺省只要求 transport。 */
  required?: readonly AgentConnectionStatusKind[];
  credentialConfigured: boolean;
  endpointAllowed?: boolean;
  reason?: string;
};

export function projectConnectionView(input: ConnectionProjectionInput): AgentConnectionView {
  // "unknown" means the runtime has not been probed yet, not that it is missing. Only explicit
  // unavailable/failed evidence blocks the first attempt; the run itself refreshes the evidence.
  const runtimeBlocked = input.runtime && (input.runtime.dependency.state === "unavailable" || input.runtime.dependency.state === "failed");
  const ready = isReady(input.status, input.required ?? ["transport"]) && !runtimeBlocked &&
    input.endpointAllowed !== false;
  return {
    connectionId: input.record.connectionId,
    ...(input.record.serviceConnectionId ? { serviceConnectionId: input.record.serviceConnectionId } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    adapterId: input.record.adapterId,
    extensionId: input.extensionId,
    name: input.record.name,
    runCategory: input.record.runCategory,
    authMode: input.record.authMode,
    configRevision: input.record.configRevision,
    credentialEpoch: input.record.credentialEpoch,
    status: input.status,
    ready,
    capabilities: input.capabilities,
    models: input.models,
    ...(input.modelsError ? { modelsError: input.modelsError } : {}),
    credentialConfigured: input.credentialConfigured,
    ...(input.endpointAllowed !== undefined ? { endpointAllowed: input.endpointAllowed } : {}),
    ...(input.reason ? { reason: input.reason } : {})
  };
}

export function modelView(input: {
  id: string;
  label?: string;
  source: AgentModelCapabilitySource;
  accountAuthorized: boolean;
  capabilities?: Partial<Pick<AgentConnectionCapabilities, "imageInput" | "tools" | "structuredResult">>;
}): AgentConnectionModel {
  return {
    id: input.id,
    label: input.label ?? input.id,
    source: input.source,
    accountAuthorized: input.accountAuthorized,
    ...(input.capabilities ? { capabilities: input.capabilities } : {})
  };
}
