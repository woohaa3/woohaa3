/**
 * `ctx.marketplace` 与市场来源扩展点契约
 * （change: 2026-10-21-add-extension-marketplace-point，design D1/D2/D11；
 *  change: 2026-10-21-add-server-extension-marketplace，D6）。
 *
 * 服务契约在这里**定义**，它由核心的 Extension Manager 实现；来源只回答「从哪里拿到字节」——
 * 校验、暂存、预检、提交与重载都在核心，来源返回的任何「已验证」信息都不被信任。
 *
 * 形状照 `ctx.generation` 的 fan-in 注册表：多个来源同时可用，搜索合并全部可用来源，安装时由
 * 调用方指定 `sourceId`；**没有** primary 选择。
 *
 * 提供来源的插件只能来自内置根（design D3）：受管根 / 可写根里的扩展注册来源会被宿主拒绝。
 */

/** 扩展声明的运行环境要求（`extension.json` 的 `engines`）。 */
export type ExtensionEngines = {
  /** 宿主后端 SDK ABI 的 semver range。 */
  readonly hostAbi: string;
  /** 浏览器 SDK ABI 的 semver range，与 browser artifact manifest 的 `sdkAbi` 对齐。 */
  readonly sdkAbi: string;
  readonly protocolVersion: number;
};

/** 来源解析出的一个可安装版本。字段即后续 woohaa-server proto `ResolveRelease` 需要的最小集合。 */
export type ReleaseRef = {
  readonly sourceId: string;
  readonly extensionId: string;
  readonly version: string;
  readonly engines: ExtensionEngines;
  /** `sha256:<hex>`：整个 `.wxt` 包的摘要。来源的声明，下载后由 Manager 复核。 */
  readonly packageDigest: string;
  readonly size: number;
  /** extensionId → semver range。 */
  readonly dependencies?: Readonly<Record<string, string>>;
};

export type MarketplaceListing = {
  readonly extensionId: string;
  readonly label: string;
  readonly description?: string;
  readonly latest: string;
  readonly icon?: string;
};

export type MarketplaceSearchQuery = { readonly text?: string; readonly cursor?: string; readonly limit?: number };
export type MarketplaceSearchPage = { readonly items: readonly MarketplaceListing[]; readonly nextCursor?: string };
export type MarketplaceAvailability = { readonly ok: true } | { readonly ok: false; readonly reason: string };
export type MarketplaceDownload = { readonly stream: ReadableStream<Uint8Array>; readonly size: number };

/** 一个市场来源。由内置根扩展在 `apply` 里经 `ctx.marketplace.register` 注册（放进 `ctx.effect`）。 */
export type MarketplaceSource = {
  readonly sourceId: string;
  readonly label: string;
  available(): MarketplaceAvailability;
  search(query: MarketplaceSearchQuery, signal: AbortSignal): Promise<MarketplaceSearchPage>;
  /** 按 semver range 解析一个版本；没有匹配返回 `null`。 */
  resolve(extensionId: string, range: string, signal: AbortSignal): Promise<ReleaseRef | null>;
  download(ref: ReleaseRef, signal: AbortSignal): Promise<MarketplaceDownload>;
};

/** `ctx.marketplace`：市场来源注册面。 */
export type HostMarketplaceService = {
  /** 注册来源；重复 `sourceId` 抛错。返回注销函数。 */
  register(source: MarketplaceSource): () => void;
  unregister(sourceId: string): void;
  list(): readonly MarketplaceSource[];
  resolve(sourceId: string): MarketplaceSource | undefined;
};
