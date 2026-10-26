/**
 * 核心层 · marketplace：`ctx.marketplace` 扩展点（change: 2026-10-21-add-extension-marketplace-point，D1/D3）。
 *
 * 形状照 `ctx.generation` 的 fan-in 注册表：多个来源并存，没有 primary。来源只负责「拿到字节」，
 * 校验与提交都在 Extension Manager。核心自带的本地文件来源（`local-file`）由 Manager 注册。
 *
 * 信任边界（D3）：提供来源的插件只能来自内置根。装配期由扩展宿主拒绝在受管根 / 可写根里声明
 * `marketplace-source`；这里再做一次**运行期**断言——调用方插件对象带宿主盖章的 `origin`，受管或
 * 可写根来源直接抛错。宿主不按扩展 ID 分支，只看 origin。
 */
import type { HostMarketplaceService, MarketplaceSource } from "@woohaa3/contracts";
import type { HostPlugin } from "../context.js";

/** 扩展宿主给插件对象盖的来源章（`scripts/lib/extension-host.mjs` 的 `createHostPlugins`）。 */
export type HostPluginOrigin = { readonly managed: boolean; readonly rootWritable: boolean };

export class MarketplaceSourceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MarketplaceSourceError";
    this.code = code;
  }
}

const SOURCE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function assertSourceShape(source: MarketplaceSource): void {
  if (!source || typeof source !== "object") throw new MarketplaceSourceError("MARKETPLACE_SOURCE_INVALID", "市场来源必须是对象");
  if (typeof source.sourceId !== "string" || !SOURCE_ID.test(source.sourceId)) {
    throw new MarketplaceSourceError("MARKETPLACE_SOURCE_INVALID", `市场来源 sourceId 非法：${String(source.sourceId)}`);
  }
  for (const method of ["available", "search", "resolve", "download"] as const) {
    if (typeof source[method] !== "function") {
      throw new MarketplaceSourceError("MARKETPLACE_SOURCE_INVALID", `市场来源 ${source.sourceId} 缺少 ${method}()`);
    }
  }
}

/**
 * 运行期来源断言（扩展层插件经 `scoped(origin)` 拿到的视图）：受管根 / 可写根插件不得注册来源；
 * **缺少宿主盖章的 origin 也拒绝**——来源插件必须是扩展宿主从内置根装配的，不能靠缺省放行。
 * 核心自己注册（本地文件来源）走未限定的注册表，不经这里。
 */
export function assertTrustedSourceOrigin(origin: HostPluginOrigin | undefined, sourceId: string): void {
  if (!origin) {
    throw new MarketplaceSourceError(
      "EXTENSION_MARKETPLACE_SOURCE_UNTRUSTED_ROOT",
      `市场来源 ${sourceId} 的插件缺少宿主来源标记：来源插件只能由扩展宿主从内置根装配`
    );
  }
  if (origin.managed || origin.rootWritable) {
    throw new MarketplaceSourceError(
      "EXTENSION_MARKETPLACE_SOURCE_UNTRUSTED_ROOT",
      `市场来源 ${sourceId} 来自${origin.managed ? "受管根" : "可写根"}：来源插件只能来自内置根`
    );
  }
}

export type MarketplaceRegistry = HostMarketplaceService & {
  /** 给某个扩展层插件的受限视图：注册时附带它的 origin 断言。 */
  scoped(origin: HostPluginOrigin | undefined): HostMarketplaceService;
};

export function createMarketplaceRegistry(options: { logger?: (event: Record<string, unknown>) => void } = {}): MarketplaceRegistry {
  const log = options.logger ?? (() => undefined);
  const sources = new Map<string, MarketplaceSource>();
  const unregister = (sourceId: string) => {
    if (sources.delete(sourceId)) log({ event: "marketplace-source-unregistered", sourceId });
  };
  const register = (source: MarketplaceSource, scope: { origin: HostPluginOrigin | undefined } | null) => {
    assertSourceShape(source);
    if (scope) assertTrustedSourceOrigin(scope.origin, source.sourceId);
    if (sources.has(source.sourceId)) {
      throw new MarketplaceSourceError("MARKETPLACE_SOURCE_DUPLICATE", `市场来源已注册：${source.sourceId}`);
    }
    sources.set(source.sourceId, source);
    log({ event: "marketplace-source-registered", sourceId: source.sourceId });
    return () => {
      if (sources.get(source.sourceId) === source) unregister(source.sourceId);
    };
  };
  const view = (scope: { origin: HostPluginOrigin | undefined } | null): HostMarketplaceService => ({
    register: (source) => register(source, scope),
    unregister,
    list: () => [...sources.values()],
    resolve: (sourceId) => sources.get(sourceId)
  });
  // 未限定视图只给核心层（Extension Manager 注册本地文件来源）；扩展层插件一律经 scoped。
  return { ...view(null), scoped: (origin) => view({ origin }) };
}

/** 核心层插件：提供 `ctx.marketplace`。不登记路由（安装 API 在 Extension Manager）。 */
export const marketplacePlugin: HostPlugin = {
  name: "marketplace",
  inject: ["log"],
  apply(ctx) {
    ctx.provide("marketplace", createMarketplaceRegistry({ logger: ctx.log.scope("marketplace") }));
  }
};
