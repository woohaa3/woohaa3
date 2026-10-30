/**
 * 开发期报错助手插件（change: 2026-10-30-add-dev-error-assistant）。
 *
 * 挂在画布页的 `canvas.overlay` 上，左下角一颗浮标，点开看捕获到的报错列表。
 *
 * **只在开发构建里注册**：`canvas-manifest.ts` 用 `import.meta.env.DEV` 决定是否把它放进
 * 画布插件目录，生产构建时这个模块与它的 CSS 都不会被打包 —— 与四喜「开发助手」同一思路。
 *
 * **捕获是全局的、销毁是局部的**：监听挂在 `window` 上，而本插件随画布页 scope 来去。
 * 因此 `install()` 只装一次（store 内部有幂等守卫），卸载时**不** `uninstall()` ——
 * 否则每进出一次画布就拆一次监听，离开画布期间发生的错误会漏掉。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { definePlugin } from "../../plugin.js";
import { DevErrorAssistant } from "./panel.js";
import { devErrorLog } from "./store.js";

export const DEV_ERROR_ASSISTANT_PLUGIN_ID = "dev-error-assistant";

export function devErrorAssistantExtension(): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      devErrorLog.install();
      const remove = ctx.slots.register("canvas.overlay", {
        id: DEV_ERROR_ASSISTANT_PLUGIN_ID,
        owner: DEV_ERROR_ASSISTANT_PLUGIN_ID,
        // 优先级靠后：浮层类贡献里它不该抢在业务浮层前面。
        priority: 90,
        render: () => <DevErrorAssistant log={devErrorLog} />
      });
      ctx.effect(() => remove, "dev-error-assistant-overlay");
    },
    { name: DEV_ERROR_ASSISTANT_PLUGIN_ID, inject: ["slots"] }
  );
}
