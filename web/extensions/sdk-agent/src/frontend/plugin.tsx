import { AgentAssistantSettingsLink, openAgentAssistant } from "@woohaa3/frontend/extension-api";
/**
 * sdk-agent 前端 plugin（Cordis apply）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 2.5/3.1 / design D1/D8）。
 *
 * 拥有本扩展的业务 service（连接 remote），并：
 * - 贡献连接设置面板到 `provider-credentials.top`（API Key 填写/测试/替换/清除）；
 * - 为每个 adapter 贡献 `authoring.generate`（`sourceId` = adapterId），供宿主多来源选择。
 *
 * 依赖宿主注入的 `slots` 与 `applicationRemote`；不自建 fetch。dispose 只释放本 scope 展示，
 * 不清除服务端凭据或画布内容。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import type { ApplicationRemoteService, SlotsService } from "@woohaa3/frontend/extension-api";
import { SDK_AGENT_ADAPTERS, SDK_AGENT_PLUGIN_ID } from "../shared.js";
import { createSdkAgentRemote, type SdkAgentRemote } from "./remote.js";
import { SdkAgentSettingsPanel } from "./settings-panel.js";

type ExtensionContext = Context & {
  slots: SlotsService;
  applicationRemote: ApplicationRemoteService;
};

export type SdkAgentExtensionOptions = {
  /** 测试注入 remote。 */
  remote?: SdkAgentRemote;
};

/**
 * 设置专用工厂：只注册 `settings.plugin-config` 面板，不启动生成入口或业务轮询。
 *
 * 宿主在扩展未激活、用户打开其设置详情时按需装配；关闭设置即释放该 fiber。
 */
export function sdkAgentSettingsExtension(_options: SdkAgentExtensionOptions = {}): Plugin.Function<void> {
  return defineExtensionPlugin<ExtensionContext>(
    (ctx) => {
      const removeSettingsPanel = ctx.slots.register("settings.plugin-config", {
        id: "sdk-agent-settings-panel",
        owner: SDK_AGENT_PLUGIN_ID,
        priority: 10,
        pluginId: SDK_AGENT_PLUGIN_ID,
        render: ({ requestClose }) => <AgentAssistantSettingsLink onOpen={() => { requestClose?.(); openAgentAssistant(ctx.appRouter, "api-key"); }} />
      });
      ctx.effect(() => () => removeSettingsPanel(), "sdk-agent-settings-panel");
    },
    { name: `${SDK_AGENT_PLUGIN_ID}-settings`, inject: ["slots", "appRouter"] }
  );
}

export function sdkAgentExtension(options: SdkAgentExtensionOptions = {}): Plugin.Function<void> {
  return defineExtensionPlugin<ExtensionContext>(
    (ctx) => {
      const remote = options.remote ?? createSdkAgentRemote({ transport: ctx.applicationRemote.transport });

      const removeSettings = ctx.slots.register("agent-assistant.configuration", {
        id: "sdk-agent-settings",
        owner: SDK_AGENT_PLUGIN_ID,
        priority: 10,
        kind: "api-key",
        label: "使用 API Key",
        render: (props) => <SdkAgentSettingsPanel remote={remote} {...props} />
      });
      ctx.effect(() => () => removeSettings(), "sdk-agent-settings");

      // 设置「插件详情 → SDK Agent 来源」的配置入口（任务 10.1）。
      const removeSettingsPanel = ctx.slots.register("settings.plugin-config", {
        id: "sdk-agent-settings-panel",
        owner: SDK_AGENT_PLUGIN_ID,
        priority: 10,
        pluginId: SDK_AGENT_PLUGIN_ID,
        render: ({ requestClose }) => <AgentAssistantSettingsLink onOpen={() => { requestClose?.(); openAgentAssistant(ctx.appRouter, "api-key"); }} />
      });
      ctx.effect(() => () => removeSettingsPanel(), "sdk-agent-settings-panel");

      for (const adapter of SDK_AGENT_ADAPTERS) {
        // 只声明来源身份；面板 UI 由宿主内置渲染（任务 9.4 / design D10）。
        const removeGenerate = ctx.slots.register("authoring.generate", {
          id: `sdk-agent-generate-${adapter.adapterId}`,
          owner: SDK_AGENT_PLUGIN_ID,
          priority: 10,
          sourceId: adapter.adapterId,
          sourceLabel: adapter.label
        });
        ctx.effect(() => () => removeGenerate(), `sdk-agent-generate-${adapter.adapterId}`);
      }
    },
    { name: SDK_AGENT_PLUGIN_ID, inject: ["slots", "applicationRemote", "appRouter"] }
  );
}
