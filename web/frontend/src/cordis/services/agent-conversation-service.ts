/**
 * 宿主 Agent 会话前端 service（Canvas page scope 唯一 owner）
 * （change: 2026-10-12-add-agent-conversation-panel，任务 5.2/5.4/5.6 / design D1/D6a）。
 *
 * 只经宿主通用 remote（`/api/agent-conversations/*`）读写会话：目录/授权/能力、创建/列出/读取
 * 会话、接受回合、按 requestId 查询/取消/关联。**不**在浏览器复制消息/事件到画布，也不自建
 * fetch/SSE（复用 `ApplicationRemoteTransport`）。
 *
 * 服务是生成面板与详情面板共同的**读模型**：提交首轮、按 requestId 恢复、以及详情快照都由
 * 它承载；打开/关闭/查询只读，不重新 accept 或 dispatch。
 */
import type { ConversationSnapshot, ConversationSummary, ConversationTurn } from "@woohaa3/contracts";
import type { CanvasPanelRoute } from "../navigation/contracts.js";
import type {
  AgentConversationResult,
  AgentConversationService,
  AgentConversationSnapshotView,
  AgentConversationSubmitInput,
  AgentConversationSubmitResult
} from "../contract/agent-conversation.js";
import type { AgentConversationRemote } from "./agent-conversation-remote.js";
import { cacheAgentDirectoryReads } from "./agent-directory.js";

/**
 * 详情打开/关闭所需的最小导航面（由宿主注入，避免 service 反向依赖导航实现）。
 *
 * 详情 route 是唯一展开状态源（design D6a）：打开前记录当前合法来源 route（生成面板），
 * 关闭后仅当来源仍可用时恢复；来源失效/目标删除/页面退出则不恢复失效 route。
 */
export type AgentDetailNavigation = {
  getPanel(): CanvasPanelRoute | null;
  openPanel(route: CanvasPanelRoute): unknown;
  closePanel(panelType?: CanvasPanelRoute["type"]): unknown;
  panelAvailable(route: CanvasPanelRoute): boolean;
};

/**
 * 当前生成目标身份（宿主注入）。
 *
 * `focus=true` 表示生成面板正随聚焦工作区呈现（此时没有 panel route），`focus=false` 表示
 * 生成面板来自概览里选中节点打开的 panel。`null` 表示当前没有生成目标（未选中任何节点）。
 */
export type AgentDetailCurrentTarget = { nodeId: string; focus: boolean };

export const AGENT_CONVERSATION_PANEL_ROUTE_TYPE = "agent-conversation" as const;

export type { AgentConversationSnapshotView } from "../contract/agent-conversation.js";

const EMPTY: AgentConversationSnapshotView = {
  conversations: [],
  active: null,
  detail: null,
  mcp: null,
  loading: false,
  error: null,
  contextRevision: 0
};

export type CreateAgentConversationServiceOptions = {
  remote: AgentConversationRemote;
  /** 目录缓存按当前数据空间隔离；身份尚未确认时不缓存。 */
  dataScopeId?: () => string | null;
  /** 记录最近一次提交的对话身份（供状态入口定位确切回合）。 */
  now?: () => string;
  /** 详情打开/关闭的受控导航（缺省只用本地读模型，不改变 route）。 */
  navigation?: AgentDetailNavigation;
  /**
   * 当前生成目标（聚焦节点或画布主选中节点 + 是否处于聚焦工作区）。
   *
   * 详情头部的「返回生成面板」只在当前目标仍是打开详情时的来源目标时成立；用户已切到别的
   * 节点（或取消选中）后该动作退化为纯关闭，不把用户拉回旧节点的生成面板。
   * 未注入时保留旧行为（只要来源 route 可用就恢复）。
   */
  currentTarget?: () => AgentDetailCurrentTarget | null;
};

export function createAgentConversationService(
  options: CreateAgentConversationServiceOptions
): AgentConversationService & {
  getSnapshot: () => AgentConversationSnapshotView;
  subscribe: (listener: () => void) => () => void;
  /** 详情打开时读取会话快照；只读，不 dispatch。 */
  openDetail: (conversationId: string) => Promise<AgentConversationResult<ConversationSnapshot>>;
  /**
   * 只清除详情读模型缓存，**不**改变导航 route（design D6a：route 是唯一展开状态源）。
   *
   * 详情面板卸载时调用（含 StrictMode 重放与切到其它 route）；导航关闭由 `collapseDetail`
   * 或 navigation transition 负责，避免卸载清理反过来改写 route。
   */
  clearDetail: () => void;
  /** 收起详情并恢复合法来源 route（导航语义）；用于显式「返回生成面板」。 */
  closeDetail: () => void;
  /**
   * 当前详情是否仍能「返回生成面板」：来源 route 可用**且**其节点仍是当前生成目标。
   *
   * 用户已选中别的节点、取消选中或来源节点被删除时返回 false：此时收起详情只是关闭，
   * 不把用户拉回旧节点的生成面板。
   */
  canReturnToSource: () => boolean;
  /** 当前详情快照（生成面板与详情共用同一读模型）。 */
  getDetail: () => ConversationSnapshot | null;
  /** 只读打开详情 route（保存合法来源，不 submit/dispatch）。 */
  navigateToDetail: (input: { conversationId: string; requestId: string; nodeId?: string; runId?: string; taskId?: string }) => void;
  /**
   * 按领域运行关联定位确切回合并只读打开详情
   * （change: 2026-10-12-add-agent-conversation-panel，任务 5.7 / design D7）。
   *
   * 用于活动/历史中的 Agent 记录：先按 `runId` 查宿主 ledger 的确切回合（不按 nodeId 跳到
   * 最近会话），命中再打开详情；未关联返回 `not-found`，调用方保留原任务详情。
   */
  locateAndOpenDetail: (input: { runId: string }) => Promise<AgentConversationResult<{ conversation: ConversationSummary; turn: ConversationTurn }>>;
  /** 收起详情 route 并恢复合法来源生成面板。 */
  collapseDetail: () => void;
} {
  const listeners = new Set<() => void>();
  let snapshot: AgentConversationSnapshotView = EMPTY;
  let disposed = false;
  // 详情来源返回上下文：只保存稳定 panel route identity，不复制消息/事件（design D6a）。
  let detailReturn: CanvasPanelRoute | null = null;
  // 详情来源生成目标（打开时的来源节点与呈现形态）：用于判断「返回生成面板」是否仍成立。
  // 概览来源同时有 `detailReturn`；聚焦工作区的生成面板没有 panel route，只有这里的目标身份。
  let detailSource: AgentDetailCurrentTarget | null = null;

  const dataScopeId = options.dataScopeId ?? (() => "page");
  let namespace = dataScopeId();
  const publish = (patch: Partial<AgentConversationSnapshotView>): void => {
    if (namespace !== dataScopeId()) { namespace = dataScopeId(); snapshot = EMPTY; }
    snapshot = { ...snapshot, ...patch, ...(patch.active ? { turnsByRequest: { ...snapshot.turnsByRequest, [patch.active.requestId]: patch.active } } : {}) };
    // Retain every active request and only a bounded window of settled summaries.
    const indexed = Object.entries(snapshot.turnsByRequest ?? {});
    const settled = indexed.filter(([, value]) => !["queued", "running", "committing", "unknown"].includes(value.turn.status));
    if (settled.length > 256) {
      const evicted = new Set(settled.slice(0, settled.length - 256).map(([key]) => key));
      snapshot = { ...snapshot, turnsByRequest: Object.fromEntries(indexed.filter(([key]) => !evicted.has(key))) };
    }
    if (disposed) return;
    for (const listener of listeners) listener();
  };

  const remote = options.remote;

  const listConversations = async (canvasId: string) => {
    const requestedScope = dataScopeId();
    const result = await remote.list(canvasId);
    if (requestedScope !== dataScopeId()) return { ok: false as const, code: "identity-changed", error: "Assistant identity changed" };
    if (result.ok) publish({ conversations: result.value.conversations, error: null });
    else publish({ error: result.error });
    return result.ok
      ? { ok: true as const, value: result.value.conversations }
      : { ok: false as const, code: result.code, error: result.error };
  };

  /** 读取内置 MCP 真实发现（只读；不复制地址为外部连接，不伪造 ready）。 */
  const mcpStatus = async () => {
    const requestedScope = dataScopeId();
    const result = await remote.mcpStatus();
    if (requestedScope !== dataScopeId()) return { ok: false as const, code: "identity-changed", error: "Assistant identity changed" };
    if (result.ok) publish({ mcp: result.value, error: null });
    else publish({ error: result.error });
    return result;
  };

  const ensureConversation = async (input: AgentConversationSubmitInput): Promise<AgentConversationResult<string>> => {
    const scope = dataScopeId();
    if (input.conversationId) return { ok: true, value: input.conversationId };
    // 一个节点复用一条会话（design D8）：先按目标查找现有会话，未命中再新建。宿主未注入
    // conversationId（如重开面板）时也据此复用，避免每次生成都新会话。
    const nodeId = input.entry.nodeId;
    if (nodeId) {
      const found = input.connectionId
        ? await remote.findForTarget(input.canvasId, nodeId, input.connectionId)
        : await remote.findForTarget(input.canvasId, nodeId);
      if (!found.ok) return found;
      const existing = found.value.conversation;
      if (existing) {
        const known = snapshot.conversations.some((entry) => entry.conversationId === existing.conversationId);
        if (scope === dataScopeId()) publish({ conversations: known ? snapshot.conversations : [existing, ...snapshot.conversations], error: null });
        return { ok: true, value: existing.conversationId };
      }
    }
    if (scope !== dataScopeId()) return { ok: false, code: "identity-changed", error: "Assistant identity changed" };
    const created = await remote.create({
      canvasId: input.canvasId,
      ...(input.adapterId ? { adapterId: input.adapterId } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(nodeId ? { nodeId } : {})
    });
    if (!created.ok) return created;
    if (scope === dataScopeId()) publish({ conversations: [created.value.conversation, ...snapshot.conversations], error: null });
    return { ok: true, value: created.value.conversation.conversationId };
  };

  /** 按目标节点查找当前会话（只读；供宿主/生成面板在重开时复用同一会话）。 */
  const findConversationForTarget = async (input: { canvasId: string; nodeId: string; connectionId?: string }) => {
    return input.connectionId
      ? await remote.findForTarget(input.canvasId, input.nodeId, input.connectionId)
      : await remote.findForTarget(input.canvasId, input.nodeId);
  };

  /** 该 owner 可见来源连接（只读；失败保留原选择）。 */
  const listConnections = async (adapterId?: string) => {
    const result = await remote.listConnections(adapterId);
    if (!result.ok) return { ok: false as const, code: result.code, error: result.error };
    return { ok: true as const, value: result.value.connections };
  };
  const directoryReads = cacheAgentDirectoryReads({ listConnections, catalog: (adapterId) => remote.catalog(adapterId) }, options.dataScopeId ?? (() => "page"));

  /**
   * 显式切换来源连接：解除目标关联、归档旧会话（保留历史）。成功后清理本地读模型中该节点的
   * active/detail，并自增 `contextRevision`，让宿主重新解析节点会话；失败（如活动回合）保留原状态。
   */
  const switchConnection = async (input: { canvasId: string; nodeId: string; connectionId: string }) => {
    const requestedScope = dataScopeId();
    const result = await remote.switchConnection(input);
    if (requestedScope !== dataScopeId()) return { ok: false as const, code: "identity-changed", error: "Assistant identity changed" };
    if (!result.ok) {
      publish({ error: result.error });
      return { ok: false as const, code: result.code, error: result.error };
    }
    const detail = snapshot.detail?.conversation;
    const shouldClearDetail = detail !== undefined && detail.nodeId === input.nodeId && detail.canvasId === input.canvasId;
    const clearActive = snapshot.active !== null && shouldClearDetail;
    publish({
      detail: shouldClearDetail ? null : snapshot.detail,
      active: clearActive ? null : snapshot.active,
      error: null,
      contextRevision: snapshot.contextRevision + 1
    });
    return { ok: true as const, value: { cleared: result.value.cleared } };
  };

  /**
   * 清空节点上下文：解除关联（归档旧会话，不删除历史），并清理本地读模型中该会话的 active/detail。
   * 自增 `contextRevision` 让宿主重新解析节点会话。
   */
  const clearContext = async (input: { canvasId: string; nodeId: string }) => {
    const requestedScope = dataScopeId();
    const result = await remote.clearContext(input.canvasId, input.nodeId);
    if (requestedScope !== dataScopeId()) return { ok: false as const, code: "identity-changed", error: "Assistant identity changed" };
    if (!result.ok) {
      publish({ error: result.error });
      return { ok: false as const, code: result.code, error: result.error };
    }
    const cleared = result.value.cleared;
    const detail = snapshot.detail?.conversation;
    const shouldClearDetail = detail !== undefined && detail.nodeId === input.nodeId && detail.canvasId === input.canvasId;
    const clearActive = snapshot.active !== null && shouldClearDetail;
    publish({
      detail: shouldClearDetail ? null : snapshot.detail,
      active: clearActive ? null : snapshot.active,
      error: null,
      contextRevision: snapshot.contextRevision + 1
    });
    return { ok: true as const, value: { cleared } };
  };

  const submitTurn = async (
    input: AgentConversationSubmitInput & { requestId: string }
  ): Promise<AgentConversationResult<AgentConversationSubmitResult>> => {
    const submittedScope = dataScopeId();
    publish({ loading: true, error: null });
    const conversation = await ensureConversation(input);
    if (!conversation.ok) {
      if (submittedScope === dataScopeId()) publish({ loading: false, error: conversation.error });
      return conversation;
    }
    if (submittedScope !== dataScopeId()) return { ok: false, code: "identity-changed", error: "Assistant identity changed" };
    const accepted = await remote.accept(conversation.value, { requestId: input.requestId, entry: input.entry });
    if (!accepted.ok) {
      if (submittedScope === dataScopeId()) publish({ loading: false, error: accepted.error });
      return accepted;
    }
    const value: AgentConversationSubmitResult = {
      conversationId: accepted.value.conversation.conversationId,
      requestId: input.requestId,
      turn: accepted.value.turn,
      reused: accepted.value.reused
    };
    if (submittedScope === dataScopeId()) publish({
      loading: false,
      active: { conversationId: accepted.value.conversation.conversationId, requestId: input.requestId, turn: accepted.value.turn },
      error: null,
      conversations: snapshot.conversations.map((entry) =>
        entry.conversationId === conversation.value ? accepted.value.conversation : entry
      )
    });
    return { ok: true, value };
  };

  const queries = new Map<string, ReturnType<AgentConversationService["queryTurn"]>>();
  const queryTurn: AgentConversationService["queryTurn"] = (requestId) => {
    const queriedScope = dataScopeId();
    const key = JSON.stringify([queriedScope, requestId]);
    const existing = queries.get(key);
    if (existing) return existing;
    const promise = (async () => {
      const result = await remote.query(requestId);
      if (!result.ok) {
        if (queriedScope === dataScopeId()) publish({ error: result.error });
        return { ok: false as const, code: result.code, error: result.error };
      }
      if (queriedScope === dataScopeId()) publish({
        active: { conversationId: result.value.conversation.conversationId, requestId, turn: result.value.turn }, error: null
      });
      return { ok: true as const, value: result.value };
    })();
    queries.set(key, promise);
    const cleanup = () => { if (queries.get(key) === promise) queries.delete(key); };
    void promise.then(cleanup, cleanup);
    return promise;
  };

  const detailReads = new Map<string, ReturnType<typeof remote.read>>();
  const readConversation = (conversationId: string, cursor = 0): ReturnType<typeof remote.read> => {
    const scope = dataScopeId();
    const key = JSON.stringify([scope, conversationId, cursor]);
    const existing = detailReads.get(key);
    if (existing) return existing;
    const promise = remote.read(conversationId, cursor).then(result => scope === dataScopeId() ? result
      : { ok: false as const, code: "identity-changed", error: "Assistant identity changed" });
    detailReads.set(key, promise);
    const cleanup = () => { if (detailReads.get(key) === promise) detailReads.delete(key); };
    void promise.then(cleanup, cleanup);
    return promise;
  };
  let detailGeneration = 0;
  const openDetail = async (conversationId: string): Promise<AgentConversationResult<ConversationSnapshot>> => {
    const scope = dataScopeId();
    const generation = ++detailGeneration;
    publish({ loading: true, error: null });
    const result = await readConversation(conversationId);
    if (scope === dataScopeId() && generation === detailGeneration) {
      if (result.ok) {
        const turnsByRequest = { ...snapshot.turnsByRequest };
        for (const turn of result.value.turns) turnsByRequest[turn.requestId] = { conversationId, requestId: turn.requestId, turn };
        publish({ loading: false, detail: result.value, turnsByRequest, error: null });
      } else publish({ loading: false, error: result.error });
    }
    return result;
  };

  /**
   * 打开确切回合的详情（只读）：切换 `agent-conversation` route 并保存当前合法来源。
   *
   * 先保存来源 panel route（若非详情自身），再打开详情；随后异步读取快照（不阻塞导航，
   * 打开本身不 dispatch/推理）。若来源无效（如已删除的节点生成面板），关闭时 `panelAvailable`
   * 判定为不可恢复，不写下失效 route。
   */
  const navigateToDetail = (input: { conversationId: string; requestId: string; nodeId?: string; runId?: string; taskId?: string }): void => {
    const nav = options.navigation;
    if (!nav) return;
    const current = nav.getPanel();
    if (current?.type === AGENT_CONVERSATION_PANEL_ROUTE_TYPE) {
      // 详情 → 详情（活动/历史里再点一条）：保留既有来源，不因为当前 panel 是详情就丢掉它。
    } else if (current) {
      detailReturn = current;
      detailSource = current.nodeId ? { nodeId: current.nodeId, focus: false } : null;
    } else {
      // 没有概览来源 panel：可能是聚焦工作区检查器里的生成面板（只有目标身份），
      // 也可能是历史/活动入口（根本没有生成面板，收起就只有关闭）。仅当聚焦节点正是本次
      // 详情的目标节点时才算「从这个生成面板打开」，否则不宣称可以返回。
      const target = options.currentTarget?.() ?? null;
      detailReturn = null;
      detailSource = target?.focus && input.nodeId !== undefined && target.nodeId === input.nodeId ? target : null;
    }
    nav.openPanel({
      type: AGENT_CONVERSATION_PANEL_ROUTE_TYPE,
      conversationId: input.conversationId,
      requestId: input.requestId,
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {})
    });
    void openDetail(input.conversationId);
  };

  /**
   * 来源是否仍是当前生成目标。
   *
   * 两种来源形态：
   * - 概览生成面板：记录了一个 panel route，只有该 route 仍可用**且**节点仍是当前目标时才能返回，
   *   否则返回会把画布拉到用户已经离开的节点。
   * - 聚焦工作区检查器：没有 panel route，关闭详情就回到工作区里的生成面板，因此要求当前仍是
   *   同一节点的聚焦态。
   *
   * 历史/活动入口打开的详情没有来源目标，只能关闭。
   * 宿主未注入目标查询时保留旧行为（只有概览来源 route 可用才算可返回）。
   */
  const canReturnToSource = (): boolean => {
    const nav = options.navigation;
    if (!nav) return false;
    const readTarget = options.currentTarget;
    if (!readTarget) return detailReturn !== null && nav.panelAvailable(detailReturn);
    const target = readTarget();
    if (detailReturn) {
      if (!nav.panelAvailable(detailReturn)) return false;
      return target !== null && target.nodeId === detailReturn.nodeId;
    }
    return target !== null && target.focus && detailSource !== null && target.nodeId === detailSource.nodeId;
  };

  /**
   * 收起详情。
   *
   * 仅当来源生成面板**仍可返回**时恢复它；否则这只是一个关闭动作——用户已选中别的节点
   * （或取消选中、来源节点被删除）时不得把画布拉回旧节点的生成面板。
   */
  const collapseDetail = (): void => {
    const nav = options.navigation;
    if (!nav) {
      publish({ detail: null });
      return;
    }
    const restore = canReturnToSource() ? detailReturn : null;
    detailReturn = null;
    detailSource = null;
    if (restore) nav.openPanel(restore);
    else nav.closePanel(AGENT_CONVERSATION_PANEL_ROUTE_TYPE);
    publish({ detail: null });
  };

  /**
   * 只清详情读模型缓存（卸载清理用），不改写 route。
   *
   * route 收起由 `collapseDetail`（显式返回）或 navigation transition（切走其它 panel）
   * 负责；卸载清理若调用 `collapseDetail` 会在 StrictMode 重放/被替换时把刚打开的详情
   * route 立即关掉。
   */
  const clearDetail = (): void => {
    detailGeneration++;
    publish({ detail: null });
  };

  const locateTurnByRun = (runId: string) => remote.locate(runId);

  /**
   * 活动/历史入口：按领域运行关联定位确切回合，命中后只读打开详情。
   *
   * 先查再导航（不按 nodeId 跳到最近会话）；未关联返回 `not-found`，调用方保留原任务详情。
   * 命中后把 runId 写进详情 route（payload 仍不复制消息），打开本身不 dispatch。
   */
  const locateAndOpenDetail = async (input: { runId: string }) => {
    const scope = dataScopeId();
    const generation = detailGeneration;
    const result = await remote.locate(input.runId);
    if (scope !== dataScopeId() || generation !== detailGeneration || disposed) return { ok: false as const, code: "identity-changed", error: "当前详情或数据空间已变更" };
    if (!result.ok) {
      publish({ error: result.error });
      return { ok: false as const, code: result.code, error: result.error };
    }
    navigateToDetail({
      conversationId: result.value.conversation.conversationId,
      requestId: result.value.turn.requestId,
      ...(result.value.turn.target.nodeId ? { nodeId: result.value.turn.target.nodeId } : {}),
      runId: input.runId,
      ...(result.value.turn.taskId ? { taskId: result.value.turn.taskId } : {})
    });
    publish({
      active: {
        conversationId: result.value.conversation.conversationId,
        requestId: result.value.turn.requestId,
        turn: result.value.turn
      },
      detail: result.value.snapshot,
      loading: false,
      error: null
    });
    return {
      ok: true as const,
      value: { conversation: result.value.conversation, turn: result.value.turn }
    };
  };

  return {
    getDataScopeId: dataScopeId,
    getSnapshot: () => {
      if (namespace !== dataScopeId()) { namespace = dataScopeId(); snapshot = EMPTY; }
      return snapshot;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getDetail: () => snapshot.detail,
    openDetail,
    clearDetail,
    closeDetail: collapseDetail,
    canReturnToSource,
    navigateToDetail,
    locateAndOpenDetail,
    collapseDetail,

    catalog: directoryReads.catalog,
    invalidateDirectory: directoryReads.invalidateDirectory,
    mcpStatus,
    listConversations,
    findConversationForTarget,
    listConnections: directoryReads.listConnections,
    clearContext,
    switchConnection,
    readConversation,
    submitTurn,
    queryTurn,
    locateTurnByRun,
    cancelTurn: (requestId) => remote.cancel(requestId),
    linkRun: (requestId, input) => remote.link(requestId, input)
  };
}

export type AgentConversationServiceHandle = ReturnType<typeof createAgentConversationService>;
