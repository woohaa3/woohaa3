/** 核心层：第一方领域服务，按依赖顺序装载；`ctx.generation`、`ctx.storage` 与 `ctx.telemetry` 是扩展层的注册点。 */
import type { MediaStorage } from "@woohaa3/contracts";
import type { ModelsConfig } from "@woohaa3/task-service";
import type { HostContext } from "../context.js";
import { registerHostPlugins } from "../inventory.js";
import { adminApiPlugin } from "./admin-api.js";
import { applicationPlugin, type ApplicationPluginConfig } from "./application.js";
import { canvasPlugin } from "./canvas.js";
import { generationPlugin } from "./generation.js";
import { mcpPlugin } from "./mcp.js";
import { mcpInstallationPlugin } from "./mcp-installation.js";
import { mediaPlugin } from "./media.js";
import { recordingExecutorPlugin } from "./recording-executor.js";
import { storagePlugin } from "./storage.js";
import { taskPlugin } from "./task.js";
import { telemetryPlugin } from "./telemetry.js";

export type CoreLayerOptions = Omit<ApplicationPluginConfig, "env"> & {
  env: Record<string, string | undefined>;
  modelsConfig?: ModelsConfig;
  mediaStorage?: MediaStorage;
  enableYjsSync?: boolean;
  /** 录制执行器 socket 绑定的 checkout 目录；缺省用进程 cwd。 */
  recordingCheckoutDirectory?: string;
};

export async function loadCoreLayer(ctx: HostContext, options: CoreLayerOptions) {
  const { env } = options;
  // 插件对象按装载顺序留一份，供设置面登记插件清单。
  // 遥测排在任务之前：任务终态经 `ctx.get("telemetry")` 写入（懒取，不影响单独装载 taskPlugin 的场景）。
  const plugins = [storagePlugin, telemetryPlugin, mediaPlugin, generationPlugin, adminApiPlugin, taskPlugin, recordingExecutorPlugin, canvasPlugin, mcpPlugin, mcpInstallationPlugin, applicationPlugin];
  const fibers = [
    await ctx.plugin(storagePlugin),
    await ctx.plugin(telemetryPlugin, { env }),
    await ctx.plugin(mediaPlugin, { env, ...(options.mediaStorage ? { storage: options.mediaStorage } : {}) }),
    await ctx.plugin(generationPlugin, { env }),
    await ctx.plugin(adminApiPlugin),
    // 录制通道在 canvas 之前：canvas 的录制编排按 `ctx.get("recordingExecutor")` 懒取。
    await ctx.plugin(recordingExecutorPlugin, {
      env,
      ...(options.recordingCheckoutDirectory ? { checkoutDirectory: options.recordingCheckoutDirectory } : {})
    }),
    await ctx.plugin(taskPlugin, { env, ...(options.modelsConfig ? { modelsConfig: options.modelsConfig } : {}) }),
    await ctx.plugin(canvasPlugin, {
      env,
      ...(options.enableYjsSync !== undefined ? { enableYjsSync: options.enableYjsSync } : {}),
      ...(options.extensionHost ? { extensionHost: options.extensionHost } : {})
    }),
    await ctx.plugin(mcpPlugin, { env }),
    await ctx.plugin(mcpInstallationPlugin, { env, basePath: options.basePath ?? "/" }),
    await ctx.plugin(applicationPlugin, {
      env,
      basePath: options.basePath,
      ...(options.applicationExtensionMetadata ? { applicationExtensionMetadata: options.applicationExtensionMetadata } : {}),
      ...(options.applicationBackendExtensions ? { applicationBackendExtensions: options.applicationBackendExtensions } : {}),
      ...(options.chatgptServiceOptions ? { chatgptServiceOptions: options.chatgptServiceOptions } : {}),
      ...(options.extensionHost ? { extensionHost: options.extensionHost } : {}),
      ...(options.treeExtensions ? { treeExtensions: options.treeExtensions } : {})
    })
  ];
  registerHostPlugins(ctx, "core", plugins);
  return fibers;
}
