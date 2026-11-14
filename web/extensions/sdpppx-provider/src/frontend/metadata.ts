/**
 * SDPPPX 前端身份（纯 JSON 可序列化数据）。
 *
 * `activation: "server-active"`：供应商登录入口与设置面板都以宿主插件已激活为前提；扩展未启用时
 * 不占位。`settingsPanel: true` 声明本扩展在设置弹窗里有自己的详情面板。
 */
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";
import { EXTENSION_SDK_ABI_VERSION } from "@woohaa3/contracts";
import { SDPPPX_PLUGIN_ID } from "../shared.js";

export const SDPPPX_FRONTEND_METADATA: ExtensionFrontendMetadata = {
  extensionId: SDPPPX_PLUGIN_ID,
  version: "0.1.1",
  label: "SDPPPX",
  description: "sdpppx 微信扫码登录与租户模板生成。登录后把当前租户的模板投影为生成模型。",
  icon: "identity",
  activation: "server-active",
  configScope: "site",
  required: false,
  sdkAbi: EXTENSION_SDK_ABI_VERSION,
  settingsPanel: true
};
