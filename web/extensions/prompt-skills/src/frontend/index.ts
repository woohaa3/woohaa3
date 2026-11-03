/**
 * prompt-skills 前端入口（扫描约定入口）：只转出 `descriptor` 与公开类型。
 */
import type { ExtensionFrontendDescriptor } from "@woohaa3/frontend/extension-api";
import { PROMPT_SKILLS_FRONTEND_METADATA } from "./metadata.js";
import { promptSkillsExtension } from "./plugin.js";
import { promptSkillsSettingsExtension } from "./settings-plugin.js";

export { promptSkillsExtension } from "./plugin.js";
export type { PromptSkillsExtensionOptions } from "./plugin.js";
export { promptSkillsSettingsExtension } from "./settings-plugin.js";
export type { PromptSkillsSettingsExtensionOptions } from "./settings-plugin.js";
export { PROMPT_SKILLS_FRONTEND_METADATA } from "./metadata.js";
export { createPromptSkillsRemote, type PromptSkillsRemote } from "./remote.js";
export { createPromptSkillsSettingsRemote, type PromptSkillsSettingsRemote } from "./settings-remote.js";
export { PromptSkillsSettingsPanel } from "./settings-panel.js";

export const descriptor: ExtensionFrontendDescriptor = {
  ...PROMPT_SKILLS_FRONTEND_METADATA,
  plugin: () => promptSkillsExtension(),
  settingsPlugin: () => promptSkillsSettingsExtension()
};
