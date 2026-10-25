/**
 * Telemetry 复盘页插件（`/telemetry` 页 scope 的唯一插件）
 * （change: 2026-10-20-add-local-client-telemetry，任务 5.3 / design D9）。
 *
 * **这个文件必须保持很薄。** 它被 `cordis/manifest.ts` 静态引入（页面清单要插件函数本体），
 * 所以这里只能有槽位注册：一旦静态引入取数层或页面，它们就进入入口静态闭包，让每个用户
 * 都在启动时下载复盘页代码。真正的适配逻辑在 `./route.js`，
 * 由这里动态 import（只在复盘页的 chunk 里）。
 *
 * 职责：注册 `app.route` 贡献；不创建 Canvas Session、sync socket、Bevy/WASM、selection 或任何
 * Canvas 插件。装配在非 telemetry 页面时安静退出（防误装的兜底，不给别的页面留空槽位）。
 */
import { Suspense, lazy } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { definePlugin } from "../../plugin.js";
import { TELEMETRY_PAGE_PATH } from "../../navigation/app-router-store.js";

const TelemetryRoute = lazy(() =>
  import("./route.js").then((module) => ({ default: module.TelemetryRoute }))
);

export const TELEMETRY_PLUGIN_ID = "telemetry";
export const TELEMETRY_ROUTE = TELEMETRY_PAGE_PATH;

export const telemetryExtension: Plugin.Function<void> = definePlugin(
  (ctx: Context) => {
    // 只在复盘页注册路由贡献：本插件按清单只装配进 telemetry 页 scope，这条判定是防误装用的
    // 兜底——被装配到其它页面时安静退出，不留一个只为别页服务的槽位。
    if (ctx.appRouter.getLocation().page !== "telemetry") return;

    const transport = ctx.applicationRemote.transport;
    const remove = ctx.slots.register("app.route", {
      id: "telemetry-route",
      owner: TELEMETRY_PLUGIN_ID,
      priority: 0,
      path: TELEMETRY_ROUTE,
      render: () => (
        <Suspense fallback={<div className="status-overlay" role="status">正在加载本机遥测…</div>}>
          <TelemetryRoute
            router={ctx.appRouter}
            transport={transport}
            onOpenSettings={() => ctx.appRouter.navigate({ page: "canvas", openSettings: true })}
          />
        </Suspense>
      )
    });
    ctx.effect(() => () => remove(), "telemetry-route");
  },
  { name: TELEMETRY_PLUGIN_ID, inject: ["slots", "appRouter", "applicationRemote"] }
);
