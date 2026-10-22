/**
 * sdk-agent extension 前端入口（扫描约定入口）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 3.1 / design D1）。
 *
 * `src/frontend/index.ts` 是构建期可信扫描入口：扫描器只读取 `descriptor`。
 * `descriptor.plugin()` 无副作用；宿主按**服务端 `sdk-agent` 实际 active 状态**（server-active
 * reconciler）装配本插件，扩展停用/失败时设置与生成入口随 owner 释放。
 */
import type { ExtensionFrontendDescriptor } from "@woohaa3/frontend/extension-api";
import { SDK_AGENT_FRONTEND_METADATA } from "./metadata.js";
import { sdkAgentExtension, sdkAgentSettingsExtension } from "./plugin.js";

export { sdkAgentExtension, sdkAgentSettingsExtension } from "./plugin.js";
export { SDK_AGENT_FRONTEND_METADATA } from "./metadata.js";
export { createSdkAgentRemote, type SdkAgentRemote, type SdkAgentConnectionView } from "./remote.js";
export { SdkAgentSettingsPanel } from "./settings-panel.js";

export const descriptor: ExtensionFrontendDescriptor = {
  ...SDK_AGENT_FRONTEND_METADATA,
  plugin: () => sdkAgentExtension(),
  // 设置专用入口（change: 2026-10-17-move-settings-into-canvas-dialog）：只装配面板，
  // 不启动生成入口/业务订阅；宿主仅在未激活时按需使用。
  settingsPlugin: () => sdkAgentSettingsExtension()
};
