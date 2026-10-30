import { isFilmSetGroupNode } from "@woohaa3/contracts";
import { resolveTextSubmission } from "../../services/assistant-execution/text-submission.js";
/**
 * Task Execution Plugin（change: adopt-frontend-cordis-plugin-runtime，design D5/D6；
 *   change: unify-canvas-presentation-navigation，task 5.2）。
 *
 * 注册 Canvas Navigation 的 `node-execution` 与 `model-node-editor` panel definition，并用
 * selection coordinator 显式导航：selection 变化只产生 open/replace/close intent，不再由
 * `canvas.node-panel` 首贡献 + selection 隐式决定。
 *
 * 视频编辑能力由 optional `video-capture` Plugin 以 `VIDEO_EDIT_SERVICE` 提供。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { lazy, Suspense, useSyncExternalStore, type ReactNode } from "react";
import type { ExecutionLaunchFeedback } from "./execution-launch.js";
import { resolveFilmSetClipHash, resolveFilmSetTargetClip } from "./film-set-target.js";
import { AuthoringGenerateHost } from "../../host.js";
import { ExecutionPanelPending, ExecutionPanelSkeleton, ExecutionPanelSurface, resolveExecutionPanelSurface } from "./execution-panel-surface.js";
import { DEFAULT_CANVAS_ID } from "../../services/canvas-session.js";
import { resolveModelMcpServerUrl } from "../../mcp-endpoint.js";
import {
  PROMPT_SNIPPET_SOURCE,
  GROUP_RUN_SERVICE,
  RUN_STATE_SERVICE,
  type PromptSnippetSource,
  type RunStateService
} from "../service-keys.js";
import { definePlugin } from "../../plugin.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import type { TaskActivityEventSink } from "./submit-coordinator.js";
import { resolveSelectionContext } from "./selection-context.js";
import { createSubmitCoordinator } from "./submit-coordinator.js";
import { createGroupRunService } from "./group-run-service.js";
import { GROUP_BULK_ACTION_ID, GroupRunSummaryStore, resolveGroupBulkDescriptor } from "./group-run-actions.js";
import { ADD_TO_COMPOSER_ACTION_ID, resolveAddToComposerDescriptor } from "./add-to-composer-action.js";
import { nodeDraftStore } from "./drafts.js";
import { registerGenerationTraceMenu } from "./generation-trace.js";
import { GENERATION_TRACE_DIALOG_ID, registerGenerationTraceDialog } from "./generation-trace-dialog.js";
import { createTaskMonitorRemote } from "../../../shared/task-trace/remote.js";
import { defaultAppTheme, isFilmSetNode, isGlbModelNodeData, OPEN_TASK_INSPECTION_ACTION, TASKS_INSPECT_ACTION } from "@woohaa3/contracts";
import {
  panelRouteForIntent,
  panelTypeForNodeType,
  type PanelPresentationIntent
} from "./node-panel-directives.js";
import { panelKindForNodeType } from "./node-panel-registry.js";
import {
  normalizeCanvasPanelRoute,
  type CanvasPanelDefinition,
  type CanvasPanelRoute
} from "../../navigation/contracts.js";
import type { AgentConversationServiceHandle } from "../../services/agent-conversation-service.js";
import { AgentConversationPanel } from "./execution-panel/agent-conversation-panel.js";
// 文本宿主随执行面板定义装配：它只做一次节点类型判定并转交 composer，
// 单独成 chunk 只会让打开文本面板多一次必然请求（change: 2026-10-27-merge-nonessential-panel-chunks）。
import { TextExecutionHost } from "./text-execution-host.js";
const ModelExecutionHost = lazy(() => import("./model-execution-host.js").then((module) => ({ default: module.ModelExecutionHost })));
const ModelParameterPanel = lazy(() => import("./model-parameter-panel.js").then((module) => ({ default: module.ModelParameterPanel })));
const GroupRunSummaryOverlay = lazy(() => import("./group-run-summary-overlay.js").then(module => ({ default: module.GroupRunSummaryOverlay })));
function GroupRunSummary({ store }: { store: GroupRunSummaryStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return state ? <Suspense fallback={null}><GroupRunSummaryOverlay store={store} /></Suspense> : null;
}

export const TASK_EXECUTION_PLUGIN_ID = "task-execution";
export const NODE_EXECUTION_PANEL_TYPE = "node-execution";
export const MODEL_NODE_EDITOR_PANEL_TYPE = "model-node-editor";
export const AGENT_CONVERSATION_PANEL_TYPE = "agent-conversation";

export function taskExecutionExtension(options: { canvasId?: string } = {}): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const canvasId = options.canvasId ?? DEFAULT_CANVAS_ID;
      let launchFeedback: ExecutionLaunchFeedback | null = null;
      let launchDisposed = false;
      let launchEpoch = 0;
      const onLaunchVisibility = () => { if (document.hidden) launchEpoch++; };
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onLaunchVisibility);
      // Load animation code on interaction; submission never waits for the optional effect.
      const loadLaunch = () => import("./execution-launch.js").then(module => {
        if (!launchDisposed && typeof window !== "undefined") launchFeedback ??= new module.ExecutionLaunchFeedback(window,
        (nodeId, operationId) => ctx.canvasRuntime.historyDotScreenPoint?.(nodeId, operationId) ?? null,
        (nodeId, operationId) => {
          const service = ctx.get(RUN_STATE_SERVICE as never) as RunStateService | undefined;
          const record = service?.snapshot().records.find(item => item.nodeId === nodeId && item.operationId === operationId);
          return !!record && record.state !== "queued" && record.state !== "running";
        });
        return module;
      });
      ctx.effect(() => () => {
        launchDisposed = true; launchFeedback?.dispose();
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onLaunchVisibility);
      }, "execution-launch-feedback");
      /**
       * 当前 scope 的稳定画布身份（change: 2026-10-16-add-group-selection-toolbar）。
       *
       * 优先用 Canvas Scope 服务（extension 语义）；缺失时回落到装配时的 canvasId。批量执行用它
       * 给提交锁/预占分区并绑定结果摘要，页面切换后旧回调不再写新页面。
       */
      const resolveScopeCanvasId = (): string => ctx.get("canvasScope")?.canvasId() ?? canvasId;
      // 分组提交摘要：绑定 canvasId/groupId 的有界 overlay 状态（每页一个）。
      const groupSummaryStore = new GroupRunSummaryStore();

      // 任务监控入口门控（change: 2026-10-13-...，任务 8.6/9.1）：由宿主内置任务监控入口注册的
      // `openTaskInspection` 页面动作承担导航；其可用性来自 `tasks.inspect` 站点策略。
      // 普通用户（无该 action）不显示入口，保留画布活动/节点历史，不引导进入全局管理数据。
      const canViewTask = (): boolean => {
        const action = ctx.get(OPEN_TASK_INSPECTION_ACTION as never) as { available?: () => boolean } | undefined;
        if (action) return action.available?.() ?? true;
        return ctx.get("siteAccessCapability")?.hasAction(TASKS_INSPECT_ACTION) ?? false;
      };
      // `taskKey` 用于从画布产物精确打开对应的上游任务（change: l0-generation-provenance）。
      const openTaskInspection = (input: { canvasId?: string; nodeId?: string; taskKey?: string }) => {
        const action = ctx.get(OPEN_TASK_INSPECTION_ACTION as never) as
          | { open?: (target?: { canvasId?: string; nodeId?: string; taskKey?: string }) => void }
          | undefined;
        // 无注册动作（tasks.inspect 不允许）时不做任何导航。
        action?.open?.(input);
      };

      // 任务活动 typed 事件出口（change: formalize-frontend-event-bus，design D6）：
      // 单节点与 group 共用同一 sink；optional task-activity 缺失时无 listener，行为不变。
      const activitySink: TaskActivityEventSink = {
        launch: event => {
          const started = Date.now();
          const epoch = launchEpoch;
          void loadLaunch().then(module => {
            if (!launchDisposed && epoch === launchEpoch && Date.now() - started < module.EXECUTION_LAUNCH.waitMs) launchFeedback?.handle(event);
          }).catch(() => { /* Optional feedback cannot fail a submission. */ });
        },
        started: (payload) => ctx.emit("task.activity.started", payload),
        localRejected: (payload) => ctx.emit("task.activity.finished", payload)
      };

      // 节点右键「查看生成溯源」（change: l0-generation-provenance；change: 生成溯源改为画布内浮窗）：
      // 按既有 `canvas.context-menu` 扩展菜单项贡献注册，与「保存为片段…」同一模式，不另建菜单 UI。
      // 只在可溯源节点（有产物或最近一次 run）且具备 tasks.inspect 时出现；解析到 taskKey 时在
      // **当前画布**打开 dialog —— 不离开画布，因此不拆 Canvas page scope（Y.Doc 连接/渲染器/视口
      // 保持）；解析不到 taskKey 仍回退 canvasId + nodeId 筛选的任务监控页。正文与独立监控页共用
      // 同一组件；数据复用任务监控的只读 adapter（传输仍由画布 scope 的 Application transport 提供）。
      const removeGenerationTraceDialog = registerGenerationTraceDialog(ctx, {
        remote: createTaskMonitorRemote({ remote: ctx.applicationRemote.transport }),
        resolveMediaUrl: (storageKey, canvasId) => ctx.mediaRemote.urlFor(storageKey, canvasId),
        openTaskMonitor: (target) => openTaskInspection(target)
      });
      /**
       * 「查看生成溯源」的浮窗打开器。
       *
       * 首次点击时 dialog 的 pre-commit 参与者（关闭右键菜单、结算 focus）可能还没稳定，
       * 偶发会拒绝入栈；这时**不立刻跳独立页**（跳页会拆掉 Canvas scope，代价很大），
       * 而是下一拍重试一次，仍失败才回退任务监控页。
       */
      let traceRetryTimer: ReturnType<typeof setTimeout> | null = null;
      let traceDisposed = false;
      const openGenerationTraceDialog = (payload: { taskKey: string; canvasId?: string; nodeId?: string }): boolean => {
        const request = { dialogId: GENERATION_TRACE_DIALOG_ID, payload };
        if (ctx.dialogs.open(request).ok) return true;
        if (traceRetryTimer !== null) clearTimeout(traceRetryTimer);
        traceRetryTimer = setTimeout(() => {
          traceRetryTimer = null;
          if (traceDisposed) return;
          if (ctx.dialogs.open(request).ok) return;
          openTaskInspection(
            payload.canvasId ? { canvasId: payload.canvasId, ...(payload.nodeId ? { nodeId: payload.nodeId } : {}) } : { taskKey: payload.taskKey }
          );
        }, 0);
        // 已经安排了重试，调用方不再走同步回退路径。
        return true;
      };
      const removeGenerationTraceMenu = registerGenerationTraceMenu(ctx, {
        owner: TASK_EXECUTION_PLUGIN_ID,
        getCanvas: () => workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas,
        canInspect: canViewTask,
        // 解析到 taskKey → 画布内浮窗；未入栈（或解析不到）→ 回退任务监控页筛选。
        openTraceDialog: openGenerationTraceDialog,
        // 解析到 taskKey 时只带 taskKey 精确定位；否则回退 canvasId + nodeId 筛选列表。
        openTrace: (target) =>
          openTaskInspection(target.taskKey ? { taskKey: target.taskKey } : { canvasId: target.canvasId, nodeId: target.nodeId })
      });

      // 普通执行 panel（图片/文本/视频/音频生成）。
      const executionPanel: CanvasPanelDefinition = {
        type: NODE_EXECUTION_PANEL_TYPE,
        owner: TASK_EXECUTION_PLUGIN_ID,
        validate: (route) => isExecutionPanelRoute(route),
        render: ({ route, writable }) => {
          if (route.type !== NODE_EXECUTION_PANEL_TYPE) return null;
          const snippetSource = ctx.get(PROMPT_SNIPPET_SOURCE) as PromptSnippetSource | undefined;
          const runtime = ctx.canvasRuntime;
          const presentation = route.presentation ?? "compact";
          const submitPresentationIntent = (intent: PanelPresentationIntent) => {
            if (intent.kind === "close") {
              ctx.canvasNavigation.closePanel(panelTypeForNodeType("node-execution"));
              return;
            }
            const next = panelRouteForIntent("node-execution", route.nodeId, intent);
            if (next) ctx.canvasNavigation.openPanel(next);
          };
          // 呈现表面与骨架、宿主共用同一判断（音频没有 expanded 面）。
          const surface = resolveExecutionPanelSurface(presentation, resolvePanelNodeType(route.nodeId));
          // 文本宿主已静态装配；composer 的懒加载骨架由 `AuthoringGenerateHost` 内部提供，
          // 这里不再包一层不会触发的 `Suspense`。
          if (resolvePanelNodeType(route.nodeId) === "text") return (
            <TextExecutionHost canvasId={canvasId} nodeId={route.nodeId} writable={writable} runtime={runtime} presentation={surface} onPresentationIntent={submitPresentationIntent} />
          );
          return (
            <Suspense fallback={<ExecutionPanelPending nodeId={route.nodeId} presentation={surface} runtime={runtime} />}><ModelExecutionHost
              submitCoordinator={coordinator}
              canvasId={canvasId}
              selectedNodeId={route.nodeId}
              session={ctx.canvasSession}
              runClient={ctx.canvasRemote}
              writable={writable}
              dialogs={ctx.dialogs}
              catalog={ctx.taskCatalog}
              registry={ctx.modelInteractions}
              presentation={presentation}
              runtime={runtime}
              onPresentationIntent={submitPresentationIntent}
              activity={activitySink}
              panelActions={{
                ...(canViewTask()
                  ? {
                      viewTask: () => openTaskInspection({ canvasId, nodeId: route.nodeId })
                    }
                  : {})
              }}
              {...(snippetSource ? { snippetSource } : {})}
              onParameterGesture={(input) => {
                ctx.canvasEdit.recordParameter({
                  label: "撤销参数修改",
                  nodeId: input.nodeId,
                  modelKey: input.modelKey,
                  before: input.before,
                  after: input.after,
                  apply: input.apply
                });
              }}
            /></Suspense>
          );
        }
      };

      // 模型 model3d/composite-asset 节点编辑 panel（与 model-focus 互斥；由 Canvas Navigation 保证）。
      const modelNodeEditorPanel: CanvasPanelDefinition = {
        type: MODEL_NODE_EDITOR_PANEL_TYPE,
        owner: TASK_EXECUTION_PLUGIN_ID,
        render: ({ route, writable }) => {
          if (route.type !== MODEL_NODE_EDITOR_PANEL_TYPE) return null;
          // 交付完成后重新解析片段与写权限，避免沿用占位节点时期的空 clipId。
          useSyncExternalStore(ctx.canvasState.subscribe, ctx.canvasState.getWorkingCanvas, ctx.canvasState.getWorkingCanvas);
          if (!resolveSelectionContext(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas(), route.nodeId)) return null;
          return (
            <ExecutionPanelSurface nodeId={route.nodeId} presentation="compact" runtime={ctx.canvasRuntime}>
              <Suspense fallback={<ExecutionPanelSkeleton />}><ModelParameterPanel
                canvasId={canvasId}
                nodeId={route.nodeId}
                nodeType={resolveModelPanelNodeType(route.nodeId)}
                isFilmSet={resolveIsFilmSetNode(route.nodeId)}
                mcpServerUrl={resolveModelMcpServerUrl()}
                disabledReason={null}
                renderGenerate={buildModelRenderGenerate(ctx, route.nodeId, writable)}
              /></Suspense>
            </ExecutionPanelSurface>
          );
        }
      };

      const disposeExecution = ctx.canvasNavigation.registerPanel(executionPanel);
      const disposeEditor = ctx.canvasNavigation.registerPanel(modelNodeEditorPanel);

      // Agent 对话详情 panel（change: 2026-10-12-add-agent-conversation-panel，任务 5.4/5.5）。
      // 唯一展开状态源是 CanvasNavigation 的类型化 route；只有用户点击详情动作才打开。打开只读
      // 快照、定位确切回合，**不**重新提交；关闭恢复合法来源（由 Nav 保存的轻量来源 route）。
      const agentConversations = ctx.get("agentConversationService" as never) as AgentConversationServiceHandle | undefined;
      // 「返回生成面板」语义的实时来源：订阅选中节点与聚焦变化，供详情面板内部
      // 用 useSyncExternalStore 派生按钮文案（render 本身保持无 hook，便于静态解析）。
      const detailReturnSource = agentConversations
        ? {
            subscribe: (listener: () => void) => {
              const offSelection = nodeSelectionStore.subscribe(listener);
              const offNavigation = ctx.canvasNavigation.subscribe(listener);
              return () => { offSelection(); offNavigation(); };
            },
            canReturn: () => agentConversations.canReturnToSource()
          }
        : undefined;
      const agentConversationPanel: CanvasPanelDefinition = {
        type: AGENT_CONVERSATION_PANEL_TYPE,
        owner: TASK_EXECUTION_PLUGIN_ID,
        // 聚焦态占用公共侧栏容器（与检查器共用、互斥；design D6a）。
        focusPresentation: "sidebar",
        validate: (route) => route.type === AGENT_CONVERSATION_PANEL_TYPE && route.conversationId !== "" && route.requestId !== "",
        render: ({ route }) => {
          if (route.type !== "agent-conversation" || !agentConversations) return null;
          return (
            <AgentConversationPanel
              conversationId={route.conversationId}
              requestId={route.requestId}
              {...(route.nodeId ? { nodeId: route.nodeId } : {})}
              {...(detailReturnSource ? { returnToSource: detailReturnSource } : {})}
              service={agentConversations}
              onManageAssistant={() => ctx.canvasNavigation.openDialog({ dialogId: "agent-assistant", payload: { canvasId: ctx.canvasScope.canvasId(), ...(agentConversations.getDetail()?.conversation.connectionId ? { connectionId: agentConversations.getDetail()!.conversation.connectionId } : {}) } })}
              targetExecution={() => {
                const detail = agentConversations.getDetail();
                const target = detail?.turns.find(turn => turn.requestId === route.requestId)?.target;
                const nodeId = target?.nodeId;
                const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
                if (!nodeId || !target || !ctx.canvasSession.isWritable() || !canvas?.document.nodes.some((node) => node.id === nodeId)) return null;
                if (target.mode === "canvas-group") return canvas.document.nodes.some(node => node.id === nodeId && node.type === "group") ? { ...target, action: "modify", prompt: "", expectedContentHash: undefined } : null;
                const hash = target.mode === "film-set" ? resolveFilmSetClipHash(nodeId, target.clipId) : (canvas.nodeData[nodeId]?.modelContentVersion as { contentHash?: string } | undefined)?.contentHash;
                return { ...target, action: "modify", prompt: "", ...(hash ? { expectedContentHash: hash } : {}) };
              }}
              onContinueGroup={() => {
                const target = agentConversations.getDetail()?.turns.find(turn => turn.requestId === route.requestId)?.target;
                const canvas = ctx.canvasState.getCanvas();
                if (target?.mode !== "canvas-group" || !target.nodeId || !ctx.canvasSession.isWritable() || !canvas?.document.nodes.some(node => node.id === target.nodeId && node.type === "group")) return;
                ctx.canvasRuntime.controller()?.selectNode(target.nodeId);
                ctx.canvasNavigation.openPanel({ type: MODEL_NODE_EDITOR_PANEL_TYPE, nodeId: target.nodeId });
              }}
              // 概览态让 runtime 视口避让侧栏宽度；卸载时释放（0）。聚焦态宽度由
              // FocusWorkspace 统一计算（不重复占位）。
              onWidthChange={(width) => {
                if (ctx.canvasNavigation.getSnapshot().mode.type !== "overview") return;
                ctx.canvasRuntime.setContentRect({ right: width ?? 0 });
              }}
              onClose={() => agentConversations.collapseDetail()}
            />
          );
        }
      };
      const disposeAgentConversation = ctx.canvasNavigation.registerPanel(agentConversationPanel);

      // group 批量执行 capability（change: add-canvas-node-grouping，任务 3.4b；
      // change: 2026-10-16-add-group-selection-toolbar，任务 1.1-1.4/2.2/2.3/4.1）：
      // 横条与右键共用同一 service：只读预览（N）、提交锁/预占、请求前复核、结果摘要。
      // 提交仍逐个走既有单节点 coordinator，失败不回滚已受理项，不写分组任务状态。
      const coordinator = createSubmitCoordinator({
        store: woohaa3CanvasStore,
        client: ctx.canvasRemote,
        activity: activitySink,
        // 镜头参考：录制完成并冻结后（画布更新）自动续交一次（任务 8.6）。
        isWaiting: (error) => error.includes("等待镜头参考"),
        isWritable: () => ctx.canvasSession.isWritable(),
        imageReferenceBackground: () => (ctx.get("theme") as { getSnapshot?: () => { tokens?: { webSubtle?: string } } } | undefined)?.getSnapshot?.().tokens?.webSubtle ?? defaultAppTheme().tokens.webSubtle
      });
      // 统一运行状态：活动状态优先于滞后的 canonical taskStatus（不依赖鼠标移动刷新）。
      const runStateService = (): RunStateService | undefined => ctx.get(RUN_STATE_SERVICE) as RunStateService | undefined;
      const groupRun = createGroupRunService({
        canvasId: () => resolveScopeCanvasId(),
        getCanvas: () => workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas ?? null,
        catalogState: () => ctx.taskCatalog.getState(),
        isWritable: () => ctx.canvasSession.isWritable(),
        readDraft: (nodeId, modelKey) => nodeDraftStore.get(nodeId, modelKey),
        // 统一运行状态按 `(canvasId, nodeId)` 查询；缺失时视为空闲（由提交自身门禁兜底）。
        isBusy: (nodeId) => runStateService()?.isBusy(resolveScopeCanvasId(), nodeId) ?? false,
        submit: (input) => coordinator.submit(input),
        textPrecheck: (canvas, nodeId) => resolveTextSubmission(ctx.agentConversationService, canvas, nodeId, () => invalidateToolbar()),
        submitText: async input => { const result = await ctx.agentConversationService.submitTurn({ ...input, requestId: `assistant:${crypto.randomUUID()}` }); return result.ok ? { ok: true } : { ok: false, error: result.error }; },
        onSummary: (summary) => {
          groupSummaryStore.show({ canvasId: resolveScopeCanvasId(), summary });
        }
      });
      ctx.provide(GROUP_RUN_SERVICE as never, groupRun as never);

      // 分组「批量执行 · N」横条贡献（change: 2026-10-16-add-group-selection-toolbar，任务 2.2）：
      // 宿主横条是唯一渲染者，这里只提供**纯数据描述**与命中派发；N、原因与提交态来自同一
      // service 与预览，与右键共享门禁。仅对 group 节点呈现，不参与其它节点类型。
      const removeGroupBulkAction = ctx.slots.register("canvas.node-action", {
        id: GROUP_BULK_ACTION_ID,
        owner: TASK_EXECUTION_PLUGIN_ID,
        order: -20,
        available: ({ nodeId, nodeType }) => {
          if (nodeType !== "group") return false;
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
          const node = canvas?.document.nodes.find(entry => entry.id === nodeId);
          return !!node && !isFilmSetGroupNode(node, canvas?.nodeData?.[nodeId]);
        },
        describe: ({ nodeId }) => resolveGroupBulkDescriptor({
          preview: groupRun.preview(nodeId),
          submitting: groupRun.isSubmitting(nodeId)
        }),
        activate: ({ nodeId, writable }) => {
          if (!writable) return;
          if (groupRun.isSubmitting(nodeId)) return;
          const pointer = ctx.canvasRuntime.lastPointerWorld();
          const point = pointer ? ctx.canvasRuntime.worldToClient(pointer) : null;
          void groupRun.runGroup(nodeId, point ? { ...point, token: crypto.randomUUID() } : undefined);
        }
      });

      // 卡片悬浮条「添加到对话框」：选中该节点，底部停靠的节点面板随后切到它。
      // 只对带生成面板的节点类型呈现（图片/视频/音频/文本）；分组与模型卡片没有该面板。
      const removeAddToComposerAction = ctx.slots.register("canvas.node-action", {
        id: ADD_TO_COMPOSER_ACTION_ID,
        owner: TASK_EXECUTION_PLUGIN_ID,
        order: -30,
        available: ({ nodeType }) => panelKindForNodeType(nodeType) !== null,
        describe: ({ writable }) => resolveAddToComposerDescriptor({ writable }),
        activate: ({ nodeId, writable }) => {
          if (!writable) return;
          // 与画布选中同一条路径：面板内容跟随 selection，避免这里再写一份打开逻辑。
          ctx.canvasRuntime.controller()?.selectNode(nodeId);
        }
      });

      // 分组提交摘要 overlay（change: 2026-10-16-add-group-selection-toolbar，任务 4.1）：
      // 非模态、可关闭、绑定 canvasId；复用 canvas overlay 与共享 chrome。
      const removeGroupSummaryOverlay = ctx.slots.register("canvas.overlay", {
        id: "group-run-summary",
        owner: TASK_EXECUTION_PLUGIN_ID,
        priority: 27,
        render: () => <GroupRunSummary store={groupSummaryStore} />
      });

      /**
       * 描述失效（任务 2.3）：N、禁用原因与「提交中」文案在**静止鼠标**下也随数据变化更新。
       *
       * 数据源变化（草稿、目录、working/canonical 画布、统一运行状态、本页提交编排）任一到达时
       * 请求一帧重建横条描述；**不逐帧扫描全画布**。目录/运行态订阅可能晚于本插件装配，因此在
       * effect 内建立并在释放时撤销。
       */
      const invalidateToolbar = () => ctx.canvasRuntime.controller()?.invalidate("node-action-description");
      const offGroupRun = groupRun.subscribe(invalidateToolbar);
      const offDrafts = nodeDraftStore.subscribe(invalidateToolbar);
      const offCatalog = ctx.taskCatalog.subscribe(invalidateToolbar);
      const offCanvas = woohaa3CanvasStore.subscribe(() => {
        groupSummaryStore.syncCanvas(resolveScopeCanvasId());
        invalidateToolbar();
        // 权威画布更新后重试等待中的镜头参考提交（每个节点至多续交一次）。
        void coordinator.retryWaiting();
      });
      // 运行态服务由 run-state 插件提供（兄弟插件），装配期它的 fiber 还没 active：在这里
      // `ctx.get` 只会拿到 undefined，订阅永远建不起来，横条的 N/禁用原因就不再随运行态失效。
      // 声明式等待：服务就绪才订阅，服务撤销随 fiber 一起释放。
      ctx.inject([RUN_STATE_SERVICE], (scoped) => {
        const service = scoped.get(RUN_STATE_SERVICE) as RunStateService;
        const off = service.subscribe(invalidateToolbar);
        scoped.effect(() => () => off(), "task-execution:run-state-toolbar");
      });

      // selection coordinator：selection → 显式 panel route。
      const resolvePanelRoute = (nodeId: string | null): CanvasPanelRoute | null => {
        if (!nodeId) return null;
        const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
        const context = resolveSelectionContext(canvas, nodeId);
        if (!context) return null;
        if (context.panelKind) return { type: NODE_EXECUTION_PANEL_TYPE, nodeId };
        if (isModelEditorNodeType(context.nodeType, context.nodeData)) return { type: MODEL_NODE_EDITOR_PANEL_TYPE, nodeId };
        return null;
      };

      let lastRoute: CanvasPanelRoute | null = null;
      const syncSelection = () => {
        // focus 活动期间 selection 不驱动 panel（design D5：普通 selection 不退出/干扰 focus）。
        if (ctx.canvasNavigation.getSnapshot().mode.type === "node-focus") return;
        const primary = nodeSelectionStore.getSnapshot().primaryNodeId;
        const route = resolvePanelRoute(primary);
        // 只在 identity（type+nodeId）变化时提交，避免重复 transition；也因此不会在用户
        // 展开后因同节点 selection 通知而收起（design D5/D6）。
        if (sameRouteIdentity(route, lastRoute)) return;
        if (!route) {
          lastRoute = null;
          ctx.canvasNavigation.closePanel(NODE_EXECUTION_PANEL_TYPE);
          ctx.canvasNavigation.closePanel(MODEL_NODE_EDITOR_PANEL_TYPE);
          return;
        }
        const previousRoute = lastRoute;
        lastRoute = route;
        const opened = ctx.canvasNavigation.openPanel(normalizeCanvasPanelRoute(route));
        if (!opened.ok) lastRoute = previousRoute;
      };
      const unsubscribeSelection = nodeSelectionStore.subscribe(syncSelection);
      // focus 结束时 Navigation 已恢复返回面板；以当前选择作为去重游标，
      // 后续数据回流不能用聚焦期间的旧选择覆盖刚恢复的面板。
      let wasFocused = ctx.canvasNavigation.getSnapshot().mode.type === "node-focus";
      const unsubscribeNavigation = ctx.canvasNavigation.subscribe(() => {
        const snapshot = ctx.canvasNavigation.getSnapshot();
        const focused = snapshot.mode.type === "node-focus";
        if (wasFocused && !focused) {
          lastRoute = resolvePanelRoute(nodeSelectionStore.getSnapshot().primaryNodeId);
        }
        wasFocused = focused;
      });
      // 面板与选择读取同一 working 投影，待确认节点不等于已删除节点。
      // 数据先后到达/重基后重新解析 route；显式关闭仍由 lastRoute 去重，不会被回流重开。
      const unsubscribeCanvas = woohaa3CanvasStore.subscribe(() => {
        const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
        ctx.canvasNavigation.reconcile(new Set(canvas?.document.nodes.map((node) => node.id) ?? []));
        syncSelection();
      });

      ctx.effect(
        () => () => {
          disposeExecution();
          disposeEditor();
          disposeAgentConversation();
          traceDisposed = true;
          if (traceRetryTimer !== null) clearTimeout(traceRetryTimer);
          removeGenerationTraceMenu();
          removeGenerationTraceDialog();
          removeGroupBulkAction();
          removeAddToComposerAction();
          removeGroupSummaryOverlay();
          offGroupRun();
          offDrafts();
          offCatalog();
          offCanvas();
          groupRun.dispose();
          groupSummaryStore.dispose();
          unsubscribeSelection();
          unsubscribeNavigation();
          unsubscribeCanvas();
        },
        "task-execution-panels"
      );
    },
    {
      name: TASK_EXECUTION_PLUGIN_ID,
      inject: ["theme", "slots", "canvasRemote", "canvasSession", "canvasState", "taskCatalog", "dialogs", "modelInteractions", "canvasRuntime", "canvasNavigation", "canvasEdit", "appRouter", "applicationRemote", "mediaRemote"]
    }
  );
}

function isModelEditorNodeType(nodeType: string, nodeData?: unknown): boolean {
  // 宿主模型编辑器只服务 model3d 与片场业务；炉体等其它复合资产业务聚焦到自己的 extension 工作区。
  return nodeType === "model3d" || nodeType === "group" || isFilmSetNode(nodeType, nodeData);
}

/** 读取选中模型节点的真实类型，供模型面板渲染 MCP 指引。 */
function resolveModelPanelNodeType(nodeId: string): string {
  return resolvePanelNodeType(nodeId) ?? "model3d";
}

/** 读取节点在规范画布里的类型；节点不存在或画布未就绪时返回 `null`。 */
function resolvePanelNodeType(nodeId: string): string | null {
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
  return canvas?.document.nodes.find((entry) => entry.id === nodeId)?.type ?? null;
}

/** 选中节点是否为片场业务（composite-asset + extensionId="film-set"）。 */
function resolveIsFilmSetNode(nodeId: string): boolean {
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
  const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
  return isFilmSetGroupNode(node, canvas?.nodeData?.[nodeId]);
}



/**
 * 由 `authoring.generate` slot 组装模型面板生成入口
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 6.4 / design D9）。
 *
 * 宿主不再读取或导入任何具体生成插件（如 ChatGPT）：无 contribution 时返回 undefined，面板只
 * 显示 MCP 指引（不出现不能工作的生成按钮）。目标身份与门禁由宿主注入。
 */
function buildModelRenderGenerate(
  ctx: Context,
  nodeId: string,
  writable: boolean
): (() => ReactNode) | undefined {
  const isFilmSet = resolveIsFilmSetNode(nodeId);
  const isGroup = resolvePanelNodeType(nodeId) === "group";
  const mode = isFilmSet ? "film-set" : isGroup ? "canvas-group" : "model3d";
  // 片场面板无显式片段选择：解析默认片段并带上，否则后端不签发片段写权限（动作写入必带 clipId）。
  const clipId = isFilmSet ? resolveFilmSetTargetClip(nodeId) : undefined;
  const expectedContentHash = isFilmSet ? resolveFilmSetClipHash(nodeId) : isGroup ? resolveExpectedGroupAppearanceHash(nodeId) : resolveExpectedModelContentHash(nodeId);
  const blockedReason = isFilmSet && !clipId ? "该片场节点还没有可写入的动画片段，请先创建动画片段。" : null;
  // 文件模型以原始 GLB 为唯一权威内容：脚本/部件生成入口按来源禁用并说明原因
  // （change: 2026-10-28-support-glb-model-nodes，spec「文件模型仅提供可用操作」）。
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
  const fileModel = isGlbModelNodeData(canvas?.nodeData?.[nodeId]);
  const fileModelReason = fileModel ? "文件模型只支持查看和下载原 GLB，不提供脚本修改。" : null;
  return () => (
    <AuthoringGenerateHost
      canvasId={resolveCanvasId()}
      nodeId={nodeId}
      mode={mode}
      writable={writable && blockedReason === null && !fileModel}
      disabledReason={fileModelReason ?? (!writable ? "当前会话不可写，无法直接生成。" : blockedReason)}
      {...(expectedContentHash ? { expectedContentHash } : {})}
      clipId={clipId ?? null}
      onAuthorize={() => ctx.canvasNavigation.openDialog({ dialogId: "agent-assistant", payload: {} })}
    />
  );
}

function resolveExpectedGroupAppearanceHash(nodeId: string): string | undefined {
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
  const data = canvas?.nodeData?.[nodeId] as { groupAppearance?: { model?: { contentVersion?: { contentHash?: unknown } } } } | undefined;
  const hash = data?.groupAppearance?.model?.contentVersion?.contentHash;
  return typeof hash === "string" && hash !== "" ? hash : undefined;
}

/** 当前画布 id（宿主注入目标身份用）。 */
function resolveCanvasId(): string {
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
  return canvas?.id ?? "";
}

/** 读取节点模型内容哈希作为并发 precondition（缺失则省略，由服务端以当前定义为准）。 */
function resolveExpectedModelContentHash(nodeId: string): string | undefined {
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
  const data = canvas?.nodeData?.[nodeId] as { modelContentVersion?: { contentHash?: unknown } } | undefined;
  const hash = data?.modelContentVersion?.contentHash;
  return typeof hash === "string" && hash !== "" ? hash : undefined;
}

/** selection coordinator 只关心 type + nodeId 的 identity，不因 presentation 变化重复导航。 */
function sameRouteIdentity(a: CanvasPanelRoute | null, b: CanvasPanelRoute | null): boolean {
  if (!a || !b) return a === b;
  return a.type === b.type && a.nodeId === b.nodeId;
}

/** 执行面板 route 校验：只接受 nodeId 与非空 presentation。 */
function isExecutionPanelRoute(route: CanvasPanelRoute): boolean {
  if (route.type !== "node-execution") return false;
  if (typeof route.nodeId !== "string" || route.nodeId === "") return false;
  return route.presentation === undefined || route.presentation === "compact" || route.presentation === "expanded";
}
