/**
 * SDPPPX 前端入口（扫描约定的 `src/frontend/index.ts`，本文件不含 JSX）。
 *
 * 装配两个面：
 * - 两个单例弹窗：登录与账号管理（均由供应商登录入口打开）；
 * - `agent-assistant.configuration`：在 AI 助手的供应商列表里提供 SDPPPX 登录入口，
 *   用户点选后才读取会话并按需打开扫码弹窗，应用启动不自动弹登录。
 *
 * 另外注册 `settings.plugin-config` 面板（主插件与 `settingsPlugin()` 两处），只读展示解析后的
 * `SDPPPX_*`、登录态与「刷新模型」。
 */
import type {
  ApplicationRemoteService,
  Context,
  DialogsService,
  ExtensionFrontendDescriptor,
  SlotsService
} from "@woohaa3/frontend/extension-api";
import { defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import {
  SDPPPX_ACCOUNT_DIALOG_ID,
  SDPPPX_LOGIN_DIALOG_ID,
  SDPPPX_PLUGIN_ID
} from "../shared.js";
import { createSdpppxAccountService } from "./account-service.js";
import {
  createSdpppxAccountDialogRenderer,
  sdpppxAccountDialogDefinition
} from "./account-dialog.js";
import {
  createSdpppxLoginDialogRenderer,
  sdpppxLoginDialogDefinition
} from "./login-dialog.js";
import { SDPPPX_FRONTEND_METADATA } from "./metadata.js";
import { createSdpppxProviderLoginRenderer } from "./provider-login.js";
import { createSdpppxProviderBalanceRenderer } from "./provider-balance.js";
import { createSdpppxHostingSourceRenderer } from "./hosting-source.js";
import {
  registerSdpppxSettingsPanel,
  sdpppxSettingsExtension
} from "./settings-plugin.js";
import "./sdpppx.css";

type ExtensionContext = Context & {
  applicationRemote: ApplicationRemoteService;
  slots: SlotsService;
  dialogs: DialogsService;
};

export function sdpppxProviderExtension(): ReturnType<typeof defineExtensionPlugin<ExtensionContext>> {
  return defineExtensionPlugin<ExtensionContext>(
    (ctx) => {
      const service = createSdpppxAccountService(ctx.applicationRemote.transport);

      const openLogin = (): void => {
        ctx.dialogs.open({ dialogId: SDPPPX_LOGIN_DIALOG_ID, payload: {} });
      };
      const openAccount = (): void => {
        ctx.dialogs.open({ dialogId: SDPPPX_ACCOUNT_DIALOG_ID, payload: {} });
      };

      // 弹窗先于入口注册：供应商入口点选后可能立刻打开登录窗。
      const removeLoginDialog = ctx.dialogs.registerDialog(SDPPPX_LOGIN_DIALOG_ID, {
        definition: sdpppxLoginDialogDefinition,
        renderer: createSdpppxLoginDialogRenderer(service)
      });
      const removeAccountDialog = ctx.dialogs.registerDialog(SDPPPX_ACCOUNT_DIALOG_ID, {
        definition: sdpppxAccountDialogDefinition,
        renderer: createSdpppxAccountDialogRenderer(service, openLogin)
      });
      ctx.effect(
        () => () => {
          removeLoginDialog();
          removeAccountDialog();
        },
        "sdpppx-dialogs"
      );

      const removeProviderLogin = ctx.slots.register("agent-assistant.configuration", {
        id: `${SDPPPX_PLUGIN_ID}-provider-login`,
        owner: SDPPPX_PLUGIN_ID,
        priority: 30,
        kind: "provider-login",
        label: "sdpppx",
        description: "老用户回馈,积分复用",
        icon: "/plugin-icons/sdpppx-provider.svg",
        modelTypes: ["image", "video"],
        setupOrder: 60,
        providerId: "sdpppx",
        render: createSdpppxProviderLoginRenderer(service, openLogin, openAccount)
      });
      ctx.effect(() => () => removeProviderLogin(), "sdpppx-provider-login");

      const removeProviderBalance = ctx.slots.register("agent-assistant.provider-balance", {
        id: `${SDPPPX_PLUGIN_ID}-provider-balance`,
        owner: SDPPPX_PLUGIN_ID,
        priority: 0,
        providerId: "sdpppx",
        render: createSdpppxProviderBalanceRenderer(service)
      });
      ctx.effect(() => () => removeProviderBalance(), "sdpppx-provider-balance");

      // 临时图床来源的就绪条件是账号登录态；能力中心按候选 owner 找到这里。
      const removeHostingSource = ctx.slots.register("agent-assistant.hosting-source", {
        id: `${SDPPPX_PLUGIN_ID}-hosting-source`,
        owner: SDPPPX_PLUGIN_ID,
        priority: 30,
        ownerExtensionId: SDPPPX_PLUGIN_ID,
        render: createSdpppxHostingSourceRenderer(service, openLogin, openAccount)
      });
      ctx.effect(() => () => removeHostingSource(), "sdpppx-hosting-source");

      registerSdpppxSettingsPanel(ctx, service);
      ctx.effect(() => () => service.dispose(), "sdpppx-account-service");
    },
    {
      name: "sdpppx-provider-extension",
      inject: ["applicationRemote", "slots", "dialogs"]
    }
  );
}

export const descriptor: ExtensionFrontendDescriptor = {
  ...SDPPPX_FRONTEND_METADATA,
  plugin: () => sdpppxProviderExtension(),
  settingsPlugin: () => sdpppxSettingsExtension()
};

export {
  SDPPPX_ACCOUNT_DIALOG_ID,
  SDPPPX_LOGIN_DIALOG_ID,
  SDPPPX_PLUGIN_ID
} from "../shared.js";
export { createSdpppxAccountService, decodeSdpppxLoginStatus, decodeSdpppxSnapshot } from "./account-service.js";
export type { SdpppxAccountService } from "./account-service.js";
export { SdpppxAccountDialog } from "./account-dialog.js";
export {
  SDPPPX_LOGIN_POLL_INTERVAL_MS,
  SdpppxLoginDialog,
  createSdpppxLoginDialogRenderer,
  sdpppxLoginDialogDefinition,
  sdpppxLoginErrorCode
} from "./login-dialog.js";
export { SDPPPX_FRONTEND_METADATA } from "./metadata.js";
export { SdpppxProviderLogin, createSdpppxProviderLoginRenderer } from "./provider-login.js";
export { SdpppxHostingSource, createSdpppxHostingSourceRenderer } from "./hosting-source.js";
export { SdpppxProviderBalance } from "./provider-balance.js";
export { SdpppxSettingsPanel } from "./settings-panel.js";
export { sdpppxSettingsExtension } from "./settings-plugin.js";
