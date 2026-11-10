/** 基础层：第一方，最先装载，给核心层与扩展层用。 */
import type { BootstrapExtension, HostLog } from "@woohaa3/contracts";
import type { ApplicationRequestAuthenticator } from "@woohaa3/application-service";
import type { RuntimeStorageProvider } from "../../extensions/slot-contract.js";
import type { SettingsService } from "../../settings/settings-service.js";
import type { ApplicationServiceSeedProviders, HostContext } from "../context.js";
import { registerHostPlugins } from "../inventory.js";
import { accessPlugin } from "./access.js";
import { configPlugin } from "./config.js";
import { diagnosticsPlugin } from "./diagnostics.js";
import { gatewayPlugin } from "./gateway.js";
import { identityPlugin } from "./identity.js";
import { logPlugin } from "./log.js";
import { restartPlugin } from "./restart.js";

export type BaseLayerOptions = {
  env: Record<string, string | undefined>;
  sink: HostLog;
  /** 内置 sink 的落盘目录；调用方注入 logger 或关闭落盘时为 null（导出端点据此决定是否登记）。 */
  logDir?: string | null;
  /** 显式注入的可信认证器（测试/受控部署）。 */
  authenticator?: ApplicationRequestAuthenticator;
  /** 显式注入的基础提供者（测试/受控部署）。 */
  seedProviders?: ApplicationServiceSeedProviders;
  /** 启动期槽位实现（storage / identity / access）。 */
  bootstrapExtensions?: readonly BootstrapExtension<RuntimeStorageProvider>[];
  settings?: SettingsService;
  directoryControl?: import("../../extensions/manifest.js").LoadedExtensionHost["directoryControl"];
};

export async function loadBaseLayer(ctx: HostContext, options: BaseLayerOptions) {
  // 插件对象按装载顺序留一份，供设置面登记插件清单。
  // diagnostics 必须先于 log：log 出口把每条事件喂给它做白名单投影。
  // identity 排在 config 之前：它不依赖任何配置，任何一份宿主都应当能自报家门。
  const plugins = [diagnosticsPlugin, logPlugin, gatewayPlugin, identityPlugin, accessPlugin, configPlugin, restartPlugin];
  const fibers = [
    await ctx.plugin(diagnosticsPlugin),
    await ctx.plugin(logPlugin, { sink: options.sink, ...(options.logDir === undefined ? {} : { logDir: options.logDir }) }),
    await ctx.plugin(gatewayPlugin),
    await ctx.plugin(identityPlugin, { env: options.env }),
    await ctx.plugin(accessPlugin, {
      env: options.env,
      ...(options.authenticator ? { authenticator: options.authenticator } : {}),
      ...(options.seedProviders ? { seedProviders: options.seedProviders } : {}),
      ...(options.bootstrapExtensions ? { bootstrapExtensions: options.bootstrapExtensions } : {})
    }),
    await ctx.plugin(configPlugin, { env: options.env, directoryControl: options.directoryControl, ...(options.settings ? { settings: options.settings } : {}) }),
    await ctx.plugin(restartPlugin, { env: options.env })
  ];
  registerHostPlugins(ctx, "base", plugins);
  return fibers;
}
