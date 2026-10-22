/**
 * 连接发现端口装配
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 2.1 / design D3）。
 *
 * 两个扩展都用同一装配把私有连接元数据投影成公开的 `AgentConnectionProvider`：宿主按
 * `agent-connection-provider:<id>` 解析，只拿到 owner-scoped 公开视图；凭据与原生会话映射
 * 留在扩展私有存储。每类连接的证据（transport/credential/modelAccess/tools）由扩展按自身
 * 协议采集，本模块只负责聚合与投影，不伪造 `ready`。
 */
import type {
  AgentConnectionRuntime,
  AgentConnectionCapabilities,
  AgentConnectionModel,
  AgentConnectionProvider,
  AgentConnectionStatus,
  AgentConnectionStatusKind,
  AgentConnectionView,
  AgentCredentialPurpose
} from "@woohaa3/contracts";
import type { ConnectionMetadataRecord } from "./metadata.js";
import type { ConnectionService } from "./service.js";
import { emptyStatus, projectConnectionView, statusEvidence } from "./connection-view.js";

export type ConnectionDescribeContext = {
  record: ConnectionMetadataRecord;
  credentialConfigured: boolean;
  /** 读取本连接凭据（进程内；适配器协议检查用，不进入返回视图）。 */
  readCredential: <T = { secret: string }>(purpose: AgentCredentialPurpose) => Promise<T | null>;
  /** 记录真实证据快照（探测/运行后）；保存设置不调用。 */
  recordStatus: (patch: Partial<Pick<AgentConnectionStatus, "transport" | "modelAccess" | "tools">>) => Promise<void>;
};

export type ConnectionDescribeResult = {
  /** 公开展示名称；省略时使用用户保存的名称。 */
  name?: string;
  runtime?: AgentConnectionRuntime;
  capabilities: AgentConnectionCapabilities;
  models: readonly AgentConnectionModel[];
  modelsError?: string;
  /** 若返回，作为真实证据快照；否则用连接记录中的 `lastStatus`。 */
  status?: AgentConnectionStatus;
  /** 当前动作所需证据（缺省只要求 transport）。 */
  required?: readonly AgentConnectionStatusKind[];
  endpointAllowed?: boolean;
  reason?: string;
};

/** 每类 adapter 的投影器：只做本地投影；真正的协议探测由扩展在 `probe` 中显式触发。 */
export type ConnectionDescriptor = {
  describe: (context: ConnectionDescribeContext) => Promise<ConnectionDescribeResult> | ConnectionDescribeResult;
};

export type ConnectionProviderOptions = {
  /** providerId（= capability 后缀）。 */
  id: string;
  extensionId: string;
  service: ConnectionService;
  descriptors: Record<string, ConnectionDescriptor>;
};

export function createConnectionProvider(options: ConnectionProviderOptions): AgentConnectionProvider {
  const { service } = options;

  const project = async (record: ConnectionMetadataRecord): Promise<AgentConnectionView | null> => {
    const descriptor = options.descriptors[record.adapterId];
    if (!descriptor) return null;
    const credentialConfigured = await service.credentialConfigured({
      owner: record.owner,
      connectionId: record.connectionId,
      purpose: "model-api-key"
    });
    const context: ConnectionDescribeContext = {
      record,
      credentialConfigured,
      readCredential: <T = { secret: string }>(purpose: AgentCredentialPurpose) =>
        service.readCredential<T>({ owner: record.owner, connectionId: record.connectionId, purpose }),
      recordStatus: async (patch) => {
        await service.setStatus({ owner: record.owner, connectionId: record.connectionId, patch });
      }
    };
    const described = await descriptor.describe(context);
    const base = described.status ?? record.lastStatus ?? emptyStatus();
    // credential 证据：仅 api-key 连接由「是否已保存 Key」维护；local-login/oauth 等由真实探测记录。
    const status: AgentConnectionStatus =
      record.authMode === "api-key"
        ? {
            ...base,
            credential: credentialConfigured
              ? statusEvidence("ready", { checkedAt: base.credential.checkedAt ?? null })
              : statusEvidence("unavailable", {
                  checkedAt: base.credential.checkedAt ?? null,
                  reason: base.credential.reason ?? "尚未保存凭据"
                })
          }
        : base;
    return projectConnectionView({
      record: described.name === undefined ? record : { ...record, name: described.name },
      ...(described.runtime ? { runtime: described.runtime } : {}),
      extensionId: options.extensionId,
      capabilities: described.capabilities,
      models: described.models,
      ...(described.modelsError ? { modelsError: described.modelsError } : {}),
      status,
      ...(described.required ? { required: described.required } : {}),
      credentialConfigured,
      ...(described.endpointAllowed !== undefined ? { endpointAllowed: described.endpointAllowed } : {}),
      ...(described.reason ? { reason: described.reason } : {})
    });
  };

  return {
    id: options.id,
    async listConnections({ owner }) {
      const records = await service.list(owner);
      const views: AgentConnectionView[] = [];
      for (const record of records) {
        const view = await project(record);
        if (view) views.push(view);
      }
      return views;
    },
    async getConnection({ owner, connectionId }) {
      const record = await service.get(owner, connectionId);
      if (!record) return null;
      return project(record);
    }
  };
}
