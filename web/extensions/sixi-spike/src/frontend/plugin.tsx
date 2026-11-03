/**
 * 四喜迁移 spike 插件：把四喜的真实前端挂到宿主画布的 `canvas.overlay` 上。
 *
 * 这里只注册外壳。早期验证 antd / MemoryRouter / 浮层容器的那套演示（`SixiApp`）
 * 已经删掉 —— 它的结论都落进了 `cf363bc` 和迁移文档，四喜本体现在整块跑在宿主里，
 * 留着那个工具栏按钮只会弹出一个无意义的测试对话框。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import type {
  CanvasCatalogService,
  CanvasCommandsService,
  CanvasLocateService,
  CanvasNavigationService,
  CanvasRemoteService,
  CanvasScopeService,
  CanvasSession,
  ImageLibrarySource,
  MediaRemoteService,
  SlotsService,
  TaskCatalogService,
  ThemeService
} from "@woohaa3/frontend/extension-api";
import { SIXI_SPIKE_ID } from "../shared.js";
import { SixiShell } from "../app/SixiShell.js";
import type { GenerateServices } from "../app/hostGenerateRunner.js";

type ExtensionContext = Context & { slots: SlotsService; theme: ThemeService };

/**
 * 取画布页作用域的服务，拿不到就返回 undefined。
 *
 * `ctx.get(name, false)` 是非严格读：不抛、没有就是 undefined。这些服务（`canvasNavigation` /
 * `canvasScope` / `canvasCatalog`）由画布页作用域提供，本插件的 context 是 App 作用域，
 * 严格读会抛 `cannot get property …`，把整个 `canvas.overlay` 贡献一起带下去。
 */
function safeGet<T>(ctx: Context, name: string): T | undefined {
  try {
    return ctx.get(name as never, false) as T | undefined;
  } catch {
    return undefined;
  }
}

const safeCanvasNavigation = (ctx: Context): CanvasNavigationService | undefined =>
  safeGet<CanvasNavigationService>(ctx, "canvasNavigation");

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
          //   否则项目页显示的永远是它自己那三条 mock 种子；
          // - 当前画布 id 让「点项目卡」点到当前这张时不必跳页，直接进画布态。
          render: () => (
            <SixiShell
              theme={ctx.theme}
              canvasCatalog={ctx.get("canvasCatalog" as never) as CanvasCatalogService | undefined}
              /*
               * 画布态顶栏的切换器直接唤起宿主那个弹窗（见 app/hostCanvasBridge.ts）。
               *
               * **必须用 `get(…, false)` 且包 try**：`canvasNavigation` 是**画布页作用域**的服务，
               * 而本插件的 context 是 App 作用域、`inject` 里也没有它 —— cordis 对未注入的服务
               * 读 `ctx.get(name)` 会直接抛。抛在这里等于整个 `canvas.overlay` 贡献渲染失败，
               * 宿主的错误边界按 `fallback="hidden"` 把四喜整个藏掉（实测：连遮罩属性都没挂上）。
               * `get(name, false)` 不抛、拿不到就返回 undefined，切换器退化成不响应点击，
               * 但外壳照常显示 —— 宁可少一个按钮，不能让整个四喜消失。
               */
              canvasNavigation={safeCanvasNavigation(ctx)}
              /*
               * 图片库同样是画布页作用域服务，必须非严格读（拿不到就 undefined，资源页退回 mock）。
               */
              imageLibrary={safeGet<ImageLibrarySource>(ctx, "imageLibrary")}
              /* 首页「生成」带参考图时先上传;应用作用域就有,拿不到则只能发纯文字 */
              mediaRemote={safeGet<MediaRemoteService>(ctx, "mediaRemote")}
              /*
               * 进入新画布后执行交接要用的画布页服务,**每次调用现取**:渲染时它们可能还没起来
               * (画布冷启动),runner 轮询到全部就绪再动手;缓存一次的话永远停在 undefined。
               */
              generateServices={(): GenerateServices => ({
                scope: safeGet<CanvasScopeService>(ctx, "canvasScope"),
                commands: safeGet<CanvasCommandsService>(ctx, "canvasCommands"),
                locate: safeGet<CanvasLocateService>(ctx, "canvasLocate"),
                catalog: safeGet<TaskCatalogService>(ctx, "taskCatalog"),
                session: safeGet<CanvasSession>(ctx, "canvasSession"),
                remote: safeGet<CanvasRemoteService>(ctx, "canvasRemote")
              })}
              /* 同样是非严格读:拿不到时 `null` 只让「点当前画布不跳页」与顶栏标题退化成保守行为 */
              currentCanvasId={() => safeGet<CanvasScopeService>(ctx, "canvasScope")?.canvasId() ?? null}
            />
          )
        })
      );
    },
    { name: SIXI_SPIKE_ID, inject: ["slots", "theme"] }
  );
}
