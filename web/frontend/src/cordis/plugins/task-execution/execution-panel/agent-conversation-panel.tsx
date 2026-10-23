/**
 * Agent 对话详情侧栏
 * （change: 2026-10-12-add-agent-conversation-panel，任务 5.5/5.6/5.9 / design D6a）。
 *
 * 宿主拥有：读取 `agentConversationService` 的权威快照（消息/回合/事件/工具/回执），渲染目标、
 * 阶段、消息、工具过程、权威结果卡与后续回复。**打开/关闭/查询只读**：挂载只读快照，回复才
 * 显式 `submitTurn`（action=discuss）。关闭**不**取消后端任务。
 *
 * 纯展示 + 受控导航；DOM/几何避让由宿主在注册 panel definition 处按宽度上报 `setContentRect`。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  AgentEntryIntent,
  ConversationSnapshot,
  ConversationTurn,
  ConversationMessage,
  ConversationToolActivity,
} from "@woohaa3/contracts";
import type { AgentConversationServiceHandle } from "../../../services/agent-conversation-service.js";
import { assistantInputController } from "../../../services/assistant-execution/controller.js";
import { assistantConversationPort } from "../../../services/assistant-execution/conversation-port.js";
import type { AgentConversationSubmitInput, AgentConversationSubmitResult } from "../../../contract/agent-conversation.js";
import { AssistantComposer } from "../../../ui/assistant-execution/composer.js";
import { AssistantModelSelector } from "../../../ui/assistant-execution/model-selector.js";
import { agentDirectory } from "../../../services/assistant-execution/directory.js";
import { agentDirectoryModels, agentModelSelection, assistantSelectionMemory, rememberAssistantPreference } from "../../../services/assistant-execution/selection.js";
import {
  CheckIcon,
  ChevronRightIcon,
  WarningIcon,
  LoadingIcon,
} from "../../../../shared/ui/icons.js";
import { buildConversationTimeline } from "./agent-conversation-timeline.js";
import "./agent-conversation-panel.css";

/** 详情侧栏宽度（桌面 400 / 宽屏 420；design D6a）。 */
export const AGENT_DETAIL_WIDTH = 400;
export const AGENT_DETAIL_WIDTH_WIDE = 420;

/** 运行中回合的状态刷新间隔（宿主只读查询，不重复 dispatch）。 */
const DETAIL_POLL_MS = 1500;

const TURN_STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  committing: "提交中",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已停止",
  unknown: "执行状态未知",
};

const TURN_STAGE_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  reasoning: "思考中",
  responding: "生成中",
  "thread-started": "助手已连接",
  resumed: "助手已连接",
  "prepare-source": "准备素材",
  "analyze-content": "分析素材",
  "generate-film-set": "生成片场",
  "repair-candidate": "修正片场数据",
  "validate-and-save": "校验并保存",
  completed: "生成结束",
  committing: "提交中",
};

/** 终态回合不再刷新（unknown 仍可能被 adapter 回执收敛，故视为非终态）。 */
function isTurnSettled(status: string): boolean {
  return (
    status === "succeeded" ||
    status === "partial" ||
    status === "failed" ||
    status === "cancelled"
  );
}

/** 未注入实时来源时的空订阅（静态 `canReturnToSource` 路径不需要通知）。 */
const NO_SUBSCRIBE = (): (() => void) => () => undefined;

export type AgentConversationPanelProps = {
  conversationId: string;
  requestId: string;
  nodeId?: string;
  /** 受控收起：恢复合法来源（生成面板）或关闭详情。 */
  onClose: () => void;
  /**
   * 收起动作语义的静态来源：来源生成面板是否仍是当前目标（缺省 true，兼容只读挂载）。
   *
   * `true` → 「返回生成面板」（恢复来源 route）；`false` → 「关闭」（用户已选中别的节点或
   * 取消选中，不得把画布拉回旧节点的生成面板）。
   */
  canReturnToSource?: boolean;
  /**
   * 收起动作语义的实时来源：订阅目标节点/聚焦变化，换选节点后头部立刻从「返回生成面板」
   * 变成「关闭」。提供时优先于静态 `canReturnToSource`。
   */
  returnToSource?: {
    subscribe: (listener: () => void) => () => void;
    canReturn: () => boolean;
  };
  /** 宿主会话 service（读模型 + 讨论回合）。 */
  service: AgentConversationServiceHandle;
  /**
   * 详情侧栏宽度上报（宿主据此让 runtime/dock/activity 避让）。
   * 传入宽度；`null` 表示释放占位。
   */
  targetExecution?: () => AgentEntryIntent | null;
  onWidthChange?: (width: number | null) => void;
};

export function AgentConversationPanel(props: AgentConversationPanelProps) {
  const service = props.service;
  // 收起动作语义：来源节点仍是当前目标时是「返回生成面板」，否则只是「关闭」。
  // 订阅而不是读取一次，才能在用户换选节点后立刻改写头部按钮。
  const liveReturn = useSyncExternalStore(
    props.returnToSource?.subscribe ?? NO_SUBSCRIBE,
    props.returnToSource?.canReturn ?? (() => props.canReturnToSource !== false),
    props.returnToSource?.canReturn ?? (() => props.canReturnToSource !== false),
  );
  const snapshot = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot,
  );
  const controller = assistantInputController<AgentConversationSubmitInput, AgentConversationSubmitResult>(service, {
    dataScopeId: service.getDataScopeId?.() ?? "page", canvasId: snapshot.detail?.conversation.canvasId ?? "unresolved",
    purpose: `reply:${props.conversationId}`, nodeId: props.nodeId,
  });
  const input = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const draft = input.draft.prompt;
  const setDraft = (prompt: string) => controller.edit({ prompt });
  const port = assistantConversationPort(service);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [selector, setSelector] = useState<"assistant" | "model" | null>(null);
  const [switchingConnection, setSwitchingConnection] = useState(false);
  const replySession = useRef<object | null>(null);
  useEffect(() => { const session = {}; replySession.current = session; return () => { if (replySession.current === session) replySession.current = null; }; }, [props.conversationId]);
  const directory = agentDirectory(service, service.getDataScopeId?.() ?? "page");
  const directoryView = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot);
  useEffect(() => { void directory.load(); }, [directory]);
  const latest = snapshot.detail?.turns.at(-1);
  const replyConnectionId = snapshot.detail?.conversation.connectionId;
  const replyConnection = directoryView.connections.find(connection => connection.connectionId === replyConnectionId);
  const replyModels = agentDirectoryModels(replyConnection?.models, replyConnection ? directoryView.catalogs[replyConnection.adapterId]?.models : undefined);
  const modelKey = replyConnectionId ?? "legacy";
  const replyModel = input.draft.models[modelKey] ?? latest?.target.model ?? "";
  const replyEffort = input.draft.efforts[modelKey] ?? (input.draft.models[modelKey] === undefined ? latest?.target.reasoningEffort : undefined) ?? "";
  const toolDefault = replyConnection?.authMode === "local-login";
  const modelSelection = agentModelSelection(replyModels, replyModel, replyEffort, Boolean(replyConnection) && !toolDefault);
  const replyBinding = input.draft.connection ?? latest?.connection;
  const rememberReply = (model = replyModel, reasoningEffort: typeof replyEffort = replyEffort) => {
    if (replyConnection) rememberAssistantPreference(service.getDataScopeId?.() ?? "page", { sourceId: replyConnection.adapterId, connectionId: replyConnection.connectionId, model, reasoningEffort });
  };
  const selectionReason = !replyConnectionId ? "" : !directoryView.ready ? "正在读取助手连接…"
    : !replyConnection ? "原助手连接已失效，请选择其他连接"
    : !replyConnection.ready ? replyConnection.reason ?? "原助手尚未就绪"
    : !replyConnection.capabilities.discussion ? "此连接不支持讨论，请切换助手"
    : replyBinding && (replyBinding.configRevision !== replyConnection.configRevision || replyBinding.credentialEpoch !== replyConnection.credentialEpoch) ? "助手连接版本已变更，请重新选择"
    : modelSelection.invalidModel || modelSelection.missingRequiredModel ? "原模型已失效，请重新选择"
    : modelSelection.invalidEffort ? "原 Variant 已失效，请重新选择" : "";
  const chooseConnection = async (id: string) => {
    const connection = directoryView.connections.find(connection => connection.connectionId === id);
    if (!connection || input.busy || switchingConnection || snapshot.detail?.turns.some(turn => !isTurnSettled(turn.status))) return;
    if (id === replyConnectionId) {
      controller.edit({ connection: { connectionId: id, adapterId: connection.adapterId, configRevision: connection.configRevision, credentialEpoch: connection.credentialEpoch } });
      rememberReply();
      return;
    }
    if (!props.nodeId || !snapshot.detail) { setReplyError("请返回作品面板切换助手连接。"); return; }
    const session = replySession.current;
    const scope = service.getDataScopeId?.();
    setSwitchingConnection(true);
    const result = await service.switchConnection({ canvasId: snapshot.detail.conversation.canvasId, nodeId: props.nodeId, connectionId: id })
      .catch(() => ({ ok: false as const, error: "切换助手失败，请重试" }));
    if (session !== replySession.current || scope !== service.getDataScopeId?.()) return;
    setSwitchingConnection(false);
    if (result.ok) {
      const memory = assistantSelectionMemory(service, service.getDataScopeId?.() ?? "page");
      const selection = { sourceId: connection.adapterId, connectionId: id };
      memory.set(`${snapshot.detail.conversation.canvasId}:${props.nodeId}`, selection);
      memory.set("last-explicit", selection);
      rememberAssistantPreference(service.getDataScopeId?.() ?? "page", { sourceId: connection.adapterId, connectionId: id });
      props.onClose();
    }
    else setReplyError(result.error);
  };
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const followLatest = useRef(true);

  // 打开只读快照；卸载只清详情读模型缓存，**不**改写导航 route（design D6a：route 是唯一展开
  // 状态源）。StrictMode 重放/切换到其它 route 时，卸载清理不得反过来收起刚打开的详情。
  useEffect(() => {
    if (service.getDetail()?.conversation.conversationId !== props.conversationId) void service.openDetail(props.conversationId);
    return () => service.clearDetail();
  }, [service, props.conversationId]);

  // 侧栏宽度占位上报（挂载/卸载成对）。
  useEffect(() => {
    props.onWidthChange?.(resolveDetailWidth());
    return () => props.onWidthChange?.(null);
  }, [props.onWidthChange]);

  // 首次打开聚焦详情标题（不抢回复输入焦点；design D6a）。
  useEffect(() => {
    titleRef.current?.focus();
  }, [props.conversationId]);

  const submitReply = (event?: React.FormEvent) => {
    event?.preventDefault();
    const prompt = draft.trim();
    if (!snapshot.detail || snapshot.detail.conversation.conversationId !== props.conversationId || input.busy) return;
    if (input.pending) { void controller.submit(input.pending.input, port); return; }
    if (selectionReason || switchingConnection) { setReplyError(selectionReason || "正在切换助手…"); return; }
    if (!prompt || snapshot.detail.turns.some(turn => !isTurnSettled(turn.status))) return;
    setReplyError(null);
    const session = replySession.current;
    void controller.submit({
      canvasId: snapshot.detail.conversation.canvasId, conversationId: props.conversationId,
      connectionId: snapshot.detail.conversation.connectionId, adapterId: snapshot.detail.conversation.adapterId,
      entry: {
        ...(snapshot.detail.conversation.connectionId ? { connectionId: snapshot.detail.conversation.connectionId } : {}),
        ...(replyBinding ? { connection: replyBinding } : {}),
        ...(replyModel ? { model: replyModel } : {}),
        ...(replyEffort ? { reasoningEffort: replyEffort } : {}),
        action: "discuss", canvasId: snapshot.detail.conversation.canvasId,
        ...(props.nodeId ? { nodeId: props.nodeId } : {}), prompt,
      },
    }, port).then(result => {
      if (result?.kind === "accepted" && replySession.current === session) void service.openDetail(result.value.conversationId);
    });
  };

  /**
   * 清空节点上下文：解除关联并归档当前会话（不删除历史；design D8），成功后返回生成面板。
   * 二次确认避免误触。
   */
  const clearContext = useCallback(() => {
    const canvasId = service.getDetail()?.conversation.canvasId;
    if (!props.nodeId || !canvasId) return;
    setContextError(null);
    void service
      .clearContext({ canvasId, nodeId: props.nodeId })
      .then((result) => {
        if (!result.ok) {
          setContextError(result.error);
          return;
        }
        setConfirmClear(false);
        props.onClose();
      });
  }, [props.nodeId, props.onClose, service]);

  const detail = snapshot.detail;
  const requestedTurn = pickTurn(detail, props.requestId);
  const activeTurn = detail
    ? ([...detail.turns]
        .reverse()
        .find((entry) => !isTurnSettled(entry.status)) ?? null)
    : null;
  const turn = requestedTurn;
  const turnActive = activeTurn !== null;
  const [clockNow, setClockNow] = useState(Date.now);
  useEffect(() => {
    if (!turnActive) return;
    setClockNow(Date.now());
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [turnActive, activeTurn?.turnId]);
  const publicSummary = detail && activeTurn ? [...detail.events].reverse().find(event =>
    event.turnId === activeTurn.turnId && event.type === "stage" &&
    typeof (event.payload as { summary?: unknown } | null)?.summary === "string",
  )?.payload as { summary: string } | undefined : undefined;
  const receivedChars = detail?.messages.filter(message => message.turnId === activeTurn?.turnId && message.role === "assistant")
    .reduce((count, message) => count + message.content.length, 0) ?? 0;
  // 清空上下文：仅在详情已加载、有目标节点且无在途回合时可用（运行中不清空，避免孤立在途回合）。
  const canClearContext =
    Boolean(props.nodeId) && detail !== null && !turnActive;
  const timeline = detail ? buildConversationTimeline(detail) : [];
  const stopUnknownTurn = async () => {
    if (!turn || stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      const result = await service.cancelTurn(turn.requestId);
      if (!result.ok) throw new Error(result.error);
      await service.openDetail(props.conversationId);
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "停止未确认，请核对状态");
    } finally { setStopping(false); }
  };

  useEffect(() => {
    followLatest.current = true;
  }, [props.conversationId]);

  useEffect(() => {
    const body = bodyRef.current;
    if (body && followLatest.current) body.scrollTop = body.scrollHeight;
  }, [detail]);

  // 运行中回合按固定间隔刷新权威快照（打开/查询只读，不重新 accept/dispatch）。详情面板打开后
  // 生成面板已卸载、不再轮询；此处不刷新则消息/工具/状态会停在打开瞬间，完成也不会收敛。
  useEffect(() => {
    if (!turnActive) return;
    let cancelled = false;
    const timer = setInterval(() => {
      if (cancelled) return;
      void service.openDetail(props.conversationId);
    }, DETAIL_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [service, props.conversationId, turnActive]);

  return (
    <aside
      className="agent-detail"
      aria-label="Agent 对话详情"
      data-testid="agent-conversation-panel"
      data-conversation-id={props.conversationId}
      data-request-id={props.requestId}
    >
      <header className="agent-detail__header">
        <h2 className="agent-detail__title" tabIndex={-1} ref={titleRef}>
          {detail?.conversation.title ?? "对话详情"}
        </h2>
        <div className="agent-detail__actions">
          {canClearContext ? (
            confirmClear ? (
              <>
                <button
                  type="button"
                  className="agent-detail__clear"
                  onClick={clearContext}
                >
                  确认清空
                </button>
                <button
                  type="button"
                  className="agent-detail__back"
                  onClick={() => setConfirmClear(false)}
                >
                  取消
                </button>
              </>
            ) : (
              <button
                type="button"
                className="agent-detail__clear"
                onClick={() => setConfirmClear(true)}
              >
                清空上下文
              </button>
            )
          ) : null}
          <button
            type="button"
            className="agent-detail__back"
            onClick={props.onClose}
          >
            {liveReturn ? "返回生成面板" : "关闭"}
          </button>
        </div>
      </header>

      {contextError ? (
        <p className="agent-detail__error" role="alert">
          {contextError}
        </p>
      ) : null}

      {turn ? (
        <div className="agent-detail__meta">
          <span className="agent-detail__target" title={props.requestId}>
            {describeTarget(turn)}
          </span>
          <span
            className="agent-detail__stage"
            role="status"
            aria-live="polite"
          >
            {describeStage(turn)}
          </span>
        </div>
      ) : null}

      <div
        className="agent-detail__body"
        ref={bodyRef}
        role="log"
        aria-label="对话与工具调用"
        onScroll={() => {
          const body = bodyRef.current;
          if (body)
            followLatest.current =
              body.scrollHeight - body.scrollTop - body.clientHeight < 48;
        }}
      >
        {!detail ? (
          <p className="agent-detail__loading" role="status">
            {snapshot.error ??
              (snapshot.loading ? "正在读取对话…" : "暂无对话内容")}
          </p>
        ) : (
          timeline.map((item) =>
            item.kind === "message" ? (
              <MessageRow key={item.key} message={item.message} structuredOutput={detail.turns.some(turn => turn.turnId === item.message.turnId && turn.target.delivery?.purpose === "film-set-conversion")} />
            ) : item.kind === "tool" ? (
              <ToolRow key={item.key} tool={item.tool} turnStatus={item.turnStatus} />
            ) : (
              <TurnResult key={item.key} turn={item.turn} recovered={detail.events.some(event => event.turnId === item.turn.turnId && event.type === "receipt" && (event.payload as { reconciled?: boolean } | null)?.reconciled === true)} />
            ),
          )
        )}
        {turnActive && activeTurn?.status !== "unknown" ? (
          <div className="agent-detail__progress">
            <p className="agent-detail__working">
              <LoadingIcon size={14} />
              {describeStage(activeTurn)} · 已用 {formatDuration(clockNow - Date.parse(activeTurn.createdAt))}
            </p>
            {publicSummary ? <details className="agent-detail__receipt" open={activeTurn.stage === "reasoning"}>
              <summary><ChevronRightIcon size={14} />思考摘要</summary>
              <p className="agent-detail__progress-text">{publicSummary.summary}</p>
            </details> : null}
            {receivedChars > 0 ? <p className="agent-detail__progress-note">已收到 {receivedChars.toLocaleString()} 字</p> : activeTurn.stage === "reasoning" ? (
              <p className="agent-detail__progress-note">
                {publicSummary ? "" : "尚无公开摘要或正文 · "}距上次活动 {formatDuration(clockNow - Date.parse(activeTurn.updatedAt))}
              </p>
            ) : null}
          </div>
        ) : null}
        {turn?.status === "unknown" && turn.target.mode === "canvas-group" ? (
          <div className="agent-detail__result">
            <p>{liveReturn ? "可先停止此回合，再返回生成面板继续搭建。" : "可先停止此回合，再关闭详情继续搭建。"}</p>
            <div className="agent-detail__actions">
              <button type="button" disabled={stopping} onClick={() => void stopUnknownTurn()}>{stopping ? "正在停止…" : "停止此回合"}</button>
            </div>
            {stopError ? <p className="agent-detail__error">{stopError}</p> : null}
          </div>
        ) : null}
      </div>

      <form className="agent-detail__reply" onSubmit={submitReply}>
        {replyConnectionId ? <div className="agent-detail__actions">
          <AssistantModelSelector label="选择助手" model={replyConnectionId} options={directoryView.connections.map(connection => ({ value: connection.connectionId, label: connection.name, detail: connection.reason ?? undefined }))}
            open={selector === "assistant"} onOpenChange={open => setSelector(open ? "assistant" : null)} disabled={input.busy || switchingConnection || turnActive || Boolean(input.pending)} onChange={id => void chooseConnection(id)} />
          <AssistantModelSelector label="选择助手模型" model={replyModel} options={replyModels.map(model => ({ value: model.id, label: model.label }))}
            open={selector === "model"} onOpenChange={open => setSelector(open ? "model" : null)} disabled={input.busy || turnActive || Boolean(input.pending) || toolDefault} keepOpenOnModelSelect
            onChange={model => { controller.edit({ models: { ...input.draft.models, [modelKey]: model }, efforts: { ...input.draft.efforts, [modelKey]: "" } }); rememberReply(model, ""); }}
            variant={modelSelection.supportedEfforts.length ? { value: replyEffort, options: [{ value: "", label: "默认 Variant" }, ...modelSelection.supportedEfforts.map(value => ({ value, label: value }))],
              onChange: effort => { controller.edit({ efforts: { ...input.draft.efforts, [modelKey]: effort as typeof replyEffort } }); rememberReply(replyModel, effort as typeof replyEffort); } } : undefined} />
        </div> : null}
        {selectionReason ? <p className="agent-detail__reply-error">{selectionReason}</p> : null}
        <AssistantComposer className="agent-detail__reply-input" rows={2}
          placeholder="继续讨论"
          value={draft} onChange={setDraft} disabled={!detail || input.busy || turnActive || switchingConnection} onSubmit={() => submitReply()} />
        <button
          type="submit"
          className="agent-detail__reply-send"
          disabled={input.busy || draft.trim() === "" || turnActive || Boolean(selectionReason && !input.pending)}
        >
          发送
        </button>
        {input.pending ? <button type="button" disabled={input.busy} onClick={() => void controller.query(port)}>核对原请求</button> : null}
        {input.notice ? <p className="agent-detail__reply-error">{input.notice}</p> : null}
        {replyError ? (
          <p className="agent-detail__reply-error" role="alert">
            {replyError}
          </p>
        ) : null}
      </form>
    </aside>
  );
}

function MessageRow({ message, structuredOutput }: { message: ConversationMessage; structuredOutput: boolean }) {
  const [expanded, setExpanded] = useState(false);
  // 转换候选是建模输入；按确切回合识别，普通讨论（包括 JSON 回复）仍按消息展示。
  if (structuredOutput && message.role === "assistant") return (
    <details className="agent-detail__receipt" onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary><ChevronRightIcon size={14} />片场生成数据</summary>
      {expanded ? <pre>{message.content}{message.truncated ? "\n（历史记录已截断）" : ""}</pre> : null}
    </details>
  );
  return (
    <article className="agent-detail__message" data-role={message.role}>
      <span className="agent-detail__message-role">
        {message.role === "assistant"
          ? "助手"
          : message.role === "system"
            ? "系统"
            : "你"}
      </span>
      <span className="agent-detail__message-content">{message.content}</span>
      {message.truncated ? (
        <span className="agent-detail__message-truncated">（已截断）</span>
      ) : null}
    </article>
  );
}

function ToolRow({ tool, turnStatus }: { tool: ConversationToolActivity; turnStatus: ConversationTurn["status"] }) {
  const running = tool.status === "started" && ["queued", "running", "committing"].includes(turnStatus);
  const unresolved = tool.status === "started" && !running;
  const label =
    tool.status === "started"
      ? running ? "进行中" : turnStatus === "unknown" ? "调用结果未知" : "未收到完成回执"
      : tool.status === "failed"
        ? "失败"
        : "已完成";
  const Icon =
    running
      ? LoadingIcon
      : tool.status === "failed" || unresolved
        ? WarningIcon
        : CheckIcon;
  return (
    <details className="agent-detail__tool" data-status={unresolved ? "unknown" : tool.status}>
      <summary>
        <Icon size={14} />
        <span className="agent-detail__tool-name">{tool.tool}</span>
        <span className="agent-detail__tool-status">{label}</span>
        <ChevronRightIcon className="agent-detail__tool-chevron" size={14} />
      </summary>
      <p className="agent-detail__tool-summary">
        {unresolved ? "仅记录到工具调用开始，未收到完成回执；当前无法确认它是否完成。" : tool.summary ??
          (tool.status === "started"
            ? "正在调用工具…"
            : "此调用未提供更多详情。")}
      </p>
    </details>
  );
}

function resultLabel(turn: ConversationTurn): string {
  if (turn.status === "succeeded") return turn.action === "discuss" ? "回复完成" : turn.receipt !== undefined || turn.runId || turn.taskId ? "作品已更新" : "作品更新未确认";
  return TURN_STATUS_LABEL[turn.status] ?? turn.status;
}

function TurnResult({ turn, recovered }: { turn: ConversationTurn; recovered: boolean }) {
  const groupReceipt = turn.receipt as { kind?: string; actions?: unknown[] } | undefined;
  return (
    <div className="agent-detail__result" data-status={turn.status}>
      {turn.status === "unknown" ? (
        <p>{recovered ? "本机宿主重启后未取得完整执行回执。" : "未收到执行完成回执，当前无法确认结果。"}系统没有在等待你确认。{groupReceipt?.kind === "canvas-group" && groupReceipt.actions?.length === 0 ? "此回合尚无已登记的画布操作。" : "请核对已有结果。"}</p>
      ) : null}
      {turn.receipt !== undefined ? (
        <details className="agent-detail__receipt">
          <summary>
            <ChevronRightIcon size={14} />
            执行结果 · {resultLabel(turn)}
          </summary>
          <pre>{safeStringify(turn.receipt)}</pre>
        </details>
      ) : null}
      {turn.error ? (
        <p className="agent-detail__error" role="alert">
          {turn.error.message}
        </p>
      ) : null}
    </div>
  );
}

/** 详情宽度：宽屏 420，常规桌面 400（design D6a）。 */
export function resolveDetailWidth(viewportWidth?: number): number {
  const width =
    viewportWidth ??
    (typeof window === "undefined" ? undefined : window.innerWidth);
  return typeof width === "number" && width >= 1440
    ? AGENT_DETAIL_WIDTH_WIDE
    : AGENT_DETAIL_WIDTH;
}

/** A historical request must never resolve to another, newer execution. */
function pickTurn(
  detail: ConversationSnapshot | null,
  requestId: string,
): ConversationTurn | null {
  if (!detail) return null;
  return (
    detail.turns.find((entry) => entry.requestId === requestId) ??
    null
  );
}

function describeStage(turn: ConversationTurn): string {
  const status = resultLabel(turn);
  if (isTurnSettled(turn.status) || !turn.stage || turn.stage === turn.status)
    return status;
  const stage = TURN_STAGE_LABEL[turn.stage] ?? turn.stage;
  return stage === status ? status : `${status} · ${stage}`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours} 小时 ` : ""}${minutes || hours ? `${minutes} 分 ` : ""}${seconds % 60} 秒`;
}

function describeTarget(turn: ConversationTurn): string {
  const parts: string[] = [];
  if (turn.target.mode) parts.push(turn.target.mode);
  if (turn.target.nodeId) parts.push(turn.target.nodeId);
  if (turn.target.clipId) parts.push(turn.target.clipId);
  if (turn.target.itemId) parts.push(turn.target.itemId);
  return parts.length > 0 ? parts.join(" · ") : `请求 ${turn.requestId}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
