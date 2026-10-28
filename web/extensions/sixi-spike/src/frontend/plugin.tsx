/**
 * 四喜迁移 spike 插件：把四喜的真实前端挂到宿主画布的 `canvas.overlay` 上。
 *
 * 这里只注册外壳。早期验证 antd / MemoryRouter / 浮层容器的那套演示（`SixiApp`）
 * 已经删掉 —— 它的结论都落进了 `cf363bc` 和迁移文档，四喜本体现在整块跑在宿主里，
 * 留着那个工具栏按钮只会弹出一个无意义的测试对话框。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import type { CanvasCatalogService, SlotsService, ThemeService } from "@woohaa3/frontend/extension-api";
import { SIXI_SPIKE_ID } from "../shared.js";
import { SixiShell } from "../app/SixiShell.js";

type ExtensionContext = Context & { slots: SlotsService; theme: ThemeService };

export function sixiSpikeExtension(): Plugin.Function<void> {
  return defineExtensionPlugin<ExtensionContext>(
    (ctx) => {
      const disposers: Array<() => void> = [];
      ctx.effect(
        () => () => {
          for (const dispose of disposers.splice(0)) dispose();
        },
        "sixi-spike-cleanup"
      );

      // 外壳：侧栏 + 顶栏 + 四喜全部页面；「创作」路由把内容区让给宿主画布。
      disposers.push(
        ctx.slots.register("canvas.overlay", {
          id: "sixi-shell",
          owner: SIXI_SPIKE_ID,
          priority: 1,
          // 宿主主题与画布目录交给外壳：
          // - 主题让画布配色跟随四喜的亮 / 暗（见 app/hostTheme.ts）；
          // - 目录让四喜的「项目」就是宿主的画布（见 app/hostProjectSource.ts），
          //   否则项目页显示的永远是它自己那三条 mock 种子。
          render: () => (
            <SixiShell
              theme={ctx.theme}
              canvasCatalog={ctx.get("canvasCatalog" as never) as CanvasCatalogService | undefined}
            />
          )
        })
      );
    },
    { name: SIXI_SPIKE_ID, inject: ["slots", "theme"] }
  );
}
