/**
 * 单个受管扩展的隔离控制器（change: 2026-10-21-isolate-extension-host-process，D1/D6/D7/D10）。
 *
 * 持有「当前活跃实例」与它在宿主的镜像（Provider 桩、gateway 路由表），对外给三类调用方：
 * - 代理插件（任务 4.2）：`activate(values)` / `deactivate()`；
 * - supervisor（任务 7）：实例崩溃时 `detach` 镜像、按退避 `activate` 重启；
 * - swap（任务 8）：`prepare(directory)` 起绿 → `commit(green)` 原子切换 → 返回蓝供排空。
 *
 * 镜像规则：Provider 桩与路由的目标端点都经 `target()` 现取活跃实例；切换时在一个同步块里
 * register 绿（同 providerId 由 generation 注册表替换）→ 撤蓝独有的 providerId → 替换路由表。
 */
import type { ExtensionHostHealthSnapshot, ExtensionHostProviderRegistration, GenerationProvider, HostGenerationService, HostStorageService } from "@woohaa3/contracts";
import type { RpcEndpoint } from "../rpc/index.js";
import { RpcError } from "../rpc/index.js";
import { bindInstance, type InstanceBinding } from "./binding.js";
import { capabilitiesFor, type IsolatedPluginDescriptor } from "./descriptor.js";
import type { GatewayForwarder } from "./gateway-forward.js";
import type { ExtensionHostInstance, ExtensionHostManager, InstanceExit } from "./manager.js";
import { createProviderStub } from "./provider-stub.js";

export type ActiveInstance = {
  readonly instance: ExtensionHostInstance;
  readonly binding: InstanceBinding;
  readonly directory: string;
};

export type IsolatedControllerOptions = {
  descriptor: IsolatedPluginDescriptor;
  manager: ExtensionHostManager;
  generation: HostGenerationService;
  forwarder: GatewayForwarder;
  storage?: HostStorageService;
  log: (event: Record<string, unknown>) => void;
  /** 激活（hello → ready → 首次健康）时限。 */
  activationTimeoutMs: () => number;
  /** 停止时限（到期 SIGKILL）。 */
  disposeTimeoutMs: () => number;
  /** 生成执行类调用超时（取模型 taskTimeoutMs）。 */
  executionTimeoutMs?: (modelType: string, modelId: string) => number | undefined;
  /** 实例意外结束（崩溃）的观察者：supervisor 订阅。只对**当前活跃**实例触发。 */
  onCrash?: (exit: InstanceExit, active: ActiveInstance) => void;
};

export type IsolatedController = {
  readonly extensionId: string;
  readonly descriptor: IsolatedPluginDescriptor;
  /** 当前活跃实例（无则 null）。 */
  active(): ActiveInstance | null;
  /** 当前目标端点（桩与路由现取）。 */
  target(): RpcEndpoint | null;
  /** 最近一次健康上报（代理插件 `health()` 同步读取）。 */
  health(): ExtensionHostHealthSnapshot | undefined;
  /** 当前配置值（重启 / 切换时复用）。 */
  values(): Record<string, unknown>;
  /** 当前版本目录（崩溃重启复用；切换后更新）。 */
  directory(): string;
  /** 没有活跃实例时改指下一次激活用的版本目录（升级到停用中的扩展）。 */
  retarget(directory: string): void;
  /**
   * 站点门禁是否希望它运行（apply 之后、deactivate 之前为 true）。崩溃不改变它：崩溃后没有活跃实例，
   * 但仍「应当运行」，换版本（观察期回滚）时要直接激活新目录，而不是只改指向。
   */
  wanted(): boolean;
  /** 起一个实例并等它就绪；成功后成为活跃实例并镜像注册。已有活跃实例时先停掉。 */
  activate(values: Record<string, unknown>, directory?: string): Promise<void>;
  /** 停止活跃实例并撤销镜像。 */
  deactivate(): Promise<void>;
  /** 起一个**候选**实例（不镜像）：就绪且首次健康不是 failed 才 resolve。 */
  prepare(directory: string): Promise<ActiveInstance>;
  /** 同步、原子地把候选切成活跃；返回被替换下来的旧实例（调用方负责排空与停止）。 */
  commit(candidate: ActiveInstance): ActiveInstance | null;
  /** 停止一个非活跃实例（候选失败 / 排空完成）。 */
  stopInstance(target: ActiveInstance): Promise<void>;
  /** 崩溃后撤镜像（幂等）：Provider 立即撤注册、路由清空 → 503。 */
  detach(): void;
};

export function createIsolatedController(options: IsolatedControllerOptions): IsolatedController {
  const { descriptor, manager, generation, forwarder } = options;
  const extensionId = descriptor.extensionId;
  const capabilities = capabilitiesFor(descriptor);
  let current: ActiveInstance | null = null;
  let currentValues: Record<string, unknown> = {};
  /** 当前版本目录：初始为描述里的目录，蓝绿切换后改为新版本（崩溃重启复用它）。 */
  let activeDirectory = descriptor.directory;
  let wantedActive = false;
  /**
   * 当前在 generation 注册表里的 providerId → 稳定桩对象与注销函数（只属于活跃实例）。
   * 宿主注册表拒绝重复 providerId，所以同 providerId 再登记（模型集合变化、蓝绿切换）时**原地更新**桩对象：
   * 注册表里始终是同一个对象，不经历 unregister → register 的空窗。
   */
  const mirrored = new Map<string, { stub: GenerationProvider; unregister: () => void }>();
  let lastHealth: ExtensionHostHealthSnapshot | undefined;

  const log = (event: Record<string, unknown>) => options.log({ extension: extensionId, ...event });

  const mirrorProvider = (registration: ExtensionHostProviderRegistration) => {
    const fresh = createProviderStub({
      extensionId,
      registration,
      target: () => current?.binding.rpc ?? null,
      ...(options.executionTimeoutMs ? { executionTimeoutMs: options.executionTimeoutMs } : {})
    });
    const existing = mirrored.get(registration.providerId);
    if (existing) {
      // 原地替换全部字段（含可选函数成员的增删）。已拿到旧 `provider` 句柄的调用方继续用旧句柄：
      // 它的模型桩同样经 target() 现取活跃实例。
      const target = existing.stub as Record<string, unknown>;
      for (const key of Object.keys(target)) if (!(key in fresh)) delete target[key];
      Object.assign(target, fresh);
      return;
    }
    mirrored.set(registration.providerId, { stub: fresh, unregister: generation.register(fresh) });
  };
  const unmirrorProvider = (providerId: string) => {
    const entry = mirrored.get(providerId);
    if (!entry) return;
    mirrored.delete(providerId);
    entry.unregister();
  };

  const spawn = (directory: string, values: Record<string, unknown>): ActiveInstance => {
    const entry = directory === descriptor.directory ? descriptor.entry : descriptor.entry.replace(descriptor.directory, directory);
    const instance = manager.spawn({
      extensionId,
      directory,
      start: { entry, factory: descriptor.factory, kind: descriptor.kind, values, capabilities }
    });
    let self: ActiveInstance;
    const binding = bindInstance({
      extensionId,
      instanceId: instance.instanceId,
      rpc: instance.rpc,
      exited: instance.exited,
      capabilities,
      log: options.log,
      ...(options.storage ? { storage: options.storage } : {}),
      assertForRequest: (params) => forwarder.assertForRequest(params),
      events: {
        // 只有活跃实例的登记进入宿主镜像；候选实例的登记先攒在 binding 里，commit 时一次性镜像。
        onProviderRegistered: (registration) => {
          if (current === self) mirrorProvider(registration);
        },
        onProviderUnregistered: (providerId) => {
          if (current === self) unmirrorProvider(providerId);
        },
        onRouteAdded: (route) => {
          if (current === self) forwarder.addRoute(route);
        },
        onRouteRemoved: (routeId) => {
          if (current === self) forwarder.removeRoute(routeId);
        },
        onHealth: (health) => {
          if (current === self) lastHealth = health;
        }
      }
    });
    self = { instance, binding, directory };
    instance.exited.then((exit) => {
      binding.dispose();
      if (current === self && exit.reason !== "stopped") {
        detach();
        options.onCrash?.(exit, self);
      }
    });
    return self;
  };

  /** 等到 ready 且首次健康不是 failed；超时或失败时停掉该实例并抛错。 */
  const awaitReady = async (candidate: ActiveInstance): Promise<void> => {
    const timeoutMs = options.activationTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RpcError("activation-timeout", `扩展子进程未在 ${timeoutMs}ms 内就绪`)), timeoutMs);
    });
    try {
      await Promise.race([candidate.instance.started, deadline]);
      const ready = await Promise.race([candidate.binding.ready, deadline]);
      if (!ready.ok) throw new RpcError(ready.error.code, ready.error.message);
      await Promise.race([candidate.binding.firstHealth, deadline]);
    } catch (error) {
      await candidate.instance.stop(options.disposeTimeoutMs());
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const mirrorAll = (active: ActiveInstance) => {
    for (const registration of active.binding.providers().values()) mirrorProvider(registration);
    forwarder.clearRoutes();
    for (const route of active.binding.routes().values()) forwarder.addRoute(route);
    lastHealth = active.binding.health();
  };

  const detach = () => {
    for (const providerId of [...mirrored.keys()]) unmirrorProvider(providerId);
    forwarder.clearRoutes();
    lastHealth = undefined;
    current = null;
  };

  const commit = (candidate: ActiveInstance): ActiveInstance | null => {
    const previous = current;
    activeDirectory = candidate.directory;
    const previousIds = new Set(mirrored.keys());
    current = candidate;
    // 同一 tick：先镜像新实例（同 providerId 覆盖），再撤旧实例独有的 providerId，最后整体替换路由表。
    for (const registration of candidate.binding.providers().values()) {
      previousIds.delete(registration.providerId);
      mirrorProvider(registration);
    }
    for (const providerId of previousIds) unmirrorProvider(providerId);
    forwarder.clearRoutes();
    for (const route of candidate.binding.routes().values()) forwarder.addRoute(route);
    lastHealth = candidate.binding.health();
    log({ event: "extension-host-instance-committed", instanceId: candidate.instance.instanceId, directory: candidate.directory, ...(previous ? { replaced: previous.instance.instanceId } : {}) });
    return previous;
  };

  return {
    extensionId,
    descriptor,
    active: () => current,
    target: () => current?.binding.rpc ?? null,
    health: () => lastHealth,
    values: () => currentValues,
    directory: () => activeDirectory,
    retarget(directory) {
      activeDirectory = directory;
    },
    wanted: () => wantedActive,
    async activate(values, directory) {
      currentValues = values;
      wantedActive = true;
      const target = directory ?? current?.directory ?? activeDirectory;
      if (current) await this.deactivate();
      activeDirectory = target;
      const candidate = spawn(target, values);
      await awaitReady(candidate);
      current = candidate;
      mirrorAll(candidate);
      log({ event: "extension-host-activated", instanceId: candidate.instance.instanceId, pid: candidate.instance.pid });
    },
    async deactivate() {
      wantedActive = false;
      const active = current;
      detach();
      if (active) await active.instance.stop(options.disposeTimeoutMs());
    },
    async prepare(directory) {
      const candidate = spawn(directory, currentValues);
      await awaitReady(candidate);
      return candidate;
    },
    commit,
    async stopInstance(target) {
      if (target === current) detach();
      await target.instance.stop(options.disposeTimeoutMs());
    },
    detach
  };
}
