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
   * 插件自报健康（缺省表示健康）。装载器在 fiber 运行期间用**当前**配置求值；未装载时返回 undefined。
   * 控制面在状态查询里同步调用，所以补上凭据后不用重启插件，状态就回到 active。
   */
  health?(): ApplicationBackendExtensionHealth | undefined;
};

export type SiteGate = {
  managed(extensionId: string): boolean;
  /** 装载器登记扩展；控制面的激活会等到登记后才执行。 */
  attach(extensionId: string, handle: SiteGateHandle): void;
  readonly definitions: readonly ApplicationBackendExtensionDefinition[];
};

export function createSiteGate(extensionIds: Iterable<string>): SiteGate {
  const handles = new Map<
    string,
    { promise: Promise<SiteGateHandle>; resolve: (handle: SiteGateHandle) => void; current?: SiteGateHandle }
  >();
  for (const id of extensionIds) {
    let resolve!: (handle: SiteGateHandle) => void;
    const promise = new Promise<SiteGateHandle>((done) => {
      resolve = done;
    });
    handles.set(id, { promise, resolve });
  }
  return {
    managed: (extensionId) => handles.has(extensionId),
    attach(extensionId, handle) {
      const entry = handles.get(extensionId);
      if (!entry) return;
      entry.current = handle;
      entry.resolve(handle);
    },
    definitions: [...handles].map(([extensionId, entry]) => ({
      extensionId,
      async activate() {
        const handle = await entry.promise;
        await handle.acquire();
        return { dispose: () => handle.release() };
      },
      // 未装载（配置中/已停用）时状态投影自己会给出 configuring/disabled，这里没有额外健康信息。
      health: () => entry.current?.health?.()
    }))
  };
}
