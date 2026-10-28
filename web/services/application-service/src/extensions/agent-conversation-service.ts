import { createHash } from "node:crypto";
/**
 * 宿主 Agent 会话服务
 * （change: 2026-10-12-add-agent-conversation-panel，任务 1.5/1.6/1.7 / design D1/D2/D7）。
 *
 * 编排：create/list/read/send(query)/cancel/link-run 与事件 cursor 重放。语义要点：
 * - accept-before-dispatch：先 durable 写 turn（queued），再异步 dispatch adapter；
 * - requestId + 规范输入 hash 去重：相同身份相同输入返回原运行，不再推理；不同输入拒绝；
 * - 单会话最多一个 active turn；owner/global 有界并发与队列预算；
 * - 重启 discovered nsettled 标记 unknown 并核对 adapter 回执，不自动重推理；
 * - 打开/关闭/查询只读，不重新 accept 或 dispatch。
 *
 * 本服务不写 Y.Doc、不复制 Task 事实源；领域回执按 adapter discriminant 原样保存与投影。
 */
import type {
  AgentAdapterRunOutcome,
  AgentConnectionBinding,
  AgentConnectionView,
  AgentConversationAdapterEvent,
  AgentEntryIntent,
  AgentTargetSnapshot,
  ConversationEventType,
  ConversationSnapshot,
  ConversationSummary,
  ConversationTurn,
  AgentCatalogSnapshot,
  AgentAdapterAuthState,
  AgentAdapterCapabilities
} from "@woohaa3/contracts";
import type {
  AgentConversationStore,
  ConversationAdapterBinding,
  ConversationTurnRecord
} from "../repository/agent-conversation-repository.js";
import { isTerminalTurnStatus } from "../repository/agent-conversation-repository.js";
import type { AgentAdapterRegistry } from "../extensions/agent-adapter-registry.js";
import type { AgentConnectionRegistry } from "../extensions/agent-connection-registry.js";
import {
  buildSnapshot as projectionBuildSnapshot,
  clamp,
  createAssistantMessageDigest,
  conversationStatusFor as projectionConversationStatusFor,
  defaultId,
  entryFromTurn,
  hashIntent,
  safeJson,
  toMessage as projectionToMessage,
  toSummary as projectionToSummary,
  toTurn as projectionToTurn
} from "./agent-conversation-projection.js";
import { createStreamAccumulator } from "./agent-conversation-stream.js";

export { hashIntent } from "./agent-conversation-projection.js";

export type AgentConversationServiceOptions = {
  groupScopeEpoch?: (canvasId: string, rootGroupId: string) => number;
  groupEffects?: {
    settle(input: { owner: string; requestId: string; actions: import("@woohaa3/contracts").CanvasGroupAction[]; outcome: AgentAdapterRunOutcome; signal: AbortSignal; recovery?: boolean }): Promise<AgentAdapterRunOutcome>;
    cancel(input: { owner: string; requestId: string; actions: import("@woohaa3/contracts").CanvasGroupAction[] }): void;
  };
  store: AgentConversationStore;
  registry: AgentAdapterRegistry;
  /**
   * 连接发现注册表（change: 2026-10-16-...，任务 2.1/2.3）。
   *
   * 可选：未注入时按 adapter 解析兼容默认连接（既有 ChatGPT 行为不变）。
   */
  connections?: AgentConnectionRegistry;
  /**
   * 兼容默认连接解析（旧数据/未显式选连接时）。
   *
   * 返回该 owner + adapter 的兼容默认连接（既有 ChatGPT）；未配置时返回 null（不伪造）。
   */
  defaultConnectionFor?: (input: { owner: string; adapterId: string }) => Promise<AgentConnectionView | null> | AgentConnectionView | null;
  /** 每会话事件保留窗口（用于 resync 判定）；缺省 2000。 */
  maxEvents?: number;
  /** 单页消息数（分页读取的传输参数，不是总量截断）；缺省 200。 */
  maxMessages?: number;
  /** 显式部署的单条消息预算；缺省保留完整正文。 */
  maxMessageChars?: number;
  now?: () => string;
  /** 稳定 id 生成器（按前缀）；测试可注入确定性实现。 */
  createId?: (prefix: string) => string;
  logger?: (event: Record<string, unknown>) => void;
  /** Supervisor 模式下暂时没有回执时保留 unknown，等待重新 attach，而不是终结回合。 */
  preserveUnreconciledOnRestart?: boolean;
};

export type AgentConversationServiceError = {
  code:
    | "malformed-request"
    | "unauthorized"
    | "not-found"
    | "request-id-reused"
    | "conversation-busy"
    | "adapter-unavailable"
    | "connection-unavailable"
    | "capability-unsupported"
    | "budget-exceeded"
    | "storage-failed"
    | "active-turn";
  message: string;
};

export type AcceptTurnResult =
  | { ok: true; conversation: ConversationSummary; turn: ConversationTurn; reused: boolean }
  | { ok: false; error: AgentConversationServiceError };

type StructuredCandidate = NonNullable<import("@woohaa3/contracts").AgentAdapterRunInput["candidate"]> & {
  referenceIdentity?: readonly { storageKey: string; checksum: string }[];
};
const candidateHash = (candidate: StructuredCandidate): string => createHash("sha256").update(JSON.stringify({
  schema: candidate.outputSchema, references: candidate.referenceIdentity, images: candidate.images.map(image => ({contentType: image.contentType,
    hash: createHash("sha256").update(image.bytes).digest("hex")}))
})).digest("hex");

export type AgentConversationService = {
  /** Host-only structured discussion, including exact schema and resolved image bytes. */
  acceptStructuredTurn(input: Parameters<AgentConversationService["acceptTurn"]>[0] & { candidate: StructuredCandidate }): AcceptTurnResult;
  dispatchStructuredTurn(turnId: string, candidate: StructuredCandidate): Promise<void>;
  /** Trusted host entry, deliberately absent from the HTTP decoder and browser API. */
  acceptDeliveryTurn(input: { owner: string; conversationId: string; requestId: string; entry: AgentEntryIntent; connection?: AgentConnectionBinding | null;
    delivery: NonNullable<AgentTargetSnapshot["delivery"]> }): AcceptTurnResult;
  dispatchDeliveryTurn(turnId: string, execute: (context: {
    signal: AbortSignal;
    history: readonly import("@woohaa3/contracts").ConversationMessage[];
    emit: (event: AgentConversationAdapterEvent) => void;
  }) => Promise<AgentAdapterRunOutcome>): Promise<void>;
  reconcileDeliveryTurn(input: { owner: string; requestId: string; canvasId: string;
    delivery: NonNullable<AgentTargetSnapshot["delivery"]>; outcome: AgentAdapterRunOutcome }): void;
  recordGroupAction(input: { owner: string; requestId: string; action: import("@woohaa3/contracts").CanvasGroupAction }): void;
  createConversation(input: { owner: string; canvasId: string; adapterId?: string; title?: string; nodeId?: string; connectionId?: string }):
    | { ok: true; conversation: ConversationSummary }
    | { ok: false; error: AgentConversationServiceError };
  listConversations(input: { owner: string; canvasId: string; limit?: number }): ConversationSummary[];
  listGroupExecutions(input: { owner: string; canvasId: string; nodeId?: string; cursor?: string; limit?: number }): { turns: ConversationTurn[]; nextCursor?: string };
  /**
   * 按生成目标节点查找该节点当前会话（一个节点复用一条；design D8）。
   *
   * 只读：只返回仍与节点关联的会话；`connectionId` 提供时只返回该来源连接下的会话
   * （change: 2026-10-16-...，任务 2.3）。无则 `conversation: null`（调用方据此新建）。
   */
  findConversationForTarget(input: { owner: string; canvasId: string; nodeId: string; connectionId?: string }):
    { ok: true; conversation: ConversationSummary | null };
  /**
   * 清空节点上下文：解除该节点与当前会话的关联（归档旧会话，**不**删除历史；design D8）。
   *
   * 只解除绑定，不删除会话/消息/回合；随后该节点提交将新建会话。存在未终态回合时拒绝
   * （change: 2026-10-16-...，任务 2.3：活动回合阻止切换/清空）。
   */
  clearContext(input: { owner: string; canvasId: string; nodeId: string }):
    | { ok: true; cleared: number }
    | { ok: false; error: AgentConversationServiceError };
  /**
   * 显式切换来源连接：解除该节点与当前会话的关联（归档旧会话，保留历史），下一次提交建立
   * 新来源会话并重新取本轮许可（change: 2026-10-16-...，任务 2.3 / design D7）。
   *
   * 活动回合存在时拒绝；不将原原生会话 ID 作为新来源恢复。
   */
  switchConnection(input: { owner: string; canvasId: string; nodeId: string; connectionId: string }):
    Promise<{ ok: true; cleared: number } | { ok: false; error: AgentConversationServiceError }>;
  readConversation(input: { owner: string; conversationId: string; cursor?: number; beforeMessageSequence?: number; turnOffset?: number }):
    | { ok: true; snapshot: ConversationSnapshot }
    | { ok: false; error: AgentConversationServiceError };
  acceptTurn(input: { owner: string; conversationId: string; requestId: string; entry: AgentEntryIntent; connection?: AgentConnectionBinding | null }): AcceptTurnResult;
  /**
   * 解析本回合要冻结的连接身份（change: 2026-10-16-...，任务 2.2/2.3）。
   *
   * 显式选择必须经连接注册表校验属于该 owner；缺失时映射兼容默认连接。API 在接受回合前调用，
   * 把结果作为 `connection` 传入 `acceptTurn`（保持后者同步，便于复用/测试）。
   */
  resolveConnectionBinding(input: { owner: string; adapterId: string; connectionId?: string }):
    Promise<{ ok: true; binding: AgentConnectionBinding | null } | { ok: false; error: AgentConversationServiceError }>;
  /** 异步 dispatch（accept 后调用）；幂等，同一 turn 只运行一次。 */
  dispatchTurn(turnId: string): Promise<void>;
  /** 等待指定回合 dispatch 完成（测试/受控收尾用）。 */
  whenSettled(turnId: string): Promise<void>;
  queryTurn(input: { owner: string; requestId: string }):
    | { ok: true; conversation: ConversationSummary; turn: ConversationTurn; snapshot: ConversationSnapshot }
    | { ok: false; error: AgentConversationServiceError };
  cancelTurn(input: { owner: string; requestId: string }): { ok: true } | { ok: false; error: AgentConversationServiceError };
  /**
   * 按领域运行关联定位确切回合（活动/历史 Agent 记录 → 确切 request/run）。
   *
   * 绝不按 nodeId 跳到最近会话：只匹配已显式关联的 runId；只读，不 dispatch。
   */
  locateTurnByRun(input: { owner: string; runId: string }):
    | { ok: true; conversation: ConversationSummary; turn: ConversationTurn; snapshot: ConversationSnapshot }
    | { ok: false; error: AgentConversationServiceError };
  /** 由宿主领域链在 run/task 接受后显式关联（不从节点 active run 反推）。 */
  linkRun(input: { owner: string; requestId: string; runId?: string; taskId?: string }): { ok: true; turn: ConversationTurn } | { ok: false; error: AgentConversationServiceError };
  catalog(input: { owner: string; adapterId?: string }): Promise<{ ok: true; models: AgentCatalogSnapshot["models"]; error?: string; authState: AgentAdapterAuthState; capabilities: AgentAdapterCapabilities } | { ok: false; error: AgentConversationServiceError }>;
  /** 重启恢复：标记未结算回合为 unknown 并核对 adapter 回执，不自动重推理。 */
  reconcileUnknown(): Promise<ConversationTurnRecord[]>;
  deleteAll(input: { owner: string; canvasId: string }): void;
};

export function createAgentConversationService(options: AgentConversationServiceOptions): AgentConversationService {
  const store = options.store;
  const registry = options.registry;
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? defaultId;
  const log = options.logger ?? (() => undefined);
  const maxMessages = options.maxMessages ?? 200;
  const maxMessageChars = options.maxMessageChars ?? Infinity;
  const dispatches = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();
  let acceptingTrustedDelivery = false;
  let acceptingStructuredHash: string | undefined;
  const connections = options.connections;

  const fail = (code: AgentConversationServiceError["code"], message: string): { ok: false; error: AgentConversationServiceError } => ({ ok: false, error: { code, message } });

  const resolveAdapter = (adapterId: string | undefined) => registry.resolve(adapterId);

  /**
   * 解析该 owner + adapter 的兼容默认连接（旧数据/未显式选择）。
   *
   * 未注入兜底解析时返回 null：调用方不伪造连接身份（旧历史仍可读）。
   */
  const resolveDefaultConnection = async (owner: string, adapterId: string): Promise<AgentConnectionView | null> => {
    if (!options.defaultConnectionFor) {
      const visible = connections ? await connections.listConnections({ owner }) : [];
      const defaults = visible.filter((view) => view.adapterId === adapterId && view.authMode === "oauth");
      return defaults.length === 1 ? defaults[0]! : null;
    }
    try {
      return await options.defaultConnectionFor({ owner, adapterId });
    } catch {
      return null;
    }
  };

  /**
   * 解析本回合要冻结的连接身份：优先显式选择，其次兼容默认连接；都没有时返回 null。
   *
   * 显式选择必须经连接注册表校验属于该 owner（跨 owner/未知连接拒绝，不静默降级）。
   */
  const resolveTurnConnection = async (
    owner: string,
    adapterId: string,
    requestedId: string | undefined
  ): Promise<{ ok: true; binding: AgentConnectionBinding | null } | { ok: false; error: { code: AgentConversationServiceError["code"]; message: string } }> => {
    if (requestedId) {
      if (!connections) return { ok: false, error: { code: "connection-unavailable", message: "连接服务未配置" } };
      try {
        await connections.migrateConnection?.({ owner, connectionId: requestedId, beforeMigration: () => store.prepareConnectionMigration?.(owner, requestedId) ?? false });
      } catch { return { ok: false, error: { code: "connection-unavailable", message: "连接执行版本升级未完成；请先核对活动或未知回合再重试" } }; }
      const view = await connections.getConnection({ owner, connectionId: requestedId });
      if (!view) return { ok: false, error: { code: "connection-unavailable", message: "连接不存在或无权访问" } };
      if (view.adapterId !== adapterId) return { ok: false, error: { code: "connection-unavailable", message: "连接与来源不一致" } };
      return {
        ok: true,
        binding: { connectionId: view.connectionId, adapterId: view.adapterId, configRevision: view.configRevision, credentialEpoch: view.credentialEpoch }
      };
    }
    const fallback = await resolveDefaultConnection(owner, adapterId);
    return { ok: true, binding: fallback ? { connectionId: fallback.connectionId, adapterId: fallback.adapterId, configRevision: fallback.configRevision, credentialEpoch: fallback.credentialEpoch } : null };
  };

  // 投影绑定 store：把存储记录转成公开 DTO（纯函数在 projection 模块）。
  const toSummary = projectionToSummary;
  const toTurn = (record: ConversationTurnRecord): ConversationTurn => projectionToTurn(store, record);
  const buildSnapshot = (binding: ConversationAdapterBinding, cursor: number, page: { beforeMessageSequence?: number; turnOffset?: number } = {}): ConversationSnapshot =>
    projectionBuildSnapshot(store, binding, cursor, {
      maxMessages,
      maxEvents: options.maxEvents ?? 2000,
      ...(page.beforeMessageSequence !== undefined ? { beforeMessageSequence: page.beforeMessageSequence } : {}),
      ...(page.turnOffset !== undefined ? { turnOffset: page.turnOffset } : {})
    });
  const conversationStatusFor = projectionConversationStatusFor;

  const ownedConversation = (owner: string, conversationId: string): ConversationAdapterBinding | null => {
    const binding = store.getConversation(conversationId);
    if (!binding || binding.owner !== owner) return null;
    return binding;
  };

  const appendEvent = (conversationId: string, turnId: string, requestId: string, type: ConversationEventType, payload: unknown): void => {
    store.appendEvent({
      conversationId,
      turnId,
      requestId,
      type,
      payloadJson: safeJson(payload),
      createdAt: now()
    });
  };

  /** 从持久化回合记录还原冻结的连接身份（旧数据缺省返回 null）。 */
  const turnConnection = (turn: ConversationTurnRecord): AgentConnectionBinding | null => {
    if (!turn.connectionId || !turn.connectionAdapterId) return null;
    return {
      connectionId: turn.connectionId,
      adapterId: turn.connectionAdapterId,
      configRevision: turn.connectionConfigRevision ?? 0,
      credentialEpoch: turn.connectionCredentialEpoch ?? 0
    };
  };

  const runTurn = async (turn: ConversationTurnRecord, entry: AgentEntryIntent,
    delivery?: Parameters<AgentConversationService["dispatchDeliveryTurn"]>[1], candidate?: StructuredCandidate): Promise<void> => {
    const resolved = resolveAdapter(undefined);
    // adapter 可能与创建时不同（扩展升级）；用会话绑定的 adapterId 再解析一次。
    const binding = store.getConversation(turn.conversationId);
    const bound = binding ? registry.resolve(binding.adapterId) : resolved;
    if (!bound.ok) {
      finishTurn(turn, { status: "failed", error: { code: "adapter-unavailable", message: bound.message } });
      return;
    }
    const controller = new AbortController();
    controllers.set(turn.turnId, controller);
    store.updateTurn(turn.turnId, { status: "running", stage: "running" }, now());
    appendEvent(turn.conversationId, turn.turnId, turn.requestId, "stage", { stage: "running" });

    // 完整历史（任务 4.1）：按游标从冻结基准向前逐页读取，不按固定条数截断；真正的上下文窗口
    // 由所选引擎的原生能力处理（此处只保证不静默丢弃合法历史）。
    const historyRecords: Array<ReturnType<typeof projectionToMessage>> = [];
    let beforeSequence: number | null = turn.historySequence;
    for (;;) {
      const page = store.listMessagesBefore(turn.conversationId, beforeSequence, maxMessages);
      if (page.length === 0) break;
      for (const message of page) {
        if (message.turnId !== turn.turnId && (message.role === "user" || message.role === "assistant")) historyRecords.push(projectionToMessage(message));
      }
      const first = page[0]!.sequence;
      if (beforeSequence !== null && first >= beforeSequence) break;
      beforeSequence = first;
    }
    const history = historyRecords
      .reverse()
      .map((message) => ({ ...message, content: clamp(message.content, maxMessageChars) }));

    const assistantDigest = createAssistantMessageDigest();
    // 流式聚合：同一逻辑消息的分片合并成一行（阶段/工具事件先结算当前消息）。
    const stream = createStreamAccumulator({
      maxMessageChars,
      nextMessageId: () => createId("msg"),
      appendMessage: (message) => {
        store.appendMessage({
          messageId: message.messageId,
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          requestId: turn.requestId,
          role: message.role,
          content: message.content,
          truncated: message.truncated ? 1 : 0,
          sequence: store.maxMessageSequence(turn.conversationId) + 1,
          createdAt: now()
        });
      },
      updateMessage: (messageId, patch) => store.updateMessage(messageId, { content: patch.content, truncated: patch.truncated ? 1 : 0 }),
      appendEvent: (type, payload) => appendEvent(turn.conversationId, turn.turnId, turn.requestId, type, payload),
      recordAssistantText: (text) => assistantDigest.append(text)
    });
    let acceptingEvents = true;
    const emit = (event: AgentConversationAdapterEvent): void => {
      if (!acceptingEvents) return;
      switch (event.type) {
        case "stage": {
          // 阶段切换可能夹着下一条助手消息：先结算当前打开的那条。
          stream.flush();
          store.updateTurn(turn.turnId, { stage: event.stage }, now());
          appendEvent(turn.conversationId, turn.turnId, turn.requestId, "stage", { stage: event.stage, ...(event.detail ? { detail: event.detail } : {}), ...(event.summary ? { summary: event.summary } : {}) });
          return;
        }
        case "message": {
          stream.push(event);
          return;
        }
        case "tool-started": {
          stream.flush();
          store.appendTool({ toolId: createId("tool"), conversationId: turn.conversationId, turnId: turn.turnId, tool: event.tool, status: "started", summary: event.summary ?? null, sequence: store.maxEventSequence(turn.conversationId), createdAt: now() });
          appendEvent(turn.conversationId, turn.turnId, turn.requestId, "tool-started", { tool: event.tool, ...(event.callId ? { callId: event.callId } : {}), ...(event.summary ? { summary: event.summary } : {}) });
          return;
        }
        case "tool-completed": {
          stream.flush();
          store.appendTool({ toolId: createId("tool"), conversationId: turn.conversationId, turnId: turn.turnId, tool: event.tool, status: event.ok ? "completed" : "failed", summary: event.summary ?? null, sequence: store.maxEventSequence(turn.conversationId), createdAt: now() });
          appendEvent(turn.conversationId, turn.turnId, turn.requestId, "tool-completed", { tool: event.tool, ...(event.callId ? { callId: event.callId } : {}), ok: event.ok, ...(event.summary ? { summary: event.summary } : {}) });
          return;
        }
      }
    };
    let outcome: AgentAdapterRunOutcome;
    try {
      outcome = delivery ? await delivery({ signal: controller.signal, emit, history }) : await bound.handle.adapter.run({
        owner: turn.owner,
        canvasId: turn.canvasId,
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        requestId: turn.requestId,
        intent: entry,
        ...(candidate ? { candidate } : {}),
        ...(turnConnection(turn) ? { connection: turnConnection(turn)! } : {}),
        history,
        signal: controller.signal,
        emit
      });
      if (entry.mode === "canvas-group" && entry.action !== "discuss" && options.groupEffects) {
        const latest = store.getTurn(turn.turnId);
        const actions = groupActions(latest?.receiptJson);
        outcome = await options.groupEffects.settle({ owner: turn.owner, requestId: turn.requestId, actions, outcome, signal: controller.signal });
      }
    } catch (error) {
      const actions = groupActions(store.getTurn(turn.turnId)?.receiptJson);
      outcome = { status: controller.signal.aborted ? "cancelled" : actions.length ? "partial" : "failed", ...(actions.length ? { receipt: { kind: "canvas-group", actions } } : {}), error: { code: controller.signal.aborted ? "cancelled" : "adapter-error", message: error instanceof Error ? error.message : String(error) } };
    } finally {
      acceptingEvents = false;
      controllers.delete(turn.turnId);
    }
    // 回合结束：结算仍在增长的助手消息（否则它的完成事件/摘要不会落库）。
    stream.flush();
    finishTurn(turn, outcome, assistantDigest);
  };

  const appendMessage = (turn: ConversationTurnRecord, role: "assistant" | "system" | "user", content: string): void => {
    const truncated = content.length > maxMessageChars;
    const bounded = clamp(content, maxMessageChars);
    const messageId = createId("msg");
    store.appendMessage({
      messageId,
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      requestId: turn.requestId,
      role,
      content: bounded,
      truncated: truncated ? 1 : 0,
      sequence: store.maxMessageSequence(turn.conversationId) + 1,
      createdAt: now()
    });
    appendEvent(turn.conversationId, turn.turnId, turn.requestId, "message-completed", { messageId, role, content: bounded, truncated });
  };

  const finishTurn = (turn: ConversationTurnRecord, outcome: AgentAdapterRunOutcome, assistantDigest?: ReturnType<typeof createAssistantMessageDigest>): void => {
    if (outcome.assistantText && outcome.assistantText.trim() !== "") {
      if (!assistantDigest?.matches(outcome.assistantText)) appendMessage(turn, "assistant", outcome.assistantText);
    }
    if (turn.action !== "discuss" && outcome.status === "succeeded" && outcome.receipt === undefined && !outcome.runId && !outcome.taskId) {
      outcome = { ...outcome, status: "unknown", error: { code: "write-unconfirmed", message: "回复完成，作品更新未确认；请核对原请求" } };
    }
    const status = outcome.status;
    store.updateTurn(
      turn.turnId,
      {
        status,
        stage: status,
        ...(outcome.assistantText !== undefined ? { assistantText: outcome.assistantText } : {}),
        ...(outcome.runId !== undefined ? { runId: outcome.runId } : {}),
        ...(outcome.taskId !== undefined ? { taskId: outcome.taskId } : {}),
        ...(outcome.receipt !== undefined ? { receiptJson: safeJson(outcome.receipt) } : {}),
        ...(outcome.error !== undefined ? { errorCode: outcome.error.code, errorMessage: outcome.error.message } : {})
      },
      now()
    );
    if (status === "succeeded" || status === "partial") {
      appendEvent(turn.conversationId, turn.turnId, turn.requestId, "receipt", { status, ...(outcome.receipt !== undefined ? { receipt: outcome.receipt } : {}) });
    } else {
      appendEvent(turn.conversationId, turn.turnId, turn.requestId, "error", { status, ...(outcome.error ?? {}) });
    }
    const binding = store.getConversation(turn.conversationId);
    if (binding) {
      store.updateConversation(turn.conversationId, { status: conversationStatusFor(store.latestTurn(turn.conversationId)), latestRequestId: turn.requestId }, now());
    }
    log({ event: "agent-conversation-turn-settled", conversationId: turn.conversationId, requestId: turn.requestId, status });
  };

  const service: AgentConversationService = {
    createConversation(input) {
      if (!input.owner) return fail("unauthorized", "缺少可信用户主体");
      const resolved = resolveAdapter(input.adapterId);
      if (!resolved.ok) return fail("adapter-unavailable", resolved.message);
      const conversationId = createId("conv");
      const timestamp = now();
      const binding = store.createConversation({
        conversationId,
        owner: input.owner,
        canvasId: input.canvasId,
        adapterId: resolved.handle.owner.adapterId,
        connectionId: input.connectionId ?? null,
        title: input.title?.trim() || "新对话",
        nodeId: input.nodeId ?? null,
        now: timestamp
      });
      return { ok: true, conversation: toSummary(binding) };
    },

    listConversations(input) {
      return store.listConversations({ owner: input.owner, canvasId: input.canvasId }, input.limit ?? 50).map(toSummary);
    },

    listGroupExecutions(input) {
      const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 50)));
      let cursor: { createdAt: string; turnId: string } | undefined;
      if (input.cursor) {
        const parsed = JSON.parse(input.cursor);
        if (typeof parsed?.createdAt !== "string" || typeof parsed?.turnId !== "string") throw new Error("无效组执行分页游标");
        cursor = parsed;
      }
      const rows = store.listGroupTurns({ owner: input.owner, canvasId: input.canvasId, nodeId: input.nodeId, cursor }, limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { turns: page.map(toTurn), ...(rows.length > limit && last ? { nextCursor: JSON.stringify({ createdAt: last.createdAt, turnId: last.turnId }) } : {}) };
    },

    findConversationForTarget(input) {
      const binding = store.findConversationByTarget({
        owner: input.owner,
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId })
      });
      return { ok: true, conversation: binding ? toSummary(binding) : null };
    },

    clearContext(input) {
      if (store.activeGroupTurnCount(input) > 0) return fail("active-turn", "组仍有活动或待核对回合，请先停止并核对结果");
      if (!input.owner) return fail("unauthorized", "缺少可信用户主体");
      // change: 2026-10-22-remove-agent-execution-limits，任务 3.1/3.2 / design D3：
      // 删除「活动回合阻止清空」。清空只解除目标关联（归档会话），不删除回合/消息/回执，
      // 因此不会丢掉尚未核对的执行；后续只停止用户明确选择的 requestId。
      const cleared = store.clearTarget({ owner: input.owner, canvasId: input.canvasId, nodeId: input.nodeId });
      return { ok: true, cleared };
    },

    async switchConnection(input) {
      if (store.activeGroupTurnCount(input) > 0) return fail("active-turn", "组仍有活动或待核对回合，请先停止并核对结果");
      if (!input.owner) return fail("unauthorized", "缺少可信用户主体");
      // 先核对目标连接属于该 owner（跨 owner/未知连接拒绝，不静默降级）。
      if (connections) {
        const view = await connections.getConnection({ owner: input.owner, connectionId: input.connectionId });
        if (!view) return fail("connection-unavailable", "连接不存在或无权访问");
      }
      // 解除目标关联（归档旧会话，保留全部历史与未核对回合）；下一次提交按新连接建立新会话。
      // 活动回合不再阻止切换：执行拥有独立取消身份，旧回合继续按其原冻结连接结算。
      const cleared = store.archiveTargetForConnection({ owner: input.owner, canvasId: input.canvasId, nodeId: input.nodeId });
      return { ok: true, cleared };
    },

    readConversation(input) {
      const binding = ownedConversation(input.owner, input.conversationId);
      if (!binding) return fail("not-found", "会话不存在或无权访问");
      return {
        ok: true,
        snapshot: buildSnapshot(binding, input.cursor ?? 0, {
          ...(input.beforeMessageSequence !== undefined ? { beforeMessageSequence: input.beforeMessageSequence } : {}),
          ...(input.turnOffset !== undefined ? { turnOffset: input.turnOffset } : {})
        })
      };
    },

    resolveConnectionBinding(input) {
      return resolveTurnConnection(input.owner, input.adapterId, input.connectionId);
    },

    acceptStructuredTurn(input) {
      if (input.entry.action !== "discuss") return fail("malformed-request", "Structured assistant requires discuss");
      const conversation = ownedConversation(input.owner, input.conversationId);
      if (!conversation) return fail("not-found", "会话不存在或无权访问");
      const adapter = resolveAdapter(conversation.adapterId);
      const capability = adapter.ok ? adapter.handle.capabilities.candidateGeneration : undefined;
      if (!capability || input.candidate.images.length > capability.maxImages || (input.candidate.images.length > 0 && !capability.imageInput)) {
        return fail("capability-unsupported", "所选助手不支持本次结构化设计或参考图数量，请更换助手。");
      }
      acceptingStructuredHash = candidateHash(input.candidate);
      try { return service.acceptTurn(input); }
      finally { acceptingStructuredHash = undefined; }
    },
    async dispatchStructuredTurn(turnId, candidate) {
      const existing = dispatches.get(turnId);
      if (existing) return existing;
      const record = store.getTurn(turnId);
      if (!record || record.status !== "queued") return;
      if (JSON.parse(record.targetJson).structuredInputHash !== candidateHash(candidate)) return;
      const promise = Promise.resolve().then(() => runTurn(record, entryFromTurn(record), undefined, candidate))
        .catch(error => { log({ event: "agent-structured-dispatch-error", turnId, message: error instanceof Error ? error.message : String(error) }); })
        .finally(() => dispatches.delete(turnId));
      dispatches.set(turnId, promise);
      return promise;
    },
    acceptDeliveryTurn(input) {
      const existing = store.findTurnByRequest(input.owner, input.requestId);
      if (existing && JSON.stringify(JSON.parse(existing.targetJson).delivery) !== JSON.stringify(input.delivery)) {
        return fail("request-id-reused", "交付请求已绑定其它尝试");
      }
      let accepted: ReturnType<AgentConversationService["acceptTurn"]>;
      acceptingTrustedDelivery = true;
      try { accepted = service.acceptTurn(input); }
      finally { acceptingTrustedDelivery = false; }
      if (!accepted.ok) return accepted;
      if (!accepted.reused) store.updateTurn(accepted.turn.turnId, {
        targetJson: safeJson({ ...accepted.turn.target, delivery: input.delivery }),
      }, now());
      return { ...accepted, turn: toTurn(store.getTurn(accepted.turn.turnId)!) };
    },

    reconcileDeliveryTurn(input) {
      const record = store.findTurnByRequest(input.owner, input.requestId);
      if (!record || record.canvasId !== input.canvasId || dispatches.has(record.turnId)) return;
      if (JSON.stringify(JSON.parse(record.targetJson).delivery) !== JSON.stringify(input.delivery)) return;
      if (!["unknown", "queued", "running", "committing"].includes(record.status) && !(input.delivery.purpose === "text-generation" && input.outcome.status === "succeeded" && input.outcome.receipt)) return;
      finishTurn(record, input.outcome);
    },

    async dispatchDeliveryTurn(turnId, execute) {
      const existing = dispatches.get(turnId);
      if (existing) return existing;
      const record = store.getTurn(turnId);
      if (!record || record.status !== "queued" || !JSON.parse(record.targetJson).delivery) return;
      const promise = Promise.resolve().then(() => runTurn(record, entryFromTurn(record), execute)).finally(() => {
        dispatches.delete(turnId);
      });
      dispatches.set(turnId, promise);
      return promise;
    },

    acceptTurn(input) {
      if (!input.owner) return fail("unauthorized", "缺少可信用户主体");
      const binding = ownedConversation(input.owner, input.conversationId);
      if (!binding) return fail("not-found", "会话不存在或无权访问");
      if (input.entry.canvasId !== binding.canvasId) return fail("unauthorized", "目标画布与会话不一致");
      if (input.entry.action !== "discuss" && binding.nodeId && input.entry.nodeId !== binding.nodeId) return fail("unauthorized", "目标节点与会话不一致");

      if (input.entry.mode === "text" && input.entry.action !== "discuss" && !acceptingTrustedDelivery) return fail("capability-unsupported", "文本生成必须经过可信文本交付入口");
      const inputHash = hashIntent(input.entry, input.connection ?? null) + (acceptingStructuredHash ? `:${acceptingStructuredHash}` : "");
      const existing = store.findTurnByRequest(input.owner, input.requestId);
      if (existing) {
        if (existing.conversationId !== binding.conversationId || existing.canvasId !== binding.canvasId) return fail("request-id-reused", "requestId 已绑定其它会话或画布");
        if (existing.inputHash !== inputHash) return fail("request-id-reused", "requestId 已用于不同输入");
        // 相同身份相同输入：返回原运行，不重复推理/写入。
        return { ok: true, conversation: toSummary(binding), turn: toTurn(existing), reused: true };
      }

      // change: 2026-10-22-remove-agent-execution-limits，任务 3.1 / design D3：
      // 删除「单会话单活动回合」与 owner/global 活跃数量拒绝。每个 requestId 都有独立回合、
      // 取消身份与冻结历史基准；并发写由 Canvas 内容版本与事务决定，不用活动数门禁代替。
      const resolved = registry.resolve(binding.adapterId);
      if (!resolved.ok) return fail("adapter-unavailable", resolved.message);
      const capabilities = resolved.handle.capabilities;
      if (!capabilities.discussion && input.entry.action === "discuss") {
        return fail("capability-unsupported", "该 adapter 不支持讨论");
      }
      if (input.entry.action !== "discuss") {
        if (binding.nodeId === null && binding.turnCount > 0) return fail("capability-unsupported", "此会话已归档或没有当前目标，请返回作品面板执行");
        if (!acceptingTrustedDelivery && !capabilities.targets.includes(input.entry.mode ?? "model3d")) {
          return fail("capability-unsupported", "该 adapter 不支持此目标动作");
        }
        if (input.entry.nodeId === undefined) return fail("malformed-request", "目标动作必须带 nodeId");
      }
      if (input.entry.itemId !== undefined && input.entry.clipId === undefined) {
        return fail("malformed-request", "对象动作缺少 clipId，拒绝退化成整体片场修改");
      }

      // 冻结本回合来源连接身份（design D7）：由 API 在接受前解析后传入；缺失时为兼容默认连接或 null。
      const connection = input.connection ?? null;
      // 会话冻结的连接与本次请求不一致时拒绝（不静默换来源）。
      if (binding.connectionId && connection && binding.connectionId !== connection.connectionId) {
        return fail("connection-unavailable", "该会话已冻结其它来源连接，请先切换来源");
      }

      const turnId = createId("turn");
      const timestamp = now();
      const target: AgentTargetSnapshot = {
        ...(acceptingStructuredHash ? { structuredInputHash: acceptingStructuredHash } : {}),
        canvasId: binding.canvasId,
        ...(input.entry.nodeId !== undefined ? { nodeId: input.entry.nodeId } : {}),
        ...(input.entry.mode !== undefined ? { mode: input.entry.mode } : {}),
        ...(input.entry.cameraId !== undefined ? { cameraId: input.entry.cameraId } : {}),
        ...(input.entry.clipId !== undefined ? { clipId: input.entry.clipId } : {}),
        ...(input.entry.itemId !== undefined ? { itemId: input.entry.itemId } : {}),
        ...(input.entry.model !== undefined ? { model: input.entry.model } : {}),
        ...(input.entry.reasoningEffort !== undefined ? { reasoningEffort: input.entry.reasoningEffort } : {}),
        ...(connection ? { connectionId: connection.connectionId } : {}),
        ...(input.entry.expectedContentHash !== undefined ? { expectedContentHash: input.entry.expectedContentHash } : {})
      };
      if (input.entry.mode === "canvas-group" && input.entry.action !== "discuss") {
        if (!options.groupScopeEpoch) return fail("capability-unsupported", "组范围代次端口未装配");
        target.expectedContentHash = `group-epoch:${options.groupScopeEpoch(binding.canvasId, input.entry.nodeId!)}`;
      }
      store.createTurn({
        turnId,
        conversationId: binding.conversationId,
        owner: input.owner,
        canvasId: binding.canvasId,
        requestId: input.requestId,
        action: input.entry.action,
        status: "queued",
        stage: "queued",
        inputHash,
        targetJson: safeJson(target),
        intentJson: safeJson({ ...input.entry, ...(target.expectedContentHash ? { expectedContentHash: target.expectedContentHash } : {}) }),
        connectionId: connection?.connectionId ?? null,
        connectionAdapterId: connection?.adapterId ?? null,
        connectionConfigRevision: connection?.configRevision ?? null,
        connectionCredentialEpoch: connection?.credentialEpoch ?? null,
        // 受理时冻结历史基准（任务 3.1）：只把此刻已完成的合法前缀纳入本回合，不读并发回合的半条输出。
        historySequence: store.maxMessageSequence(binding.conversationId),
        createdAt: timestamp,
        updatedAt: timestamp
      });
      // 用户消息先于 dispatch 持久化（accept-before-dispatch）。
      appendMessage(store.getTurn(turnId)!, "user", input.entry.prompt);
      appendEvent(binding.conversationId, turnId, input.requestId, "accepted", { action: input.entry.action, target });
      store.updateConversation(binding.conversationId, {
        status: "active",
        latestRequestId: input.requestId,
        turnCount: store.turnCount(binding.conversationId),
        // 首次提交时把会话绑定到目标节点（一个节点复用一条；design D8）。仅在无既往回合的
        // 新会话上补绑，避免把「已清空归档」的旧会话在讨论回复时重新绑回节点。
        ...(binding.nodeId === null && binding.turnCount === 0 && input.entry.nodeId !== undefined ? { nodeId: input.entry.nodeId } : {}),
        ...(binding.title === "新对话" && input.entry.prompt.trim() !== "" ? { title: input.entry.prompt.trim().slice(0, 40) } : {})
      }, timestamp);
      const turn = store.getTurn(turnId)!;
      return { ok: true, conversation: toSummary(store.getConversation(binding.conversationId)!), turn: toTurn(turn), reused: false };
    },

    async dispatchTurn(turnId) {
      const existing = dispatches.get(turnId);
      if (existing) return existing;
      const record = store.getTurn(turnId);
      if (!record || isTerminalTurnStatus(record.status) || record.status !== "queued") return;
      // A persisted candidate delivery can only be dispatched by the trusted domain coordinator.
      if (JSON.parse(record.targetJson).delivery || JSON.parse(record.targetJson).structuredInputHash) return;
      const entry = entryFromTurn(record);
      const promise = runTurn(record, entry).catch((error) => {
        log({ event: "agent-conversation-dispatch-error", turnId, message: error instanceof Error ? error.message : String(error) });
      });
      dispatches.set(turnId, promise);
      return promise;
    },

    async whenSettled(turnId) {
      const promise = dispatches.get(turnId);
      if (promise) await promise;
    },

    queryTurn(input) {
      const record = store.findTurnByRequest(input.owner, input.requestId);
      if (!record) return fail("not-found", "未找到该请求");
      const binding = ownedConversation(input.owner, record.conversationId);
      if (!binding) return fail("not-found", "未找到该请求");
      return { ok: true, conversation: toSummary(binding), turn: toTurn(record), snapshot: buildSnapshot(binding, 0) };
    },

    locateTurnByRun(input) {
      const record = store.findTurnByRun(input.owner, input.runId);
      if (!record) return fail("not-found", "未找到该运行关联的 Agent 回合");
      const binding = ownedConversation(input.owner, record.conversationId);
      if (!binding) return fail("not-found", "未找到该运行关联的 Agent 回合");
      return { ok: true, conversation: toSummary(binding), turn: toTurn(record), snapshot: buildSnapshot(binding, 0) };
    },

    recordGroupAction(input) {
      const turn = store.findTurnByRequest(input.owner, input.requestId);
      if (!turn || turn.canvasId !== input.action.canvasId || JSON.parse(turn.targetJson).mode !== "canvas-group" || turn.action === "discuss") return;
      const actions = groupActions(turn.receiptJson);
      if (!input.action.commandId && !input.action.runId) return;
      if (actions.some(a => input.action.commandId ? a.commandId === input.action.commandId : a.runId === input.action.runId)) return;
      if (actions.length >= 1024) throw new Error("组创作回执超过预算");
      actions.push(input.action);
      store.updateTurn(turn.turnId, { receiptJson: safeJson({ kind: "canvas-group", actions }) }, now());
      appendEvent(turn.conversationId, turn.turnId, turn.requestId, "task-linked", input.action);
    },
    cancelTurn(input) {
      const record = store.findTurnByRequest(input.owner, input.requestId);
      if (!record) return fail("not-found", "未找到该请求");
      options.groupEffects?.cancel({ owner: input.owner, requestId: input.requestId, actions: groupActions(record.receiptJson) });
      const controller = controllers.get(record.turnId);
      const binding = store.getConversation(record.conversationId);
      if (binding && !JSON.parse(record.targetJson).delivery) {
        const resolved = registry.resolve(binding.adapterId);
        if (resolved.ok && resolved.handle.adapter.cancel) {
          void Promise.resolve(resolved.handle.adapter.cancel({ owner: input.owner, requestId: input.requestId })).catch(() => undefined);
        }
      }
      controller?.abort();
      // 宿主重启后没有在途控制器：任何目标类型都按用户停止结算，否则 unknown 只能靠手工改库脱身。
      if (!controller && ["queued", "running", "committing", "unknown"].includes(record.status)) {
        store.updateTurn(record.turnId, { status: "cancelled", stage: "cancelled" }, now());
        appendEvent(record.conversationId, record.turnId, record.requestId, "stage", { stage: "cancelled" });
      }
      return { ok: true };
    },

    linkRun(input) {
      const record = store.findTurnByRequest(input.owner, input.requestId);
      if (!record) return fail("not-found", "未找到该请求");
      store.updateTurn(record.turnId, {
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {})
      }, now());
      appendEvent(record.conversationId, record.turnId, record.requestId, "task-linked", {
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {})
      });
      return { ok: true, turn: toTurn(store.getTurn(record.turnId)!) };
    },

    async catalog(input) {
      if (!input.owner) return fail("unauthorized", "缺少可信用户主体");
      const resolved = resolveAdapter(input.adapterId);
      if (!resolved.ok) return fail("adapter-unavailable", resolved.message);
      const { adapter, capabilities } = resolved.handle;
      const authState = await adapter.authorization({ owner: input.owner }).catch(() => "unavailable" as const);
      let snapshot: AgentCatalogSnapshot = { models: [] };
      let error: string | undefined;
      // 目录与账号授权分开：本机 App Server 在未登录时也可返回内置模型列表，只能展示，
      // 不能据此标 ready。adapter 自己决定能否读目录，失败时返回可读原因。
      if (capabilities.models === "remote") {
        try {
          snapshot = await adapter.models({ owner: input.owner });
          error = snapshot.error;
        } catch (cause) {
          error = cause instanceof Error ? cause.message : "目录读取失败";
        }
      }
      return { ok: true, models: snapshot.models, authState, capabilities, ...(error ? { error } : {}) };
    },

    async reconcileUnknown() {
      const marked = store.markUnsettledUnknown(now());
      const owners = new Set<string>();
      for (const turn of marked) {
        // Candidate completion is not proof of domain delivery. Only the durable domain receipt can settle it.
        if (JSON.parse(turn.targetJson).delivery) continue;
        // Group effects remain evidence in our ledger. An adapter's text completion cannot
        // settle linked media runs, and restart never reissues a grant or inference.
        if (JSON.parse(turn.targetJson).mode === "canvas-group") {
          if (options.groupEffects) {
            try {
              const outcome = await options.groupEffects.settle({ owner: turn.owner, requestId: turn.requestId, actions: groupActions(turn.receiptJson), outcome: { status: "unknown" }, signal: new AbortController().signal, recovery: true });
              store.updateTurn(turn.turnId, { receiptJson: safeJson(outcome.receipt ?? { kind: "canvas-group", actions: groupActions(turn.receiptJson) }) }, now());
              appendEvent(turn.conversationId, turn.turnId, turn.requestId, "receipt", { status: "unknown", reconciled: true });
            } catch (error) { log({ event: "agent-group-reconcile-failed", turnId: turn.turnId, message: String(error) }); }
          }
          continue;
        }
        const resolved = registry.resolve(undefined);
        const binding = store.getConversation(turn.conversationId);
        const bound = binding ? registry.resolve(binding.adapterId) : resolved;
        const query = bound.ok ? bound.handle.adapter.query : undefined;
        // 重启后无法核对（adapter 不可用/无 query 端口/查不到记录/结构化结果缺正文）时，
        // 以 failed 结算：unknown 在界面上没有继续/停止出口，留在 unknown 会让节点永久卡在
        // 执行中。组回合（canvas-group）另有回执与用户停止入口，不在此处改判。
        const settleUnreconciled = () => {
          if (options.preserveUnreconciledOnRestart) {
            store.updateTurn(turn.turnId, { status: "unknown", stage: "unknown", errorCode: "runtime-reconnecting", errorMessage: "Agent 运行时正在重新连接，结果尚未确认" }, now());
            appendEvent(turn.conversationId, turn.turnId, turn.requestId, "error", { status: "unknown", code: "runtime-reconnecting" });
            return;
          }
          finishTurn(turn, {
            status: "failed",
            error: { code: "turn-unreconciled", message: "本机宿主重启后未取得执行回执，结果无法确认；请核对后重试" }
          });
        };
        if (!query) { settleUnreconciled(); continue; }
        owners.add(turn.turnId);
        try {
          const outcome = await query({ owner: turn.owner, requestId: turn.requestId });
          if (!outcome) { settleUnreconciled(); continue; }
          if (JSON.parse(turn.targetJson).structuredInputHash) {
            // A completion without its structured text cannot be adopted as a design result.
            if (outcome.status !== "succeeded" || outcome.assistantText?.trim()) finishTurn(turn, outcome);
            else settleUnreconciled();
            continue;
          }
          store.updateTurn(turn.turnId, {
            status: outcome.status,
            stage: outcome.status,
            ...(outcome.receipt !== undefined ? { receiptJson: safeJson(outcome.receipt) } : {}),
            ...(outcome.runId !== undefined ? { runId: outcome.runId } : {}),
            ...(outcome.taskId !== undefined ? { taskId: outcome.taskId } : {}),
            ...(outcome.error !== undefined ? { errorCode: outcome.error.code, errorMessage: outcome.error.message } : {})
          }, now());
          appendEvent(turn.conversationId, turn.turnId, turn.requestId, "receipt", { status: outcome.status, reconciled: true });
        } catch (error) {
          log({ event: "agent-conversation-reconcile-failed", turnId: turn.turnId, message: error instanceof Error ? error.message : String(error) });
          settleUnreconciled();
        }
      }
      if (marked.length > 0) log({ event: "agent-conversation-unknown-marked", count: marked.length, reconciled: owners.size });
      return marked;
    },

    deleteAll(input) {
      store.deleteAll({ owner: input.owner, canvasId: input.canvasId });
    }
  };

  return service;
}

function groupActions(json: string | null | undefined): import("@woohaa3/contracts").CanvasGroupAction[] {
  try { const value = JSON.parse(json ?? "{}"); return value.kind === "canvas-group" && Array.isArray(value.actions) ? value.actions : []; } catch { return []; }
}
