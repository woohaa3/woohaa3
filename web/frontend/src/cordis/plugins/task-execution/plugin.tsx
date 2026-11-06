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
import { useSyncExternalStore, type ReactNode } from "react";
import type { ExecutionLaunchFeedback } from "./execution-launch.js";
import { AuthoringGenerateHost } from "../../host.js";
import { ExecutionPanelSurface, resolveExecutionPanelSurface } from "./execution-panel-surface.js";
import { DEFAULT_CANVAS_ID } from "../../services/canvas-session.js";
import { resolveModelMcpServerUrl } from "../../mcp-endpoint.js";
import {
  PROMPT_SNIPPET_SOURCE,
  RUN_STATE_SERVICE,
  type PromptSnippetSource,
  type RunStateService
} from "../service-keys.js";
import { definePlugin } from "../../plugin.js";
import { worldCameraEditorStore } from "../../services/world-camera-editor-store.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import type { TaskActivityEventSink } from "./submit-coordinator.js";
import { resolveSelectionContext } from "./selection-context.js";
import { createSubmitCoordinator } from "./submit-coordinator.js";
import { nodeDraftStore } from "./drafts.js";
import { shouldDismissAgentDetailOnDeselect } from "./detail-dismissal.js";
import { registerGenerationTraceMenu } from "./generation-trace.js";
import { GENERATION_TRACE_DIALOG_ID, registerGenerationTraceDialog } from "./generation-trace-dialog.js";
import { createTaskMonitorRemote } from "../../../shared/task-trace/remote.js";
import { decodeWorldCamera, decodeSceneAreaData, isGlbModelNodeData, isModelNodeType, OPEN_TASK_INSPECTION_ACTION, TASKS_INSPECT_ACTION } from "@woohaa3/contracts";
import {
  panelRouteForIntent,
  panelTypeForNodeType,
  type PanelPresentationIntent
} from "./node-panel-directives.js";
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
// 模型执行宿主随执行面板定义静态装配：图片/视频/音频是执行面板的主要打开路径，
// 不再为它承担一次按需请求；加载骨架仍服务 authoring 等按需入口。
import { ModelExecutionHost } from "./model-execution-host.js";
// 模型参数面板已随宿主的静态依赖进入启动包，保留 `lazy()` 只会多一次空转 Suspense。
import { ModelParameterPanel } from "./model-parameter-panel.js";

export const TASK_EXECUTION_PLUGIN_ID = "task-execution";
export const NODE_EXECUTION_PANEL_TYPE = "node-execution";
export const MODEL_NODE_EDITOR_PANEL_TYPE = "model-node-editor";
export const GROUP_EXECUTION_PANEL_TYPE = "group-execution";
export const DIRECTOR_EXECUTION_PANEL_TYPE = "director-execution";
export const CAMERA_EXECUTION_PANEL_TYPE = "camera-execution";
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
      // optional task-activity 缺失时无 listener，行为不变。
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
          // 文本与模型执行宿主都已静态装配；按需入口的骨架由各自模块内部提供，
          // 这里不再包一层不会触发的 `Suspense`。
          if (resolvePanelNodeType(route.nodeId) === "text") return (
            <TextExecutionHost canvasId={canvasId} nodeId={route.nodeId} writable={writable} runtime={runtime} presentation={surface} onPresentationIntent={submitPresentationIntent} />
          );
          return (
            <ModelExecutionHost
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
            />
          );
        }
      };

      // 模型 model3d/composite-asset 节点编辑 panel（与 model-focus 互斥；由 Canvas Navigation 保证）。
      const modelNodeEditorPanel: CanvasPanelDefinition = {
        type: MODEL_NODE_EDITOR_PANEL_TYPE,
        owner: TASK_EXECUTION_PLUGIN_ID,
        render: ({ route, writable }) => {
          if (route.type !== MODEL_NODE_EDITOR_PANEL_TYPE) return null;
          useSyncExternalStore(ctx.canvasState.subscribe, ctx.canvasState.getWorkingCanvas, ctx.canvasState.getWorkingCanvas);
          if (!resolveSelectionContext(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas(), route.nodeId)) return null;
          return (
            <ExecutionPanelSurface nodeId={route.nodeId} presentation="compact" runtime={ctx.canvasRuntime}>
              <ModelParameterPanel
                canvasId={canvasId}
                nodeId={route.nodeId}
                nodeType={resolveModelPanelNodeType(route.nodeId)}
                mcpServerUrl={resolveModelMcpServerUrl()}
                disabledReason={null}
                renderGenerate={buildModelRenderGenerate(ctx, route.nodeId, writable)}
              />
            </ExecutionPanelSurface>
          );
        }
      };

      // 2D 组执行面板：与 3D 模型同样由 authoring 生成器承载，模式为 canvas-group；
      // 宿主在签发工具 grant 时绑定根组，助手只能改根组与成员。
      const groupExecutionPanel: CanvasPanelDefinition = {
        type: GROUP_EXECUTION_PANEL_TYPE,
        owner: TASK_EXECUTION_PLUGIN_ID,
        render: ({ route, writable }) => {
          if (route.type !== GROUP_EXECUTION_PANEL_TYPE) return null;
          useSyncExternalStore(ctx.canvasState.subscribe, ctx.canvasState.getWorkingCanvas, ctx.canvasState.getWorkingCanvas);
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
          if (!canvas?.document.nodes.some((node) => node.id === route.nodeId && node.type === "workflow-group-2d")) return null;
          return (
            <ExecutionPanelSurface nodeId={route.nodeId} presentation="compact" runtime={ctx.canvasRuntime}>
              <AuthoringGenerateHost
                canvasId={canvasId}
                nodeId={route.nodeId}
                mode="canvas-group"
                writable={writable}
                disabledReason={writable ? null : "当前会话不可写，无法让助手修改 2D 组。"}
                onAuthorize={() => ctx.canvasNavigation.openDialog({ dialogId: "agent-assistant", payload: {} })}
              />
            </ExecutionPanelSurface>
          );
        }
      };

      // 导演区（原场景区）执行面板：底部生成面板，助手以 host 签发的 world scope
      // 读写完整包含的模型与区内镜头；只读参考与占用仍由权威服务复核。
      const directorExecutionPanel: CanvasPanelDefinition = {
        type: DIRECTOR_EXECUTION_PANEL_TYPE,
        owner: TASK_EXECUTION_PLUGIN_ID,
        render: ({ route, writable }) => {
          if (route.type !== DIRECTOR_EXECUTION_PANEL_TYPE) return null;
          useSyncExternalStore(ctx.canvasState.subscribe, ctx.canvasState.getWorkingCanvas, ctx.canvasState.getWorkingCanvas);
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
          const node = canvas?.document.nodes.find((item) => item.id === route.nodeId && item.type === "scene-area");
          const area = node ? decodeSceneAreaData(canvas?.nodeData[route.nodeId]?.sceneArea) : undefined;
          if (!node || !area || !area.ok) return null;
          return (
            <ExecutionPanelSurface nodeId={route.nodeId} presentation="compact" runtime={ctx.canvasRuntime}>
              <AuthoringGenerateHost
                canvasId={canvasId}
                nodeId={route.nodeId}
                mode="world"
                worldScope={{ kind: "scene-area", areaId: area.value.areaId }}
                writable={writable}
                disabledReason={writable ? null : "当前会话不可写，无法让助手修改导演区。"}
                onAuthorize={() => ctx.canvasNavigation.openDialog({ dialogId: "agent-assistant", payload: {} })}
              />
            </ExecutionPanelSurface>
          );
        }
      };

      const cameraExecutionPanel: CanvasPanelDefinition = {
        type: CAMERA_EXECUTION_PANEL_TYPE,
        owner: TASK_EXECUTION_PLUGIN_ID,
        render: ({ route, writable }) => {
          const editing = useSyncExternalStore(worldCameraEditorStore.subscribe, worldCameraEditorStore.getSnapshot, () => null);
          useSyncExternalStore(ctx.canvasState.subscribe, ctx.canvasState.getWorkingCanvas, ctx.canvasState.getWorkingCanvas);
          if (route.type !== CAMERA_EXECUTION_PANEL_TYPE || editing) return null;
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
          const node = canvas?.document.nodes.find(item => item.id === route.nodeId && item.type === "world-camera");
          const camera = decodeWorldCamera(node ? canvas?.nodeData[route.nodeId]?.worldCamera : null);
          if (!camera.ok) return null;
          return (
            <ExecutionPanelSurface nodeId={route.nodeId} presentation="compact" runtime={ctx.canvasRuntime}>
              <AuthoringGenerateHost
                canvasId={canvasId}
                nodeId={route.nodeId}
                mode="world"
                worldScope={{ kind: "world-camera", cameraId: camera.value.cameraId }}
                writable={writable}
                disabledReason={writable ? null : "当前会话不可写，无法让助手调整镜头。"}
                onAuthorize={() => ctx.canvasNavigation.openDialog({ dialogId: "agent-assistant", payload: {} })}
              />
            </ExecutionPanelSurface>
          );
        }
      };

      const disposeExecution = ctx.canvasNavigation.registerPanel(executionPanel);
      const disposeEditor = ctx.canvasNavigation.registerPanel(modelNodeEditorPanel);
      const disposeGroupExecution = ctx.canvasNavigation.registerPanel(groupExecutionPanel);
      const disposeDirectorExecution = ctx.canvasNavigation.registerPanel(directorExecutionPanel);
      const disposeCameraExecution = ctx.canvasNavigation.registerPanel(cameraExecutionPanel);

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
                const hash = (canvas.nodeData[nodeId]?.modelContentVersion as { contentHash?: string } | undefined)?.contentHash;
                return { ...target, action: "modify", prompt: "", ...(hash ? { expectedContentHash: hash } : {}) };
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

      const coordinator = createSubmitCoordinator({
        store: woohaa3CanvasStore,
        client: ctx.canvasRemote,
        activity: activitySink,
        isWritable: () => ctx.canvasSession.isWritable()
      });

      /**
       * 描述失效：草稿、目录、working/canonical 画布、统一运行状态任一到达时请求一帧重建
       * 节点操作横条描述；**不逐帧扫描全画布**。
       */
      const invalidateToolbar = () => ctx.canvasRuntime.controller()?.invalidate("node-action-description");
      const offDrafts = nodeDraftStore.subscribe(invalidateToolbar);
      const offCatalog = ctx.taskCatalog.subscribe(invalidateToolbar);
      const offCanvas = woohaa3CanvasStore.subscribe(invalidateToolbar);
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
        // 导演区（scene-area）使用底部执行面板：目标身份是区节点，写范围由 worldScope 冻结。
        if (canvas?.document.nodes.some((node) => node.id === nodeId && node.type === "scene-area")) {
          return { type: DIRECTOR_EXECUTION_PANEL_TYPE, nodeId };
        }
        if (canvas?.document.nodes.some(node => node.id === nodeId && node.type === "world-camera")) {
          return { type: CAMERA_EXECUTION_PANEL_TYPE, nodeId };
        }
        // 2D 组使用独立执行面板：目标身份是根组，助手工具由宿主组作用域限制。
        if (canvas?.document.nodes.some((node) => node.id === nodeId && node.type === "workflow-group-2d")) {
          return { type: GROUP_EXECUTION_PANEL_TYPE, nodeId };
        }
        const context = resolveSelectionContext(canvas, nodeId);
        if (!context) return null;
        if (context.panelKind) return { type: NODE_EXECUTION_PANEL_TYPE, nodeId };
        if (isModelEditorNodeType(context.nodeType)) return { type: MODEL_NODE_EDITOR_PANEL_TYPE, nodeId };
        return null;
      };

      let lastRoute: CanvasPanelRoute | null = null;
      // 取消选择时用来识别「从该节点打开的右侧详情」；聚焦态没有取消选择语义，退出聚焦后
      // 由 navigation 订阅把游标同步回当前选择。
      let lastSelectedNodeId = nodeSelectionStore.getSnapshot().primaryNodeId;
      const syncSelection = () => {
        // focus 活动期间 selection 不驱动 panel（design D5：普通 selection 不退出/干扰 focus）。
        if (ctx.canvasNavigation.getSnapshot().mode.type === "node-focus") return;
        const primary = nodeSelectionStore.getSnapshot().primaryNodeId;
        // 取消选中节点：节点绑定的 Agent 对话详情是右侧常驻面板，不随普通执行面板的
        // closePanel 关闭，需要在这里显式收起（用户要的是面板直接消失，而不是留在右侧）。
        if (shouldDismissAgentDetailOnDeselect({
          previousNodeId: lastSelectedNodeId,
          nextNodeId: primary,
          panel: ctx.canvasNavigation.getSnapshot().panel
        })) {
          ctx.canvasNavigation.closePanel(AGENT_CONVERSATION_PANEL_TYPE);
        }
        lastSelectedNodeId = primary;
        const route = resolvePanelRoute(primary);
        // 只在 identity（type+nodeId）变化时提交，避免重复 transition；也因此不会在用户
        // 展开后因同节点 selection 通知而收起（design D5/D6）。
        if (sameRouteIdentity(route, lastRoute)) return;
        if (!route) {
          lastRoute = null;
          ctx.canvasNavigation.closePanel(NODE_EXECUTION_PANEL_TYPE);
          ctx.canvasNavigation.closePanel(MODEL_NODE_EDITOR_PANEL_TYPE);
          ctx.canvasNavigation.closePanel(GROUP_EXECUTION_PANEL_TYPE);
          ctx.canvasNavigation.closePanel(DIRECTOR_EXECUTION_PANEL_TYPE);
          ctx.canvasNavigation.closePanel(CAMERA_EXECUTION_PANEL_TYPE);
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
          const primary = nodeSelectionStore.getSnapshot().primaryNodeId;
          lastRoute = resolvePanelRoute(primary);
          lastSelectedNodeId = primary;
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
          disposeGroupExecution();
          disposeDirectorExecution();
          disposeCameraExecution();
          disposeAgentConversation();
          traceDisposed = true;
          if (traceRetryTimer !== null) clearTimeout(traceRetryTimer);
          removeGenerationTraceMenu();
          removeGenerationTraceDialog();
          offDrafts();
          offCatalog();
          offCanvas();
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

function isModelEditorNodeType(nodeType: string): boolean {
  // 宿主模型编辑器服务 3D 内容节点（model3d / 复合资产卡片）。
  return isModelNodeType(nodeType);
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
  const mode = "model3d" as const;
  const expectedContentHash = resolveExpectedModelContentHash(nodeId);
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
      writable={writable && !fileModel}
      disabledReason={fileModelReason ?? (!writable ? "当前会话不可写，无法直接生成。" : null)}
      {...(expectedContentHash ? { expectedContentHash } : {})}
      onAuthorize={() => ctx.canvasNavigation.openDialog({ dialogId: "agent-assistant", payload: {} })}
    />
  );
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
