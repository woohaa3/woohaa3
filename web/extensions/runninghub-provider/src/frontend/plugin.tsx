/**
 * RunningHub App Interaction Plugin
 * （change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 5.2 / design D7；
 *   change: 2026-10-10-extract-optional-feature-extensions，任务 3.1：迁入 runninghub-provider
 *   包，并在服务端 `runninghub-provider` 实际 active 时由前端 reconciler 装配）。
 *
 * 在 activation 中把 `runninghub-app@1` 注册进 page-scoped `modelInteractions` Registry。
 * 这是 RunningHub App 工作流的专用交互；generic 仍承载普通 text/image/video/audio。
 * 不在 import evaluation 产生全局副作用；disposer 幂等且随 Canvas page scope 释放，
 * 因此服务端 disable/draining/failed/unconfigured 时专用面板随 owner 释放。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import type {
  ApplicationRemoteService,
  ModelInteractionRegistry,
  SlotsService
} from "@woohaa3/frontend/extension-api";
import { RUNNINGHUB_PLUGIN_ID, RUNNINGHUB_PROVIDER_ID } from "../shared.js";
import {
  RunningHubAppPanel,
  RUNNINGHUB_APP_INTERACTION_ID,
  RUNNINGHUB_APP_INTERACTION_VERSION
} from "./runninghub-app-panel.js";
import { createRunningHubProviderBalanceRenderer } from "./provider-balance.js";

export { RUNNINGHUB_PLUGIN_ID } from "../shared.js";
export { RUNNINGHUB_APP_INTERACTION_ID, RUNNINGHUB_APP_INTERACTION_VERSION } from "./runninghub-app-panel.js";

/** 宿主在 extension scope 注入的能力。 */
type ExtensionContext = Context & {
  modelInteractions: ModelInteractionRegistry;
  slots: SlotsService;
  applicationRemote: ApplicationRemoteService;
};

export function runningHubAppInteractionExtension(): Plugin.Function<void> {
  return defineExtensionPlugin<ExtensionContext>(
    (ctx) => {
      const dispose = ctx.modelInteractions.register({
        id: RUNNINGHUB_APP_INTERACTION_ID,
        version: RUNNINGHUB_APP_INTERACTION_VERSION,
        owner: RUNNINGHUB_PLUGIN_ID,
        Panel: RunningHubAppPanel
      });
      ctx.effect(() => () => dispose(), "runninghub-app-interaction");

      const removeProviderBalance = ctx.slots.register("agent-assistant.provider-balance", {
        id: `${RUNNINGHUB_PLUGIN_ID}-provider-balance`,
        owner: RUNNINGHUB_PLUGIN_ID,
        priority: 0,
        providerId: RUNNINGHUB_PROVIDER_ID,
        render: createRunningHubProviderBalanceRenderer(ctx.applicationRemote.transport)
      });
      ctx.effect(() => () => removeProviderBalance(), "runninghub-provider-balance");
    },
    {
      name: RUNNINGHUB_PLUGIN_ID,
      inject: ["modelInteractions", "slots", "applicationRemote"]
    }
  );
}
