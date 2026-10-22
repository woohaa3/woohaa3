import { AgentAssistantSettingsLink, openAgentAssistant } from "@woohaa3/frontend/extension-api";
/**
 * ChatGPT extension 前端 plugin（Cordis apply、service 与 UI 接线）
 * （change: 2026-10-10-unify-extension-frontend-entry，任务 5.1 / design D5）。
 *
 * plugin 在自身 scope 拥有 ChatGPT 业务 service，贡献授权行（`provider-credentials.top`）与
 * authoring 生成面板（`authoring.generate`），监听同源授权回调消息，并在 dispose 时按 owner
 * 释放；**不**清除服务端持久授权或已提交的画布内容。
 *
 * extension 经宿主注入的 Context 使用 `slots`/`applicationRemote`；业务 remote 复用宿主注入的
 * Application Remote 通用传输，不自建 fetch/EventSource。业务 service 由本插件
 * `ctx.provide("chatgpt", …)`，保留既有依赖等待与可释放生命周期。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import type {
  ApplicationRemoteService,
  SlotsService
} from "@woohaa3/frontend/extension-api";
import { OAUTH_AGENT_PLUGIN_ID, OAUTH_AGENT_PROVIDERS } from "../shared.js";
import { createChatGptRemote } from "./remote.js";
import { createChatGptService, type ChatGptService } from "./service.js";
import { ChatGptAuthorizationRow } from "./authorization-row.js";

/**
 * 宿主在 extension scope 注入的能力（`inject` 声明的服务）。
 * extension 业务 Service 类型由本包拥有；宿主 Context 不声明业务内部路径。
 */
type ExtensionContext = Context & {
  slots: SlotsService;
  applicationRemote: ApplicationRemoteService;
};

const AUTH_ROW_ID = "chatgpt-auth-row";
const GENERATE_ID = "chatgpt-generate";

export type OAuthAgentExtensionOptions = {
  /** 使用已提供的 ChatGPT service（测试注入）；缺省自建并注册。 */
  service?: ChatGptService;
};

/**
 * 设置专用工厂：只注册 `settings.plugin-config` 授权面板，不注册生成入口、不监听授权回调、
 * 不建立额外轮询（change: 2026-10-17-move-settings-into-canvas-dialog，任务 5.2）。
 *
 * 仅提供跳转同一 AI 助手的入口，不启动授权 service。
 */
export function oauthAgentSettingsExtension(): Plugin.Function<void> {
  return defineExtensionPlugin<ExtensionContext>(
    (ctx) => {
      const removeSettingsPanel = ctx.slots.register("settings.plugin-config", {
        id: "chatgpt-settings-panel",
        owner: OAUTH_AGENT_PLUGIN_ID,
        priority: 0,
        pluginId: OAUTH_AGENT_PLUGIN_ID,
        render: ({ requestClose }) => <AgentAssistantSettingsLink onOpen={() => { requestClose?.(); openAgentAssistant(ctx.appRouter, "login"); }} />
      });
      ctx.effect(() => () => removeSettingsPanel(), "chatgpt-settings-panel");
    },
    { name: `${OAUTH_AGENT_PLUGIN_ID}-settings`, inject: ["slots", "appRouter"] }
  );
}

export function oauthAgentExtension(options: OAuthAgentExtensionOptions = {}): Plugin.Function<void> {
  return defineExtensionPlugin<ExtensionContext>(
    (ctx) => {
      // 本插件**拥有**其业务 service：仅当外部显式注入（测试）时才复用；否则自建并注册。
      const existing = ctx.get("chatgpt" as never) as ChatGptService | undefined;
      const service =
        options.service ??
        existing ??
        createChatGptService({ remote: createChatGptRemote({ transport: ctx.applicationRemote.transport }) });
      const ownsService = !existing && !options.service;
      if (ownsService) {
        ctx.provide("chatgpt" as never, service as never);
        service.start();
      }

      const removeRow = ctx.slots.register("agent-assistant.configuration", {
        id: AUTH_ROW_ID,
        owner: OAUTH_AGENT_PLUGIN_ID,
        priority: 0,
        kind: "login",
        label: "登录 ChatGPT",
        render: () => <ChatGptAuthorizationRow service={service} onOpenRuntimes={() => {
          void (ctx.get("settingsOpen" as never) as { open(input: { section: "runtimes" }): Promise<unknown> } | undefined)?.open({ section: "runtimes" });
        }} />
      });
      ctx.effect(() => () => removeRow(), "chatgpt-auth-row");

      // 设置「插件详情 → OAuth Agent 来源」也打开同一份授权面板（任务 10.1）。
      const removeSettingsPanel = ctx.slots.register("settings.plugin-config", {
        id: "chatgpt-settings-panel",
        owner: OAUTH_AGENT_PLUGIN_ID,
        priority: 0,
        pluginId: OAUTH_AGENT_PLUGIN_ID,
        render: ({ requestClose }) => <AgentAssistantSettingsLink onOpen={() => { requestClose?.(); openAgentAssistant(ctx.appRouter, "login"); }} />
      });
      ctx.effect(() => () => removeSettingsPanel(), "chatgpt-settings-panel");

      // 来源 = provider 列表（任务 9.6 / design D11）：ChatGPT 是第一个 provider，新增 OAuth
      // 厂商只需向 `OAUTH_AGENT_PROVIDERS` 添加声明；生成面板 UI 由宿主内置渲染（design D10）。
      for (const provider of OAUTH_AGENT_PROVIDERS) {
        const removeGenerate = ctx.slots.register("authoring.generate", {
          id: `${GENERATE_ID}-${provider.providerId}`,
          owner: OAUTH_AGENT_PLUGIN_ID,
          priority: 0,
          sourceId: provider.providerId,
          sourceLabel: provider.label
        });
        ctx.effect(() => () => removeGenerate(), `chatgpt-generate-${provider.providerId}`);
      }

      // 同源授权回调消息：只通知主页面刷新状态，不传 token。
      const onMessage = (event: MessageEvent) => {
        const data = event.data as { type?: unknown } | null;
        if (data && data.type === "woohaa3-chatgpt-auth") service.onAuthMessage();
      };
      globalThis.addEventListener?.("message", onMessage);
      ctx.effect(() => () => globalThis.removeEventListener?.("message", onMessage), "chatgpt-auth-message");

      // 资源所有权：自建 service 时 dispose；复用注入 service 时只停止本 scope 的展示轮询
      // （不清除服务端凭据或已提交内容）。
      if (ownsService) {
        ctx.effect(() => () => service.dispose(), "chatgpt-service");
      } else {
        ctx.effect(() => () => service.stop(), "chatgpt-service-stop");
      }
    },
    { name: OAUTH_AGENT_PLUGIN_ID, inject: ["slots", "applicationRemote", "appRouter"], provide: "chatgpt" }
  );
}
