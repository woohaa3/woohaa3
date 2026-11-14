/**
 * sdk-agent extension 纯前端 metadata
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 3.1 / design D1）。
 *
 * 只导出 JSON 可序列化数据；`index.ts` 的 descriptor 复用本 metadata。
 * `server-active` + `required:false`：随服务端实际 active 状态装配，停用/失败隔离，不影响画布。
 */
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";
import { EXTENSION_SDK_ABI_VERSION } from "@woohaa3/contracts";
import { SDK_AGENT_PLUGIN_ID } from "../shared.js";

export const SDK_AGENT_FRONTEND_METADATA: ExtensionFrontendMetadata = {
  extensionId: SDK_AGENT_PLUGIN_ID,
  version: "0.1.2",
  label: "SDK Agent 来源",
  description: "配置 Responses / Messages / Chat Completions / Gemini 协议的服务地址和 API Key。",
  icon: "agent",
  activation: "server-active",
  configScope: "site",
  required: false,
  sdkAbi: EXTENSION_SDK_ABI_VERSION,
  settingsPanel: true
};
