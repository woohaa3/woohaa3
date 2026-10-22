/**
 * 生产插件清单（change: adopt-frontend-cordis-plugin-runtime，design D1/D5；
 *   change: unify-canvas-presentation-navigation，task 2.3）。
 *
 * **静态可信**：所有 Plugin 都是本模块明确静态导入的代码。不存在从远端或用户配置解析
 * 模块名并执行任意前端代码的入口。
 *
 * 页面边界（view `frontend-navigation` / design D1）：
 * - Canvas page scope 使用 `createCanvasExtensionManifest()`；设置是画布壳内功能
 *   （change: 2026-10-17-move-settings-into-canvas-dialog：不再有独立 Settings page scope）；
 * - Task History page scope 使用 `createTaskHistoryExtensionManifest()`（不安装 Canvas 插件）；
 * - Telemetry 复盘页 scope 使用 `createTelemetryExtensionManifest()`（同样不安装 Canvas 插件）。
 */
import type { FrontendExtensionDefinition } from "./kernel.js";
import { taskHistoryExtension, TASK_HISTORY_PLUGIN_ID } from "./plugins/task-history/plugin.js";
import { telemetryExtension, TELEMETRY_PLUGIN_ID } from "./plugins/telemetry/plugin.js";

export type { ExtensionManifestOptions } from "./canvas-manifest.js";

export { createCanvasExtensionManifest } from "./canvas-manifest.js";
export {
  CONFIGURABLE_OPTIONAL_PLUGIN_IDS,
  canvasExtensionCatalogMetadata,
  builtinCanvasCatalogMetadata,
  resolveConfigurableOptionalIds
} from "./canvas-manifest.js";

/** Task History page scope 插件清单：只注册独立历史页面 route。 */
export function createTaskHistoryExtensionManifest(): FrontendExtensionDefinition[] {
  return [{ id: TASK_HISTORY_PLUGIN_ID, required: true, plugin: taskHistoryExtension }];
}

/**
 * Telemetry 复盘页 scope 插件清单：只注册 `/telemetry` 页面 route。
 *
 * 与 Canvas scope 无关：复盘是独立页面，不需要画布会话、渲染或任何 Canvas 插件。
 * 它也不进 `CANVAS_PLUGIN_CATALOG`——那个目录是 Canvas page scope 的装配清单。
 */
export function createTelemetryExtensionManifest(): FrontendExtensionDefinition[] {
  return [{ id: TELEMETRY_PLUGIN_ID, required: true, plugin: telemetryExtension }];
}
