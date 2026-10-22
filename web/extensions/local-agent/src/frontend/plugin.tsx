import { AgentAssistantSettingsLink, openAgentAssistant } from "@woohaa3/frontend/extension-api";
/**
 * local-agent 前端 plugin（Cordis apply）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 2.5/3.1 / design D1/D8）。
 *
 * 拥有本扩展业务 service（连接 remote），贡献连接设置面板与每个本机 adapter 的生成入口。
 * 依赖宿主注入的 `slots`/`applicationRemote`；dispose 只释放本 scope 展示，不停止服务端进程
 * （进程由服务端停用/执行生命周期管理）。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import type { ApplicationRemoteService, SlotsService } from "@woohaa3/frontend/extension-api";
import { LOCAL_AGENT_ADAPTERS, LOCAL_AGENT_PLUGIN_ID } from "../shared.js";
import { createLocalAgentRemote, type LocalAgentRemote } from "./remote.js";
import { LocalAgentSettingsPanel } from "./settings-panel.js";

type ExtensionContext = Context & {
  slots: SlotsService;
  applicationRemote: ApplicationRemoteService;
};

export type LocalAgentExtensionOptions = {
  remote?: LocalAgentRemote;
};

/**
 * 设置专用工厂：只注册 `settings.plugin-config` 面板，不检测/轮询本机服务、不注册生成入口。
 *
 * 宿主在扩展未激活、用户打开其设置详情时按需装配；关闭设置即释放该 fiber。
 */
export function localAgentSettingsExtension(_options: LocalAgentExtensionOptions = {}): Plugin.Function<void> {
  return defineExtensionPlugin<ExtensionContext>(
    (ctx) => {
      const removeSettingsPanel = ctx.slots.register("settings.plugin-config", {
        id: "local-agent-settings-panel",
        owner: LOCAL_AGENT_PLUGIN_ID,
        priority: 20,
        pluginId: LOCAL_AGENT_PLUGIN_ID,
        render: ({ requestClose }) => <AgentAssistantSettingsLink onOpen={() => { requestClose?.(); openAgentAssistant(ctx.appRouter, "installed"); }} />
      });
      ctx.effect(() => () => removeSettingsPanel(), "local-agent-settings-panel");
    },
    { name: `${LOCAL_AGENT_PLUGIN_ID}-settings`, inject: ["slots", "appRouter"] }
  );
}

export function localAgentExtension(options: LocalAgentExtensionOptions = {}): Plugin.Function<void> {
  return defineExtensionPlugin<ExtensionContext>(
    (ctx) => {
      const remote = options.remote ?? createLocalAgentRemote({ transport: ctx.applicationRemote.transport });

      const removeSettings = ctx.slots.register("agent-assistant.configuration", {
        id: "local-agent-settings",
        owner: LOCAL_AGENT_PLUGIN_ID,
        priority: 20,
        kind: "installed",
        label: "使用已安装工具",
        render: (props) => <LocalAgentSettingsPanel remote={remote} {...props} onOpenRuntimes={() => {
          void (ctx.get("settingsOpen" as never) as { open(input: { section: "runtimes" }): Promise<unknown> } | undefined)?.open({ section: "runtimes" });
        }} />
      });
      ctx.effect(() => () => removeSettings(), "local-agent-settings");

      // 设置「插件详情 → 本机 Agent 来源」的配置入口（任务 10.1）。
      const removeSettingsPanel = ctx.slots.register("settings.plugin-config", {
        id: "local-agent-settings-panel",
        owner: LOCAL_AGENT_PLUGIN_ID,
        priority: 20,
        pluginId: LOCAL_AGENT_PLUGIN_ID,
        render: ({ requestClose }) => <AgentAssistantSettingsLink onOpen={() => { requestClose?.(); openAgentAssistant(ctx.appRouter, "installed"); }} />
      });
      ctx.effect(() => () => removeSettingsPanel(), "local-agent-settings-panel");

      for (const adapter of LOCAL_AGENT_ADAPTERS) {
        // 只声明来源身份；面板 UI 由宿主内置渲染（任务 9.4 / design D10）。
        const removeGenerate = ctx.slots.register("authoring.generate", {
          id: `local-agent-generate-${adapter.adapterId}`,
          owner: LOCAL_AGENT_PLUGIN_ID,
          priority: 10,
          sourceId: adapter.adapterId,
          sourceLabel: adapter.label
        });
        ctx.effect(() => () => removeGenerate(), `local-agent-generate-${adapter.adapterId}`);
      }
    },
    { name: LOCAL_AGENT_PLUGIN_ID, inject: ["slots", "applicationRemote", "appRouter"] }
  );
}
