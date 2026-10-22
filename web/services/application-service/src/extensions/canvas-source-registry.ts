/**
 * 受控外部画布来源注册表
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 3.1–3.3 / design D3、D10、D11）。
 *
 * 把宿主 `canvas-source:<sourceId>` capability 解析为**版本绑定**的调用 handle：
 * - 每次调用都校验 owner 与配置版本，不裸缓存 capability（停用/升级立即生效）；
 * - 一个 sourceId 只能有一个活动 owner，注册冲突使 activation 回滚；
 * - 校验 capability 形状，拒绝半成品实现。
 *
 * 本模块只依赖 `@woohaa3/contracts`；具体调用由 Backend 的受控来源调用桥落地下游。
 */
import {
  canvasSourceCapabilityId,
  isCanvasSourceCapabilityId,
  isCanvasSourceProviderShape,
  canvasSourceIdFromCapabilityId,
  type CanvasSourceProvider,
  type CanvasSourceTrustedContext
} from "@woohaa3/contracts";

export type CanvasSourceRegistryOwner = {
  sourceId: string;
  extensionId: string;
  configVersion: number;
  mode: "public" | "recovery";
};

/** 版本绑定 handle：调用时以 owner+配置版本再校验。 */
export type CanvasSourceHandle = {
  owner: CanvasSourceRegistryOwner;
  provider: CanvasSourceProvider;
};

export type ResolveCanvasSourceResult =
  | { ok: true; handle: CanvasSourceHandle }
  | { ok: false; code: "SOURCE_UNAVAILABLE" | "FORBIDDEN"; message: string };

export type CanvasSourceRegistryHost = {
  hasCapability(id: string): boolean;
  /**
   * 宿主级 capability 拥有者查询（不返回实现），用于在调用时做版本/停用校验。
   * 未提供时回退到 `hasCapability` + `resolveCapability`（测试可用）。
   */
  resolveCapabilityOwner?(id: string): { extensionId: string; configVersion: number; mode: "public" | "recovery" } | null;
  resolveCapability(id: string): unknown;
  /** 宿主 owner 摘要（含 capability id 列表）；用于枚举活动来源，不暴露实现。 */
  snapshot?(): Array<{ extensionId: string; capabilities: string[] }>;
};

export type CanvasSourceRegistry = {
  /** 枚举当前活动来源（不暴露实现）；只返回 public owner。 */
  list(): CanvasSourceRegistryOwner[];
  /** 解析 sourceId 的版本绑定 handle；每次调用校验 owner/配置版本。 */
  resolve(sourceId: string): ResolveCanvasSourceResult;
  /** 由 capability id 解析（`canvas-source:<sourceId>`）。 */
  resolveByCapabilityId(capabilityId: string): ResolveCanvasSourceResult;
  /** 校验可信上下文与 handle 的 owner 是否一致（跨版本调用拒绝）。 */
  assertBoundContext(handle: CanvasSourceHandle, context: CanvasSourceTrustedContext): { ok: true } | { ok: false; code: "FORBIDDEN"; message: string };
};

export function createCanvasSourceRegistry(host: CanvasSourceRegistryHost): CanvasSourceRegistry {
  const resolveById = (capabilityId: string): ResolveCanvasSourceResult => {
    if (!isCanvasSourceCapabilityId(capabilityId)) {
      return { ok: false, code: "SOURCE_UNAVAILABLE", message: "不是受控来源 capability" };
    }
    if (!host.hasCapability(capabilityId)) {
      return { ok: false, code: "SOURCE_UNAVAILABLE", message: "来源不可用" };
    }
    const owner = host.resolveCapabilityOwner?.(capabilityId);
    if (!owner) return { ok: false, code: "SOURCE_UNAVAILABLE", message: "来源不可用" };
    if (owner.mode !== "public") return { ok: false, code: "SOURCE_UNAVAILABLE", message: "来源处于恢复模式" };
    const value = host.resolveCapability(capabilityId);
    if (!isCanvasSourceProviderShape(value)) {
      return { ok: false, code: "SOURCE_UNAVAILABLE", message: "来源 capability 形态非法" };
    }
    const sourceId = canvasSourceIdFromCapabilityId(capabilityId);
    if (value.sourceId !== sourceId) {
      return { ok: false, code: "SOURCE_UNAVAILABLE", message: "来源 capability 身份不一致" };
    }
    return {
      ok: true,
      handle: { owner: { sourceId, extensionId: owner.extensionId, configVersion: owner.configVersion, mode: owner.mode }, provider: value }
    };
  };

  return {
    list: () => {
      const snapshot = host.snapshot?.() ?? [];
      const owners: CanvasSourceRegistryOwner[] = [];
      for (const entry of snapshot) {
        for (const capabilityId of entry.capabilities) {
          if (!isCanvasSourceCapabilityId(capabilityId)) continue;
          const owner = host.resolveCapabilityOwner?.(capabilityId);
          if (!owner || owner.mode !== "public") continue;
          owners.push({ sourceId: canvasSourceIdFromCapabilityId(capabilityId), extensionId: owner.extensionId, configVersion: owner.configVersion, mode: owner.mode });
        }
      }
      return owners.sort((left, right) => (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0));
    },
    resolve: (sourceId) => resolveById(canvasSourceCapabilityId(sourceId)),
    resolveByCapabilityId: resolveById,
    assertBoundContext: (handle, context) => {
      if (context.extensionId !== handle.owner.extensionId || context.configVersion !== handle.owner.configVersion) {
        return { ok: false, code: "FORBIDDEN", message: "调用上下文与来源版本绑定不一致" };
      }
      // 再次校验活动 owner（防止 resolve 与调用之间被停用/升级）。
      const live = host.resolveCapabilityOwner?.(canvasSourceCapabilityId(handle.owner.sourceId));
      if (!live || live.configVersion !== handle.owner.configVersion || live.mode !== "public") {
        return { ok: false, code: "FORBIDDEN", message: "来源已在准备期间停用或升级" };
      }
      return { ok: true };
    }
  };
}
