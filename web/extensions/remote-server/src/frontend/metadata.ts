/**
 * remote-server 前端 metadata（纯浏览器数据，JSON 可序列化，唯一身份来源）。
 *
 * `activation: "server-active"`：本扩展的徽标依赖本机宿主提供的连接状态，
 * 因此只在宿主报告它已激活时装配；未激活时不占位、不显示一个点不动的「连接」。
 *
 * `settingsPanel: true` 声明「本扩展有设置面板」：接入面是**设置弹窗里的插件详情**
 * （`settings.plugin-config`），不是独立页面，所以这里不再声明 `appPages`。
 */
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";
import { EXTENSION_SDK_ABI_VERSION } from "@woohaa3/contracts";
import { REMOTE_SERVER_EXTENSION_ID, REMOTE_SERVER_METADATA } from "../shared.js";

export const REMOTE_SERVER_FRONTEND_METADATA: ExtensionFrontendMetadata = {
  extensionId: REMOTE_SERVER_EXTENSION_ID,
  version: REMOTE_SERVER_METADATA.version,
  label: REMOTE_SERVER_METADATA.name,
  description: REMOTE_SERVER_METADATA.description,
  icon: "network",
  activation: "server-active",
  configScope: "site",
  required: false,
  sdkAbi: EXTENSION_SDK_ABI_VERSION,
  settingsPanel: true
};
