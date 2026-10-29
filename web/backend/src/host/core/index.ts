/** 核心层：第一方领域服务，按依赖顺序装载；`ctx.generation`、`ctx.storage` 与 `ctx.telemetry` 是扩展层的注册点。 */
import type { MediaStorage } from "@woohaa3/contracts";
import type { ModelsConfig } from "@woohaa3/task-service";
import type { HostContext } from "../context.js";
import { registerHostPlugins } from "../inventory.js";
import { adminApiPlugin } from "./admin-api.js";
import { applicationPlugin, type ApplicationPluginConfig } from "./application.js";
import { canvasPlugin } from "./canvas.js";
import { generationPlugin } from "./generation.js";
import { marketplacePlugin } from "./marketplace.js";
import { extensionManagerPlugin } from "./extension-manager/index.js";
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
  /** 启动阶段耗时探针（逐插件）；缺省不记录，测试/嵌入调用保持安静。 */
  logger?: (event: Record<string, unknown>) => void;
};

export async function loadCoreLayer(ctx: HostContext, options: CoreLayerOptions) {
  const { env } = options;
  // 插件对象按装载顺序留一份，供设置面登记插件清单。
  // 遥测排在任务之前：任务终态经 `ctx.get("telemetry")` 写入（懒取，不影响单独装载 taskPlugin 的场景）。
  const plugins = [storagePlugin, telemetryPlugin, mediaPlugin, generationPlugin, marketplacePlugin, adminApiPlugin, taskPlugin, recordingExecutorPlugin, canvasPlugin, mcpPlugin, mcpInstallationPlugin, applicationPlugin, extensionManagerPlugin];
  // 逐插件计时：core 层整体耗时异常时，必须能直接看出是哪个插件慢。
  const timed = async <T>(plugin: string, load: () => PromiseLike<T> | T): Promise<T> => {
    const started = Date.now();
    const result = await load();
    options.logger?.({ module: "boot", event: "boot-plugin", layer: "core", plugin, ms: Date.now() - started });
    return result;
  };
  const fibers = [
    await timed("storage", () => ctx.plugin(storagePlugin)),
    await timed("telemetry", () => ctx.plugin(telemetryPlugin, { env })),
    await timed("media", () => ctx.plugin(mediaPlugin, { env, ...(options.mediaStorage ? { storage: options.mediaStorage } : {}) })),
    await timed("generation", () => ctx.plugin(generationPlugin, { env })),
    await timed("marketplace", () => ctx.plugin(marketplacePlugin)),
    await timed("admin-api", () => ctx.plugin(adminApiPlugin)),
    // 录制通道在 canvas 之前：canvas 的录制编排按 `ctx.get("recordingExecutor")` 懒取。
    await timed("recording-executor", () =>
      ctx.plugin(recordingExecutorPlugin, {
        env,
        ...(options.recordingCheckoutDirectory ? { checkoutDirectory: options.recordingCheckoutDirectory } : {})
      })
    ),
    await timed("task", () => ctx.plugin(taskPlugin, { env, ...(options.modelsConfig ? { modelsConfig: options.modelsConfig } : {}) })),
    await timed("canvas", () =>
      ctx.plugin(canvasPlugin, {
        env,
        ...(options.enableYjsSync !== undefined ? { enableYjsSync: options.enableYjsSync } : {}),
        ...(options.extensionHost ? { extensionHost: options.extensionHost } : {})
      })
    ),
    await timed("mcp", () => ctx.plugin(mcpPlugin, { env })),
    await timed("mcp-installation", () => ctx.plugin(mcpInstallationPlugin, { env, basePath: options.basePath ?? "/" })),
    await timed("application", () =>
      ctx.plugin(applicationPlugin, {
        env,
        basePath: options.basePath,
        ...(options.applicationExtensionMetadata ? { applicationExtensionMetadata: options.applicationExtensionMetadata } : {}),
        ...(options.applicationBackendExtensions ? { applicationBackendExtensions: options.applicationBackendExtensions } : {}),
        ...(options.chatgptServiceOptions ? { chatgptServiceOptions: options.chatgptServiceOptions } : {}),
        ...(options.extensionHost ? { extensionHost: options.extensionHost } : {}),
        ...(options.treeExtensions ? { treeExtensions: options.treeExtensions } : {}),
        ...(options.safeMode ? { safeMode: options.safeMode } : {})
      })
    ),
    // 排在 application 之后：卸载 / 观察期读站点控制面（按调用现取）。没有受管根时插件不提供服务。
    await timed("extension-manager", () => ctx.plugin(extensionManagerPlugin, { env, ...(options.extensionHost ? { extensionHost: options.extensionHost } : {}) }))
  ];
  registerHostPlugins(ctx, "core", plugins);
  return fibers;
}
