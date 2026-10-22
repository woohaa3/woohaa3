/**
 * 设置面板注册与设置专用插件工厂（JSX 放在 `.tsx`，`index.ts` 保持可被扫描入口安全读取）。
 *
 * **两个入口共用同一份注册逻辑**，因为它们服务的是同一个面板的两种生命周期：
 *
 * - `registerRemoteServerSettingsPanel`：由**主插件**（Canvas scope）调用。扩展在运行中时
 *   宿主直接复用它已有的贡献，不会调用 settings-only 工厂（`extension-settings-assembly.ts`
 *   对 `activeIds()` 提前返回）。面板只注册在工厂里，就会出现「运行中反而看不到配置」——
 *   插件卡片显示「无可配置项」、详情页空白。
 * - `remoteServerSettingsExtension`：宿主在扩展**未激活/未运行**时按需装配，关闭设置即释放。
 *
 * 两条路径必须产生同一个 slot id 与同一个 `pluginId`；测试里用真实 Cordis Context 锁住这点。
 */
import type {
  Context,
  ApplicationRemoteService,
  DialogsService,
  Plugin,
  SlotsService
} from "@woohaa3/frontend/extension-api";
import { defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import { REMOTE_SERVER_EXTENSION_ID } from "../shared.js";
import {
  REMOTE_SERVER_DEBUG_DIALOG_ID,
  ensureRemoteServerDebugDialog
} from "./debug-dialog.js";
import { createRemoteServerService, type RemoteServerService } from "./remote.js";
import { RemoteServerSettingsPanel } from "./settings-panel.js";

type SettingsSlotsContext = Context & { slots: SlotsService };

/**
 * 注册「设置 → 插件配置 → 服务端接入」详情面板，复用调用方给的那份 service。
 *
 * 复用而不是自建：运行中时徽标与面板应当看到同一个快照，两份 service 会让「徽标已连接、
 * 面板还显示本地」这类不一致重新出现。
 *
 * `onOpenDebug` 是**可选**的：宿主没有 `dialogs` 能力（空壳/恢复页）时面板不渲染调试入口，
 * 而不是给一个点了没反应的按钮。
 */
export function registerRemoteServerSettingsPanel(
  ctx: SettingsSlotsContext,
  service: RemoteServerService,
  onOpenDebug?: () => void
): void {
  const remove = ctx.slots.register("settings.plugin-config", {
    id: `${REMOTE_SERVER_EXTENSION_ID}-settings-panel`,
    owner: REMOTE_SERVER_EXTENSION_ID,
    priority: 10,
    pluginId: REMOTE_SERVER_EXTENSION_ID,
    render: (props) => (
      <RemoteServerSettingsPanel
        service={service}
        {...props}
        {...(onOpenDebug ? { onOpenDebug } : {})}
      />
    )
  });
  ctx.effect(() => () => remove(), "remote-server-settings-panel");
}

type SettingsContext = Context & {
  applicationRemote: ApplicationRemoteService;
  slots: SlotsService;
};

export function remoteServerSettingsExtension(): Plugin.Function<void> {
  return defineExtensionPlugin<SettingsContext>(
    (ctx) => {
      const service = createRemoteServerService(ctx.applicationRemote.transport);
      // `dialogs` 惰性取（不进 inject）：设置专用装配不该因为宿主没有 dialog 能力就装载失败。
      const dialogs = ctx.get("dialogs" as never) as DialogsService | undefined;
      let openDebug: (() => void) | undefined;
      if (dialogs) {
        // 扩展此刻未运行：窗口要由设置路径自己注册，否则按钮能点但打不开。
        const disposeDebugDialog = ensureRemoteServerDebugDialog(dialogs, service);
        ctx.effect(() => () => disposeDebugDialog(), "remote-server-settings-debug-dialog");
        openDebug = () => {
          dialogs.open({ dialogId: REMOTE_SERVER_DEBUG_DIALOG_ID, payload: {} });
        };
      }
      registerRemoteServerSettingsPanel(ctx, service, openDebug);
      ctx.effect(() => () => service.dispose(), "remote-server-settings-service");
    },
    { name: "remote-server-settings", inject: ["applicationRemote", "slots"] }
  );
}
