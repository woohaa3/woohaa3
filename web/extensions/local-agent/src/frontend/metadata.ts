/**
 * local-agent extension 纯前端 metadata
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 3.1 / design D1）。
 *
 * `server-active` + `required:false`：随服务端实际 active 状态装配；停用/失败隔离，不影响画布。
 */
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";
import { EXTENSION_SDK_ABI_VERSION } from "@woohaa3/contracts";
import { LOCAL_AGENT_PLUGIN_ID } from "../shared.js";

export const LOCAL_AGENT_FRONTEND_METADATA: ExtensionFrontendMetadata = {
  extensionId: LOCAL_AGENT_PLUGIN_ID,
  version: "0.1.0",
  label: "本地 agent",
  description: "连接运行本应用的电脑上的本地 ChatGPT / 本地 OpenCode / 本地 CodeBuddy（默认关闭）。",
  icon: "agent",
  activation: "server-active",
  configScope: "site",
  required: false,
  sdkAbi: EXTENSION_SDK_ABI_VERSION,
  settingsPanel: true
};
