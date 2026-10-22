/**
 * ChatGPT extension 前端入口（真实实现 / 扫描约定入口）
 * （change: 2026-10-10-unify-extension-frontend-entry，任务 5.1 / design D5）。
 *
 * 本模块是 `web/extensions/oauth-agent/src/frontend/index.ts` 约定入口：构建期扫描器只读取本文件
 * 的 `descriptor`，形成静态可信前端入口集合。`descriptor.plugin()` 是无副作用工厂，宿主按
 * 服务端 active 状态在 Canvas scope 装配完整 Cordis plugin（见 `./plugin.js`）。
 *
 * 仅导入 `./plugin.js` 与 `./style.css`：CSS 由消费方打包器（Vite）按相对 import 加载，包构建
 * 以 copy loader 保留。
 */
import type { ExtensionFrontendDescriptor } from "@woohaa3/frontend/extension-api";
import { OAUTH_AGENT_FRONTEND_METADATA } from "./metadata.js";
import { oauthAgentExtension, oauthAgentSettingsExtension } from "./plugin.js";
import "./style.css";

export { oauthAgentExtension, oauthAgentSettingsExtension } from "./plugin.js";
export { OAUTH_AGENT_FRONTEND_METADATA } from "./metadata.js";
export type { OAuthAgentExtensionOptions } from "./plugin.js";

/** 构建期扫描读取的入口描述。`plugin()` 无副作用；常驻装配（`activation: "always"`）。 */
export const descriptor: ExtensionFrontendDescriptor = {
  ...OAUTH_AGENT_FRONTEND_METADATA,
  plugin: () => oauthAgentExtension(),
  // 设置专用入口（change: 2026-10-17-move-settings-into-canvas-dialog）：只装配授权面板。
  settingsPlugin: () => oauthAgentSettingsExtension()
};
