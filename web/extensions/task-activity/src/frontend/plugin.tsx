/**
 * Task Activity Plugin（canvas page scope overlay）
 * （change: 2026-09-29-add-canvas-task-activity-feed，任务 2.1 / 3.1 / design D1；
 *   change: formalize-frontend-event-bus，任务 5.2–5.4 / design D5；
 *   change: 2026-10-10-extract-optional-feature-extensions，任务 5.1/5.2：由宿主
 *   `cordis/plugins/task-activity` 迁入独立 browser-local extension 包，使用注入的
 *   `canvasScope`/`canvasState`/`taskCatalog`/`canvasLocate` capability，不 import 宿主内部 store；
 *   change: 2026-10-22-unify-task-activity-rows，任务 3.3 / design D6：行所需的定位、详情与组动作
 *   能力**装配时构造一次**交给 store，渲染层不再按来源透传 props）。
 *
 * 只属于 Canvas page scope：从当前 scope 获取 canvasId、Canvas Remote、Media Remote 与
 * dispose 信号。装配顺序（design D5）：**建 store → 注入行能力 → 注册三个 listener → 启动
 * bridge → 注册 overlay**，保证首批同步 snapshot 结果不会早于 consumer 丢失。切换画布或释放
 * scope 时反序清理：停止 bridge、取消 listener、清理 store/浮层；迟到结果按 scope identity 丢弃。
 *
 * 任务记录经 `task.activity.*` 事件进入 store，组创作订阅宿主 canvasGroupRuns 读模型；不查询
 * Task Execution service，也不由本插件拥有 WebSocket（物理连接由 page-owned Canvas Session 负责）。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import type {
  AgentConversationServiceHandle,
  CanvasGroupRunsService,
  CanvasSession,
  CanvasNavigationService,
  CanvasLocateService,
  CanvasRemoteService,
  CanvasRuntimeService,
  CanvasScopeService,
  CanvasStoreFacade,
  MediaRemoteService,
  SlotsService,
  TaskCatalogService
} from "@woohaa3/frontend/extension-api";
import type { CanvasTaskActivity } from "@woohaa3/contracts";
import { TASK_ACTIVITY_PLUGIN_ID } from "../shared.js";
import { TaskActivityStore } from "./store.js";
import { createTaskActivityEventBridge } from "./bridge.js";
import { TaskActivityFeed } from "./feed.js";
import type { TaskActivityFeedProps } from "./feed.js";
import { resolveTaskActivityDisplay } from "./display.js";

export { TASK_ACTIVITY_PLUGIN_ID } from "../shared.js";

/**
 * feature capability key：只暴露**只读** store 快照/订阅（供测试与诊断）。
 *
 * Task Execution 不再通过 service 直接写入活动栈（change: formalize-frontend-event-bus）；
 * 它只抛 `task.activity.*` 事件。
 */
export const TASK_ACTIVITY_STORE_SERVICE = "taskActivityStore";

/** 宿主在 extension scope 注入的能力。 */
type ExtensionContext = Context & {
  canvasNavigation: CanvasNavigationService;
  slots: SlotsService;
  canvasRemote: CanvasRemoteService;
  mediaRemote: MediaRemoteService;
  canvasRuntime: CanvasRuntimeService;
  taskCatalog: TaskCatalogService;
  canvasLocate: CanvasLocateService;
  canvasScope: CanvasScopeService;
  canvasState: CanvasStoreFacade;
  canvasGroupRuns: CanvasGroupRunsService;
};

export function taskActivityExtension(): Plugin.Function<void> {
  return defineExtensionPlugin<ExtensionContext>(
    (ctx) => {
      const canvasId = ctx.canvasScope.canvasId();

      // 1) store（可重放状态源）。
      const store = new TaskActivityStore();
      const groupRuns = ctx.canvasGroupRuns;

      // 2) 行能力：装配时构造一次（design D6）。记录只携带这里构造的动作函数引用。
      store.configure({
        locateNode: (nodeId) => {
          const result = ctx.canvasLocate.locateNodes([nodeId]);
          if (!result.ok) ctx.canvasRuntime.controller()?.selectNode(nodeId);
        },
        resolveTaskDisplay: (item) => {
          const canvas = ctx.canvasState.getWorkingCanvas();
          const node = canvas?.document.nodes.find((entry) => entry.id === item.nodeId);
          const catalogState = ctx.taskCatalog.getState();
          const catalog = catalogState.status === "ready" ? catalogState.catalog : null;
          const data = canvas?.nodeData[item.nodeId] as { title?: string; prompt?: string } | undefined;
          return resolveTaskActivityDisplay({
            item,
            node: node ? { id: node.id, type: node.type, ...(data?.title !== undefined ? { title: data.title } : {}), ...(data?.prompt !== undefined ? { prompt: data.prompt } : {}) } : null,
            catalog
          });
        },
        // 活动中的 Agent 记录：按确切 runId 定位同一详情；无关联（普通 Task）返回 false，
        // 由适配器退回作品生成历史，不伪造对话（change: 2026-10-12-add-agent-conversation-panel，任务 5.7）。
        openTaskDetail: async (item) => {
          const conversations = ctx.get("agentConversationService" as never) as AgentConversationServiceHandle | undefined;
          if (!conversations?.locateAndOpenDetail) return false;
          const result = await conversations.locateAndOpenDetail({ runId: item.runId });
          return result.ok;
        },
        openHistory: () => {
          store.markRead();
          ctx.canvasNavigation.openDialog({ dialogId: "canvas-generation-history", payload: {} });
        },
        group: {
          writable: () => (ctx.get("canvasSession" as never) as CanvasSession | undefined)?.isWritable() ?? false,
          resolveTitle: (nodeId) => {
            const data = ctx.canvasState.getWorkingCanvas()?.nodeData[nodeId] as { title?: string } | undefined;
            return data?.title || "节点搭建";
          },
          action: async (row, action) => {
            if (action === "stop") await groupRuns.stop(row.requestId);
            else if (action === "retry") await groupRuns.retry(row.creation.requestId);
            else await groupRuns.refresh();
          },
          openConversation: (row) => {
            const conversations = ctx.get("agentConversationService" as never) as AgentConversationServiceHandle | undefined;
            if (!conversations?.navigateToDetail) throw new Error("对话服务尚未就绪");
            const conversationId = row.creation.conversationId;
            if (!conversationId) throw new Error("该创作尚未建立对话");
            conversations.navigateToDetail({ conversationId, requestId: row.requestId, nodeId: row.creation.rootGroupId });
            const panel = ctx.canvasNavigation.getSnapshot().panel;
            if (panel?.type !== "agent-conversation" || panel.conversationId !== conversationId || panel.requestId !== row.requestId) {
              throw new Error("无法打开对话详情，详情面板尚未就绪");
            }
          }
        }
      });

      const syncGroups = () => store.replaceGroupRuns(groupRuns.getSnapshot());
      const disposeGroups = groupRuns.subscribe(syncGroups);
      syncGroups();
      const disposeOpen = ctx.on("ui.task-activity.open-requested", ({ nodeId }) => store.openGroup(nodeId));

      // 3) 注册 listener 并把 disposer 绑定到 scope。
      const disposeStarted = ctx.on("task.activity.started", (payload) => {
        store.applyEvent({ name: "task.activity.started", payload });
      });
      const disposeUpdated = ctx.on("task.activity.updated", (payload) => {
        store.applyEvent({ name: "task.activity.updated", payload });
      });
      const disposeFinished = ctx.on("task.activity.finished", (payload) => {
        store.applyEvent({ name: "task.activity.finished", payload });
      });
      // 扩展后台活动（非 durable 任务，如镜头参考录制）：按画布过滤后幂等 upsert。
      const disposeJob = ctx.on("extension.activity.updated", ({ job }) => {
        if (job.canvasId !== canvasId) return;
        store.applyJob(job);
      });

      // 4) 启动 bridge（snapshot 只取高水位；session 通道；有限 HTTP recovery）。
      // 扩展用**目录字面量** emit（架构审计要求生产 emit 使用字面量）。
      const bridge = createTaskActivityEventBridge({
        sink: {
          updated: (payload) => ctx.emit("task.activity.updated", payload),
          finished: (payload) => ctx.emit("task.activity.finished", payload)
        },
        initialCursor: 0,
        sources: {
          readSnapshot: async () => {
            const result = await ctx.canvasRemote.taskActivitySnapshot({ canvasId });
            if (!result.ok) throw new Error(result.error);
            return { cursor: result.value.cursor };
          },
          readChanges: async (after) => {
            const result = await ctx.canvasRemote.taskActivityChanges({ canvasId, after });
            if (!result.ok) throw new Error(result.error);
            return result.value;
          },
          subscribe: (input) =>
            ctx.canvasRemote.subscribeTaskActivity({
              canvasId,
              cursor: input.cursor,
              onRecord: (record: CanvasTaskActivity, cursor) => input.onRecord(record, cursor),
              ...(input.onError ? { onError: input.onError } : {})
            })
        },
        onError: () => undefined
      });
      void bridge.start();

      // feature capability：只提供 store 读取（submit 通过事件，不再有 hook）。
      ctx.provide(TASK_ACTIVITY_STORE_SERVICE as never, {
        store,
        getSnapshot: store.getPublicSnapshot,
        subscribe: store.subscribe
      } as never);

      const feedProps: TaskActivityFeedProps = {
        // 活动面板只属于当前画布 scope：媒体读请求带上画布，同步到远端的画布会路由到托管存储。
        store,
        resolveMediaUrl: (storageKey) => ctx.mediaRemote.urlFor(storageKey, ctx.canvasScope.canvasId()),
        // 受控打开宿主已注册的「作品生成历史」弹窗，与工具栏入口一致。
        onOpenHistory: () => {
          store.markRead();
          ctx.canvasNavigation.openDialog({ dialogId: "canvas-generation-history", payload: {} });
        }
      };
      const removeOverlay = ctx.slots.register("canvas.overlay", {
        id: "task-activity-feed",
        owner: TASK_ACTIVITY_PLUGIN_ID,
        priority: 5,
        render: () => <TaskActivityFeed {...feedProps} />
      });

      // 反序清理：overlay → bridge → listener → store。
      return () => {
        removeOverlay();
        bridge.stop();
        disposeStarted();
        disposeUpdated();
        disposeFinished();
        disposeJob();
        disposeGroups?.();
        disposeOpen();
        store.dispose();
      };
    },
    {
      name: TASK_ACTIVITY_PLUGIN_ID,
      inject: [
        "canvasNavigation",
        "slots",
        "canvasRemote",
        "mediaRemote",
        "canvasRuntime",
        "taskCatalog",
        "canvasLocate",
        "canvasScope",
        "canvasState",
        "canvasGroupRuns"
      ]
    }
  );
}
