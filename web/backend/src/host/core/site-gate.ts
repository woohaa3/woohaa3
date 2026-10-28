/**
 * 插件管理里的站点启停开关 → 插件树扩展层。
 *
 * 本次装配的扩展层 Cordis 插件（声明了 `site` 元数据的站点插件，以及声明了 `hostPlugin`
 * 的 Provider / 存储后端）在站点插件宿主上只有一个占位定义：控制面激活它时让装载器启动对应的
 * Cordis 插件，停用时卸载。这样开关、`actualState`（前端 `server-active` 插件跟随它）与插件树里
 * 实际装载的东西是同一件事。停用是运行中生效的，不依赖目录改名或进程重启
 * （change: 2026-10-19-restore-runtime-extension-toggling）。
 *
 * 定义还带上插件的**健康钩子**：activation 成功只说明装载完成，插件可能「装着但用不了」（生成
 * Provider 没配 API Key）。控制面据此把状态投影成 `degraded`，而不是笼统的「运行中」。
 */
import type { ApplicationBackendExtensionDefinition, ApplicationBackendExtensionHealth } from "@woohaa3/contracts";

export type SiteGateHandle = {
  acquire(): Promise<void>;
  release(): Promise<void>;
  /**
   * 该扩展的受控 HTTP 路由注册面（`ctx.webServer`）。
   *
   * 装载器把它注入到扩展的 Cordis Context：路由按 extensionId 命名空间隔离，前缀由宿主添加。
   * 没有 gateway 的最小装配里为 undefined，插件据此判断能力是否可用。
   */
  webServer?: import("@woohaa3/contracts").HostWebServerService;
  /**
   * 插件自报健康（缺省表示健康）。装载器在 fiber 运行期间用**当前**配置求值；未装载时返回 undefined。
   * 控制面在状态查询里同步调用，所以补上凭据后不用重启插件，状态就回到 active。
   */
  health?(): ApplicationBackendExtensionHealth | undefined;
};

export type SiteGate = {
  managed(extensionId: string): boolean;
  /** 已 attach 的 handle（未 attach 返回 undefined）；装载器用它取 `webServer` 等扩展专属能力。 */
  handle(extensionId: string): SiteGateHandle | undefined;
  /** 装载器登记扩展；控制面的激活会等到登记后才执行。 */
  attach(extensionId: string, handle: SiteGateHandle): void;
  /** 启动期定义（构造时的扩展集合）。运行期 add 的定义不在这里，由 `add` 返回。 */
  readonly definitions: readonly ApplicationBackendExtensionDefinition[];
  /**
   * 运行期登记（change: 2026-10-21-isolate-extension-host-process；首次安装的受管后端扩展）：之后装载器按
   * `managed(id)` 走 gated 分支并 attach。已登记时返回原定义（幂等）。
   */
  add(extensionId: string): ApplicationBackendExtensionDefinition;
  /**
   * 运行期移除：之后的 activate 以 `extension-unavailable` 拒绝，等待中的 activate 同样拒绝；`managed(id)` 变为 false。
   * 已激活的实例由控制面先释放（removeExtension），这里不再调 release。未登记时为 no-op。
   */
  remove(extensionId: string): void;
};

type GateEntry = {
  promise: Promise<SiteGateHandle>;
  resolve: (handle: SiteGateHandle) => void;
  reject: (error: Error) => void;
  current?: SiteGateHandle;
  removed: boolean;
  definition: ApplicationBackendExtensionDefinition;
};

function unavailable(extensionId: string): Error {
  return Object.assign(new Error(`扩展 ${extensionId} 已移除`), { code: "extension-unavailable" });
}

function createEntry(extensionId: string): GateEntry {
  let resolve!: (handle: SiteGateHandle) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SiteGateHandle>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  // 未被 activate 等待时 remove 产生的拒绝不能变成未处理拒绝。
  promise.catch(() => undefined);
  const entry: GateEntry = {
    promise,
    resolve,
    reject,
    removed: false,
    definition: {
      extensionId,
      async activate() {
        if (entry.removed) throw unavailable(extensionId);
        const handle = await entry.promise;
        if (entry.removed) throw unavailable(extensionId);
        await handle.acquire();
        return { dispose: () => handle.release() };
      },
      // 未装载（配置中/已停用）时状态投影自己会给出 configuring/disabled，这里没有额外健康信息。
      health: () => (entry.removed ? undefined : entry.current?.health?.())
    }
  };
  return entry;
}

export function createSiteGate(extensionIds: Iterable<string>): SiteGate {
  const handles = new Map<string, GateEntry>();
  for (const id of extensionIds) handles.set(id, createEntry(id));
  return {
    managed: (extensionId) => handles.has(extensionId),
    handle: (extensionId) => handles.get(extensionId)?.current,
    attach(extensionId, handle) {
      const entry = handles.get(extensionId);
      if (!entry) return;
      entry.current = handle;
      entry.resolve(handle);
    },
    definitions: [...handles.values()].map((entry) => entry.definition),
    add(extensionId) {
      const existing = handles.get(extensionId);
      if (existing) return existing.definition;
      const entry = createEntry(extensionId);
      handles.set(extensionId, entry);
      return entry.definition;
    },
    remove(extensionId) {
      const entry = handles.get(extensionId);
      if (!entry) return;
      entry.removed = true;
      delete entry.current;
      entry.reject(unavailable(extensionId));
      handles.delete(extensionId);
    }
  };
}
