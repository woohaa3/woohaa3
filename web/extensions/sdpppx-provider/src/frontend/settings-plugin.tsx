/**
 * 设置面板的两种生命周期（与 remote-server 同构）：
 *
 * - `registerSdpppxSettingsPanel`：主插件运行中时由它注册，复用同一份 account service；
 * - `sdpppxSettingsExtension`：扩展未激活/未运行时，宿主按需装配的 settings-only 工厂。
 *
 * 两处必须产生同一个 slot id / pluginId；否则「运行中反而看不到配置」。
 */
import type {
  ApplicationRemoteService,
  Context,
  Plugin,
  SlotsService
} from "@woohaa3/frontend/extension-api";
import { defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import { SDPPPX_PLUGIN_ID } from "../shared.js";
import { createSdpppxAccountService, type SdpppxAccountService } from "./account-service.js";
import { SdpppxSettingsPanel } from "./settings-panel.js";

type SettingsSlotsContext = Context & { slots: SlotsService };

export function registerSdpppxSettingsPanel(ctx: SettingsSlotsContext, service: SdpppxAccountService): void {
  const remove = ctx.slots.register("settings.plugin-config", {
    id: `${SDPPPX_PLUGIN_ID}-settings-panel`,
    owner: SDPPPX_PLUGIN_ID,
    priority: 10,
    pluginId: SDPPPX_PLUGIN_ID,
    render: () => <SdpppxSettingsPanel service={service} />
  });
  ctx.effect(() => () => remove(), "sdpppx-settings-panel");
}

type SettingsContext = Context & {
  applicationRemote: ApplicationRemoteService;
  slots: SlotsService;
};

export function sdpppxSettingsExtension(): Plugin.Function<void> {
  return defineExtensionPlugin<SettingsContext>(
    (ctx) => {
      const service = createSdpppxAccountService(ctx.applicationRemote.transport);
      registerSdpppxSettingsPanel(ctx, service);
      ctx.effect(() => () => service.dispose(), "sdpppx-settings-service");
    },
    { name: "sdpppx-provider-settings", inject: ["applicationRemote", "slots"] }
  );
}
