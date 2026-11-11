/**
 * 扩展层装载器。
 *
 * 每个扩展插件：把它的 `Config` 字段并进设置定义表（设置页据此生成表单，并记下这是哪个扩展的
 * 配置段）→ 读出 `configPrefix` 段的值启动插件 → 该段配置（含写进密钥文件的 `secret` 字段）
 * 变化时按新值重启。
 *
 * 配置登记与启停无关：被停用的扩展也保有配置段（设置面因此在停用态仍能预填配置，并把该段的
 * 启停显示在配置旁边）。
 *
 * 有站点元数据的扩展由插件管理里的开关启停（见 `core/site-gate.ts`）：控制面激活时才启动，启动失败
 * 抛给控制面，显示为「激活失败」。其余扩展直接启动；失败只记日志，配置改对后再次尝试。
 *
 * 时限（change: 2026-10-21-harden-extension-fault-isolation，D4/D5）：启动、配置更新后的重启与释放
 * 各有有界时限（宿主设置 `extensions.activationTimeoutMs` / `extensions.disposeTimeoutMs`）。
 * 超时按失败处理且不自动重试；迟到的 fiber 用单调 attempt 计数识别并立即释放。非 gated 的可选
 * 插件并发启动、不 await，宿主就绪不再等它们；`optional: false` 的插件仍按顺序等待。
 */
import type { Fiber } from "@deepseek-ai/cordis";
import type { AnyExtensionPlugin } from "@woohaa3/contracts";
import type { HostContext, HostServices } from "../context.js";
import type { SiteGate } from "../core/site-gate.js";
import type { HostPluginOrigin } from "../core/marketplace.js";
import {
  DEFAULT_ACTIVATION_TIMEOUT_MS,
  DEFAULT_DISPOSE_TIMEOUT_MS,
  boundedTimeout,
  isDeadlineError,
  withDeadline
} from "./deadline.js";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | undefined {
  return isDeadlineError(error) ? error.code : undefined;
}

export type LoadedExtension = {
  name: string;
  dispose: () => Promise<void>;
  /** 非 gated 插件的首次启动（可选插件不被装载器 await）；gated 插件为已完成的 promise。 */
  started: Promise<void>;
};

type LoaderServices = Pick<HostServices, "log" | "config"> & { siteGate?: SiteGate };

/** 每个插件的装载声明：缺省可选（并发启动、不阻塞就绪）；`optional: false` 表示就绪必须等它。 */
export type ExtensionLayerEntry = AnyExtensionPlugin | { plugin: AnyExtensionPlugin; optional: boolean };

function entryOf(entry: ExtensionLayerEntry): { plugin: AnyExtensionPlugin; optional: boolean } {
  return "plugin" in entry && typeof (entry as { apply?: unknown }).apply !== "function"
    ? (entry as { plugin: AnyExtensionPlugin; optional: boolean })
    : { plugin: entry as AnyExtensionPlugin, optional: true };
}

function timeouts(config: LoaderServices["config"]) {
  return {
    activation: () => boundedTimeout(config.get("extensions.activationTimeoutMs" as never), DEFAULT_ACTIVATION_TIMEOUT_MS),
    dispose: () => boundedTimeout(config.get("extensions.disposeTimeoutMs" as never), DEFAULT_DISPOSE_TIMEOUT_MS)
  };
}

function loadExtension(ctx: HostContext, services: LoaderServices, plugin: AnyExtensionPlugin): LoadedExtension | null {
  const { config, siteGate } = services;
  const log = services.log.scope("extensions");
  const limits = timeouts(config);
  const gated = siteGate?.managed(plugin.name) ?? false;
  const { configPrefix: prefix } = plugin;
  const fields = plugin.Config.fields;
  // 先登记插件清单再登记配置段：配置段非法时插件仍出现在设置页，卡片据此说明失败原因。
  const unregisterPlugin = config.registerPlugin({
    id: plugin.name,
    label: plugin.label,
    layer: "extension",
    ...(plugin.directory ? { directory: plugin.directory } : {}),
    ...(plugin.icon ? { icon: plugin.icon } : {}),
    ...(plugin.modelTypes ? { modelTypes: plugin.modelTypes } : {}),
    ...(plugin.website ? { website: plugin.website } : {}),
    ...(plugin.setupOrder !== undefined ? { setupOrder: plugin.setupOrder } : {}),
    ...(plugin.modelRefresh ? { modelRefresh: plugin.modelRefresh } : {}),
    ...(plugin.testConnection ? { testConnection: plugin.testConnection.bind(plugin) } : {}),
    configPrefix: prefix,
    siteManaged: gated
  });
  let unregister: () => void;
  try {
    unregister = config.register(prefix, fields, plugin.label, plugin.name);
  } catch (error) {
    log({ event: "extension-config-invalid", extension: plugin.name, message: message(error) });
    if (gated) {
      siteGate!.attach(plugin.name, {
        acquire: async () => {
          throw new Error(`配置不合法：${message(error)}`);
        },
        release: async () => undefined
      });
    }
    // 这里没有 dispose，插件清单里的登记会一直留着——这是有意的：坏插件也要在设置页露面。
    return null;
  }

  const report = (event: string, error: unknown) => {
    if (error !== undefined) {
      const code = codeOf(error);
      log({ event, extension: plugin.name, message: message(error), ...(code ? { code } : {}) });
    }
  };
  const values = () => config.section(prefix);
  // application 模块比扩展层晚装载，只能按调用现取。
  // 最小装配（测试）里 `application` 可能只有 `siteGate`：拿不到宿主注册面时就不提供这些能力。
  const applicationHost = () => ctx.get("application")?.service?.host?.();

  let fiber: (Fiber & PromiseLike<Fiber>) | null = null;
  /** 本次装载拿到的注册面；停用时 release，避免路由/能力留在全局表里。 */
  let surface: import("@woohaa3/application-service").PluginRegistrationSurface | null = null;
  let holders = 0;
  /** 单调递增：每次 start/stop 推进一次，超时后迟到的 fiber 凭它识别出「已过期」。 */
  let attempt = 0;
  // 启停与配置更新串行执行，避免交错。
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };

  /** 释放一个 fiber，受 dispose 时限约束；超时只记诊断并放弃等待（资源由下次重启回收）。 */
  const disposeBounded = async (target: Fiber): Promise<void> => {
    try {
      await withDeadline(target.dispose(), limits.dispose(), "dispose-timeout");
    } catch (error) {
      if (isDeadlineError(error)) {
        log({ event: "extension-dispose-timeout", extension: plugin.name, timeoutMs: error.timeoutMs });
        return;
      }
      log({ event: "extension-dispose-failed", extension: plugin.name, message: message(error) });
    }
  };

  /** 启动；失败或超时时卸掉半成品并返回错误。超时后迟到成功的 fiber 被立即释放。 */
  const start = async (): Promise<unknown> => {
    const mine = ++attempt;
    // 每个扩展层插件拿到带宿主 origin 盖章的 `ctx.marketplace`（change: 2026-10-21-add-extension-marketplace-point，D3）：
    // 受管根 / 可写根 / 缺少 origin 的插件注册市场来源会被拒绝。没有市场服务（测试最小装配）时原样装载。
    const marketplace = ctx.get("marketplace");
    // `ctx.webServer`：受控 HTTP 路由注册面。由站点 gate 按 extensionId 绑定（路由自动带命名空间），
    // 与 `ctx.generation` / `ctx.storage` 同级——它是公共基础设施，不是 backend 类插件的专属特权。
    // 每次启动都现取一份注册面：它会把上一次装载留下的路由清掉，
    // 否则反复启停会撞上 `duplicate-handler`。停用时由 `stop()` 调 `release()`。
    surface = applicationHost()?.pluginContextFor?.(plugin.name) ?? null;
    // 没有覆盖项时不要 extend：fork 出新的 isolate 会让父级服务（`log` 等）解析不到。
    // 与 `marketplace.scoped()` 同一套机制：`extend` 传服务值，按扩展生效。
    const services = {
      ...(marketplace ? { marketplace: marketplace.scoped((plugin as { origin?: HostPluginOrigin }).origin) } : {}),
      ...(surface?.webServer ? { webServer: surface.webServer } : {}),
      ...(surface?.capabilities ? { capabilities: surface.capabilities } : {}),
      ...(surface?.mediaFormats ? { mediaFormats: surface.mediaFormats } : {}),
      ...(surface?.agentRoles ? { agentRoles: surface.agentRoles } : {}),
      ...(surface?.services ? { services: surface.services } : {}),
      ...(surface?.diagnostics ? { diagnostics: surface.diagnostics } : {}),
      deployment: { basePath: applicationHost()?.basePath ?? "" }
    };
    const host = Object.keys(services).length > 0 ? ctx.extend(services) : ctx;
    const started = host.plugin(plugin, values()) as Fiber & PromiseLike<Fiber>;
    try {
      await withDeadline(started, limits.activation(), "activation-timeout");
    } catch (error) {
      if (isDeadlineError(error)) {
        // 迟到结果：无论之后成功还是失败，都不装进当前状态。释放在后台进行（自身受 dispose 时限约束），
        // 不把「激活超时」的报告再拖一个 dispose 时限。
        void Promise.resolve(started).then(
          () => log({ event: "extension-late-start-released", extension: plugin.name }),
          () => undefined
        );
        void disposeBounded(started);
        return error;
      }
      await disposeBounded(started);
      return error ?? new Error("扩展启动失败");
    }
    if (mine !== attempt) {
      // 等待期间被 stop 推进了 attempt（理论上 serial 已排除；纵深防御）。
      await disposeBounded(started);
      return undefined;
    }
    fiber = started;
    return undefined;
  };
  const stop = async () => {
    attempt += 1;
    const current = fiber;
    fiber = null;
    if (current) await disposeBounded(current);
    // 撤销本次装载注册的路由与能力：停用的扩展不该还能被调用。
    surface?.release();
    surface = null;
  };

  let started: Promise<void> = Promise.resolve();
  if (gated) {
    siteGate!.attach(plugin.name, {
      acquire: () =>
        serial(async () => {
          holders += 1;
          if (fiber) return;
          const error = await start();
          if (error !== undefined) {
            holders -= 1;
            report("extension-start-failed", error);
            const code = codeOf(error);
            const failure = error instanceof Error ? error : new Error(message(error));
            if (code) Object.assign(failure, { code });
            throw failure;
          }
        }),
      release: () =>
        serial(async () => {
          holders = Math.max(0, holders - 1);
          if (holders === 0) await stop();
        }),
      // 健康用**当前**配置求值：管理员补上 API Key 后，站点状态不必重启插件就回到 active。
      // 只在 fiber 运行期间报告；未装载时状态投影自己会给出 configuring/disabled。
      ...(plugin.health
        ? { health: () => (fiber ? plugin.health!(values()) : undefined) }
        : {})
    });
  } else {
    started = serial(start).then((error) => report("extension-start-failed", error));
  }

  const keys = Object.keys(fields).map((key) => `${prefix}.${key}`);
  const stopConfig = config.subscribe(keys, () =>
    serial(async () => {
      if (!fiber) {
        if (!gated) report("extension-start-failed", await start());
        return;
      }
      try {
        fiber.update(values());
      } catch (error) {
        report("extension-config-invalid", error);
        return;
      }
      const current = fiber;
      try {
        await withDeadline(current.await(), limits.activation(), "activation-timeout");
      } catch (error) {
        report("extension-restart-failed", error);
        if (isDeadlineError(error) && fiber === current) {
          // 重启挂起：释放这个 fiber，不留下半启动实例；不自动重试。
          await stop();
        }
      }
    })
  );

  return {
    name: plugin.name,
    started,
    dispose: () =>
      serial(async () => {
        stopConfig();
        holders = 0;
        await stop();
        unregister();
        unregisterPlugin();
      })
  };
}

export type ExtensionLayer = LoadedExtension[] & {
  /** 必需（`optional: false`）插件已启动完成、可选插件已发起；可选插件的完成在 `settled` 里。 */
  settled: Promise<void>;
  /**
   * 运行期追加一个扩展层插件（change: 2026-10-21-isolate-extension-host-process，任务 8.4）：
   * 与启动期同一条 `loadExtension` 路径——配置段登记、站点门禁（`siteGate.managed(name)` 时 attach，
   * 由控制面 acquire）、P0 激活 / 释放时限、serial 队列都不变。同名已装载时抛 `extension-exists`。
   * 返回装载记录；非 gated 插件的首次启动结果在 `started`。配置段非法时返回 null（与启动期一致）。
   */
  add(plugin: AnyExtensionPlugin): LoadedExtension | null;
  /** 卸载一个已装载（启动期或运行期追加）的插件：停 fiber、撤配置段与插件清单登记。未装载时为 no-op。 */
  remove(name: string): Promise<void>;
  /** 是否已装载。 */
  has(name: string): boolean;
  /** 卸载全部（组合根关闭时调用；包含运行期追加的插件）。 */
  disposeAll(): Promise<void>;
};

/**
 * 装载扩展层；返回的 disposer 按相反顺序卸载。
 *
 * 必需插件（`optional: false`）按顺序 await；可选插件并发发起、不 await（D5）。可选插件的启动结果
 * 写日志与站点状态，宿主就绪不等它们。站点开关管着的插件仍由控制面 acquire，与此无关。
 */
export async function loadExtensionLayer(ctx: HostContext, entries: readonly ExtensionLayerEntry[]): Promise<ExtensionLayer> {
  const siteGate = ctx.get("application")?.siteGate;
  const services: LoaderServices = {
    log: ctx.get("log")!,
    config: ctx.get("config")!,
    ...(siteGate ? { siteGate } : {})
  };
  const loaded: LoadedExtension[] = [];
  const pending: Promise<void>[] = [];
  for (const entry of entries) {
    const { plugin, optional } = entryOf(entry);
    const extension = loadExtension(ctx, services, plugin);
    if (!extension) continue;
    loaded.push(extension);
    if (optional) pending.push(extension.started);
    else await extension.started;
  }
  const unknown = services.config.unknownKeys();
  if (unknown.length > 0) services.log.scope("settings")({ event: "settings-unknown-keys", keys: unknown });
  const byName = () => new Map(loaded.map((extension) => [extension.name, extension]));
  // 运行期追加时 siteGate 可能已由控制面新登记（`siteGate.add`）：每次现取，不缓存启动期的引用。
  const runtimeServices = (): LoaderServices => {
    const gate = ctx.get("application")?.siteGate;
    return { log: services.log, config: services.config, ...(gate ? { siteGate: gate } : {}) };
  };
  const layer: ExtensionLayer = Object.assign(loaded, {
    settled: Promise.all(pending).then(() => undefined),
    add(plugin: AnyExtensionPlugin) {
      if (byName().has(plugin.name)) {
        throw Object.assign(new Error(`扩展层已装载同名插件：${plugin.name}`), { code: "extension-exists" });
      }
      const extension = loadExtension(ctx, runtimeServices(), plugin);
      if (extension) loaded.push(extension);
      services.log.scope("extensions")({ event: "extension-layer-added", extension: plugin.name, loaded: extension !== null });
      return extension;
    },
    async remove(name: string) {
      const index = loaded.findIndex((extension) => extension.name === name);
      if (index < 0) return;
      const [extension] = loaded.splice(index, 1);
      await extension!.dispose();
      services.log.scope("extensions")({ event: "extension-layer-removed", extension: name });
    },
    has: (name: string) => byName().has(name),
    async disposeAll() {
      // 按装载的反序卸载（与组合根 disposers 的语义一致）。
      for (const extension of loaded.splice(0).reverse()) await extension.dispose();
    }
  });
  return layer;
}
