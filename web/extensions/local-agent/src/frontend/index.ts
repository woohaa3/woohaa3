/**
 * local-agent extension 前端入口（扫描约定入口）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 3.1 / design D1）。
 *
 * `src/frontend/index.ts` 是构建期可信扫描入口：扫描器只读取 `descriptor`。
 * `descriptor.plugin()` 无副作用；宿主按**服务端 `local-agent` 实际 active 状态**装配本插件
 * （`server-active` + `required:false`），扩展停用/失败时设置与生成入口随 owner 释放。
 */
import type { ExtensionFrontendDescriptor } from "@woohaa3/frontend/extension-api";
import { LOCAL_AGENT_FRONTEND_METADATA } from "./metadata.js";
import { localAgentExtension, localAgentSettingsExtension } from "./plugin.js";

export { localAgentExtension, localAgentSettingsExtension } from "./plugin.js";
export { LOCAL_AGENT_FRONTEND_METADATA } from "./metadata.js";
export { createLocalAgentRemote, type LocalAgentRemote, type LocalAgentConnectionView } from "./remote.js";
export { LocalAgentSettingsPanel } from "./settings-panel.js";

export const descriptor: ExtensionFrontendDescriptor = {
  ...LOCAL_AGENT_FRONTEND_METADATA,
  plugin: () => localAgentExtension(),
  // 设置专用入口（change: 2026-10-17-move-settings-into-canvas-dialog）：只装配面板。
  settingsPlugin: () => localAgentSettingsExtension()
};
