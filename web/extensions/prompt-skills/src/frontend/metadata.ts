/**
 * prompt-skills 前端 metadata（纯 JSON 数据，唯一身份来源）。
 *
 * `server-active` + `required:false`：改写依赖本机宿主的扩展后端与语言模型目录，
 * 因此只在宿主报告该扩展已激活时装配；停用/失败不影响画布本身。
 */
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";
import { EXTENSION_SDK_ABI_VERSION } from "@woohaa3/contracts";
import { PROMPT_SKILLS_PLUGIN_ID } from "../shared.js";

export const PROMPT_SKILLS_FRONTEND_METADATA: ExtensionFrontendMetadata = {
  extensionId: PROMPT_SKILLS_PLUGIN_ID,
  version: "0.1.0",
  label: "提示词快捷改写",
  description: "把执行面板的快捷改写交给站点语言模型：润色、翻译、分层整理、风格迁移与 Loop 动态提示词。",
  activation: "server-active",
  configScope: "site",
  required: false,
  sdkAbi: EXTENSION_SDK_ABI_VERSION,
  // 改写模型属于插件配置：设置弹窗按需加载本扩展的设置专属入口。
  settingsPanel: true
};
