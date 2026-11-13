/**
 * 受控 Agent 会话 adapter 注册表
 * （change: 2026-10-12-add-agent-conversation-panel，任务 1.2 / design D1）。
 *
 * 把宿主 `agent-conversation-adapter:<adapterId>` capability 解析为**版本绑定**的 adapter：
 * - 每次调用校验 owner 与配置版本，不裸缓存 capability（停用/升级立即生效）；
 * - 一个 adapterId 只能有一个 public owner，注册冲突使 activation 回滚；
 * - 校验 adapter 形状，拒绝半成品实现。
 *
 * 通用面板只经宿主 API 使用会话；本注册表只解析扩展提供的 adapter。
 */
import {
  agentConversationAdapterCapabilityId,
  agentConversationAdapterIdFromCapabilityId,
  isAgentAdapterCapabilities,
  isAgentConversationAdapterCapabilityId,
  isAgentConversationAdapterShape,
  type AgentAdapterCapabilities,
  type AgentConversationAdapter
} from "@woohaa3/contracts";

export type AgentAdapterRegistryOwner = {
  adapterId: string;
  extensionId: string;
  configVersion: number;
  mode: "public" | "recovery";
};

export type AgentAdapterHandle = {
  owner: AgentAdapterRegistryOwner;
  adapter: AgentConversationAdapter;
  capabilities: AgentAdapterCapabilities;
};

export type ResolveAgentAdapterResult =
  | { ok: true; handle: AgentAdapterHandle }
  | { ok: false; code: "adapter-unavailable"; message: string };

export type AgentAdapterRegistryHost = {
  hasCapability(id: string): boolean;
  resolveCapabilityOwner?(id: string): { extensionId: string; configVersion: number; mode: "public" | "recovery" } | null;
  resolveCapability(id: string): unknown;
  snapshot?(): Array<{ extensionId: string; capabilities: string[] }>;
};

export type AgentAdapterRegistry = {
  /** 枚举当前活动 adapter（不暴露实现）；只返回 public owner。 */
  list(): AgentAdapterRegistryOwner[];
  /** 解析默认 adapter：优先 `preferred`，否则按 id 排序首个可用 public adapter。 */
  resolve(preferred?: string): ResolveAgentAdapterResult;
  resolveByCapabilityId(capabilityId: string): ResolveAgentAdapterResult;
};

export function createAgentAdapterRegistry(
  host: AgentAdapterRegistryHost,
  options: { wrapAdapter?: (handle: AgentAdapterHandle) => AgentConversationAdapter } = {}
): AgentAdapterRegistry {
  const resolveById = (adapterId: string): ResolveAgentAdapterResult => {
    const capabilityId = agentConversationAdapterCapabilityId(adapterId);
    if (!host.hasCapability(capabilityId)) {
      return { ok: false, code: "adapter-unavailable", message: "该 Agent adapter 不可用" };
    }
    const owner = host.resolveCapabilityOwner?.(capabilityId);
    if (!owner) return { ok: false, code: "adapter-unavailable", message: "该 Agent adapter 不可用" };
    if (owner.mode !== "public") return { ok: false, code: "adapter-unavailable", message: "该 Agent adapter 处于恢复模式" };
    const value = host.resolveCapability(capabilityId);
    if (!isAgentConversationAdapterShape(value)) return { ok: false, code: "adapter-unavailable", message: "Agent adapter capability 形态非法" };
    if (value.id !== adapterId) return { ok: false, code: "adapter-unavailable", message: "Agent adapter 身份不一致" };
    let capabilities: AgentAdapterCapabilities;
    try {
      capabilities = value.capabilities();
    } catch {
      return { ok: false, code: "adapter-unavailable", message: "Agent adapter 能力声明失败" };
    }
    if (!isAgentAdapterCapabilities(capabilities)) return { ok: false, code: "adapter-unavailable", message: "Agent adapter 能力声明非法" };
    const handle: AgentAdapterHandle = {
      owner: { adapterId, extensionId: owner.extensionId, configVersion: owner.configVersion, mode: owner.mode },
      adapter: value,
      capabilities
    };
    return {
      ok: true,
      handle: options.wrapAdapter
        ? { ...handle, adapter: options.wrapAdapter(handle) }
        : handle
    };
  };

  const list = (): AgentAdapterRegistryOwner[] => {
    const snapshot = host.snapshot?.() ?? [];
    const owners: AgentAdapterRegistryOwner[] = [];
    for (const entry of snapshot) {
      for (const capabilityId of entry.capabilities) {
        if (!isAgentConversationAdapterCapabilityId(capabilityId)) continue;
        const owner = host.resolveCapabilityOwner?.(capabilityId);
        if (!owner || owner.mode !== "public") continue;
        owners.push({ adapterId: agentConversationAdapterIdFromCapabilityId(capabilityId), extensionId: owner.extensionId, configVersion: owner.configVersion, mode: owner.mode });
      }
    }
    return owners.sort((left, right) => (left.adapterId < right.adapterId ? -1 : left.adapterId > right.adapterId ? 1 : 0));
  };

  return {
    list,
    resolveByCapabilityId: (capabilityId) => {
      if (!isAgentConversationAdapterCapabilityId(capabilityId)) {
        return { ok: false, code: "adapter-unavailable", message: "不是受控 Agent adapter capability" };
      }
      return resolveById(agentConversationAdapterIdFromCapabilityId(capabilityId));
    },
    resolve: (preferred) => {
      if (preferred) return resolveById(preferred);
      const first = list()[0];
      if (!first) return { ok: false, code: "adapter-unavailable", message: "没有可用的 Agent adapter" };
      return resolveById(first.adapterId);
    }
  };
}
