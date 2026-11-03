/**
 * prompt-skills 设置面板的注册入口（change: prompt-skill-config-in-plugin）。
 *
 * 同一份注册逻辑被两处使用：
 * - 扩展**已激活**时，主 plugin 注册设置面板（宿主此时不会加载设置专用工厂）；
 * - 扩展**未激活**时，宿主按需调用 `settingsPlugin()`，这里只注册面板，不启动改写入口。
 *
 * 面板只拿有界能力（`requestClose` / `reportEditState`）；数据经扩展自己的公开路由。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import type { ApplicationRemoteService, SlotsService } from "@woohaa3/frontend/extension-api";
import { PROMPT_SKILLS_PLUGIN_ID } from "../shared.js";
import { PromptSkillsSettingsPanel } from "./settings-panel.js";
import { createPromptSkillsSettingsRemote, type PromptSkillsSettingsRemote } from "./settings-remote.js";

type PromptSkillsSettingsContext = Context & {
  slots: SlotsService;
  applicationRemote: ApplicationRemoteService;
};

export type PromptSkillsSettingsExtensionOptions = {
  remote?: PromptSkillsSettingsRemote;
};

export function registerPromptSkillsSettingsPanel(
  ctx: PromptSkillsSettingsContext,
  options: PromptSkillsSettingsExtensionOptions = {}
): () => void {
  const remote = options.remote ?? createPromptSkillsSettingsRemote({
    transport: ctx.applicationRemote.transport
  });
  return ctx.slots.register("settings.plugin-config", {
    id: "prompt-skills-settings",
    owner: PROMPT_SKILLS_PLUGIN_ID,
    pluginId: PROMPT_SKILLS_PLUGIN_ID,
    render: ({ reportEditState }) => (
      <PromptSkillsSettingsPanel
        remote={remote}
        {...(reportEditState ? { reportEditState } : {})}
      />
    )
  });
}

export function promptSkillsSettingsExtension(
  options: PromptSkillsSettingsExtensionOptions = {}
): Plugin.Function<void> {
  return defineExtensionPlugin<PromptSkillsSettingsContext>(
    (ctx) => {
      const dispose = registerPromptSkillsSettingsPanel(ctx, options);
      ctx.effect(() => () => dispose(), "prompt-skills-settings");
    },
    { name: `${PROMPT_SKILLS_PLUGIN_ID}-settings`, inject: ["slots", "applicationRemote"] }
  );
}
