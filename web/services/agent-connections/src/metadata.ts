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
import type { AgentConnectionRunCategory, AgentConnectionAuthMode, AgentConnectionStatus } from "@woohaa3/contracts";

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
    typeof candidate.credentialEpoch === "number"
  );
}
