/**
 * 受控 Agent 连接发现注册表
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 2.1 / design D3）。
 *
 * 把宿主 `agent-connection-provider:<providerId>` capability 解析为**版本绑定**的连接提供方：
 * - 每次调用重新读取 owner 与配置版本，不裸缓存 capability（停用/升级立即生效）；
 * - 只返回 public owner；停用/未安装的扩展没有该 capability，因此连接自然不可见（fail closed）；
 * - 校验 provider 形状，拒绝半成品实现。
 *
 * 核心不 import 任何厂商实现（本模块只依赖 contracts 的纯类型与形状校验）。
 */
import {
  AGENT_CONNECTION_PROVIDER_CAPABILITY_VERSION,
  agentConnectionProviderCapabilityId,
  agentConnectionProviderIdFromCapabilityId,
  isAgentConnectionProviderCapabilityId,
  isAgentConnectionProviderShape,
  type AgentConnectionView,
  type AgentConnectionProvider,
} from "@woohaa3/contracts";

export type AgentConnectionProviderOwner = {
  providerId: string;
  extensionId: string;
  configVersion: number;
  mode: "public" | "recovery";
};

export type AgentConnectionProviderHandle = {
  owner: AgentConnectionProviderOwner;
  provider: AgentConnectionProvider;
};

export type ResolveAgentConnectionProviderResult =
  | { ok: true; handle: AgentConnectionProviderHandle }
  | { ok: false; code: "adapter-unavailable"; message: string };

export type AgentConnectionRegistryHost = {
  hasCapability(id: string, version: number): boolean;
  resolveCapabilityOwner?(id: string, version: number): { extensionId: string; configVersion: number; mode: "public" | "recovery" } | null;
  resolveCapability(id: string, version: number): unknown;
  snapshot?(): Array<{ extensionId: string; capabilities: string[] }>;
};

export type AgentConnectionRegistry = {
  migrateConnection?(input: { owner: string; connectionId: string; beforeMigration: () => boolean }): Promise<void>;
  /** 枚举当前活动连接提供方（不暴露实现）；只返回 public owner。 */
  list(): AgentConnectionProviderOwner[];
  /** 解析指定 provider；未激活/非法/恢复模式返回 adapter-unavailable。 */
  resolve(providerId: string): ResolveAgentConnectionProviderResult;
  /** 列出某 owner 的全部可见连接（跨活动提供方；按 connectionId 去重）。 */
  listConnections(input: { owner: string; adapterId?: string }): Promise<readonly AgentConnectionView[]>;
  /** 解析某个 owner 的单条连接；不存在/无权限返回 null。 */
  getConnection(input: { owner: string; connectionId: string }): Promise<AgentConnectionView | null>;
};

export function createAgentConnectionRegistry(host: AgentConnectionRegistryHost): AgentConnectionRegistry {
  const resolveById = (providerId: string): ResolveAgentConnectionProviderResult => {
    const capabilityId = agentConnectionProviderCapabilityId(providerId);
    if (!host.hasCapability(capabilityId, AGENT_CONNECTION_PROVIDER_CAPABILITY_VERSION)) {
      return { ok: false, code: "adapter-unavailable", message: "该连接提供方不可用" };
    }
    const owner = host.resolveCapabilityOwner?.(capabilityId, AGENT_CONNECTION_PROVIDER_CAPABILITY_VERSION);
    if (!owner) return { ok: false, code: "adapter-unavailable", message: "该连接提供方不可用" };
    if (owner.mode !== "public") return { ok: false, code: "adapter-unavailable", message: "该连接提供方处于恢复模式" };
    const value = host.resolveCapability(capabilityId, AGENT_CONNECTION_PROVIDER_CAPABILITY_VERSION);
    if (!isAgentConnectionProviderShape(value)) return { ok: false, code: "adapter-unavailable", message: "连接提供方 capability 形态非法" };
    if (value.id !== providerId) return { ok: false, code: "adapter-unavailable", message: "连接提供方身份不一致" };
    return {
      ok: true,
      handle: {
        owner: { providerId, extensionId: owner.extensionId, configVersion: owner.configVersion, mode: owner.mode },
        provider: value
      }
    };
  };

  const list = (): AgentConnectionProviderOwner[] => {
    const snapshot = host.snapshot?.() ?? [];
    const owners: AgentConnectionProviderOwner[] = [];
    for (const entry of snapshot) {
      for (const capabilityId of entry.capabilities) {
        if (!isAgentConnectionProviderCapabilityId(capabilityId)) continue;
        const owner = host.resolveCapabilityOwner?.(capabilityId, AGENT_CONNECTION_PROVIDER_CAPABILITY_VERSION);
        if (!owner || owner.mode !== "public") continue;
        owners.push({
          providerId: agentConnectionProviderIdFromCapabilityId(capabilityId),
          extensionId: owner.extensionId,
          configVersion: owner.configVersion,
          mode: owner.mode
        });
      }
    }
    return owners.sort((left, right) => (left.providerId < right.providerId ? -1 : left.providerId > right.providerId ? 1 : 0));
  };

  const listConnections = async (input: { owner: string; adapterId?: string }): Promise<readonly AgentConnectionView[]> => {
    const seen = new Map<string, AgentConnectionView>();
    for (const owner of list()) {
      const resolved = resolveById(owner.providerId);
      if (!resolved.ok) continue;
      let views: readonly AgentConnectionView[];
      try {
        views = await resolved.handle.provider.listConnections({ owner: input.owner });
      } catch {
        continue;
      }
      for (const view of views) {
        if (input.adapterId && view.adapterId !== input.adapterId) continue;
        if (!seen.has(view.connectionId)) seen.set(view.connectionId, view);
      }
    }
    return [...seen.values()].sort((left, right) => (left.connectionId < right.connectionId ? -1 : left.connectionId > right.connectionId ? 1 : 0));
  };

  const getConnection = async (input: { owner: string; connectionId: string }): Promise<AgentConnectionView | null> => {
    for (const owner of list()) {
      const resolved = resolveById(owner.providerId);
      if (!resolved.ok) continue;
      if (!resolved.handle.provider.getConnection) continue;
      try {
        const found = await resolved.handle.provider.getConnection({ owner: input.owner, connectionId: input.connectionId });
        if (found && found.connectionId === input.connectionId) return found;
      } catch {
        continue;
      }
    }
    return null;
  };

  const migrateConnection = async (input: { owner: string; connectionId: string; beforeMigration: () => boolean }) => {
    for (const owner of list()) {
      const resolved = resolveById(owner.providerId);
      if (!resolved.ok) continue;
      const provider = resolved.handle.provider;
      const view = await provider.getConnection?.(input);
      if (view?.connectionId === input.connectionId) { await provider.migrateConnection?.(input); return; }
    }
  };
  return { migrateConnection, list, resolve: resolveById, listConnections, getConnection };
}
