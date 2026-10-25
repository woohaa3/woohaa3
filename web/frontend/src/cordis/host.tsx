/**
 * React Host slot 渲染（change: adopt-frontend-cordis-plugin-runtime，design D6/D8）。
 *
 * Host 通过 `useSyncExternalStore` 订阅 slot snapshot，只负责渲染；不知道具体 feature。
 * 不创建 feature client、catalog cache 或专用 dialog state。
 */
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { useOptionalService, useService } from "./react.js";
import { PanelRenderErrorFallback, RenderErrorBoundary } from "./app-error-boundary.js";
import type { SyncStatusView } from "./sync-status.js";
import { useFocusLayoutSource } from "./focus/workspace.js";
import { Button, IconButton } from "../shared/ui/Button.js";
import { Tooltip } from "../shared/ui/Tooltip.js";
import { DesktopCanvasBar } from "../desktop/canvas-window-controls.js";
import { desktopBootstrap } from "../desktop/window-controls.js";
import { normalizeCanvasMenuSections } from "@woohaa3/contracts";
import type { AgentConnectionView } from "@woohaa3/contracts";
import { assistantSelectionMemory, readAssistantPreference, rememberAssistantPreference } from "./services/assistant-execution/selection.js";
import { mcpHintView } from "./mcp-hint.js";
import { resolveModelMcpServerUrl } from "./mcp-endpoint.js";
import type { CanvasPanelRoute } from "./navigation/contracts.js";
import type {
  CanvasSlotProps,
  SlotName,
  SlotContribution
} from "./contracts.js";

// 来源选择与页面 service 同寿命，返回生成面板时恢复；不持久化账号数据。

// 生成面板仅在目标入口真正打开时加载，不进入画布启动闭包。
const AuthoringModelGenerateHost = lazy(() => import("./plugins/task-execution/authoring-model-generate-host.js").then((module) => ({ default: module.AuthoringModelGenerateHost })));
const AuthoringGeneratePanel = lazy(() => import("./plugins/task-execution/authoring-generate-panel.js").then((module) => ({ default: module.AuthoringGeneratePanel })));

/** 首次加载延迟模块时保留面板轮廓，不闪现裸文字或提前加载执行模块。 */
export function AuthoringGeneratePlaceholder() {
  return <div className="authoring-generate-placeholder">
    <div className="authoring-generate-placeholder__header"><span /><span /></div>
    <div className="authoring-generate-placeholder__prompt" />
    <div className="authoring-generate-placeholder__footer"><span /><span /><span /></div>
  </div>;
}

/** 订阅一个 slot 的 contributions（确定排序 + availability 过滤）。 */
export function useSlot<S extends SlotName>(slot: S): ReadonlyArray<SlotContribution<S>> {
  const slots = useService("slots");
  useSyncExternalStore(
    (listener) => slots.subscribe(slot, listener),
    () => slots.version(),
    () => slots.version()
  );
  return slots.list(slot);
}

/** 渲染 route slot 中匹配当前 path 的 contribution。 */
export function RouteHost({ path, navigate }: { path: string; navigate: (to: string) => void }) {
  const routes = useSlot("app.route");
  const match = routes.find((route) => route.path === path);
  if (!match) return null;
  const Component = match.render;
  return <Component path={path} navigate={navigate} />;
}

/** 渲染 `canvas.overlay` contributions。 */
export function CanvasOverlayHost(props: CanvasSlotProps) {
  const contributions = useSlot("canvas.overlay");
  return (
    <>
      {contributions.map((entry) => {
        const Component = entry.render;
        return <Component key={entry.id} {...props} />;
      })}
    </>
  );
}

/**
 * 渲染 `canvas.topbar` contributions：浏览器为左上角浮动行，Tauri 为完整窗口横栏。
 *
 * 贡献自身**不**做绝对定位（与 `canvas.overlay` 的区别），因此「当前用户」等常驻控件能与
 * 画布切换器相邻；全空时不渲染容器，避免挡住画布。
 *
 * Tauri 横栏是窗口装饰：它承载品牌、画布切换器与窗口按钮，因此**在首页与节点聚焦编辑时都保留**，
 * 不能随 overview 消失（否则用户无法拖动/最小化/关闭窗口）。
 * 浏览器保留既有浮动行语义：只在 overview 且确有贡献时出现，避免与聚焦标题栏重叠。
 *
 * 桌面横栏右侧只有一个**合并读数**：同步/连接状态与 `canvas.topbar-status`（FPS、Draw Call）
 * 共用同一个气泡，位于画布控件之后、窗口按钮之前。即使没有性能贡献也渲染同步状态，
 * 因此读数区不会因为扩展未加载而空着。底部工具栏在桌面不再重复展示同步状态。
 */
export function CanvasTopBarHost({ overview = true, ...props }: CanvasSlotProps & { overview?: boolean }) {
  const contributions = useSlot("canvas.topbar");
  const statusReadouts = useSlot("canvas.topbar-status");
  const statusReadout = statusReadouts[0];
  const Readout = statusReadout?.render;
  const content = contributions.map((entry) => {
    const Component = entry.render;
    return <Component key={entry.id} {...props} />;
  });
  if (desktopBootstrap(globalThis)) {
    // 合并读数：同步/连接状态始终在，性能读数作为同一按钮的紧凑内容。
    const renderStatus = (readout?: ReactNode, details?: ReactNode) => (
      <CanvasControlStatus
        status={props.sync}
        details={details}
        placement="down"
        className="canvas-control-panel__status--topbar"
        onReconnect={props.onReconnect}
      >
        {readout}
      </CanvasControlStatus>
    );
    const trailing = !Readout
      ? renderStatus()
      : statusReadout.wrapsStatus
        // 新贡献自己调用 renderStatus 装配气泡（仍使用本宿主的合并版本）。
        ? <Readout {...props} renderStatus={renderStatus} />
        // 旧贡献只返回紧凑读数，由宿主放进同一个气泡。
        : renderStatus(<Readout {...props} renderStatus={renderStatus} />);
    return (
      <DesktopCanvasBar status={<div className="desktop-canvas-bar__readouts" role="group" aria-label="画布状态读数">{trailing}</div>}>
        {content}
      </DesktopCanvasBar>
    );
  }
  if (!overview || contributions.length === 0) return null;
  return (
    <div className="canvas-topbar" role="toolbar" aria-label="画布顶栏">
      {content}
    </div>
  );
}

/**
 * 渲染模型/镜头 authoring 生成入口（change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 6.4）。
 *
 * 宿主持有目标身份、门禁与 MCP 指引，并**内置渲染生成面板**（change: 2026-10-16-...，任务 9.1 /
 * design D10）；来源扩展经 `authoring.generate` typed slot 只声明来源身份与可用连接。
 * 无来源时仍渲染面板并提示配置，MUST NOT 返回 null 隐藏生成入口。
 *
 * 宿主同时注入两项 host-owned 能力（change: 2026-10-12-add-agent-conversation-panel，任务 4.1/5.3）：
 * - `agentConversation`：宿主会话 service（生成面板据此提交首轮并展示详情入口）；
 * - `mcpHint`：MCP 常驻文字入口（外部连接指引；内置发现就绪状态缺省不伪造）。
 */
export function AuthoringGenerateHost(props: import("./contract/authoring.js").AuthoringGenerationProps) {
  const service = useService("agentConversationService");
  const scope = useSyncExternalStore(service.subscribe, () => service.getDataScopeId?.() ?? "page", () => "page");
  return <AuthoringGenerateContent key={`${scope}:${props.canvasId}:${props.nodeId}`} {...props} />;
}

function AuthoringGenerateContent(props: import("./contract/authoring.js").AuthoringGenerationProps) {
  const contributions = useSlot("authoring.generate");
  const groupRuns = useOptionalService("canvasGroupRuns");
  const deliveries = useSlot("authoring.delivery");
  const canvasState = useOptionalService("canvasState");
  const canvasSession = useOptionalService("canvasSession");
  useSyncExternalStore(listener => canvasState?.subscribe(listener) ?? (() => undefined), () => canvasState?.getWorkingCanvas() ?? null, () => null);
  const conversation = useService("agentConversationService");
  // 来源选择（change: 2026-10-16-...，任务 2.4）：宿主决定当前来源，而不是由首个贡献隐式决定。
  const selectionKey = `${props.canvasId}:${props.nodeId}`;
  const selectionMemory = assistantSelectionMemory(conversation, conversation.getDataScopeId?.() ?? "page");
  const targetRememberedSelection = selectionMemory.get(selectionKey);
  const rememberedSelection = targetRememberedSelection ?? readAssistantPreference(conversation.getDataScopeId?.() ?? "page") ?? selectionMemory.get("last-explicit");
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(rememberedSelection?.sourceId ?? null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(rememberedSelection?.connectionId ?? null);
  const [connectionsResult, setConnectionsResult] = useState<{ sourceId: string; connections: AgentConnectionView[] } | null>(null);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [switching, setSwitching] = useState(false);
  const explicitSelectionRevision = useRef(0);
  const pendingSourceSwitch = useRef(false);
  const dialogs = useOptionalService("dialogs");
  const credentialsOpen = useSyncExternalStore(
    listener => dialogs?.subscribe(listener) ?? (() => undefined),
    () => dialogs?.getSnapshot().stack.some(entry => entry.dialogId === "agent-assistant") ?? false,
    () => false
  );
  const connectionRevision = useSyncExternalStore(conversation.subscribe, () => conversation.getSnapshot().contextRevision, () => conversation.getSnapshot().contextRevision);
  // 该节点当前会话（一个节点复用一条；design D8）：按目标解析，重开面板/清空上下文后重新解析。
  const conversationSnapshot = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot, conversation.getSnapshot);
  const [nodeConversation, setNodeConversation] = useState<{ conversationId: string; latestRequestId?: string } | null>(null);

  // 来源清单：按 `sourceId` 去重；未声明 sourceId 的贡献作为 legacy 单来源（保持既有行为）。
  const sources: Array<{ sourceId: string; label: string; contribution: (typeof contributions)[number] }> = [];
  for (const entry of contributions) {
    const declared = (entry as { sourceId?: string }).sourceId;
    const sourceId = declared ?? entry.id;
    if (sources.some((source) => source.sourceId === sourceId)) continue;
    sources.push({ sourceId, label: (entry as { sourceLabel?: string }).sourceLabel ?? declared ?? sourceId, contribution: entry });
  }
  const hostOwnedConnections = connectionsResult?.connections ?? [];
  const effectiveConnectionId = props.sourceSelection?.selectedConnectionId ?? selectedConnectionId ?? (hostOwnedConnections.length === 1 ? hostOwnedConnections[0]!.connectionId : null);
  const selectedConnection = hostOwnedConnections.find((entry) => entry.connectionId === effectiveConnectionId);
  const effectiveSourceId = selectedConnection?.adapterId ?? selectedSourceId;
  const activeSource = sources.find((source) => source.sourceId === effectiveSourceId) ?? null;
  useEffect(() => {
    if (props.sourceSelection) return;
    const store = selectionMemory;
    store.set(selectionKey, { sourceId: effectiveSourceId, connectionId: effectiveConnectionId });
  }, [conversation, selectionKey, effectiveSourceId, effectiveConnectionId, props.sourceSelection]);
  useEffect(() => {
    if (props.sourceSelection) return;
    let cancelled = false;
    const revision = explicitSelectionRevision.current;
    void conversation.findConversationForTarget({ canvasId: props.canvasId, nodeId: props.nodeId }).then((result) => {
      if (!cancelled && revision === explicitSelectionRevision.current && result.ok && result.value.conversation?.connectionId) setSelectedConnectionId(result.value.conversation.connectionId);
    });
    return () => { cancelled = true; };
  }, [conversation, props.canvasId, props.nodeId]);
  const targetKey = `${props.canvasId}:${props.nodeId}:${effectiveConnectionId ?? ""}`;
  const resolvedTarget = useRef<string | null>(null);

  useEffect(() => {
    if (!effectiveConnectionId) { resolvedTarget.current = null; setNodeConversation(null); return; }
    let cancelled = false;
    void conversation.findConversationForTarget({
      canvasId: props.canvasId,
      nodeId: props.nodeId,
      ...(effectiveConnectionId ? { connectionId: effectiveConnectionId } : {})
    }).then((result) => {
      if (cancelled) return;
      resolvedTarget.current = targetKey;
      const found = result.ok ? result.value.conversation : null;
      setNodeConversation(
        found
          ? { conversationId: found.conversationId, ...(found.latestRequestId ? { latestRequestId: found.latestRequestId } : {}) }
          : null
      );
    });
    return () => {
      cancelled = true;
    };
  }, [conversation, props.canvasId, props.nodeId, effectiveConnectionId, targetKey, conversationSnapshot.contextRevision, connectionRevision]);

  // 解析当前来源的可见连接（不含秘密）；失败不自动换来源，保留原选择。
  useEffect(() => {
    if (props.sourceSelection !== undefined) return undefined;

    let cancelled = false;
    const listConnections = conversation.listConnections;
    if (!listConnections) return undefined;
    setConnectionsLoading(true);
    setConnectionsError(null);
    void listConnections().then(async result => {
      if (cancelled) return;
      setConnectionsLoading(false);
      if (!result.ok) { setConnectionsError(result.error); return; }
      setConnectionsResult({ sourceId: "all", connections: result.value });
      if (pendingSourceSwitch.current && result.value.length === 1 && conversation.switchConnection) {
        pendingSourceSwitch.current = false;
        setSwitching(true);
        try {
          const switched = await conversation.switchConnection({ canvasId: props.canvasId, nodeId: props.nodeId, connectionId: result.value[0].connectionId });
          if (!cancelled && !switched.ok) setConnectionsError(switched.error);
        } finally { setSwitching(false); }
      }
    }).catch(() => { if (!cancelled) { setConnectionsLoading(false); setConnectionsError("连接读取失败，请刷新重试。"); } });
    return () => {
      cancelled = true;
    };
  }, [conversation, props.sourceSelection, connectionRevision, refreshRevision, credentialsOpen]);

  const service = conversation as { navigateToDetail?: (input: { conversationId: string; requestId: string; nodeId?: string }) => void } | undefined;

  // 即使没有来源也传递读取状态，避免把尚未加载或读取失败误报为未配置助手。
  const hostSourceSelection: import("./contract/authoring.js").AuthoringGenerationProps["sourceSelection"] = props.sourceSelection ?? {
        sources: [
          ...sources.map((source) => ({ sourceId: source.sourceId, label: source.label })),
          ...(selectedSourceId && !activeSource ? [{ sourceId: selectedSourceId, label: "先前来源（已停用）" }] : [])
        ],
        selectedSourceId: effectiveSourceId ?? "",
        connections: hostOwnedConnections.map((entry) => ({
          connectionId: entry.connectionId,
          binding: { connectionId: entry.connectionId, adapterId: entry.adapterId, configRevision: entry.configRevision, credentialEpoch: entry.credentialEpoch },
          label: entry.name,
          ready: entry.ready && entry.capabilities?.tools !== false,
          modelSelection: entry.authMode === "local-login" ? "tool-default" as const : "explicit" as const,
          models: entry.models,
          modelsError: entry.modelsError,
          revision: `${entry.configRevision}:${entry.credentialEpoch}`,
          reason: entry.capabilities?.tools === false ? "此连接不支持作品修改，请选择其他助手" : entry.reason ?? null
        })),
        selectedConnectionId: effectiveConnectionId,
        onSelectSource: (sourceId: string) => {
          explicitSelectionRevision.current++;
          pendingSourceSwitch.current = true;
          setConnectionsError(null);
          setSelectedSourceId(sourceId);
          setSelectedConnectionId(null);
        },
        onSelectConnection: (connectionId: string) => {
          explicitSelectionRevision.current++;
          if (!conversation.switchConnection) { setSelectedConnectionId(connectionId); return; }
          setSwitching(true);
          setConnectionsError(null);
          void conversation.switchConnection({ canvasId: props.canvasId, nodeId: props.nodeId, connectionId }).then(result => {
            if (result.ok) {
              pendingSourceSwitch.current = false; setSelectedConnectionId(connectionId);
              const sourceId = hostOwnedConnections.find((entry) => entry.connectionId === connectionId)?.adapterId ?? null;
              setSelectedSourceId(sourceId);
              const store = selectionMemory;
              store.set("last-explicit", { sourceId, connectionId });
              if (sourceId) rememberAssistantPreference(conversation.getDataScopeId?.() ?? "page", { sourceId, connectionId });
            }
            else setConnectionsError(result.error);
          }).catch(() => setConnectionsError("切换连接失败，请重试。"))
            .finally(() => setSwitching(false));
        },
        loading: connectionsLoading,
        error: selectedSourceId && !activeSource ? "先前使用的来源已停用。请选择其他来源，或在插件管理中重新启用。" : connectionsError,
        blockedReason: switching ? "正在切换连接…" : null,
        onRefresh: () => { conversation.invalidateDirectory?.(); setRefreshRevision(value => value + 1); }
      };

  useEffect(() => {
    const apply = (event: Event) => {
      const detail = (event as CustomEvent<{ canvasId: string; nodeId: string; connectionId: string }>).detail;
      if (detail?.canvasId !== props.canvasId || detail.nodeId !== props.nodeId || !props.writable) return;
      hostSourceSelection?.onSelectConnection(detail.connectionId);
    };
    globalThis.addEventListener("woohaa3-agent-assistant-selection", apply);
    return () => globalThis.removeEventListener("woohaa3-agent-assistant-selection", apply);
  });
  const withConversation: import("./contract/authoring.js").AuthoringGenerationProps = {
    ...props,
    onAuthorize: () => { dialogs?.open({ dialogId: "agent-assistant", payload: { canvasId: props.canvasId, nodeId: props.nodeId } }); },
    mcpHint: props.mcpHint ?? resolveMcpHint(),
    ...(hostSourceSelection ? { sourceSelection: hostSourceSelection } : {}),
    ...(service?.navigateToDetail
      ? {
          groupRuns: props.mode === "canvas-group" ? groupRuns : undefined,
          agentConversation: {
            service: conversation as never,
            conversationId: resolvedTarget.current === targetKey ? nodeConversation?.conversationId ?? null : null,
            latestRequestId: resolvedTarget.current === targetKey ? nodeConversation?.latestRequestId ?? null : null,
            onOpenDetail: (input: { conversationId: string; requestId: string; nodeId?: string }) => service.navigateToDetail!(input)
          }
        }
      : {})
  };
  const generationKey = JSON.stringify([props.canvasId, props.nodeId, props.mode, props.selectedCameraId, props.clipId, props.itemId]);
  const data = (canvasState?.getWorkingCanvas() ?? canvasState?.getCanvas())?.nodeData[props.nodeId];
  const delivery = deliveries.map(contribution => contribution.resolve({ canvasId: props.canvasId, nodeId: props.nodeId, data })).find(Boolean);
  // 面板 UI 由宿主内置渲染；来源扩展只声明来源（design D10）。无来源时仍渲染面板并提示配置。
  if (withConversation.mode === "model3d") return <Suspense fallback={<AuthoringGeneratePlaceholder />}><AuthoringModelGenerateHost key={generationKey} {...withConversation} render={AuthoringGeneratePanel} /></Suspense>;
  return <Suspense fallback={<AuthoringGeneratePlaceholder />}><AuthoringGeneratePanel key={generationKey} {...withConversation} writable={canvasSession?.isWritable() ?? props.writable} deliveryHistory={delivery ?? undefined} /></Suspense>;
}

/** 生成面板常驻 MCP 文字入口的派生（外部连接指引；不表示外部客户端已连接）。 */
function resolveMcpHint(): import("./contract/authoring.js").AuthoringGenerationProps["mcpHint"] {
  const hint = mcpHintView(resolveModelMcpServerUrl());
  return { label: hint.label, text: hint.text, serverUrl: hint.serverUrl };
}

/**
 * 渲染当前 active Canvas Navigation panel route 对应的 definition
 * （change: unify-canvas-presentation-navigation，design D2/D3）。
 *
 * 没有 active route、definition 未注册或已 dispose 时返回 null；不再用 selection 隐式打开。
 */
export function CanvasPanelHost({ writable }: { writable: boolean }) {
  const navigation = useService("canvasNavigation");
  useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  const route = navigation.getSnapshot().panel;
  if (!route) return null;
  const definition = navigation.resolvePanel(route.type);
  if (!definition) return null;
  const Component = definition.render;
  // Panel 级兜底：某个 definition 的 render 抛错时只替换该 panel，Canvas、其它 panel 与
  // canonical 节点保持可用（change: fix-delete-node-crash-and-white-screen）。
  // 切换节点或显式重开对话时重置失败态，允许修复后直接再次打开。
  return (
    <RenderErrorBoundary
      resetKey={panelResetKey(route)}
      fallback={({ error }) => <PanelRenderErrorFallback error={error} />}
    >
      <Component route={route} writable={writable} />
    </RenderErrorBoundary>
  );
}

/** 普通 panel 按节点 identity 重试；对话每次显式打开都可重试。 */
function panelResetKey(route: CanvasPanelRoute): string | CanvasPanelRoute {
  // 显式重开同一对话会产生新 route 对象，应允许重试此前失败的渲染。
  // 只重置错误边界；健康详情的组件、草稿与滚动位置保持不变。
  if (route.type === "agent-conversation") return route;
  return `${route.type}:${route.nodeId}`;
}

/**
 * 独立文档工作区 host（change: 2026-10-21-add-photocraft-document-workspace，design D1/D4）。
 *
 * 只在 Canvas Navigation mode 为 `document-workspace` 时渲染**唯一**贡献。宿主不按业务类型
 * 分支，也不伪造节点聚焦：贡献方自持不透明内容背景、文档预览、取景与输入，宿主只提供内容
 * 矩形布局。无可用贡献时呈现可读诊断与受控返回，不留下只有背景的空呈现。
 */
export function DocumentWorkspaceHost({ document, ...props }: CanvasSlotProps & { document: { documentId: string } | null }) {
  const slots = useService("slots");
  const canvasNavigation = useService("canvasNavigation");
  useSyncExternalStore(
    (listener) => slots.subscribe("canvas.document-workspace", listener),
    () => slots.version(),
    () => slots.version()
  );
  const contributions = slots.list("canvas.document-workspace");
  const entry = contributions.find((candidate) => candidate.isAvailable?.(document?.documentId ?? "") ?? true) ?? contributions[0];
  useFocusLayoutSource(entry?.layout);
  if (entry) {
    const Component = entry.render;
    return <Component {...props} document={document} />;
  }
  return (
    <div className="status-overlay" role="status">
      <div className="status-title">文档工作区不可用</div>
      <div className="status-detail">当前文档无法呈现，请返回画布后重新打开。</div>
      <Button onClick={() => void canvasNavigation.requestExitNodeFocus()}>返回画布</Button>
    </div>
  );
}

/**
 * 聚焦侧栏 panel host（change: 2026-10-12-add-agent-conversation-panel，design D6a）。
 *
 * 只渲染声明 `focusPresentation: "sidebar"` 的当前 panel definition，并放入公共侧栏容器
 * `.focus-workspace__panel`；聚焦时与工作区检查器**共用同一栏**（由 `data-focus-panel="detail"`
 * 隐藏检查器），不额外并列一栏。未声明该标志的 panel 不在聚焦态渲染。
 */
export function CanvasFocusSidePanelHost({ writable }: { writable: boolean }) {
  const navigation = useService("canvasNavigation");
  useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  const route = navigation.getSnapshot().panel;
  if (!route) return null;
  const definition = navigation.resolvePanel(route.type);
  if (!definition || definition.focusPresentation !== "sidebar") return null;
  const Component = definition.render;
  return (
    <div className="focus-workspace__panel" data-focus-side-panel="true">
      <RenderErrorBoundary
        resetKey={panelResetKey(route)}
        fallback={({ error }) => <PanelRenderErrorFallback error={error} />}
      >
        <Component route={route} writable={writable} />
      </RenderErrorBoundary>
    </div>
  );
}

/**
 * 聚焦态节点版本 drawer host。
 *
 * `node-history` 刻意不声明 `focusPresentation: "sidebar"`（它占用工作区检查器位，而不是
 * 与检查器并列的详情栏）；而 `.app[data-focus-panel="history"] .focus-workspace__panel`
 * 会隐藏通用侧栏容器。因此这里直接渲染 drawer 自身（其定位由 focus.css 的
 * `.node-history--drawer` 负责），不额外包一层 `.focus-workspace__panel`。
 *
 * 没有该宿主时，聚焦态（图片/视频/模型）的历史入口只预留侧栏宽度、不出现版本列表。
 */
export function CanvasFocusNodeHistoryHost({ writable }: { writable: boolean }) {
  const navigation = useService("canvasNavigation");
  useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  const route = navigation.getSnapshot().panel;
  if (!route || route.type !== "node-history") return null;
  const definition = navigation.resolvePanel(route.type);
  if (!definition) return null;
  const Component = definition.render;
  return (
    <RenderErrorBoundary
      resetKey={panelResetKey(route)}
      fallback={({ error }) => <PanelRenderErrorFallback error={error} />}
    >
      <Component route={route} writable={writable} />
    </RenderErrorBoundary>
  );
}

/** 右下角面板里的一个功能图标动作（宿主从 `canvas.toolbar-action` 派生）。 */
export type ControlPanelAction = {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** 面板主操作用 primary（强调色实底）；缺省 ghost。 */
  tone?: "primary";
  tooltip?: ComponentType<{ children: ReactNode }>;
  onActivate: () => void;
  disabled?: boolean;
};

/**
 * 右下角工具栏的紧凑状态读数。扩展提供性能小字，无贡献时显示「状态」。
 * 同步详情仍由悬停气泡承载；异常态保持气泡常驻和状态色调。
 *
 * `placement` 决定气泡展开方向：右下角工具栏向上（缺省），窗口顶栏向下（顶栏之上没有空间）。
 */
export function CanvasControlStatus({
  status,
  children,
  details,
  placement = "up",
  className,
  onReconnect
}: {
  status?: SyncStatusView;
  children?: ReactNode;
  details?: ReactNode;
  placement?: "up" | "down";
  className?: string;
  /** 断线/同步异常时气泡里的显式恢复动作（change: 2026-10-21-recover-canvas-connection-explicitly）。 */
  onReconnect?: () => void;
}) {
  return (
    <div
      className={`canvas-control-panel__status${status ? ` is-${status.tone}` : ""}${className ? ` ${className}` : ""}`}
      data-placement={placement}
    >
      <div
        className="canvas-control-panel__status-bubble"
        role="tooltip"
        data-pinned={status?.pinned ? "true" : undefined}
      >
        {details}
        {status ? <span className="canvas-control-panel__status-bubble-text">{status.detail}</span> : null}
        {/* 显式恢复入口：断线/同步异常时气泡常驻，用户无须刷新页面即可重连。 */}
        {status?.action ? (
          <Button
            size="sm"
            className="canvas-control-panel__status-action"
            disabled={status.action.busy}
            onClick={() => onReconnect?.()}
          >
            {status.action.label}
          </Button>
        ) : null}
      </div>
      <button
        type="button"
        className="canvas-control-panel__status-readout"
        aria-label={status?.label}
      >
        {children ?? "状态"}
      </button>
    </div>
  );
}

/**
 * 右下角统一控件面板的**纯展示**组件（无 Context 依赖，可独立预览/测试）。
 *
 * 分排：上排功能图标（靠左）与状态读数（靠右）、下排画布视图
 * 控件（缩放 + 适合屏幕）。内容为空时不渲染。
 */
export function CanvasControlPanel({
  actions = [],
  viewport,
  status,
  statusContent,
  onReconnect
}: {
  actions?: readonly ControlPanelAction[];
  /** 下排内容（通常是 `CanvasZoomControls`）。 */
  viewport?: ReactNode;
  /** 上排靠右的同步状态（change: move-sync-status-to-corner-panel）。 */
  status?: SyncStatusView;
  statusContent?: ReactNode;
  /** 状态气泡内的显式重连入口（change: 2026-10-21-recover-canvas-connection-explicitly）。 */
  onReconnect?: () => void;
}) {
  if (actions.length === 0 && !viewport && !status && !statusContent) return null;
  return (
    <div className="canvas-control-panel" role="toolbar" aria-label="画布控件">
      {actions.length > 0 || status || statusContent ? (
        <div className="canvas-control-panel__row canvas-control-panel__row--actions">
          <div className="canvas-control-panel__actions" role="group" aria-label="功能">
            {actions.map((action) => {
              const Icon = action.icon;
              const Guidance = action.tooltip;
              const button = (
                <IconButton
                  className={`canvas-control-panel__icon${action.tone === "primary" ? " canvas-control-panel__icon--primary" : ""}`}
                  label={action.label}
                  disabled={action.disabled ?? false}
                  onClick={() => action.onActivate()}
                >
                  <Icon className="canvas-control-panel__icon-svg" />
                </IconButton>
              );
              return Guidance ? <Guidance key={action.id}>{button}</Guidance> : <Tooltip key={action.id} content={action.label}>{button}</Tooltip>;
            })}
          </div>
          {statusContent ?? (status ? <CanvasControlStatus status={status} onReconnect={onReconnect} /> : null)}
        </div>
      ) : null}
      {viewport ? (
        <div className="canvas-control-panel__row canvas-control-panel__row--viewport" role="group" aria-label="视图">
          {viewport}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 渲染同步状态、`canvas.toolbar-action` 图标动作（上排）与 `canvas.toolbar` contributions（下排）。
 *
 * 所有内容聚合到**屏幕右下角的同一个面板**（`.canvas-control-panel`），分排：
 * - 上排右侧：状态读数（同步详情稳态按需、异常态气泡常驻）；
 * - 上排：feature 图标按钮（如提示词片段管理，后续会追加更多功能）；
 * - 下排：画布控件主体（缩放 + 适合屏幕）。
 *
 * 桌面壳（Tauri）的同步状态与性能读数已合并进窗口横栏右侧，这里**不再重复渲染状态位**，
 * 只保留功能图标与视图控件；浏览器保持原行为。
 */
export function CanvasToolbarHost(props: CanvasSlotProps) {
  const onDesktop = desktopBootstrap(globalThis) !== undefined;
  const contributions = useSlot("canvas.toolbar");
  const actions = useSlot("canvas.toolbar-action");
  const statusReadouts = useSlot("canvas.toolbar-status");
  const statusReadout = onDesktop ? undefined : statusReadouts[0];
  const Readout = statusReadout?.render;
  const renderStatus = (readout: ReactNode, details?: ReactNode) => (
    <CanvasControlStatus status={props.sync} details={details} onReconnect={props.onReconnect}>{readout}</CanvasControlStatus>
  );
  const readout = Readout ? <Readout {...props} renderStatus={renderStatus} /> : undefined;
  const viewport =
    contributions.length > 0 ? (
      <>
        {contributions.map((entry) => {
          const Component = entry.render;
          return <Component key={entry.id} {...props} />;
        })}
      </>
    ) : null;
  return (
    <CanvasControlPanel
      actions={actions.map((entry) => ({
        id: entry.id,
        label: entry.label,
        icon: entry.icon,
        tone: entry.tone,
        tooltip: entry.tooltip,
        onActivate: entry.onActivate,
        disabled: entry.available ? !entry.available() : false
      }))}
      viewport={viewport}
      onReconnect={props.onReconnect}
      {...(onDesktop ? {} : { status: props.sync })}
      {...(readout === undefined ? {} : { statusContent: readout && !statusReadout?.wrapsStatus ? renderStatus(readout) : readout })}
    />
  );
}

/** 合并 `canvas.context-menu` contributions 的菜单项，并按 section/order 规范化分隔线。 */
export function useContextMenuItems(context: import("./contracts.js").ContextMenuContext) {
  const contributions = useSlot("canvas.context-menu");
  return normalizeCanvasMenuSections(contributions.flatMap((entry) => entry.items(context)));
}

/** 分发 context-menu 选择到各 contribution。 */
export function useSelectContextMenuItem() {
  const contributions = useSlot("canvas.context-menu");
  return (itemId: string, context: import("./contracts.js").ContextMenuContext) => {
    for (const entry of contributions) entry.onSelect(itemId, context);
  };
}
