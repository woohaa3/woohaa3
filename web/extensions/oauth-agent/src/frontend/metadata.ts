/**
 * ChatGPT extension 纯前端 metadata
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 1.2 / design D4）。
 *
 * 只导出 JSON 可序列化数据：稳定 extensionId、version、label、description、activation、
 * configScope、required 与 SDK ABI。MUST NOT 引用 plugin/UI/CSS/业务 store 或后端校验实现。
 * `index.ts` 的 descriptor 复用本 metadata，避免重复维护 activation/required。
 */
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";
import { EXTENSION_SDK_ABI_VERSION } from "@woohaa3/contracts";
import { OAUTH_AGENT_PLUGIN_ID } from "../shared.js";

export const OAUTH_AGENT_FRONTEND_METADATA: ExtensionFrontendMetadata = {
  extensionId: OAUTH_AGENT_PLUGIN_ID,
  version: "1.0.2",
  label: "OAuth Agent 来源",
  description: "个人 OAuth 授权与连接（首个 provider：ChatGPT）。",
  icon: "identity",
  activation: "always",
  configScope: "site",
  required: true,
  sdkAbi: EXTENSION_SDK_ABI_VERSION,
  settingsPanel: true
};
