/**
 * Frontend 页面级插件运行时 kernel（change: adopt-frontend-cordis-plugin-runtime，design D1/D2/D10）。
 *
 * 一个页面只创建一个 Context；required Service 与 Plugin 在挂载可交互应用前启动完成。
 * 生产清单是**静态可信**的 TypeScript 导入，不解析用户配置、不动态执行远端代码。
 */
import { Context, type Fiber } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { DiagnosticsService } from "./diagnostics.js";
import { markServiceAccessGuardScope, reportLateServiceReads } from "./service-access-guard.js";
import type { RuntimeStatus } from "./contracts.js";
import { fiberStatus } from "./diagnostics.js";
import { scopedExtensionServices } from "./slots.js";
import type { ExtensionFaultService } from "./extension-faults.js";

export type FrontendExtensionDefinition = {
  id: string;
  /** required 失败时整个启动失败；optional 失败只暴露诊断。 */
  required: boolean;
  plugin: Plugin;
  /** Plugin 提供的 service key（诊断用）。 */
  provides?: string[];
  /** 用户可读名称（change: add-frontend-plugin-manager，design D1）。 */
  name?: string;
  /** 简短说明（管理面板展示）。 */
  description?: string;
  /**
   * 是否为**用户可配置的 optional** Plugin（change: add-frontend-plugin-manager，design D1）。
   *
   * 只有静态清单显式标记为 configurable 且 `required: false` 的定义可被 browser-local
   * 选择过滤；required 定义一律强制装配，MUST NOT 被用户配置禁用。
   */
  configurable?: boolean;
  /**
   * 是否来自扩展发布目录（change: 2026-10-21-harden-extension-fault-isolation，design D1）。
   *
   * 为 true 时 kernel 以注入的 slots 代理装配它：贡献由宿主盖章 `origin: extension`，
   * 渲染错误逐项隔离，可选扩展可在本会话内熔断。宿主内置插件保持缺省（builtin）。
   */
  extension?: boolean;
  /**
   * 重新求值该扩展的代码来源，返回可装配的插件（change: 2026-10-27-add-extension-dev-reload，D1）。
   *
   * 缺省时重装复用 `plugin`（同一份代码再跑一遍）。来源可变的扩展（开发者模式 `dev-source`）
   * 提供该函数，使 reload 能取到产物更新后的模块，而不必重建页面 scope。
   */
  resolvePlugin?: () => Plugin | Promise<Plugin>;
};

/**
 * 一个定义的当前装配（扩展熔断后重新加载会换成新 fiber）。
 *
 * `reload` 是实例级重装的唯一入口（change: 2026-10-27-add-extension-dev-reload，D1）：
 * 释放当前 fiber → 重新求值代码来源 → 按同一份定义重新装配。串行排队，重入只执行一次。
 */
type Assembly = {
  current: Fiber;
  dispose: () => Promise<void>;
  /** 用当前定义可求值的代码来源重装；失败时保留上一次成功的装配并抛出。 */
  reload: () => Promise<Fiber>;
};

/**
 * 按定义装配一个 fiber。扩展定义：
 * - 在子 Context 上覆盖 `slots` 为盖章代理（同一扩展内嵌套的插件同样继承该代理）；
 * - 向 App 级 `extensionFaults` 登记熔断（释放 fiber）与重新加载（新 epoch 重新装配）。
 */
function assemble(ctx: Context, definition: FrontendExtensionDefinition): Assembly {
  /** 重新求值代码来源；没有 `resolvePlugin` 时复用同一份 plugin。 */
  const resolvePlugin = async (): Promise<Plugin> =>
    definition.resolvePlugin ? await definition.resolvePlugin() : definition.plugin;

  if (!definition.extension) {
    let disposed = false;
    /** 重装串行队列：同一时刻最多一次 dispose + 装配。 */
    let queue: Promise<unknown> = Promise.resolve();
    const assembly: Assembly = {
      current: ctx.plugin(definition.plugin as Plugin) as Fiber,
      dispose: async () => {
        disposed = true;
        await assembly.current.dispose();
      },
      reload: () => {
        const run = queue.then(async () => {
          if (disposed) throw new Error('装配已释放，不能重装');
          const plugin = await resolvePlugin();
          await assembly.current.dispose();
          if (disposed) throw new Error('装配已释放，不能重装');
          assembly.current = ctx.plugin(plugin) as Fiber;
          return assembly.current;
        });
        queue = run.catch(() => undefined);
        return run;
      }
    };
    return assembly;
  }

  const faults = ctx.get("extensionFaults" as never) as ExtensionFaultService | undefined;
  let detach: (() => void) | null = null;
  let disposed = false;
  /** 重装串行队列：同一时刻最多一次 dispose + 装配。 */
  let queue: Promise<unknown> = Promise.resolve();

  const start = (plugin: Plugin): Fiber => {
    const { slots, dialogs, epoch } = scopedExtensionServices(ctx, definition.id);
    const fiber = ctx.extend({ slots, dialogs } as never).plugin(plugin) as Fiber;
    detach?.();
    detach = faults?.attach(definition.id, {
      required: definition.required,
      epoch,
      trip: () => { void fiber.dispose(); },
      reload: () => {
        if (disposed) return;
        // 熔断后的重新加载同样走实例重装，复用同一条串行队列。
        void assembly.reload().catch(() => undefined);
      }
    }) ?? null;
    return fiber;
  };
  const assembly: Assembly = {
    current: null as unknown as Fiber,
    dispose: async () => {
      disposed = true;
      detach?.();
      detach = null;
      await assembly.current.dispose();
    },
    reload: () => {
      const run = queue.then(async () => {
        if (disposed) throw new Error('装配已释放，不能重装');
        const plugin = await resolvePlugin();
        await assembly.current.dispose();
        if (disposed) throw new Error('装配已释放，不能重装');
        assembly.current = start(plugin);
        return assembly.current;
      });
      queue = run.catch(() => undefined);
      return run;
    }
  };
  // 初次装配同步完成（保持既有启动语义），重装才走异步队列。
  assembly.current = start(definition.plugin as Plugin);
  return assembly;
}

export type FrontendRuntimeOptions = {
  plugins: FrontendExtensionDefinition[];
  /** 在启动 feature plugin 之前安装 required platform services（可为异步）。 */
  installPlatform: (ctx: Context) => void | Promise<void>;
  /** 在启动 feature plugin 之后、ready 之前运行的收尾。 */
  beforeReady?: (ctx: Context) => Promise<void> | void;
};

export type FrontendRuntime = {
  ctx: Context;
  diagnostics: DiagnosticsService;
  status(): RuntimeStatus;
  subscribe(listener: () => void): () => void;
  /**
   * 运行期按 id 装配/卸下 optional 插件（跟着配置热生效）。
   * 只在 `startFrontendScope` 上提供：App 级运行时没有可换清单。
   */
  plugins?: PluginSwap;
  /**
   * 运行期按 id 重装单个扩展实例（开发者模式热重载，change: 2026-10-27-add-extension-dev-reload）。
   * 只在 `startFrontendScope` 上提供。
   */
  reloadExtension?: ExtensionReloader["reload"];
  dispose(): Promise<void>;
};

/**
 * 运行期按 id 装配/卸下 optional 插件的能力（plugin hot swap）。
 *
 * 供 composition root 跟随宿主配置（\`extensions.frontend.<id>.enabled\`）在**不重建页面 scope**的
 * 前提下装回或卸下某个 optional 插件：启用时按定义装配新 fiber，禁用时释放该 fiber 并撤销它
 * 注册的 contribution。required 插件不可卸载（调用方负责不把它列进可换清单）。
 */
/**
 * 实例级重装入口（change: 2026-10-27-add-extension-dev-reload，D1）。
 *
 * 与启停分开：`reload` 只换该扩展的代码，不改变它「要不装」；`required` 扩展也可重装。
 * 未装配的 id 返回 `not-mounted`（不报错，也不因此装配）。
 */
export type ExtensionReloader = {
  reload(id: string): Promise<"reloaded" | "not-mounted">;
};

export type PluginSwap = {
  /** 该 id 当前是否已装配。 */
  has(id: string): boolean;
  /** 装配一个此前未装配的 optional 定义；已在装配则忽略。 */
  enable(definition: FrontendExtensionDefinition): void;
  /** 卸下一个已装配的 optional 定义；未装配则忽略。 */
  disable(id: string): Promise<void>;
  /** 已装配的可换插件 id（稳定排序）。 */
  ids(): string[];
};

export type ScopeOptions = {
  /** 在启动 scope plugins 之前安装 scope services（可为异步）。 */
  install: (ctx: Context) => void | Promise<void>;
  plugins: FrontendExtensionDefinition[];
  beforeReady?: (ctx: Context) => Promise<void> | void;
  /**
   * 本 scope 独立提供、不与父 scope 共享的 service 名（change: unify-canvas-presentation-navigation）。
   * 这些 service 在 scope 内用独立 isolate label 解析，避免多个 page scope 互相冲突。
   */
  isolate?: string[];
  /**
   * 因用户禁用而**未**进入本次启动清单的 optional Plugin 定义
   * （change: add-frontend-plugin-manager，design D2）。
   *
   * 只用于记录稳定 `disabled` 诊断（区别于启动失败/缺失依赖），不产生任何 Fiber。
   */
  disabled?: ReadonlyArray<{ id: string; reason?: string }>;
};

/**
 * 在已有父 Context 下启动一个**可独立释放的 page scope**（change: unify-canvas-presentation-navigation）。
 *
 * scope 继承父 Context 的 App 能力（Theme/Dialog/Slots/Router）；`isolate` 中列出的 service 在
 * 本 scope 独立解析（不污染父 scope，也不与其它 page scope 冲突）。它创建的 remote/session/
 * socket/listener/plugin 只属于本 scope，`dispose()` 时全部撤销。
 */
export async function startFrontendScope(parent: Context, options: ScopeOptions): Promise<FrontendRuntime> {
  const guardedScope = markServiceAccessGuardScope(parent.extend({}));
  let scopeCtx = guardedScope.ctx;
  // `extensionReload` 是 scope 自己的重装入入口：同样按 scope 隔离，避免快速切换时
  // 两个仍在启动的 scope 争抢同一个全局服务键（重复注册会让页面启动失败、切画布白屏）。
  for (const name of [...(options.isolate ?? []), "extensionReload"]) {
    scopeCtx = scopeCtx.extend(scopeCtx.isolate(name));
  }
  const ctx = scopeCtx;
  const diagnostics = new DiagnosticsService(ctx);
  const disposers: Array<() => void> = [];
  const fibers: Fiber[] = [];
  const assemblies: Assembly[] = [];
  // install-phase effects（remote/session/taskCatalog 等 scope 资源）必须属于本 scope 自己的
  // fiber：`parent.extend()` 只创建 Context 子对象、`ctx.fiber` 仍是父 fiber，直接在 install
  // 里 `ctx.fiber.effect()` 会把 disposer 挂到父 fiber 上，导致 scope dispose 不释放这些资源
  // （多画布切换会泄漏旧 socket/session；change: 2026-09-29-add-multi-canvas-workspace）。
  const installFiber = ctx.plugin((innerCtx: Context) => options.install(innerCtx)) as Fiber;
  /** 可换插件登记：装配/卸下都走同一张表，diagnostics 随之一并维护。 */
  const swappable = new Map<string, { definition: FrontendExtensionDefinition; assembly: Assembly; undo: () => void }>();
  /**
   * 全部已装配定义的句柄（含 required）：实例级重装用（change: 2026-10-27-add-extension-dev-reload，D5）。
   *
   * 与 `swappable` 分开是刻意的：启停改变「要不要装」，重装改变「装哪份代码」，
   * `required` 扩展可以有后者、不能有前者。
   */
  const mounted = new Map<string, { definition: FrontendExtensionDefinition; assembly: Assembly; undo: () => void }>();
  /** 装配一个定义（启动期与运行期热启用共用同一路径）。 */
  const mountDefinition = (definition: FrontendExtensionDefinition): Fiber => {
    const assembly = assemble(ctx, definition);
    assemblies.push(assembly);
    const fiber = assembly.current;
    fibers.push(fiber);
    const undo = diagnostics.addExtension({ id: definition.id, required: definition.required, fiber });
    mounted.set(definition.id, { definition, assembly, undo });
    if (!definition.required) {
      swappable.set(definition.id, { definition, assembly, undo });
    }
    return fiber;
  };
  /**
   * 实例级重装：释放当前 fiber，按定义重新求值代码来源并重新装配。
   *
   * 不重建 scope，也不改变启停状态；失败时保留上一次成功的装配并抛错（D1 / D5）。
   */
  const reloadDefinition = async (id: string): Promise<"reloaded" | "not-mounted"> => {
    if (disposed) throw new Error('scope 已释放，不能重装');
    const entry = mounted.get(id);
    if (!entry) return "not-mounted";
    await entry.assembly.reload();
    // 新 fiber 重新登记诊断：先撤旧条目，再按新 fiber 记录，避免面板读到已释放的 fiber。
    entry.undo();
    const undo = diagnostics.addExtension({ id, required: entry.definition.required, fiber: entry.assembly.current });
    entry.undo = undo;
    const swappableEntry = swappable.get(id);
    if (swappableEntry) swappableEntry.undo = undo;
    return "reloaded";
  };
  let disposed = false;
  /** 本 scope 的重装入口 fiber（随 scope 释放，见下方 provide 注释）。 */
  let reloadServiceFiber: Fiber | null = null;

  try {
    await installFiber.await().catch(() => undefined);
    if (fiberStatus(installFiber) !== "active") {
      throw new Error(`scope 服务安装失败（状态 ${fiberStatus(installFiber)}）`);
    }
    disposers.push(diagnostics.addExtension({ id: "scope-services", required: true, fiber: installFiber }));

    for (const entry of options.disabled ?? []) {
      disposers.push(
        diagnostics.addDisabled({ id: entry.id, required: false, reason: entry.reason ?? "用户已禁用该可选插件" })
      );
    }

    for (const definition of options.plugins) mountDefinition(definition);

    await Promise.all(fibers.map((fiber) => fiber.await().catch(() => undefined)));
    for (const [index, definition] of options.plugins.entries()) {
      const fiber = fibers[index]!;
      if (definition.required && fiberStatus(fiber) !== "active") {
        throw new Error(`required plugin "${definition.id}" 启动失败（状态 ${fiberStatus(fiber)}）`);
      }
    }

    // 批次结算后再判装配期取空：仍不可用的服务属"本来就没有"，不追究。
    reportLateServiceReads(guardedScope.guard, ctx);

    await options.beforeReady?.(ctx);
    // 实例级重装入口（change: 2026-10-27-add-extension-dev-reload，D1/D5）：reconciler 在 install
    // 阶段只拿到惰性 getter，这里在 scope 成功后把入口挂到**本 scope 自己的 fiber**上。
    // 不能由调用方直接 `scopeCtx.provide()`：那会登记到父/root fiber，页面 dispose 不释放，
    // 第二次进入画布时重复注册会抛错，整页白屏。
    reloadServiceFiber = ctx.plugin((providerCtx) => {
      providerCtx.provide("extensionReload" as never, reloadDefinition as never);
    });
    // 启动完成即保证服务可读（cordis 只把已 active 的提供者交给 strict get）。
    await reloadServiceFiber;
    diagnostics.markReady();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.markFailed(message);
    await Promise.allSettled([
      ...(reloadServiceFiber ? [reloadServiceFiber.dispose()] : []),
      installFiber.dispose(),
      ...assemblies.map((assembly) => assembly.dispose())
    ]);
    throw error;
  }

  return {
    ctx,
    diagnostics,
    status: () => diagnostics.getStatus(),
    subscribe: diagnostics.subscribe,
    reloadExtension: reloadDefinition,
    plugins: {
      has: (id) => swappable.has(id),
      ids: () => [...swappable.keys()].sort(),
      enable(definition) {
        if (disposed || definition.required || swappable.has(definition.id)) return;
        mountDefinition(definition);
      },
      async disable(id) {
        if (disposed) return;
        const entry = swappable.get(id);
        if (!entry) return;
        // 先从可换表与诊断移除，再释放 fiber：面板的「已停用」不该晚于贡献消失。
        swappable.delete(id);
        mounted.delete(id);
        entry.undo();
        const index = assemblies.indexOf(entry.assembly);
        if (index >= 0) assemblies.splice(index, 1);
        await entry.assembly.dispose();
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      // 先释放本 scope 的重装入口，再释放 install-phase 资源与 feature plugins。
      await reloadServiceFiber?.dispose();
      await Promise.allSettled(assemblies.map((assembly) => assembly.dispose()));
      await installFiber.dispose();
      for (const dispose of disposers.reverse()) dispose();
    }
  };
}

/**
 * 创建并启动页面级运行时。
 *
 * required 失败：抛出，调用方显示稳定启动错误且不挂载画布。
 * optional 失败：记录诊断并继续；其 contribution 不出现。
 */
export async function startFrontendRuntime(options: FrontendRuntimeOptions): Promise<FrontendRuntime> {
  const guardedScope = markServiceAccessGuardScope(new Context());
  const ctx = guardedScope.ctx;
  const diagnostics = new DiagnosticsService(ctx);
  const disposers: Array<() => void> = [];
  const fibers: Fiber[] = [];
  const assemblies: Assembly[] = [];
  let disposed = false;

  try {
    await options.installPlatform(ctx);
    disposers.push(diagnostics.addExtension({ id: "platform", required: true, fiber: ctx.fiber }));

    for (const definition of options.plugins) {
      const assembly = assemble(ctx, definition);
      assemblies.push(assembly);
      const fiber = assembly.current;
      fibers.push(fiber);
      disposers.push(diagnostics.addExtension({ id: definition.id, required: definition.required, fiber }));
    }

    // 所有 plugin 注册后统一等待：依赖等待链在此结算，再判定 required 失败。
    await Promise.all(fibers.map((fiber) => fiber.await().catch(() => undefined)));
    for (const [index, definition] of options.plugins.entries()) {
      const fiber = fibers[index]!;
      if (definition.required && fiberStatus(fiber) !== "active") {
        throw new Error(`required plugin "${definition.id}" 启动失败（状态 ${fiberStatus(fiber)}）`);
      }
    }

    reportLateServiceReads(guardedScope.guard, ctx);

    await options.beforeReady?.(ctx);
    diagnostics.markReady();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.markFailed(message);
    // 启动失败：回滚所有已启动的 fiber 与 platform，保证零活动资源。
    await Promise.allSettled(assemblies.map((assembly) => assembly.dispose()));
    await ctx.fiber.dispose();
    throw error;
  }

  return {
    ctx,
    diagnostics,
    status: () => diagnostics.getStatus(),
    subscribe: diagnostics.subscribe,
    async dispose() {
      if (disposed) return;
      disposed = true;
      // 逆序释放：consumer contribution 先撤销，再关闭 provider resource。
      await Promise.allSettled(assemblies.map((assembly) => assembly.dispose()));
      for (const dispose of disposers.reverse()) dispose();
      await ctx.fiber.dispose();
    }
  };
}
