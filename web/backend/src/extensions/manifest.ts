/** 扩展定义、元数据和公开路由来自启动期目录扫描；宿主不静态装配业务扩展。 */
import type {
  AnyHostExtensionPlugin,
  ApplicationBackendExtensionDefinition,
  ApplicationExtensionMetadata,
  ApplicationExtensionPublicRouteMapping,
  BootstrapExtension
} from "@woohaa3/contracts";
import type { RuntimeStorageProvider } from "./slot-contract.js";

/**
 * 启动期宿主：由进程入口（`scripts/start-release.mjs` / `serve-web.mjs` / `dev-orchestrator.mjs`
 * 或本机 `server.ts`）扫描并加载后注入。实现见 `scripts/lib/extension-host.mjs`。
 *
 * 后端消费它的槽位发现（`slotEntries` / `createSlotDeclarations`）、扩展元数据与公开路由、
 * 以及扩展层 Cordis 插件（`createHostPlugins`）。
 */
export type LoadedExtensionHost = {
  /**
   * 安全模式（change: 2026-10-21-harden-extension-fault-isolation，D7）：`null`/缺省表示正常启动；
   * 否则 `suspended` 是本次扫描跳过装配的扩展（可写根扩展与非 required、非 bootstrap 扩展）。
   */
  safeMode?: { suspended: readonly string[] } | null;
  /**
   * 扩展目录的安装/卸载：`list()` 给出本次启动扫描到的已安装扩展（展示用），
   * `setInstalled` 只改目录名，下一次启动才影响装配。**不参与启停**——启停由站点控制面
   * 的 `desiredEnabled` 在运行中生效（change: 2026-10-19-restore-runtime-extension-toggling）。
   */
  directoryControl?: {
    list(): import("@woohaa3/contracts").InstalledExtensionView[];
    setInstalled(id: string, installed: boolean): void;
  };
  /** 宿主注入依赖后构造后端定义（已加载模块，未调用工厂前的解析失败会在启动期抛出）。 */
  createDefinitions: (
    optionsByExtensionId: Record<string, unknown>,
    options?: { excludeHostPlugins?: boolean }
  ) => Promise<readonly ApplicationBackendExtensionDefinition[]>;
  /**
   * 已启用扩展的槽位实现入口：已解析模块位置与导出名，**尚未调用工厂**。
   */
  slotEntries?: readonly {
    extensionId: string;
    directory: string;
    root: string;
    rootWritable: boolean;
    export: string;
  }[];
  /**
   * 调用槽位声明工厂并校验形状（extensionId 一致、slot ∈ {storage,identity,access}）。
   * 返回的声明交给 `bootstrapProviders` 做「每槽位恰好一个 / 依赖存在 / 无环」校验。
   */
  createSlotDeclarations?: (
    optionsByExtensionId: Record<string, unknown>,
    env?: Record<string, string | undefined>
  ) => Promise<readonly BootstrapExtension<RuntimeStorageProvider>[]>;
  /**
   * 画布内容扩展端口（预览/历史帧）：由 `canvasContent` 声明的工厂加载，核心层注入 canvas-service。
   * 宿主不认识具体内容领域；未声明时为空数组（画布回落为功能不可用）。
   */
  createCanvasContent?: (
    optionsByExtensionId: Record<string, unknown>
  ) => Promise<readonly { extensionId: string; runtime: import("@woohaa3/contracts").CanvasContentRuntime }[]>;
  /** provider metadata + 站点目录条目。 */
  metadata: readonly ApplicationExtensionMetadata[];
  /** 固定公开路径映射。 */
  publicRoutes: readonly ApplicationExtensionPublicRouteMapping[];
  /**
   * 扩展层 Cordis 插件（Provider / 存储后端）：由扩展目录里的 `extension.json` `hostPlugin` 声明
   * 驱动，宿主只负责按声明加载。宿主不再维护逐插件的手写注册表。
   */
  createHostPlugins?: (optionsByExtensionId?: Record<string, unknown>) => Promise<{
    provider: readonly AnyHostExtensionPlugin[];
    storage: readonly AnyHostExtensionPlugin[];
  }>;
  /** 站点控制面 scope 的 extensionId（runtime 只装配非站点入口）。 */
  siteExtensionIds: readonly string[];
  /** 受管安装根（change: 2026-10-21-add-extension-marketplace-point，D7）；Extension Manager 据此定位。 */
  managedRoot?: string;
  /**
   * 内置根里可参与市场升级比较的扩展（即使某个 id 已被更高的受管版本覆盖也保留）。
   * 版本是分发版本（extension.json.version / package.json.version），与 .wxt 包版本同口径。
   */
  builtinExtensions?: readonly {
    extensionId: string;
    version: string;
    directory: string;
    requiresBackend: boolean;
    hotSwappable: boolean;
  }[];
  /**
   * 扫描到并装配的扩展注册记录（只读）：宿主据 `managed` / `rootWritable` 判断扩展来源
   * （change: 2026-10-21-add-server-extension-marketplace，D6 的站点扩展来源断言）。
   */
  registrations?: readonly { extensionId: string; managed?: boolean; rootWritable?: boolean }[];
  /** 运行期发布目录：内容寻址 releaseId 与 href。缺省表示不托管发布目录；读取方每次取当前值。 */
  browserRelease?: { releaseId: string; href: string };
  /**
   * 运行期重算发布目录（change: 2026-10-21-add-extension-marketplace-point，任务 6.1 / design D8）：
   * `upsert` 按 extensionId 新增/替换（`directory` 为含 `browser-dist/` 的版本目录），`remove` 删除条目。
   * 新目录校验失败时抛错且当前 release 不变；同内容重放返回 `changed: false`。
   */
  publishBrowserRelease?: (change: {
    upsert?: ReadonlyArray<{ extensionId: string; directory: string }>;
    remove?: readonly string[];
  }) => Promise<{ releaseId: string; href: string; changed: boolean }>;
  /** 订阅发布目录切换；返回退订函数。 */
  onBrowserReleaseChange?: (listener: (release: { releaseId: string; href: string }) => void) => () => void;
  /**
   * 托管 `/extension-releases/<releaseId>.json`、`/extension-releases/current.json` 与
   * `/extensions/<id>/<artifactId>/...`；返回 `true` 表示已写响应。
   */
  handleReleaseRequest?: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => boolean;
};

export type BackendExtensionManifest = {
  definitions: ApplicationBackendExtensionDefinition[];
  /** 站点插件可信元数据（含 ChatGPT 个人授权与生成），来自扩展目录扫描。 */
  metadata: readonly ApplicationExtensionMetadata[];
  /** 扩展声明的固定公开路径映射（各扩展 `extension.json` 的 `publicRoutes`）。 */
  publicRoutes: readonly ApplicationExtensionPublicRouteMapping[];
};

/**
 * 组装后端插件清单。
 *
 * `host` 为启动期扩展宿主；缺省（嵌入式/无宿主）时扩展元数据与公开路由为空——此时只使用显式注入的定义。生产与测试都经 `createBackendService` 注入宿主，缺省分支只服务
 * 不扫描扩展目录的受控用法。
 */
export function createBackendExtensionManifest(
  extra: readonly ApplicationBackendExtensionDefinition[] = [],
  host?: LoadedExtensionHost
): BackendExtensionManifest {
  const definitions = [...extra];
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.extensionId)) throw new Error(`后端插件清单含重复 extensionId：${definition.extensionId}`);
    seen.add(definition.extensionId);
  }
  return {
    definitions,
    metadata: host ? [...host.metadata] : [],
    publicRoutes: host ? [...host.publicRoutes] : []
  };
}
