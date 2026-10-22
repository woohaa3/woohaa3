/**
 * Extension SDK `core` 能力分组（宿主 adapter）
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 2.2 / design D2）。
 *
 * 分组按当前公开 `@woohaa3/frontend/extension-api` 导出归属整理：本组只含**入口/plugin 定义辅助**
 * 与 capability key 常量。扩展无法用私有宿主文件路径绕过公共入口——这些 adapter 全部从公共
 * barrel 取具名导出，禁止对整个 barrel 做 namespace 展开（design D2）。
 */
import { defineExtensionFrontend, defineExtensionPlugin } from "../../extension-api/entry.js";
import { PROMPT_SNIPPET_SOURCE } from "../../extension-api/capability-keys.js";
import { desktopBootstrap, isDesktopHost } from "../../extension-api/host-platform.js";
import {
  resolvePublicUrl,
  toLogicalAppPath,
  AgentAssistantSettingsLink,
  openAgentAssistant,
  appBuildVersion
} from "../../extension-api/index.js";
import type { ExtensionSdkGroupModule } from "./sdk-groups.js";

export const group = "core" as const;

export const namedExports = {
  defineExtensionFrontend,
  defineExtensionPlugin,
  PROMPT_SNIPPET_SOURCE,
  // change: 2026-10-15-support-configurable-app-base-path，design D6：通用公开 URL 能力。
  resolvePublicUrl,
  toLogicalAppPath,
  AgentAssistantSettingsLink,
  openAgentAssistant,
  // change: 2026-10-18-split-performance-readout-location：运行宿主判定（桌面壳 / 浏览器）。
  desktopBootstrap,
  isDesktopHost,
  // 构建标识：扩展（如 remote-server 的诊断上报）要把自己跑的是哪次构建告诉宿主/服务端。
  // 扩展是独立构建的，只能由宿主把这个值交过去。
  appBuildVersion
} satisfies Record<string, unknown>;

const module: ExtensionSdkGroupModule = { group, namedExports };
export default module;
