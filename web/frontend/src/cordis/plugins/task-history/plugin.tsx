/**
 * Task History Plugin（Task History page scope 唯一插件）
 * （change: adopt-frontend-cordis-plugin-runtime；
 *   change: unify-canvas-presentation-navigation，task 2.3 / design D1；
 *   change: improve-task-history-experience，任务 3.5）。
 *
 * 独立页面 scope：只使用 `taskRemote` 只读 history、受控 Media resolver 与 App Router；
 * 不创建 Canvas Session、sync socket、Bevy/WASM、selection 或 Canvas 插件。跳转画布只向
 * App Router 提交目标 identity；查询/选中写入类型化 URL 并由同一 scope 复用。
 */
import { lazy, Suspense, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { EMPTY_HISTORY_FILTERS, type HistoryFilters, type HistoryTab } from "../../../pages/task-history/history-state.js";
import { definePlugin } from "../../plugin.js";
import type { AppRouterService, AppTaskHistoryQuery } from "../../navigation/app-router.js";

const TaskHistoryPage = lazy(() => import("../../../pages/task-history/index.js").then(module => ({ default: module.TaskHistoryPage })));

export const TASK_HISTORY_PLUGIN_ID = "task-history";
export const TASK_HISTORY_ROUTE = "/task-history";

/** 从类型化 URL 查询恢复页面状态（未知/无效字段已被 Router 规范化）。 */
function historyQueryToState(history: AppTaskHistoryQuery | undefined): {
  filters: HistoryFilters;
  tab: HistoryTab;
  taskKey?: string;
  cursor?: string;
} {
  const source = history ?? {};
  return {
    filters: {
      ...EMPTY_HISTORY_FILTERS,
      ...(source.providerId ? { providerId: source.providerId } : {}),
      ...(source.modelType ? { modelType: source.modelType } : {}),
      ...(source.modelKey ? { modelKey: source.modelKey } : {}),
      ...(source.canvasId ? { canvasId: source.canvasId } : {}),
      ...(source.nodeId ? { nodeId: source.nodeId } : {}),
      ...(source.source ? { source: source.source } : {}),
      ...(source.extensionId ? { extensionId: source.extensionId } : {}),
      ...(source.from ? { from: source.from } : {}),
      ...(source.to ? { to: source.to } : {})
    },
    tab: source.tab ?? "all",
    ...(source.taskKey ? { taskKey: source.taskKey } : {}),
    ...(source.cursor ? { cursor: source.cursor } : {})
  };
}

/** 页面控制器：订阅 App Router，把类型化 location 交付 TaskHistoryPage。 */
function TaskHistoryRoute({
  navigate,
  router,
  client,
  resolveMediaUrl
}: {
  navigate: (to: string) => void;
  router: AppRouterService;
  client: ReturnType<Context["taskRemote"]["createHistory"]>;
  resolveMediaUrl: (storageKey: string, canvasId?: string) => string;
}) {
  const location = useSyncExternalStore(router.subscribe, router.getLocation, router.getLocation);
  const state = historyQueryToState(location.page === "task-history" ? location.history : undefined);
  const locationToken = JSON.stringify(location.page === "task-history" ? location.history ?? {} : {});
  return (
    <Suspense fallback={<div className="status-overlay" role="status">正在加载任务历史…</div>}>
    <TaskHistoryPage
      client={client}
      resolveMediaUrl={resolveMediaUrl}
      initialQuery={{ ...state.filters, tab: state.tab }}
      initialTaskKey={state.taskKey}
      initialCursor={state.cursor}
      locationToken={locationToken}
      onLocationChange={(next) => {
        const history: AppTaskHistoryQuery = {
          ...(next.tab !== "all" ? { tab: next.tab } : {}),
          ...(next.filters.providerId ? { providerId: next.filters.providerId } : {}),
          ...(next.filters.modelType ? { modelType: next.filters.modelType } : {}),
          ...(next.filters.modelKey ? { modelKey: next.filters.modelKey } : {}),
          ...(next.filters.canvasId ? { canvasId: next.filters.canvasId } : {}),
          ...(next.filters.nodeId ? { nodeId: next.filters.nodeId } : {}),
          ...(next.filters.source ? { source: next.filters.source } : {}),
          ...(next.filters.extensionId ? { extensionId: next.filters.extensionId } : {}),
          ...(next.taskKey ? { taskKey: next.taskKey } : {}),
          ...(next.cursor ? { cursor: next.cursor } : {})
        };
        router.navigate({ page: "task-history", history });
      }}
      onOpenCanvas={({ canvasId, nodeId }) => {
        navigate(`/?canvasId=${encodeURIComponent(canvasId)}&nodeId=${encodeURIComponent(nodeId)}`);
      }}
    />
    </Suspense>
  );
}

export const taskHistoryExtension: Plugin.Function<void> = definePlugin(
  (ctx: Context) => {
    const client = ctx.taskRemote.createHistory();
    const resolveMediaUrl = (storageKey: string, canvasId?: string) => ctx.mediaRemote.urlFor(storageKey, canvasId);
    // 把渲染入口挂到 app.route slot，供 Task History page scope 的 Host 渲染。
    const remove = ctx.slots.register("app.route", {
      id: "task-history-route",
      owner: TASK_HISTORY_PLUGIN_ID,
      priority: 0,
      path: TASK_HISTORY_ROUTE,
      render: ({ navigate }) => (
        <TaskHistoryRoute
          navigate={navigate}
          router={ctx.appRouter}
          client={client}
          resolveMediaUrl={resolveMediaUrl}
        />
      )
    });
    ctx.effect(() => () => remove(), "task-history-route");
  },
  { name: TASK_HISTORY_PLUGIN_ID, inject: ["slots", "taskRemote", "mediaRemote", "appRouter"] }
);
