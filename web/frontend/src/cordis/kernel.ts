/**
 * Frontend 页面级插件运行时 kernel（change: adopt-frontend-cordis-plugin-runtime，design D1/D2/D10）。
 *
 * 一个页面只创建一个 Context；required Service 与 Plugin 在挂载可交互应用前启动完成。
 * 生产清单是**静态可信**的 TypeScript 导入，不解析用户配置、不动态执行远端代码。
 */
import { Context, type Fiber } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { DiagnosticsService } from "./diagnostics.js";
import type { RuntimeStatus } from "./contracts.js";
import { fiberStatus } from "./diagnostics.js";

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
};

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
  dispose(): Promise<void>;
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
  let scopeCtx = parent.extend({});
  for (const name of options.isolate ?? []) {
    scopeCtx = scopeCtx.extend(scopeCtx.isolate(name));
  }
  const ctx = scopeCtx;
  const diagnostics = new DiagnosticsService(ctx);
  const disposers: Array<() => void> = [];
  const fibers: Fiber[] = [];
  // install-phase effects（remote/session/taskCatalog 等 scope 资源）必须属于本 scope 自己的
  // fiber：`parent.extend()` 只创建 Context 子对象、`ctx.fiber` 仍是父 fiber，直接在 install
  // 里 `ctx.fiber.effect()` 会把 disposer 挂到父 fiber 上，导致 scope dispose 不释放这些资源
  // （多画布切换会泄漏旧 socket/session；change: 2026-09-29-add-multi-canvas-workspace）。
  const installFiber = ctx.plugin((innerCtx: Context) => options.install(innerCtx)) as Fiber;
  let disposed = false;

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

    for (const definition of options.plugins) {
      const fiber = ctx.plugin(definition.plugin as Plugin) as Fiber;
      fibers.push(fiber);
      disposers.push(diagnostics.addExtension({ id: definition.id, required: definition.required, fiber }));
    }

    await Promise.all(fibers.map((fiber) => fiber.await().catch(() => undefined)));
    for (const [index, definition] of options.plugins.entries()) {
      const fiber = fibers[index]!;
      if (definition.required && fiberStatus(fiber) !== "active") {
        throw new Error(`required plugin "${definition.id}" 启动失败（状态 ${fiberStatus(fiber)}）`);
      }
    }

    await options.beforeReady?.(ctx);
    diagnostics.markReady();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.markFailed(message);
    await Promise.allSettled([installFiber, ...fibers].map((fiber) => fiber.dispose()));
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
      // 先释放 scope 的 install-phase 资源（remote/session 等），再撤销 feature plugins。
      await Promise.allSettled(fibers.map((fiber) => fiber.dispose()));
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
  const ctx = new Context();
  const diagnostics = new DiagnosticsService(ctx);
  const disposers: Array<() => void> = [];
  const fibers: Fiber[] = [];
  let disposed = false;

  try {
    await options.installPlatform(ctx);
    disposers.push(diagnostics.addExtension({ id: "platform", required: true, fiber: ctx.fiber }));

    for (const definition of options.plugins) {
      const fiber = ctx.plugin(definition.plugin as Plugin) as Fiber;
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

    await options.beforeReady?.(ctx);
    diagnostics.markReady();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.markFailed(message);
    // 启动失败：回滚所有已启动的 fiber 与 platform，保证零活动资源。
    await Promise.allSettled(fibers.map((fiber) => fiber.dispose()));
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
      await Promise.allSettled(fibers.map((fiber) => fiber.dispose()));
      for (const dispose of disposers.reverse()) dispose();
      await ctx.fiber.dispose();
    }
  };
}
