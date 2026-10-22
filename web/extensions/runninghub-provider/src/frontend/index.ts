/**
 * RunningHub extension 前端入口（扫描约定入口）
 * （change: 2026-10-10-extract-optional-feature-extensions，任务 3.1/3.2 / design D1/D3）。
 *
 * `web/extensions/runninghub-provider/src/frontend/index.ts` 是构建期可信扫描入口：扫描器只
 * 读取 `descriptor`。`descriptor.plugin()` 是无副作用工厂；宿主按**服务端 `runninghub-provider`
 * 实际 active 状态**（server-active reconciler）在 Canvas page scope 装配 App 专用交互面板。
 *
 * 入口使用与后端相同的稳定 identity `runninghub-provider`，不另建可独立开关的
 * `runninghub-app-interaction` extension；interaction identity `runninghub-app@1` 保留，
 * registration owner 改为包的稳定 extension identity。
 *
 * 仅导入 `./plugin.js`：无专属 CSS（面板复用公共 ExecutionPanel 样式）。
 */
import type { ExtensionFrontendDescriptor } from "@woohaa3/frontend/extension-api";
import { RUNNINGHUB_FRONTEND_METADATA } from "./metadata.js";
import { runningHubAppInteractionExtension } from "./plugin.js";

export { runningHubAppInteractionExtension } from "./plugin.js";
export { RUNNINGHUB_FRONTEND_METADATA } from "./metadata.js";
export { RUNNINGHUB_APP_INTERACTION_ID, RUNNINGHUB_APP_INTERACTION_VERSION, RunningHubAppPanel } from "./runninghub-app-panel.js";

/**
 * 构建期扫描读取的入口描述。`plugin()` 无副作用；服务端 active 装配（`server-active`）。
 * 站点扩展：`runninghub-provider` 的 App 专用交互随其实际状态失效/恢复。
 */
export const descriptor: ExtensionFrontendDescriptor = {
  ...RUNNINGHUB_FRONTEND_METADATA,
  plugin: () => runningHubAppInteractionExtension()
};
