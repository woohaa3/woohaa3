/**
 * Extension Host 宿主服务（change: 2026-10-21-isolate-extension-host-process，D1/D7/D10）：
 * 按启动扫描得到的 isolated 描述，为每个受管后端扩展装配「控制器 + supervisor + swapper + 代理插件」，
 * 并以 `ctx.extensionHostIsolation` 对 Extension Manager（蓝绿切换 / 卸载 / 观察期回滚）和
 * 安装 API（解除隔离）提供统一入口。
 *
 * 首次安装的扩展在本次进程里没有代理插件（配置段、站点门禁都在启动时登记），因此仍需重启才装配；
 * 升级、回滚、解除隔离都不重启。
 */
import type { AnyHostExtensionPlugin, HostGenerationService, HostStorageService } from "@woohaa3/contracts";
import { createIsolatedController, type IsolatedController } from "./controller.js";
import { capabilitiesFor, type IsolatedPluginDescriptor } from "./descriptor.js";
import { createGatewayForwarder, type GatewayForwarder } from "./gateway-forward.js";
import type { ExtensionHostManager, InstanceExit } from "./manager.js";
import { createProxyPlugin } from "./proxy-plugin.js";
import { createExtensionSupervisor, type ExtensionSupervisor, type SupervisorSnapshot } from "./supervisor.js";
import { createExtensionSwapper, type ExtensionSwapper } from "./swap.js";

export type IsolatedExtensionView = {
  extensionId: string;
  pid: number | null;
  directory: string;
  supervisor: SupervisorSnapshot;
};

export type ExtensionHostIsolationService = {
  /** 受管扩展是否以子进程方式运行（本机设置 `extensions.host.isolation` + 启动扫描）。 */
  enabled(): boolean;
  /** 该扩展是否有隔离控制器（首次安装、本次进程未装配的为 false）。 */
  isolated(extensionId: string): boolean;
  /**
   * 蓝绿切换到新版本目录。`swapped: false` 表示同版本 no-op。没有活跃实例（停用 / 隔离）时只改指下一次
   * 激活的目录（同样返回 `swapped: true`）。失败抛 `MARKETPLACE_SWAP_FAILED`：绿已清理，蓝不动。
   * 未装配的扩展抛 `MARKETPLACE_NOT_INSTALLED`。
   */
  swap(extensionId: string, nextDirectory: string): Promise<{ swapped: boolean }>;
  /** 卸载：停止子进程、撤镜像、停止 supervisor（幂等）。 */
  remove(extensionId: string): Promise<void>;
  /** 管理员解除隔离（crash-loop）：清空崩溃窗口并重新激活（经站点控制面）。未隔离时为 no-op。 */
  unquarantine(extensionId: string, actor?: string): Promise<{ unquarantined: boolean }>;
  views(): readonly IsolatedExtensionView[];
  view(extensionId: string): IsolatedExtensionView | undefined;
  /** 运行期装配新的受管后端扩展（首次安装热装）；见 ExtensionHostService.add。 */
  add(descriptor: IsolatedPluginDescriptor): { plugin: AnyHostExtensionPlugin; order: number };
};

export type ExtensionHostServiceOptions = {
  descriptors: readonly IsolatedPluginDescriptor[];
  manager: ExtensionHostManager;
  generation: HostGenerationService;
  storage?: HostStorageService;
  log: (event: Record<string, unknown>) => void;
  activationTimeoutMs: () => number;
  disposeTimeoutMs: () => number;
  drainTimeoutMs: () => number;
  /** gateway 鉴权（与宿主统一执行边界一致）。 */
  authenticate?: Parameters<typeof createGatewayForwarder>[0]["authenticate"];
  assertAction?: Parameters<typeof createGatewayForwarder>[0]["assertAction"];
  /** 观察期内崩溃交给 Extension Manager（有上一版本时回滚）；后绑定。 */
  onObservationCrash?: () => ((extensionId: string, exit: InstanceExit) => Promise<boolean> | boolean) | undefined;
  /** 运行期 add 的扩展把 gateway 转发处理器挂到宿主（返回撤销函数）；缺省不挂。 */
  mountRoute?: (entry: IsolatedPluginEntry) => () => void;
  /** 站点控制面隔离投影（后绑定）。 */
  onQuarantine?: (extensionId: string, diagnostic: { code: "crash-loop"; message: string }) => void | Promise<unknown>;
  onUnquarantine?: (extensionId: string, actor: string) => void | Promise<unknown>;
};

type Entry = {
  controller: IsolatedController;
  supervisor: ExtensionSupervisor;
  swapper: ExtensionSwapper;
  forwarder: GatewayForwarder;
  plugin: AnyHostExtensionPlugin;
  removed: boolean;
  /** 运行期 add 时挂上的 gateway 路由（启动期的由 mountRoutes 统一管理）。 */
  unmount?: () => void;
};

export type IsolatedPluginEntry = { plugin: AnyHostExtensionPlugin; forwarder: GatewayForwarder; order: number };

export type ExtensionHostService = ExtensionHostIsolationService & {
  /** 进入扩展层的代理插件（按描述 order 排好）。 */
  plugins(): readonly IsolatedPluginEntry[];
  /**
   * 运行期装配一个新 isolated 描述（首次安装热装，任务 8.4）：控制器 + supervisor + swapper + gateway 转发
   * + 代理插件；转发处理器经 `mountRoute` 挂到宿主 gateway。同 id 已存在抛 `extension-exists`。
   * 之后 `isolated(id)` 为 true，升级走 swap。代理插件由调用方交给扩展层装载器。
   */
  add(descriptor: IsolatedPluginDescriptor): { plugin: AnyHostExtensionPlugin; order: number };
  stopAll(): Promise<void>;
};

function managerError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function createExtensionHostService(options: ExtensionHostServiceOptions): ExtensionHostService {
  const entries = new Map<string, Entry>();
  const build = (descriptor: IsolatedPluginDescriptor): Entry => {
    let controller!: IsolatedController;
    let supervisor!: ExtensionSupervisor;
    const forwarder = createGatewayForwarder({
      extensionId: descriptor.extensionId,
      target: () => controller.target(),
      reservedPrefixes: capabilitiesFor(descriptor).routePrefixes,
      ...(options.authenticate ? { authenticate: options.authenticate } : {}),
      ...(options.assertAction ? { assertAction: options.assertAction } : {}),
      log: options.log
    });
    controller = createIsolatedController({
      descriptor,
      manager: options.manager,
      generation: options.generation,
      forwarder,
      ...(options.storage ? { storage: options.storage } : {}),
      log: options.log,
      activationTimeoutMs: options.activationTimeoutMs,
      disposeTimeoutMs: options.disposeTimeoutMs,
      onCrash: (exit) => {
        if (!entries.get(descriptor.extensionId)?.removed) supervisor.handleCrash(exit);
      }
    });
    supervisor = createExtensionSupervisor({
      controller,
      log: options.log,
      onObservationCrash: (extensionId, exit) => options.onObservationCrash?.()?.(extensionId, exit) ?? false,
      ...(options.onQuarantine ? { onQuarantine: options.onQuarantine } : {}),
      ...(options.onUnquarantine ? { onUnquarantine: options.onUnquarantine } : {})
    });
    const swapper = createExtensionSwapper({
      controller,
      log: options.log,
      drainTimeoutMs: options.drainTimeoutMs,
      // 换版本即清空崩溃窗口、解除隔离（D7 解除方式 a）；reset 按是否有活跃实例给出 running / idle。
      onSwapped: () => supervisor.reset()
    });
    const base = createProxyPlugin({ controller, quarantined: () => supervisor.quarantined() });
    // 包一层，把激活 / 停用告诉 supervisor（稳定计时、取消待重启）。
    const plugin: AnyHostExtensionPlugin = {
      ...base,
      async apply(ctx, values) {
        try {
          await base.apply(ctx, values);
        } catch (error) {
          // 激活途中子进程死亡（激活即崩溃）也是一次崩溃：计入窗口并退避重启，满阈值进入隔离（D7）。
          // 激活被拒（已隔离）、协议不兼容等确定性失败不重试。
          const code = (error as { code?: unknown })?.code;
          if (code === "extension-crashed" || code === "activation-timeout") {
            supervisor.handleCrash({ instanceId: "activation", reason: "exit", exitCode: null, signal: null, message: String(code) });
          }
          throw error;
        }
        supervisor.handleActivated();
        ctx.effect(() => () => supervisor.handleDeactivated());
      }
    };
    return { controller, supervisor, swapper, forwarder, plugin, removed: false };
  };
  for (const descriptor of options.descriptors) entries.set(descriptor.extensionId, build(descriptor));
  const orderOf = (entry: Entry) => entry.controller.descriptor.order ?? 900;

  const require = (extensionId: string): Entry => {
    const entry = entries.get(extensionId);
    if (!entry || entry.removed) throw managerError("MARKETPLACE_NOT_INSTALLED", `扩展 ${extensionId} 不是本次装配的受管隔离扩展`);
    return entry;
  };
  const viewOf = (entry: Entry): IsolatedExtensionView => ({
    extensionId: entry.controller.extensionId,
    pid: entry.controller.active()?.instance.pid ?? null,
    directory: entry.controller.directory(),
    supervisor: entry.supervisor.snapshot()
  });

  return {
    enabled: () => true,
    isolated: (extensionId) => entries.has(extensionId) && !entries.get(extensionId)!.removed,
    async swap(extensionId, nextDirectory) {
      const entry = require(extensionId);
      const result = await entry.swapper.swap(nextDirectory);
      if (entry.controller.active()) entry.supervisor.handleActivated();
      return { swapped: result.outcome !== "noop" };
    },
    async remove(extensionId) {
      const entry = entries.get(extensionId);
      if (!entry || entry.removed) return;
      entry.removed = true;
      entry.supervisor.dispose();
      await entry.controller.deactivate();
      entry.unmount?.();
      // 运行期装配的条目可被同 id 重新 add（卸载后再装）；启动期条目保留占位，路由仍回 503。
      if (entry.unmount) entries.delete(extensionId);
    },
    add(descriptor) {
      const existing = entries.get(descriptor.extensionId);
      if (existing && !existing.removed) throw managerError("extension-exists", `扩展 ${descriptor.extensionId} 已装配`);
      const entry = build(descriptor);
      entries.set(descriptor.extensionId, entry);
      const order = orderOf(entry);
      entry.unmount = options.mountRoute?.({ plugin: entry.plugin, forwarder: entry.forwarder, order }) ?? (() => undefined);
      return { plugin: entry.plugin, order };
    },
    async unquarantine(extensionId, actor) {
      const entry = require(extensionId);
      if (!entry.supervisor.quarantined()) return { unquarantined: false };
      await entry.supervisor.unquarantine(actor);
      return { unquarantined: true };
    },
    views: () => [...entries.values()].filter((entry) => !entry.removed).map(viewOf),
    view: (extensionId) => {
      const entry = entries.get(extensionId);
      return entry && !entry.removed ? viewOf(entry) : undefined;
    },
    plugins: () =>
      [...entries.values()]
        .map((entry) => ({ plugin: entry.plugin, forwarder: entry.forwarder, order: orderOf(entry) }))
        .sort((a, b) => a.order - b.order),
    async stopAll() {
      for (const entry of entries.values()) entry.supervisor.dispose();
      await options.manager.stopAll(options.disposeTimeoutMs());
    }
  };
}
