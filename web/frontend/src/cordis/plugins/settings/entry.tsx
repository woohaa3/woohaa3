/**
 * 设置入口（required Canvas Plugin）
 * （change: 2026-10-17-move-settings-into-canvas-dialog，design D1）。
 *
 * 画布左下角唯一的「设置」入口：调用 Canvas 内的 `settingsOpen` 能力打开大型设置弹窗。
 * 不再调用 App Router，因此开关设置不改变地址、不创建独立页面 scope，也不释放画布资源。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { definePlugin } from "../../plugin.js";
import { AppSettingsIcon } from "@woohaa3/ui/icons";

export const SETTINGS_ENTRY_PLUGIN_ID = "settings-entry";

/** `settings` 插件提供的打开能力（capability 形状）。 */
export type SettingsOpenService = {
  /**
   * 打开设置弹窗。
   *
   * `section` 落到左侧分区；`pluginId` 再往里一步直接打开该插件详情——扩展需要一个
   * 「点击我的入口就到我自己的配置面」的动作时用它（例如顶栏的接入徽标），不必先让用户
   * 在插件列表里自己找。插件不存在时退回到 `section` 对应的列表，不报错：设置里少一个
   * 插件不是调用方该处理的异常。
   */
  open: (input?: {
    canvasId?: string | null;
    section?: "backend" | "plugins" | "appearance" | "notifications" | "runtimes";
    pluginId?: string;
  }) => Promise<{ ok: true } | { ok: false; code: string; reason: string }>;
};

export function settingsEntryExtension(): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const remove = ctx.slots.register("canvas.toolbar-action", {
        id: "settings-open",
        owner: SETTINGS_ENTRY_PLUGIN_ID,
        priority: 50,
        label: "设置",
        icon: AppSettingsIcon,
        onActivate: () => {
          const canvasId = (ctx.get("canvasScope" as never) as { canvasId(): string } | undefined)?.canvasId() ?? null;
          // 打开失败（dirty focus 取消、写请求中、弹窗不可用）只留在当前视图，不导航、不刷新。
          void (ctx.get("settingsOpen" as never) as SettingsOpenService | undefined)?.open({ canvasId });
        }
      });
      ctx.effect(() => () => remove(), "settings-entry-action");
    },
    { name: SETTINGS_ENTRY_PLUGIN_ID, inject: ["slots"] }
  );
}
