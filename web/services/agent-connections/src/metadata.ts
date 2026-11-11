/**
 * 连接元数据存储：owner-scoped、版本化（change: 2026-10-16-add-agent-appserver-and-sdk-connections，
 * 任务 1.3 / design D3）。
 *
 * 连接元数据用扩展 documents 保存（宿主按 extensionId 提供隔离 facade），凭据用 secrets 保存。
 * 本模块只定义**存储形状与不变量**，不依赖任何厂商 SDK，也不触碰凭据明文：
 * - 每份记录按 `owner` + `connectionId` 隔离；同 owner 多条连接天然独立；
 * - `configRevision` 在非秘密配置（名称/接入方式/endpoint/模型）变化时递增；
 * - `credentialEpoch` 由 secrets 仓库推进（替换/清除密钥），本模块只镜像其值；
 * - native 会话/线程索引按 `connectionId` + `credentialEpoch` 归属，换连接/epoch 不复用。
 */
import type { AgentConnectionRunCategory, AgentConnectionAuthMode, AgentConnectionStatus, AgentReasoningCapability, AgentReasoningCapabilitySource, AgentReasoningCapabilityState, AgentReasoningEffort } from "@woohaa3/contracts";
import { isAgentReasoningCapability } from "@woohaa3/contracts";
import { createHash } from "node:crypto";

/** 持久化用的 reasoning 能力；数组保持可变以通过文档存储值类型。 */
export type StoredReasoningCapability = {
  state: AgentReasoningCapabilityState;
  efforts?: Array<{ id: AgentReasoningEffort; label?: string }>;
  source: AgentReasoningCapabilitySource;
  revision: string;
};

/** 单个模型的 reasoning 能力快照（与公开目录同一投影）。 */
export type ConnectionModelCapabilityRecord = {
  id: string;
  label?: string;
  reasoning: StoredReasoningCapability;
};

/** 连接级模型目录快照；修订号只在能力事实变化时推进。 */
export type ConnectionModelCatalogRecord = {
  revision: string;
  models: ConnectionModelCapabilityRecord[];
  capturedAt: string;
  error?: string;
};

export type ConnectionNativeBinding = {
  /** 原生会话/线程 id（执行索引；不跨连接/owner 复用）。 */
  nativeId: string;
  /** 归属的凭据 epoch（不匹配即失效）。 */
  credentialEpoch: number;
  /** 关联的宿主会话 id（用于「同节点复用」时校验）。 */
  conversationId?: string;
  updatedAt: string;
};

export type ConnectionMetadataRecord = {
  runtimeVersion?: string;
  runtimeProbe?: { version: string; evidence: import("@woohaa3/contracts").AgentConnectionStatusEvidence };
  connectionId: string;
  /** Host-created alias: owns sessions, never a second model credential. */
  serviceConnectionId?: string;
  owner: string;
  adapterId: string;
  name: string;
  runCategory: AgentConnectionRunCategory;
  authMode: AgentConnectionAuthMode;
  /** 非秘密配置 revision（配置变化递增）。 */
  configRevision: number;
  /** 凭据 epoch 镜像（secrets 仓库为事实源）。 */
  credentialEpoch: number;
  /** Internal immutable secret-version pointers. Missing entries bridge legacy keys; null means revoked. */
  credentialKeys?: Partial<Record<import("@woohaa3/contracts").AgentCredentialPurpose, string | null>>;
  /** 自定义 endpoint（仅兼容 API；官方 SDK 不接受）。 */
  baseUrl?: string;
  /** 显式模型（无目录时手填；不冒充账号已授权）。 */
  models?: string[];
  /** 模型级 reasoning 能力快照；旧记录缺省时按 `models` 归一为 unknown。 */
  modelCatalog?: ConnectionModelCatalogRecord;
  /** 原生会话/线程索引：按 connectionId + epoch 归属。 */
  native?: ConnectionNativeBinding;
  /** Versioned host-conversation/target bindings; legacy native is never a fallback. */
  nativeBindings?: Record<string, ConnectionNativeBinding>;
  /**
   * 最近一次真实证据快照（transport/credential/modelAccess/tools）。
   *
   * 只在**真实探测/运行**后记录；保存设置不写入，因此保存 Key 不会把 `ready` 伪装出来。
   */
  lastStatus?: AgentConnectionStatus;
  createdAt: string;
  updatedAt: string;
};

const RECORD_PREFIX = "connections/";

export function connectionMetadataKey(connectionId: string): string {
  // 只用稳定 id 作 key 后缀，不使用显示名/地址（design D3）。
  return `${RECORD_PREFIX}${connectionId}`;
}

export function connectionMetadataPrefix(): string {
  return RECORD_PREFIX;
}

/** 校验记录形状（拒绝半成品；owner 必须存在）。参数为 `unknown` 以便用于文档扫描过滤。 */
export function isConnectionMetadataRecord(value: unknown): value is ConnectionMetadataRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.connectionId === "string" && candidate.connectionId.length > 0 &&
    typeof candidate.owner === "string" && candidate.owner.length > 0 &&
    typeof candidate.adapterId === "string" && candidate.adapterId.length > 0 &&
    typeof candidate.name === "string" &&
    typeof candidate.configRevision === "number" &&
    typeof candidate.credentialEpoch === "number" &&
    (candidate.modelCatalog === undefined || isConnectionModelCatalog(candidate.modelCatalog))
  );
}

export function isConnectionModelCatalog(value: unknown): value is ConnectionModelCatalogRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.revision !== "string" || candidate.revision.length === 0 || candidate.revision.length > 128) return false;
  if (typeof candidate.capturedAt !== "string" || candidate.capturedAt.length === 0) return false;
  if (candidate.error !== undefined && typeof candidate.error !== "string") return false;
  if (!Array.isArray(candidate.models)) return false;
  const seen = new Set<string>();
  return candidate.models.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const model = entry as Record<string, unknown>;
    if (typeof model.id !== "string" || model.id.length === 0 || model.id.length > 256 || seen.has(model.id)) return false;
    if (model.label !== undefined && (typeof model.label !== "string" || model.label.length === 0)) return false;
    seen.add(model.id);
    return isAgentReasoningCapability(model.reasoning);
  });
}

/** 能力修订号：只覆盖模型的 id + reasoning 事实，目录顺序变化不推进修订。 */
export function connectionModelCatalogRevision(models: readonly ConnectionModelCapabilityRecord[]): string {
  const normalized = [...models]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((model) => [model.id, model.reasoning.state, model.reasoning.source, model.reasoning.revision, (model.reasoning.efforts ?? []).map((option) => option.id)]);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 24);
}

/** 旧 `models: string[]` 读取为 unknown；不改写持久记录。 */
export function modelCatalogForRecord(record: Pick<ConnectionMetadataRecord, "models" | "modelCatalog" | "configRevision">): ConnectionModelCatalogRecord {
  if (record.modelCatalog) return record.modelCatalog;
  const models: ConnectionModelCapabilityRecord[] = (record.models ?? []).map((id) => ({ id, reasoning: { state: "unknown", source: "provider", revision: `legacy-${record.configRevision}` } }));
  return { revision: connectionModelCatalogRevision(models), models, capturedAt: "" };
}

const storedReasoning = (capability: AgentReasoningCapability): StoredReasoningCapability => ({
  state: capability.state,
  source: capability.source,
  revision: capability.revision,
  ...(capability.efforts ? { efforts: capability.efforts.map((option) => ({ ...option })) } : {})
});

/** 把输入模型（纯 id 或带能力）与旧快照合并；纯 id 保留同 id 的已知能力。 */
export function mergeModelCapabilities(
  entries: readonly (string | { id: string; label?: string; reasoning?: AgentReasoningCapability })[],
  previous: ConnectionModelCatalogRecord | undefined
): ConnectionModelCapabilityRecord[] {
  const known = new Map((previous?.models ?? []).map((model) => [model.id, model]));
  return entries.map((entry): ConnectionModelCapabilityRecord => {
    if (typeof entry === "string") {
      const id = entry.trim();
      const prior = known.get(id);
      return prior ?? { id, reasoning: { state: "unknown", source: "provider", revision: "user-provided" } };
    }
    const id = entry.id.trim();
    const prior = known.get(id);
    const label = entry.label ?? prior?.label;
    return {
      id,
      ...(label ? { label } : {}),
      reasoning: entry.reasoning ? storedReasoning(entry.reasoning) : prior?.reasoning ?? { state: "unknown", source: "provider", revision: "user-provided" }
    };
  }).filter((model) => model.id.length > 0);
}
