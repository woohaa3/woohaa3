/**
 * 代理插件工厂（change: 2026-10-21-isolate-extension-host-process，D1，任务 4.2）。
 *
 * 输入 isolated 描述，输出一个普通 `AnyHostExtensionPlugin`：name / label / configPrefix / Config /
 * health / modelRefresh 都来自静态描述，所以装载器的配置段登记、站点门禁、P0 时限与站点状态全部复用。
 * `apply` 向隔离控制器申请子进程并等它就绪；`dispose`（Cordis 卸载 effect）停止实例并撤销镜像。
 *
 * 配置变化：装载器按进程内语义重启插件（dispose → apply），子进程随之换一个新实例。
 */
import { defineConfigSchema, type AnyHostExtensionPlugin, type HostConfigFields } from "@woohaa3/contracts";
import type { IsolatedController } from "./controller.js";

export type ProxyPluginOptions = {
  controller: IsolatedController;
  /** 实例被熔断隔离时，`apply` 直接拒绝（supervisor 提供）。 */
  quarantined?: () => boolean;
};

export function createProxyPlugin(options: ProxyPluginOptions): AnyHostExtensionPlugin {
  const { controller } = options;
  const { descriptor } = controller;
  const fields = descriptor.plugin.fields as unknown as HostConfigFields;
  return {
    name: descriptor.plugin.name,
    label: descriptor.plugin.label,
    directory: descriptor.directory,
    ...(descriptor.icon ? { icon: descriptor.icon } : {}),
    ...(descriptor.plugin.modelRefresh ? { modelRefresh: descriptor.plugin.modelRefresh } : {}),
    configPrefix: descriptor.plugin.configPrefix,
    inject: [],
    Config: defineConfigSchema(fields),
    // 只有扩展真的实现了 health 才声明（未实现按健康处理，与进程内一致）。同步读子进程最近一次上报。
    ...(descriptor.plugin.health
      ? {
          health: () => {
            const snapshot = controller.health();
            return snapshot ? { state: snapshot.state, diagnostics: [...snapshot.diagnostics] } : undefined;
          }
        }
      : {}),
    async apply(ctx, values) {
      if (options.quarantined?.()) {
        throw Object.assign(new Error(`扩展 ${descriptor.extensionId} 因连续崩溃已被隔离`), { code: "crash-loop" });
      }
      await controller.activate({ ...(values as Record<string, unknown>) });
      ctx.effect(() => () => controller.deactivate());
    }
  } as AnyHostExtensionPlugin;
}
