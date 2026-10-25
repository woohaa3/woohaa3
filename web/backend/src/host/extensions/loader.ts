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
 */
import type { Fiber } from "@deepseek-ai/cordis";
import type { AnyHostExtensionPlugin } from "@woohaa3/contracts";
import type { HostContext, HostServices } from "../context.js";
import type { SiteGate } from "../core/site-gate.js";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function settle(fiber: PromiseLike<unknown>): Promise<unknown> {
  try {
    await fiber;
    return undefined;
  } catch (error) {
    return error ?? new Error("扩展启动失败");
  }
}

export type LoadedExtension = { name: string; dispose: () => Promise<void> };

type LoaderServices = Pick<HostServices, "log" | "config"> & { siteGate?: SiteGate };

async function loadExtension(ctx: HostContext, services: LoaderServices, plugin: AnyHostExtensionPlugin): Promise<LoadedExtension | null> {
  const { config, siteGate } = services;
  const log = services.log.scope("extensions");
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
    ...(plugin.modelRefresh ? { modelRefresh: plugin.modelRefresh } : {}),
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
    if (error !== undefined) log({ event, extension: plugin.name, message: message(error) });
  };
  const values = () => config.section(prefix);

  let fiber: (Fiber & PromiseLike<Fiber>) | null = null;
  let holders = 0;
  // 启停与配置更新串行执行，避免交错。
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };

  /** 启动；失败时卸掉半成品并返回错误。 */
  const start = async (): Promise<unknown> => {
    const started = ctx.plugin(plugin as never, values() as never) as Fiber & PromiseLike<Fiber>;
    const error = await settle(started);
    if (error !== undefined) {
      await started.dispose();
      return error;
    }
    fiber = started;
    return undefined;
  };
  const stop = async () => {
    const current = fiber;
    fiber = null;
    await current?.dispose();
  };

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
            throw error instanceof Error ? error : new Error(message(error));
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
        ? { health: () => (fiber ? plugin.health!(values() as never) : undefined) }
        : {})
    });
  } else {
    report("extension-start-failed", await serial(start));
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
      report("extension-restart-failed", await settle(fiber.await()));
    })
  );

  return {
    name: plugin.name,
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

/** 按顺序装载；返回的 disposer 按相反顺序卸载。 */
export async function loadExtensionLayer(ctx: HostContext, plugins: readonly AnyHostExtensionPlugin[]): Promise<LoadedExtension[]> {
  const siteGate = ctx.get("application")?.siteGate;
  const services: LoaderServices = {
    log: ctx.get("log")!,
    config: ctx.get("config")!,
    ...(siteGate ? { siteGate } : {})
  };
  const loaded: LoadedExtension[] = [];
  for (const plugin of plugins) {
    const extension = await loadExtension(ctx, services, plugin);
    if (extension) loaded.push(extension);
  }
  const unknown = services.config.unknownKeys();
  if (unknown.length > 0) services.log.scope("settings")({ event: "settings-unknown-keys", keys: unknown });
  return loaded;
}
