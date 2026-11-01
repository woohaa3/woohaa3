/**
 * Canvas Switcher Plugin（Canvas page scope chrome）
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 4.1–4.4 / design D7）。
 *
 * 只消费 App scope 的 `canvasCatalog`/`canvasSelection` 与当前 page scope 的
 * `canvasSession`/`canvasNavigation`；切换与创建经 App Router 走统一 scope transition 路径。
 * 不直接持有 `/api/canvases` 路径，也不缓存目录。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { definePlugin } from "../../plugin.js";
import { DEFAULT_CANVAS_ID } from "../../services/canvas-session.js";
import { ALERT_DIALOG_ID } from "../../services/dialogs/alert-dialog.js";
import { submitCanvasRename } from "./rename.js";
import { saveDownload } from "../../services/file-download.js";
import type { CanvasSummary } from "../../contract/canvas-catalog.js";
import type { CanvasSessionStatus } from "../../contract/session.js";
import {
  CANVAS_SWITCHER_DIALOG_ID,
  canvasSwitcherDefinition,
  createCanvasSwitcherRenderer
} from "./chrome.js";
import { CanvasSwitcherTrigger } from "./trigger.js";
import type { CanvasCreateOptionContribution } from "../../contracts.js";
import type { CanvasLiveSync } from "./sync-labels.js";

export const CANVAS_SWITCHER_PLUGIN_ID = "canvas-switcher";

/**
 * 由会话同步状态派生顶栏胶囊的实时连接态。
 *
 * 目录快照（`CanvasSummary.sync`）可能已经过期（服务端断开后仍写着「已同步」），
 * 顶栏必须回答和右下角气泡同一个问题：这条画布连接现在到底通不通。
 */
function deriveLiveSync(status: CanvasSessionStatus): CanvasLiveSync {
  const remote = status.remote;
  if (remote.mode === "offline" || remote.phase === "offline") return "offline";
  // disabled 是「同步不可用」（纯本地部署），不是断线：胶囊回落目录标签。
  if (remote.mode === "remote" && remote.phase !== "synced") return "connecting";
  return "ready";
}

export type CanvasSwitcherExtensionOptions = {
  canvasId?: string;
};

export function canvasSwitcherExtension(options: CanvasSwitcherExtensionOptions = {}): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const canvasId = options.canvasId ?? DEFAULT_CANVAS_ID;
      const catalog = ctx.canvasCatalog;
      const selection = ctx.canvasSelection;
      const session = ctx.canvasSession;
      const preparation = ctx.canvasPreparation;

      // 通用外部来源目录（可选）：只透传来源摘要/分页；关闭扩展不影响已导入作品
      // （change: 2026-10-12-add-extension-online-canvas-migration，任务 5.7）。
      const sources = {
        list: async () => {
          await preparation.listSources(true);
          return preparation.getState().sources.map((source) => ({ sourceId: source.sourceId, displayName: source.displayName }));
        },
        listAccessible: async (sourceId: string, cursor: string | null) => {
          const page = await preparation.listAccessible({ sourceId, cursor });
          return {
            items: page.items,
            nextCursor: page.nextCursor
          };
        }
      };

      const titleListeners = new Set<() => void>();
      let currentTitle = "";
      /** 当前画布的目录同步状态（文档 + 媒体合并后的结论）。 */
      let currentSync: CanvasSummary["sync"] | undefined;
      /** 当前画布会话的实时连接态：断线/建连优先于目录快照。 */
      let currentLiveSync: CanvasLiveSync | undefined;
      /** 目录与会话共用同一组监听者：触发器据此同时重读标题、目录状态与实时态。 */
      const refreshTitle = () => {
        const entry = catalog.getState().entries.find((item) => item.id === canvasId);
        const nextTitle = entry?.title ?? currentTitle;
        const nextSync = entry?.sync;
        const nextLiveSync = deriveLiveSync(session.getStatus());
        if (nextTitle === currentTitle && nextSync === currentSync && nextLiveSync === currentLiveSync) return;
        currentTitle = nextTitle;
        currentSync = nextSync;
        currentLiveSync = nextLiveSync;
        for (const listener of titleListeners) listener();
      };
      // 先结算一次首帧：目录还没回来时，断线/建连也要立刻显示。
      refreshTitle();
      const unsubscribeCatalog = catalog.subscribe(() => {
        refreshTitle();
      });
      // 会话状态变化同样推动触发器；订阅已有的推送，不额外轮询。
      const unsubscribeSession = session.subscribe(() => {
        refreshTitle();
      });
      ctx.effect(() => () => {
        unsubscribeCatalog();
        unsubscribeSession();
      }, "canvas-switcher-title");
      // 进入新的画布 page scope：使目录缓存失效，下一次读取得到最新标题/列表。
      catalog.invalidate();
      void catalog.load();

      const openSwitcher = () => {
        ctx.canvasNavigation.openDialog({ dialogId: CANVAS_SWITCHER_DIALOG_ID, payload: {} });
      };

      /**
       * 切换画布：先让页面级 feature 结算未保存文档（change: 2026-10-21，design D6）。
       *
       * 失败或用户取消时**不**导航，页面与草稿保留；返回画布/关闭 tab 不经过这里。
       */
      const switchTo = (targetCanvasId: string) => {
        if (targetCanvasId === canvasId) return;
        const navigate = () => {
          selection.setRecentCanvasId(targetCanvasId);
          ctx.appRouter.navigate({ page: "canvas", canvasId: targetCanvasId });
        };
        if (!ctx.pageLeave.hasUnsaved()) {
          navigate();
          return;
        }
        void ctx.pageLeave.settle().then((result) => {
          if (!result.ok) {
            // 只报告，不导航：用户仍停在原画布与原文档。
            ctx.dialogs.open({ dialogId: ALERT_DIALOG_ID, payload: { title: "无法切换画布", description: result.reason } });
            return;
          }
          navigate();
        });
      };

      const create = async (options?: readonly CanvasCreateOptionContribution[]) => {
        const result = await catalog.create({});
        if (!result.ok) return { ok: false, error: result.error };
        selection.setRecentCanvasId(result.canvasId);
        ctx.appRouter.navigate({ page: "canvas", canvasId: result.canvasId });
        // 选项在建好之后执行：失败只报告，**不回滚画布**——回滚会让用户丢掉刚建的东西。
        const failures: string[] = [];
        for (const option of options ?? []) {
          try {
            const applied = await option.apply({ canvasId: result.canvasId });
            if (!applied.ok) failures.push(`${option.label}：${applied.error}`);
          } catch (error) {
            failures.push(`${option.label}：${error instanceof Error ? error.message : "失败"}`);
          }
        }
        if (failures.length > 0) {
          ctx.dialogs.open({
            dialogId: ALERT_DIALOG_ID,
            payload: { title: "画布已创建，但选项未生效", description: failures.join("\n") }
          });
        }
        return { ok: true, canvasId: result.canvasId };
      };

      const rename = async (title: string) => {
        const result = await submitCanvasRename({ session, title });
        if (!result.ok) return { ok: false, error: result.error };
        // committed/observed：失效并刷新 Catalog，使标题来自 published projection。
        catalog.invalidate();
        await catalog.load(true);
        refreshTitle();
        return { ok: true };
      };

      /**
       * 删除画布。
       *
       * 删除入口长在目录行上，宿主在这里只做收尾：目录 store 已刷新；删掉的是当前画布时
       * 清掉「最近画布」并回到缺省解析，让路由器落到下一张或幂等新建，而不是停在一个已删
       * 的 id 上（那会变成恢复页）。不经过 `pageLeave.settle`：画布已被删除，没有可保存的目标。
       */
      const remove = async (targetCanvasId: string, expectedRevision?: number) => {
        const result = await catalog.delete(targetCanvasId, expectedRevision);
        if (!result.ok) return { ok: false, error: result.error };
        if (targetCanvasId === canvasId) {
          selection.setRecentCanvasId(null);
          ctx.appRouter.navigate({ page: "canvas" });
        }
        refreshTitle();
        return { ok: true };
      };

      /**
       * 导出归档包并触发下载。
       *
       * 浏览器只能把文件送到下载目录，选不了盘符 —— 这是浏览器的限制，不是我们省掉了。
       * 桌面壳将来接原生保存对话框时，替换的是这一处 `saveDownload` 调用。
       *
       * **不在这之后删画布**：归档是把内容搬到别处，「要不要腾出空间」是下一步的独立决定。
       */
      const exportArchive = async (entry: CanvasSummary) => {
        const result = await catalog.exportArchive(entry.id);
        if (!result.ok) return { ok: false, error: result.error };
        // `Uint8Array` 可能挂在 SharedArrayBuffer 上，`BlobPart` 只接受 ArrayBuffer 视图；
        // 切一份等价的 ArrayBuffer 再包。
        const buffer = result.bytes.buffer.slice(
          result.bytes.byteOffset,
          result.bytes.byteOffset + result.bytes.byteLength
        ) as ArrayBuffer;
        saveDownload(new Blob([buffer], { type: "application/octet-stream" }), result.filename);
        if (result.missingMedia > 0) {
          // 缺件不是失败：画布本身可能已经有断链。但必须说出来，否则用户会以为包是完整的。
          return {
            ok: true,
            error: `已导出，但有 ${result.missingMedia} 个素材文件缺失（画布里的对应图片/视频在恢复后会打不开）`
          };
        }
        return { ok: true };
      };

      const disposeDialog = ctx.dialogs.registerDialog(CANVAS_SWITCHER_DIALOG_ID, {
        definition: canvasSwitcherDefinition,
        renderer: createCanvasSwitcherRenderer({
          catalog,
          selection,
          session,
          // 条目动作 slot（change: canvas 同步显式化）：宿主只透传 registry，
          // 由扩展自行决定每个条目是否呈现动作。
          slots: ctx.slots,
          currentCanvasId: () => canvasId,
          switchTo,
          create,
          rename,
          exportArchive,
          remove,
          sources
        })
      });
      ctx.effect(() => () => disposeDialog(), "canvas-switcher-dialog");

      // 左上角触发器：显示当前标题，点击打开切换器（模型聚焦时让位返回按钮）。
      const removeOverlay = ctx.slots.register("canvas.topbar", {
        id: "canvas-switcher-trigger",
        owner: CANVAS_SWITCHER_PLUGIN_ID,
        priority: 1,
        render: () => (
          <CanvasSwitcherTrigger
            getTitle={() => currentTitle}
            getSync={() => currentSync}
            getLiveSync={() => currentLiveSync}
            subscribeTitle={(listener) => {
              titleListeners.add(listener);
              return () => {
                titleListeners.delete(listener);
              };
            }}
            onOpen={openSwitcher}
            onRefreshCatalog={() => {
              // 媒体补传完成后目录徽标要自己收敛：失效缓存再读一次（服务端现算同步状态）。
              catalog.invalidate();
              void catalog.load(true);
            }}
            navigation={ctx.canvasNavigation}
          />
        )
      });
      ctx.effect(() => () => removeOverlay(), "canvas-switcher-trigger-slot");

      // E2E/排障：确定性打开切换器（生产无副作用）。
      (globalThis as unknown as { __openCanvasSwitcher?: unknown }).__openCanvasSwitcher = openSwitcher;

      return () => {
        unsubscribeCatalog();
        unsubscribeSession();
        disposeDialog();
        removeOverlay();
      };
    },
    {
      name: CANVAS_SWITCHER_PLUGIN_ID,
      inject: ["slots", "dialogs", "canvasNavigation", "canvasSession", "canvasCatalog", "canvasSelection", "canvasPreparation", "appRouter", "pageLeave"]
    }
  );
}
