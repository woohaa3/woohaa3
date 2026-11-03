/**
 * prompt-skills 前端 plugin（Cordis apply）。
 *
 * 贡献 `execution.prompt-skill`：执行面板选中快捷改写项后调用本扩展的 `rewrite`，
 * 返回文本交给 Host 写回草稿。进行中/错误状态由面板与 Host 呈现，本插件不持有草稿。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import type { ApplicationRemoteService, SlotsService } from "@woohaa3/frontend/extension-api";
import { PROMPT_SKILLS_PLUGIN_ID } from "../shared.js";
import { createPromptSkillsRemote, type PromptSkillsRemote } from "./remote.js";
import { registerPromptSkillsSettingsPanel } from "./settings-plugin.js";
import type { PromptSkillsSettingsRemote } from "./settings-remote.js";

type PromptSkillsContext = Context & {
  slots: SlotsService;
  applicationRemote: ApplicationRemoteService;
};

export type PromptSkillsExtensionOptions = {
  remote?: PromptSkillsRemote;
  /** 设置面板的数据出口（测试注入；缺省经宿主 transport 访问扩展路由）。 */
  settingsRemote?: PromptSkillsSettingsRemote;
  /** 请求幂等身份工厂（测试注入确定性值）。 */
  newRequestId?: () => string;
};

/**
 * 生成一次请求的幂等身份。
 *
 * `crypto.randomUUID` 只在安全上下文（https / localhost）存在；内网 http 访问时没有它，
 * 这里用 `getRandomValues` 或时间戳兜底，避免点一下改写就抛错。
 */
function randomRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  const random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${Date.now().toString(16)}${random}`;
}

export function promptSkillsExtension(options: PromptSkillsExtensionOptions = {}): Plugin.Function<void> {
  return defineExtensionPlugin<PromptSkillsContext>(
    (ctx) => {
      const remote = options.remote ?? createPromptSkillsRemote({ transport: ctx.applicationRemote.transport });
      const newRequestId = options.newRequestId ?? randomRequestId;
      const dispose = ctx.slots.register("execution.prompt-skill", {
        id: "prompt-skills-rewrite",
        owner: PROMPT_SKILLS_PLUGIN_ID,
        rewrite: async (input) => {
          if (input.prompt.trim() === "") return { error: "请先输入提示词" };
          const result = await remote.rewrite({
            requestId: newRequestId(),
            skillId: input.skill.id,
            label: input.skill.label,
            prompt: input.prompt,
            canvasId: input.canvasId,
            nodeId: input.nodeId,
            taskKind: input.taskKind
          });
          return result.ok ? { prompt: result.prompt } : { error: result.error };
        }
      });
      ctx.effect(() => () => dispose(), "prompt-skills-slot");
      // 扩展已激活时宿主不会加载设置专用工厂：面板必须由主 plugin 一起注册。
      const disposeSettings = registerPromptSkillsSettingsPanel(ctx, {
        ...(options.settingsRemote ? { remote: options.settingsRemote } : {})
      });
      ctx.effect(() => () => disposeSettings(), "prompt-skills-settings");
    },
    { name: PROMPT_SKILLS_PLUGIN_ID, inject: ["slots", "applicationRemote"] }
  );
}
