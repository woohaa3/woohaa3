import { stableStringify } from "@woohaa3/contracts/canvas-yjs";
import { createHash } from "node:crypto";
/**
 * 宿主 Agent 会话服务
 * （change: 2026-10-12-add-agent-conversation-panel，任务 1.5/1.6/1.7 / design D1/D2/D7）。
 *
 * 编排：create/list/read/send(query)/cancel/link-run 与事件 cursor 重放。语义要点：
 * - accept-before-dispatch：先 durable 写 turn（queued），再异步 dispatch adapter；
 * - requestId + 规范输入 hash 去重：相同身份相同输入返回原运行，不再推理；不同输入拒绝；
 * - 单会话最多一个 active turn；owner/global 有界并发与队列预算；
 * - 重启读取未结算回合并核对 adapter 回执；无法证明时按 D2 结算 failed，不自动重推理；
 * - 打开/关闭/查询只读，不重新 accept 或 dispatch。
 *
 * 本服务不写 Y.Doc、不复制 Task 事实源；领域回执按 adapter discriminant 原样保存与投影。
 */
import type {
  AgentAdapterRunOutcome,
  AgentConnectionBinding,
  AgentConversationAdapterEvent,
    AgentEntryIntent,
  AgentRoleChannelCapabilities,
  AgentRoleDescriptor,
  AgentRoleRef,
  AgentTargetSnapshot,
  ConversationEventType,
  ConversationSnapshot,
  ConversationSummary,
  ConversationTurn,
  ConversationTurnStatus,
  AgentCatalogSnapshot,
  AgentAdapterAuthState,
  AgentAdapterCapabilities,
  PreparedAgentRoleTurn
} from "@woohaa3/contracts";
import {
  agentRoleRefEquals,
  decodePreparedAgentRoleTurn,
  decodeAgentRoleDefinition,
  reasoningCapabilityOf,
  UNCONFIRMED_RESULT_ERROR_CODE,
  UNCONFIRMED_RESULT_MESSAGE,
  UNCONFIRMED_WRITE_ERROR_CODE,
  UNCONFIRMED_WRITE_MESSAGE
} from "@woohaa3/contracts";
import { randomUUID } from "node:crypto";
import type {
  AgentConversationStore,
  ConversationAdapterBinding,
  ConversationTurnRecord,
  TurnAuthorityRecord
} from "../repository/agent-conversation-repository.js";
import { isTerminalTurnStatus } from "../repository/agent-conversation-repository.js";
import type { AgentAdapterRegistry } from "../extensions/agent-adapter-registry.js";
import type { AgentConnectionRegistry } from "../extensions/agent-connection-registry.js";
import type { AgentRoleRegistry } from "../agent-roles/registry.js";
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
  store: AgentConversationStore;
  registry: AgentAdapterRegistry;
  /**
   * 连接发现注册表（change: 2026-10-16-...，任务 2.1/2.3）。
   *
   * 新调用必须显式选择已登记的连接。
   */
  connections?: AgentConnectionRegistry;
  /**
   * 角色注册表（change: 2026-11-07-add-pluggable-agent-roles）。
   *
   * 注入后，新回合必须显式选择已注册角色；缺失时不回退执行通道里的旧业务模板。
   */
  agentRoles?: AgentRoleRegistry;
  /**
   * 权威角色上下文（只由受信宿主按 owner/画布/目标准备；浏览器不可达）。
   */
  roleContextFor?: (input: {
    owner: string;
    canvasId: string;
    nodeId?: string;
    action: string;
    mode?: string;
    roleId: string;
  }) => Promise<unknown> | unknown;
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
  /** Supervisor 模式下暂时没有回执时保持活动态等待重新 attach，由重连预算结束时结算失败。 */
  preserveUnreconciledOnRestart?: boolean;
  /**
   * Host-only terminal hook. Called after the durable turn status is written, so
   * the canvas authority can confirm an exact stopped execution against the real
   * application ledger. It never re-dispatches work.
   */
  onTurnSettled?: (input: {
    turn: {
      turnId: string;
      conversationId: string;
      owner: string;
      canvasId: string;
      requestId: string;
      action: string;
    };
    status: ConversationTurnStatus;
  }) => void;
};

/**
 * 可证明的失败码：权限、连接、冲突等明确事实。
 *
 * 这类失败不是「回执丢失」，重试时必须原样呈现，不能被 `result-unconfirmed` / `write-unconfirmed`
 * 掩盖；已失败回合也可以用它细化错误（状态仍保持 failed）。
 */
export const DEFINITE_FAILURE_ERROR_CODES: readonly string[] = [
  "content-conflict",
  "target-invalid",
  "unauthorized",
  "not-found",
  "connection-unavailable",
  "adapter-unavailable",
  "model-unavailable",
  "capability-unsupported",
  "assistant-required",
  "variant-unavailable",
  "budget-exceeded",
  "cancelled",
  "role-not-found",
  "role-unavailable",
  "role-version-conflict",
  "role-input-invalid",
  "role-context-invalid",
  "role-requirement-unsatisfied",
  "role-prepare-failed"
];

export function isDefiniteFailureCode(code: string | undefined): boolean {
  return code !== undefined && DEFINITE_FAILURE_ERROR_CODES.includes(code);
}

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
    | "active-turn"
    | "role-not-found"
    | "role-unavailable"
    | "role-version-conflict"
    | "role-input-invalid"
    | "role-context-invalid"
    | "role-requirement-unsatisfied"
    | "role-prepare-failed";
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
  createConversation(input: { contextKey?: string; owner: string; canvasId: string; adapterId?: string; title?: string; nodeId?: string; connectionId?: string }):
    | { ok: true; conversation: ConversationSummary }
    | { ok: false; error: AgentConversationServiceError };
  listConversations(input: { owner: string; canvasId: string; limit?: number }): ConversationSummary[];
  /**
   * 按生成目标节点查找该节点当前会话（一个节点复用一条；design D8）。
   *
   * 只读：只返回仍与节点关联的会话；`connectionId` 提供时只返回该来源连接下的会话
   * （change: 2026-10-16-...，任务 2.3）。无则 `conversation: null`（调用方据此新建）。
   */
  findConversationForTarget(input: { contextKey?: string; owner: string; canvasId: string; nodeId: string; connectionId?: string }):
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
  acceptTurn(input: {
    owner: string;
    conversationId: string;
    requestId: string;
    entry: AgentEntryIntent;
    connection?: AgentConnectionBinding | null;
    /**
     * 受信领域入口直接提供的角色输入/上下文（扩展 facade 使用）。
     *
     * 只在进程内出现；浏览器请求没有该通道，HTTP 解码器也不接受。提供时在**受理时**同步
     * prepare 并冻结，dispatch 直接复用。
     */
    trustedRole?: { input: unknown; context: unknown };
  }): AcceptTurnResult;
  /**
   * 解析本回合要冻结的连接身份（change: 2026-10-16-...，任务 2.2/2.3）。
   *
   * 显式选择必须经连接注册表校验属于该 owner；缺失时拒绝。API 在接受回合前调用，
   * 把结果作为 `connection` 传入 `acceptTurn`（保持后者同步，便于复用/测试）。
   *
   * `upgradedFrom` 只在本次解析触发执行器版本迁移时出现，记录迁移前身份；调用方据此
   * 接受「在自动升级前冻结」的选择，同时仍用迁移后身份冻结本回合。
   */
  resolveConnectionBinding(input: { owner: string; adapterId: string; connectionId?: string; model?: string; reasoningEffort?: string }):
    Promise<{ ok: true; binding: AgentConnectionBinding | null; upgradedFrom?: AgentConnectionBinding } | { ok: false; error: AgentConversationServiceError }>;
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
  catalog(input: { owner: string; adapterId?: string }): Promise<{ ok: true; models: AgentCatalogSnapshot["models"]; capabilityRevision?: string; error?: string; authState: AgentAdapterAuthState; capabilities: AgentAdapterCapabilities } | { ok: false; error: AgentConversationServiceError }>;
  /**
   * 只读角色目录与能力匹配投影（change: 2026-11-07-add-pluggable-agent-roles）。
   *
   * 只解析 adapter 能力并读注册表；不准备、不推理、不签发授权。
   */
  listRoles(input: { owner: string; adapterId?: string }):
    | { ok: true; roles: readonly AgentRoleDescriptor[] }
    | { ok: false; error: AgentConversationServiceError };
  /**
   * 角色插件停用/升级时精确收回活动回合（不删除历史，不影响其他角色/连接）。
   */
  onRoleRevoked(namespacedId: string): void;
  /**
   * 记录领域入口准备的规范回合（delivery 路径）：冻结角色身份必须与受理时一致。
   * 只写 prepared 摘要，不重新准备或推理。
   */
  recordPrepared(input: { owner: string; requestId: string; prepared: PreparedAgentRoleTurn }):
    | { ok: true }
    | { ok: false; error: AgentConversationServiceError };
  /** 重启恢复：接管仍在执行器 journal 中的回合；无法证明时按原身份核对回执或结算 failed。 */
  reconcileUnknown(): Promise<ConversationTurnRecord[]>;
  /**
   * 按回合身份接管单个未结算回合（宿主启动核对与桥按需重建共用）。
   *
   * 返回 `true` 表示该回合已被本宿主接管或已终态；`false` 表示当前通道没有接管能力，
   * 调用方应退回只读查询语义。
   */
  adoptTurn(turnId: string): Promise<boolean>;
  /** 持久回合授权（桥按 turnId 校验 lease；不暴露给浏览器）。 */
  turnAuthority(turnId: string): TurnAuthorityRecord | undefined;
  /** 执行器派生 turnId 与账本 turnId 不同时，按 (owner, requestId) 回到同一份授权。 */
  turnAuthorityByRequest(owner: string, requestId: string): TurnAuthorityRecord | undefined;
  /** 记录通道实际声明的 host-call 方法；只增不减，不扩大工具/凭据范围。 */
  recordHostMethods(turnId: string, methods: readonly string[]): void;
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
  /** 活动回合的冻结角色（停用/升级时按角色精确取消）。 */
  const activeRoles = new Map<string, AgentRoleRef>();
  let acceptingTrustedDelivery = false;
  let acceptingStructuredHash: string | undefined;
  const connections = options.connections;

  const fail = (code: AgentConversationServiceError["code"], message: string): { ok: false; error: AgentConversationServiceError } => ({ ok: false, error: { code, message } });

  /** 本宿主实例（接管 CAS 的 owner）；进程重启即变化，租约随之失效。 */
  const hostId = randomUUID();
  const adoptionLeaseMs = 30_000;

  const resolveAdapter = (adapterId: string | undefined) => registry.resolve(adapterId);

  /**
   * 新调用必须显式选择归属于当前 owner 的连接。
   *
   * 执行器版本升级会在解析时迁移连接并推进 `configRevision`。先读取迁移前身份，
   * 让调用方可以接受「恰好在本次自动升级前冻结」的选择：否则请求自己触发升级，
   * 又以升级后的版本不一致为由拒绝，用户只能反复重选。
   */
  const resolveTurnConnection = async (
    owner: string,
    adapterId: string,
    requestedId: string | undefined,
    reasoning?: { model?: string; effort?: string }
  ): Promise<{ ok: true; binding: AgentConnectionBinding | null; upgradedFrom?: AgentConnectionBinding } | { ok: false; error: { code: AgentConversationServiceError["code"]; message: string } }> => {
    if (requestedId) {
      if (!connections) return { ok: false, error: { code: "connection-unavailable", message: "连接服务未配置" } };
      const before = await connections.getConnection({ owner, connectionId: requestedId });
      try {
        await connections.migrateConnection?.({ owner, connectionId: requestedId, beforeMigration: () => store.prepareConnectionMigration?.(owner, requestedId) ?? false });
      } catch { return { ok: false, error: { code: "connection-unavailable", message: "连接执行版本升级未完成；请先核对活动或未知回合再重试" } }; }
      const view = await connections.getConnection({ owner, connectionId: requestedId });
      if (!view) return { ok: false, error: { code: "connection-unavailable", message: "连接不存在或无权访问" } };
      if (view.adapterId !== adapterId) return { ok: false, error: { code: "connection-unavailable", message: "连接与来源不一致" } };
      if (reasoning?.effort) {
        const model = reasoning.model ? view.models.find((candidate) => candidate.id === reasoning.model) : undefined;
        const capability = model ? reasoningCapabilityOf(model) : undefined;
        if (!capability || capability.state !== "supported" || !(capability.efforts ?? []).some((option) => option.id === reasoning.effort)) {
          return { ok: false, error: { code: "capability-unsupported", message: "当前模型未开放此思考强度，请清除强度或重新选择模型" } };
        }
      }
      const binding = {
        connectionId: view.connectionId,
        adapterId: view.adapterId,
        configRevision: view.configRevision,
        credentialEpoch: view.credentialEpoch,
        ...(view.capabilityRevision ? { capabilityRevision: view.capabilityRevision } : {})
      };
      const upgradedFrom = before && before.connectionId === view.connectionId && before.adapterId === view.adapterId
        && (before.configRevision !== view.configRevision || before.credentialEpoch !== view.credentialEpoch)
        ? { connectionId: before.connectionId, adapterId: before.adapterId, configRevision: before.configRevision, credentialEpoch: before.credentialEpoch, ...(before.capabilityRevision ? { capabilityRevision: before.capabilityRevision } : {}) }
        : undefined;
      return { ok: true, binding, ...(upgradedFrom ? { upgradedFrom } : {}) };
    }
    return { ok: false, error: { code: "connection-unavailable", message: "请求必须明确选择助手连接" } };
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
    delivery?: Parameters<AgentConversationService["dispatchDeliveryTurn"]>[1], candidate?: StructuredCandidate,
    adoption?: { cursor: number | "head" }): Promise<void> => {
    const resolved = resolveAdapter(undefined);
    // adapter 可能与创建时不同（扩展升级）；用会话绑定的 adapterId 再解析一次。
    const binding = store.getConversation(turn.conversationId);
    const bound = binding ? registry.resolve(binding.adapterId) : resolved;
    if (!bound.ok) {
      finishTurn(turn, { status: "failed", error: { code: "adapter-unavailable", message: bound.message } });
      return;
    }
    // 角色准备先于推理：required 缺失或 input/context 非法时直接失败，不调用模型。
    let prepared: PreparedAgentRoleTurn | undefined;
    const frozenForDispatch = frozenRole(turn);
    if (delivery) {
      const registration = frozenForDispatch ? options.agentRoles?.resolve(frozenForDispatch.namespacedId) : null;
      if (frozenForDispatch && (!registration || !agentRoleRefEquals(registration.ref, frozenForDispatch))) {
        finishTurn(turn, {
          status: "failed",
          error: { code: "role-version-conflict", message: "角色实现已停用或升级，本回合不再接受新的执行；历史仍可查询" }
        });
        return;
      }
    } else if (adoption) {
      // 接管不重新准备角色：只复用受理时冻结的结果；没有冻结结果的旧回合由通道返回 null，
      // 走「不可证明」路径，不按新模板重算。
      prepared = frozenPrepared(turn);
    } else {
      const rolePrepared = await prepareFrozenRole(turn, entry, bound.handle.capabilities);
      if (!rolePrepared.ok) {
        finishTurn(turn, { status: "failed", error: { code: rolePrepared.code, message: rolePrepared.message } });
        return;
      }
      prepared = rolePrepared.prepared;
    }

    // 回合授权（任务 2.1/2.3）：在调用通道前持久冻结 owner/连接版本/目标/方法/工具范围，
    // 新宿主只按这份记录授权，不扩大原回合权限。
    store.recordTurnAuthority({
      turnId: turn.turnId,
      requestId: turn.requestId,
      conversationId: turn.conversationId,
      owner: turn.owner,
      canvasId: turn.canvasId,
      action: turn.action,
      adapterId: bound.handle.adapter.id,
      executor: bound.handle.adapter.runtimeExecutor ?? null,
      connectionId: turn.connectionId,
      configRevision: turn.connectionConfigRevision,
      credentialEpoch: turn.connectionCredentialEpoch,
      targetJson: turn.targetJson,
      preparedHash: prepared?.preparedHash ?? null,
      hostMethods: [],
      toolScope: [...(prepared?.tools ?? [])],
      createdAt: now(),
      expiresAt: null,
      revokedAt: null
    });

    const controller = new AbortController();
    controllers.set(turn.turnId, controller);
    const frozenForRun = frozenRole(turn);
    if (frozenForRun) activeRoles.set(turn.turnId, frozenForRun);
    store.updateTurn(turn.turnId, { status: "running", stage: "running" }, now());
    if (!adoption) appendEvent(turn.conversationId, turn.turnId, turn.requestId, "stage", { stage: "running" });

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
      recordAssistantText: (messageId, text) => assistantDigest.record(messageId, text)
    });
    let acceptingEvents = true;
    const emittedFingerprints = new Set<string>();
    const emit = (event: AgentConversationAdapterEvent): void => {
      if (!acceptingEvents) return;
      // 接管重放可能没有稳定 cursor：按内容指纹去重，绝不重复写消息/阶段。
      if (adoption) {
        const fingerprint = JSON.stringify(event);
        if (emittedFingerprints.has(fingerprint)) return;
        emittedFingerprints.add(fingerprint);
      }
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
    const emitExecutor = (cursor: number, event: AgentConversationAdapterEvent): void => {
      // `(turnId, cursor)` 幂等：重复接管/重放不重复落库；cursor 只前进。
      if (!store.consumeExecutorEvent(turn.turnId, cursor)) return;
      store.updateTurn(turn.turnId, { executorCursor: cursor }, now());
      emit(event);
    };
    const adapterInput = {
      owner: turn.owner,
      canvasId: turn.canvasId,
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      requestId: turn.requestId,
      intent: entry,
      ...(prepared ? { prepared } : {}),
      ...(candidate ? { candidate } : {}),
      ...(turnConnection(turn) ? { connection: turnConnection(turn)! } : {}),
      history,
      signal: controller.signal,
      emit,
      emitExecutor,
      ...(adoption ? { resumeCursor: adoption.cursor } : {})
    };
    let outcome: AgentAdapterRunOutcome | null;
    try {
      outcome = delivery
        ? await delivery({ signal: controller.signal, emit, history })
        : adoption && bound.handle.adapter.resume
          ? await bound.handle.adapter.resume(adapterInput)
          : await bound.handle.adapter.run(adapterInput);
    } catch (error) {
      outcome = { status: controller.signal.aborted ? "cancelled" : "failed", error: { code: controller.signal.aborted ? "cancelled" : "adapter-error", message: error instanceof Error ? error.message : String(error) } };
    } finally {
      acceptingEvents = false;
      controllers.delete(turn.turnId);
      activeRoles.delete(turn.turnId);
    }
    // 回合结束：结算仍在增长的助手消息（否则它的完成事件/摘要不会落库）。
    stream.flush();
    if (outcome === null) {
      settleFailed(turn, "journal-missing");
      return;
    }
    finishTurn(turn, outcome, assistantDigest);
  };

  /**
   * 接管单个回合（启动核对与桥按需重建共用）。
   *
   * 返回 `false` 表示通道没有接管能力（调用方退回只读查询）；`true` 表示已接管、已有终态，
   * 或另一宿主持有未过期租约（只读，不产生重复事件/结算）。
   */
  const adopt = async (turn: ConversationTurnRecord): Promise<boolean> => {
    const binding = store.getConversation(turn.conversationId);
    const bound = registry.resolve(binding?.adapterId);
    if (!bound.ok || !bound.handle.adapter.resume) return false;
    const leaseUntil = Date.now() + adoptionLeaseMs;
    if (!store.claimAdoption(turn.turnId, hostId, leaseUntil, now())) {
      log({ event: "agent-conversation-adoption-skipped", turnId: turn.turnId, reason: "lease-held" });
      return true;
    }
    const heartbeat = setInterval(() => {
      if (!store.renewAdoption(turn.turnId, hostId, Date.now() + adoptionLeaseMs)) clearInterval(heartbeat);
    }, Math.floor(adoptionLeaseMs / 3));
    heartbeat.unref?.();
    try {
      const cursor = turn.executorCursor ?? "head";
      if (turn.executorCursor === null) {
        // 升级前没有 cursor 的旧回合：从当前 journal 头开始，避免全量重放历史消息。
        appendEvent(turn.conversationId, turn.turnId, turn.requestId, "recovered", { reason: "host-restart", from: "head" });
      }
      await runTurn(turn, entryFromTurn(turn), undefined, undefined, { cursor });
      log({ event: "agent-conversation-adopted", turnId: turn.turnId, cursor });
      return true;
    } catch (error) {
      log({ event: "agent-conversation-adoption-failed", turnId: turn.turnId, message: error instanceof Error ? error.message : String(error) });
      settleFailed(turn, "adoption-failed");
      return true;
    } finally {
      clearInterval(heartbeat);
      store.releaseAdoption(turn.turnId, hostId);
    }
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

  /** 助手正文只写一次：终态细化/重试复用同一回合时按内容去重。 */
  const hasAssistantMessage = (turn: ConversationTurnRecord, content: string): boolean =>
    store.listMessages(turn.conversationId, 5_000).some((message) => message.turnId === turn.turnId && message.role === "assistant" && message.content === content);

  const finishTurn = (
    turn: ConversationTurnRecord,
    outcome: AgentAdapterRunOutcome,
    assistantDigest?: ReturnType<typeof createAssistantMessageDigest>,
    settleOptions: { allowTerminal?: boolean } = {}
  ): void => {
    if (turn.action !== "discuss" && outcome.status === "succeeded" && outcome.receipt === undefined && !outcome.runId && !outcome.taskId) {
      outcome = { ...outcome, status: "failed", error: { code: UNCONFIRMED_WRITE_ERROR_CODE, message: UNCONFIRMED_WRITE_MESSAGE } };
    }
    // Serialized model tool syntax is plain text, never evidence of an executed tool.
    if (turn.action === "discuss" && outcome.status === "succeeded" && /<｜{1,2}DSML｜{1,2}\s*(?:calls|invoke)\b/.test(outcome.assistantText ?? "")) {
      outcome = { ...outcome, status: "failed", error: { code: "tool-call-not-executed", message: "助手返回了未执行的工具调用文本，本轮没有修改作品。请在当前作品侧栏重新发送修改要求。" } };
    }
    const status = outcome.status;
    // 终态只结算一次：条件更新失败说明另一宿主/另一路径已结算，不再追加消息或事件。
    // delivery 的权威回执细化（失败码补充、文本候选保存成功）显式允许改写已结算回合。
    const settled = settleOptions.allowTerminal ? (store.updateTurn(turn.turnId, {
      status,
      stage: status,
      ...(outcome.assistantText !== undefined ? { assistantText: outcome.assistantText } : {}),
      ...(outcome.runId !== undefined ? { runId: outcome.runId } : {}),
      ...(outcome.taskId !== undefined ? { taskId: outcome.taskId } : {}),
      ...(outcome.receipt !== undefined ? { receiptJson: safeJson(outcome.receipt) } : {}),
      ...(outcome.reasoning !== undefined ? { reasoningJson: safeJson(outcome.reasoning) } : {}),
      ...(outcome.error !== undefined ? { errorCode: outcome.error.code, errorMessage: outcome.error.message } : {})
    }, now()), true) : store.updateTurnIfActive(
      turn.turnId,
      {
        status,
        stage: status,
        ...(outcome.assistantText !== undefined ? { assistantText: outcome.assistantText } : {}),
        ...(outcome.runId !== undefined ? { runId: outcome.runId } : {}),
        ...(outcome.taskId !== undefined ? { taskId: outcome.taskId } : {}),
        ...(outcome.receipt !== undefined ? { receiptJson: safeJson(outcome.receipt) } : {}),
        ...(outcome.reasoning !== undefined ? { reasoningJson: safeJson(outcome.reasoning) } : {}),
        ...(outcome.error !== undefined ? { errorCode: outcome.error.code, errorMessage: outcome.error.message } : {})
      },
      now()
    );
    if (!settled) {
      log({ event: "agent-conversation-settle-skipped", turnId: turn.turnId, requestId: turn.requestId, status });
      return;
    }
    store.clearExecutorEvents?.(turn.turnId);
    // 失败/取消后不再接受该回合的 host-call（用户停止、运行时停止、扩展停用共用）。
    if (status === "cancelled" || status === "failed") store.revokeTurnAuthority(turn.turnId, now());
    if (outcome.assistantText && outcome.assistantText.trim() !== "") {
      if (!assistantDigest?.matches(outcome.assistantText) && !hasAssistantMessage(turn, outcome.assistantText)) {
        appendMessage(turn, "assistant", outcome.assistantText);
      }
    }
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
    try {
      options.onTurnSettled?.({
        turn: {
          turnId: turn.turnId,
          conversationId: turn.conversationId,
          owner: turn.owner,
          canvasId: turn.canvasId,
          requestId: turn.requestId,
          action: turn.action
        },
        status
      });
    } catch (error) {
      log({ event: "agent-conversation-settled-hook-failed", requestId: turn.requestId, message: error instanceof Error ? error.message : String(error) });
    }
  };

  /**
   * D2 兜底：无法证明结果时结算 failed。Supervisor 重连预算内保持活动态（不制造用户可见
   * 待核对状态）；预算结束后由下一次核对调用走同一失败结算。
   */
  const settleFailed = (turn: ConversationTurnRecord, reason: string): void => {
    if (options.preserveUnreconciledOnRestart && reason !== "journal-missing") {
      store.updateTurn(turn.turnId, {
        errorCode: "runtime-reconnecting",
        errorMessage: "Agent 运行时正在重新连接，结果尚未确认"
      }, now());
      appendEvent(turn.conversationId, turn.turnId, turn.requestId, "error", { status: turn.status, code: "runtime-reconnecting", reason });
      return;
    }
    log({ event: "agent-conversation-unconfirmed", turnId: turn.turnId, reason });
    finishTurn(turn, {
      status: "failed",
      error: { code: UNCONFIRMED_RESULT_ERROR_CODE, message: UNCONFIRMED_RESULT_MESSAGE }
    });
  };

  /** 执行通道真实能力 → 角色匹配输入（不从角色或不存在的旧授权推导）。 */
  const channelCapabilities = (capabilities: AgentAdapterCapabilities): AgentRoleChannelCapabilities => ({
    toolCalling: capabilities.tools,
    imageInput: capabilities.candidateGeneration?.imageInput ?? capabilities.textDelivery?.imageInput ?? false,
    structuredOutput: capabilities.candidateGeneration
      ? "validated-json"
      : capabilities.textDelivery
        ? "validated-json"
        : "none",
    nativeCapabilities: [...(capabilities.nativeCapabilities ?? [])]
  });

  /** 角色输入只含用户输入与动作；业务变体在 inputSchema 里表达。 */
  const roleInput = (entry: AgentEntryIntent): unknown => ({
    prompt: entry.prompt,
    action: entry.action,
    ...(entry.mode !== undefined ? { mode: entry.mode } : {})
  });

  const roleTarget = (turn: ConversationTurnRecord): import("@woohaa3/contracts").AgentRoleTargetRef => {
    const target = JSON.parse(turn.targetJson) as AgentTargetSnapshot;
    return {
      canvasId: turn.canvasId,
      ...(target.nodeId !== undefined ? { nodeId: target.nodeId } : {}),
      ...(target.mode !== undefined ? { mode: target.mode } : {}),
      ...(target.cameraId !== undefined ? { cameraId: target.cameraId } : {}),
      ...(target.worldScope?.kind === "scene-area" ? { allowSceneAreaExpansion: target.allowSceneAreaExpansion === true } : {}),
      ...(target.worldScope ? {
        worldScope: target.worldScope.kind === "scene-area"
          ? { kind: "scene-area" as const, areaId: target.worldScope.areaId }
          : { kind: "world-camera" as const, cameraId: target.worldScope.cameraId }
      } : {})
    };
  };

  const frozenRole = (turn: ConversationTurnRecord): AgentRoleRef | null => {
    if (!turn.roleRefJson) return null;
    try { return JSON.parse(turn.roleRefJson) as AgentRoleRef; } catch { return null; }
  };

  /** 已冻结的准备结果（接管复用；不按当前模板重新准备）。 */
  const frozenPrepared = (turn: ConversationTurnRecord): PreparedAgentRoleTurn | undefined => {
    if (!turn.preparedJson) return undefined;
    try {
      const decoded = decodePreparedAgentRoleTurn(JSON.parse(turn.preparedJson) as unknown);
      return decoded.ok ? decoded.value : undefined;
    } catch { return undefined; }
  };

  /**
   * 受理时解析角色：只做注册/可用性判定（同步），上下文校验与 prepare 在 dispatch 前完成。
   */
  const resolveRoleForAccept = (
    entry: AgentEntryIntent,
    capabilities: AgentAdapterCapabilities
  ): { ok: true; ref?: AgentRoleRef } | { ok: false; error: AgentConversationServiceError } => {
    // 所有新调用必须通过角色注册表；独立组合也不提供旧入口。
    if (!options.agentRoles) return { ok: false, error: { code: "role-unavailable", message: "宿主未启用 Agent 角色注册表" } };
    if (!entry.roleId) return { ok: false, error: { code: "role-not-found", message: "请求没有选择明确角色；核心不按模式或连接猜角色" } };
    const role = options.agentRoles.resolve(entry.roleId);
    if (!role) return { ok: false, error: { code: "role-not-found", message: `角色不存在或未启用：${entry.roleId}` } };
    const availability = options.agentRoles.availability(entry.roleId, channelCapabilities(capabilities));
    if (!availability.available) {
      const code = availability.missing && availability.missing.length > 0
        ? "role-requirement-unsatisfied"
        : "role-unavailable";
      return { ok: false, error: { code, message: availability.reason ?? "角色不可用" } };
    }
    return { ok: true, ref: role.ref };
  };

  /**
   * dispatch 前准备冻结角色。required 缺失或 input/context 非法时**不调用模型**。
   * 已准备并冻结的回合直接复用（重传/重启不重新准备）。
   */
  const prepareFrozenRole = async (
    turn: ConversationTurnRecord,
    entry: AgentEntryIntent,
    capabilities: AgentAdapterCapabilities
  ): Promise<{ ok: true; prepared: PreparedAgentRoleTurn } | { ok: false; code: string; message: string }> => {
    const frozen = frozenRole(turn);
    if (!frozen) return { ok: false, code: "role-not-found", message: "该回合没有冻结角色身份" };
    if (turn.preparedJson) {
      const decoded = decodePreparedAgentRoleTurn(JSON.parse(turn.preparedJson) as unknown);
      if (decoded.ok && agentRoleRefEquals(decoded.value.roleRef, frozen)) return { ok: true, prepared: decoded.value };
      return { ok: false, code: "role-version-conflict", message: "冻结的角色准备内容不可用，请以新请求重新生成" };
    }
    const registry = options.agentRoles;
    if (!registry) return { ok: false, code: "role-unavailable", message: "宿主未启用 Agent 角色注册表" };
    const registration = registry.resolve(frozen.namespacedId);
    if (!registration) return { ok: false, code: "role-unavailable", message: `角色实现已停用：${frozen.namespacedId}` };
    // 角色升级后不得用新模板重算旧请求：冻结修订必须仍与当前实现一致。
    if (!agentRoleRefEquals(registration.ref, frozen)) {
      return { ok: false, code: "role-version-conflict", message: "角色已被升级，请用新请求重新生成；本回合保留原记录" };
    }
    const definition = decodeAgentRoleDefinition(registration.definition);
    if (!definition.ok) return { ok: false, code: "role-unavailable", message: "角色定义不可用" };
    let context: unknown = {};
    try {
      context = (await options.roleContextFor?.({
        owner: turn.owner,
        canvasId: turn.canvasId,
        ...(entry.nodeId !== undefined ? { nodeId: entry.nodeId } : {}),
        action: entry.action,
        ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
        roleId: frozen.namespacedId
      })) ?? {};
    } catch (error) {
      return { ok: false, code: "role-context-invalid", message: `角色上下文准备失败：${error instanceof Error ? error.message : String(error)}` };
    }
    const prepared = registry.prepare({
      roleId: frozen.namespacedId,
      input: roleInput(entry),
      context,
      target: roleTarget(turn),
      requestId: turn.requestId,
      ...(JSON.parse(turn.targetJson) as AgentTargetSnapshot).expectedContentHash !== undefined
        ? { expectedContentHash: (JSON.parse(turn.targetJson) as AgentTargetSnapshot).expectedContentHash! }
        : {},
      channel: channelCapabilities(capabilities),
      attachments: (entry.references ?? []).map((reference) => ({ kind: reference.kind, storageKey: reference.storageKey ?? null, nodeId: reference.nodeId ?? null, role: reference.role ?? null }))
    });
    if (!prepared.ok) return { ok: false, code: prepared.code, message: prepared.message };
    if (!agentRoleRefEquals(prepared.turn.roleRef, frozen)) {
      return { ok: false, code: "role-version-conflict", message: "角色准备结果与冻结身份不一致" };
    }
    store.updateTurn(turn.turnId, { preparedJson: safeJson(prepared.turn) }, now());
    return { ok: true, prepared: prepared.turn };
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
        ...(input.contextKey ? { contextKey: input.contextKey } : {}),
        now: timestamp
      });
      return { ok: true, conversation: toSummary(binding) };
    },

    listConversations(input) {
      return store.listConversations({ owner: input.owner, canvasId: input.canvasId }, input.limit ?? 50).map(toSummary);
    },

    findConversationForTarget(input) {
      const binding = store.findConversationByTarget({
        owner: input.owner,
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        ...(input.contextKey ? { contextKey: input.contextKey } : {}),
        ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId })
      });
      return { ok: true, conversation: binding ? toSummary(binding) : null };
    },

    clearContext(input) {
      if (!input.owner) return fail("unauthorized", "缺少可信用户主体");
      // change: 2026-10-22-remove-agent-execution-limits，任务 3.1/3.2 / design D3：
      // 删除「活动回合阻止清空」。清空只解除目标关联（归档会话），不删除回合/消息/回执，
      // 因此不会丢掉尚未结算的执行；后续只停止用户明确选择的 requestId。
      const cleared = store.clearTarget({ owner: input.owner, canvasId: input.canvasId, nodeId: input.nodeId });
      return { ok: true, cleared };
    },

    async switchConnection(input) {
      if (!input.owner) return fail("unauthorized", "缺少可信用户主体");
      // 先核对目标连接属于该 owner（跨 owner/未知连接拒绝，不静默降级）。
      if (connections) {
        const view = await connections.getConnection({ owner: input.owner, connectionId: input.connectionId });
        if (!view) return fail("connection-unavailable", "连接不存在或无权访问");
      }
      // 解除目标关联（归档旧会话，保留全部历史与未结算回合）；下一次提交按新连接建立新会话。
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
      return resolveTurnConnection(input.owner, input.adapterId, input.connectionId, {
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {})
      });
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
      // 已失败回合是终态，但允许用可证明的失败细化错误码（例如保存重试时连接已被撤销），
      // 让用户看到真实原因而不是停在「结果未确认」；状态与回执不被改写。
      const refinesFailure = record.status === "failed" &&
        input.outcome.status === "failed" &&
        isDefiniteFailureCode(input.outcome.error?.code);
      const settlesTerminalText = (input.delivery.purpose === "text-generation" || input.delivery.purpose === "image-director-scene") && input.outcome.status === "succeeded" && input.outcome.receipt !== undefined;
      if (!["queued", "running", "committing"].includes(record.status) && !refinesFailure && !settlesTerminalText) return;
      finishTurn(record, input.outcome, undefined, { allowTerminal: refinesFailure || settlesTerminalText });
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

      if (input.entry.allowSceneAreaExpansion !== undefined && (typeof input.entry.allowSceneAreaExpansion !== "boolean" || input.entry.mode !== "world" || input.entry.worldScope?.kind !== "scene-area")) return fail("malformed-request", "自动扩区选项仅适用于导演区目标");
      if (input.entry.mode === "text" && input.entry.action !== "discuss" && !acceptingTrustedDelivery) return fail("capability-unsupported", "文本生成必须经过可信文本交付入口");
      const inputHash = hashIntent(input.entry, input.connection ?? null)
        + (acceptingStructuredHash ? `:${acceptingStructuredHash}` : "")
        + (input.trustedRole ? `:${createHash("sha256").update(JSON.stringify(input.trustedRole.input ?? null)).digest("hex")}` : "");
      const existing = store.findTurnByRequest(input.owner, input.requestId);
      if (existing) {
        if (existing.conversationId !== binding.conversationId || existing.canvasId !== binding.canvasId) return fail("request-id-reused", "requestId 已绑定其它会话或画布");
        if (existing.inputHash !== inputHash) {
          // Old world turns predate scope in the hash. Accept their exact frozen
          // scope and default-false policy only; never upgrade an old grant.
          const target = JSON.parse(existing.targetJson) as AgentTargetSnapshot;
          const suffix = (acceptingStructuredHash ? `:${acceptingStructuredHash}` : "") + (input.trustedRole ? `:${createHash("sha256").update(JSON.stringify(input.trustedRole.input ?? null)).digest("hex")}` : "");
          const legacyHash = hashIntent({ ...input.entry, worldScope: undefined }, input.connection ?? null) + suffix;
          if (!input.entry.worldScope || input.entry.allowSceneAreaExpansion === true || stableStringify(target.worldScope) !== stableStringify(input.entry.worldScope) || existing.inputHash !== legacyHash) return fail("request-id-reused", "requestId 已用于不同输入");
        }
        // 相同身份相同输入：返回原运行，不重复推理/写入。
        return { ok: true, conversation: toSummary(binding), turn: toTurn(existing), reused: true };
      }

      // change: 2026-10-22-remove-agent-execution-limits，任务 3.1 / design D3：
      // 删除「单会话单活动回合」与 owner/global 活跃数量拒绝。每个 requestId 都有独立回合、
      // 取消身份与冻结历史基准；并发写由 Canvas 内容版本与事务决定，不用活动数门禁代替。
      const resolved = registry.resolve(binding.adapterId);
      if (!resolved.ok) return fail("adapter-unavailable", resolved.message);
      const capabilities = resolved.handle.capabilities;
      // 显式角色解析（change: 2026-11-07-add-pluggable-agent-roles）：核心不按 mode、
      // 显示名或连接猜业务职责；未选择角色即拒绝。
      const roleResolved = resolveRoleForAccept(input.entry, capabilities);
      if (!roleResolved.ok) return roleResolved;
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

      // 冻结本回合来源连接身份（design D7）：由 API 在接受前解析后传入；缺失时不可发起新的执行。
      const connection = input.connection ?? null;
      // 会话冻结的连接与本次请求不一致时拒绝（不静默换来源）。
      if (binding.connectionId && connection && binding.connectionId !== connection.connectionId) {
        return fail("connection-unavailable", "该会话已冻结其它来源连接，请先切换来源");
      }

      // 受信领域入口提供角色输入/上下文时在受理时同步准备并冻结。
      let trustedPrepared: PreparedAgentRoleTurn | undefined;
      let trustedRoleInputDigest: string | undefined;
      if (input.trustedRole && roleResolved.ref) {
        if (!options.agentRoles) return fail("role-unavailable", "宿主未启用 Agent 角色注册表");
        const targetRef: import("@woohaa3/contracts").AgentRoleTargetRef = {
          canvasId: input.entry.canvasId,
          ...(input.entry.nodeId !== undefined ? { nodeId: input.entry.nodeId } : {}),
          ...(input.entry.mode !== undefined ? { mode: input.entry.mode } : {})
        };
        const prepared = options.agentRoles.prepare({
          roleId: roleResolved.ref.namespacedId,
          input: input.trustedRole.input,
          context: input.trustedRole.context,
          target: targetRef,
          requestId: input.requestId,
          ...(input.entry.expectedContentHash !== undefined ? { expectedContentHash: input.entry.expectedContentHash } : {}),
          channel: channelCapabilities(capabilities),
          attachments: (input.entry.references ?? []).map((reference) => ({ kind: reference.kind, storageKey: reference.storageKey ?? null, nodeId: reference.nodeId ?? null, role: reference.role ?? null }))
        });
        if (!prepared.ok) {
          const code: AgentConversationServiceError["code"] = [
            "role-not-found",
            "role-unavailable",
            "role-version-conflict",
            "role-input-invalid",
            "role-context-invalid",
            "role-requirement-unsatisfied",
            "role-prepare-failed"
          ].includes(prepared.code)
            ? prepared.code as AgentConversationServiceError["code"]
            : "role-unavailable";
          return { ok: false, error: { code, message: prepared.message } };
        }
        if (!agentRoleRefEquals(prepared.turn.roleRef, roleResolved.ref)) {
          return fail("role-version-conflict", "角色准备结果与解析到的角色身份不一致");
        }
        trustedPrepared = prepared.turn;
        trustedRoleInputDigest = prepared.turn.inputDigest;
      }

      const turnId = createId("turn");
      const timestamp = now();
      const target: AgentTargetSnapshot = {
        ...(acceptingStructuredHash ? { structuredInputHash: acceptingStructuredHash } : {}),
        canvasId: binding.canvasId,
        ...(input.entry.nodeId !== undefined ? { nodeId: input.entry.nodeId } : {}),
        ...(input.entry.mode !== undefined ? { mode: input.entry.mode } : {}),
        ...(input.entry.worldScope !== undefined ? { worldScope: input.entry.worldScope } : {}),
        ...(input.entry.worldScope?.kind === "scene-area" && input.entry.mode === "world" ? { allowSceneAreaExpansion: input.entry.allowSceneAreaExpansion === true } : {}),
        ...(input.entry.cameraId !== undefined ? { cameraId: input.entry.cameraId } : {}),
        ...(input.entry.clipId !== undefined ? { clipId: input.entry.clipId } : {}),
        ...(input.entry.itemId !== undefined ? { itemId: input.entry.itemId } : {}),
        ...(input.entry.model !== undefined ? { model: input.entry.model } : {}),
        ...(input.entry.reasoningEffort !== undefined ? { reasoningEffort: input.entry.reasoningEffort } : {}),
        ...(connection?.capabilityRevision !== undefined ? { capabilityRevision: connection.capabilityRevision } : {}),
        ...(connection ? { connectionId: connection.connectionId } : {}),
        ...(input.entry.expectedContentHash !== undefined ? { expectedContentHash: input.entry.expectedContentHash } : {}),
        ...(roleResolved.ref ? { role: roleResolved.ref } : {})
      };
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
        connectionCapabilityRevision: connection?.capabilityRevision ?? null,
        ...(roleResolved.ref ? { roleRefJson: safeJson(roleResolved.ref) } : {}),
        ...(trustedPrepared ? { preparedJson: safeJson(trustedPrepared) } : {}),
        roleInputDigest: trustedRoleInputDigest ?? createHash("sha256").update(JSON.stringify(roleInput(input.entry))).digest("hex"),
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

    cancelTurn(input) {
      const record = store.findTurnByRequest(input.owner, input.requestId);
      if (!record) return fail("not-found", "未找到该请求");
      const controller = controllers.get(record.turnId);
      const binding = store.getConversation(record.conversationId);
      if (binding && !JSON.parse(record.targetJson).delivery) {
        const resolved = registry.resolve(binding.adapterId);
        if (resolved.ok && resolved.handle.adapter.cancel) {
          void Promise.resolve(resolved.handle.adapter.cancel({ owner: input.owner, requestId: input.requestId })).catch(() => undefined);
        }
      }
      controller?.abort();
      store.revokeTurnAuthority(record.turnId, now());
      // 宿主重启后没有在途控制器：活动回合按用户停止结算；旧 unknown 已由启动核对结算失败。
      if (!controller && ["queued", "running", "committing"].includes(record.status)) {
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
      return { ok: true, models: snapshot.models, ...(snapshot.capabilityRevision ? { capabilityRevision: snapshot.capabilityRevision } : {}), authState, capabilities, ...(error ? { error } : {}) };
    },

    listRoles(input) {
      if (!input.owner) return fail("unauthorized", "缺少可信用户主体");
      if (!options.agentRoles) return fail("role-unavailable", "宿主未启用 Agent 角色注册表");
      const resolved = resolveAdapter(input.adapterId);
      if (!resolved.ok) return fail("adapter-unavailable", resolved.message);
      const channel = channelCapabilities(resolved.handle.capabilities);
      const roles = options.agentRoles.list().map((descriptor) => {
        const availability = options.agentRoles!.availability(descriptor.ref.namespacedId, channel);
        // 公开目录只投影身份/专长/能力需求/可用原因；工具与内建能力清单留在宿主内部。
        const { tools: _tools, nativeCapabilities: _native, ...publicDescriptor } = descriptor;
        return {
          ...publicDescriptor,
          available: availability.available,
          ...(availability.reason ? { reason: availability.reason } : {})
        };
      });
      return { ok: true, roles };
    },

    recordPrepared(input) {
      const record = store.findTurnByRequest(input.owner, input.requestId);
      if (!record) return fail("not-found", "未找到该请求");
      const frozen = frozenRole(record);
      if (!frozen || !agentRoleRefEquals(frozen, input.prepared.roleRef)) {
        return fail("role-version-conflict", "准备结果与回合冻结的角色身份不一致");
      }
      store.updateTurn(record.turnId, { preparedJson: safeJson(input.prepared), roleInputDigest: input.prepared.inputDigest }, now());
      return { ok: true };
    },

    onRoleRevoked(namespacedId) {
      // 只取消冻结该角色的活动回合；无关角色与连接继续运行，历史不删除。
      for (const [turnId, ref] of [...activeRoles]) {
        if (ref.namespacedId !== namespacedId) continue;
        activeRoles.delete(turnId);
        controllers.get(turnId)?.abort();
        store.revokeTurnAuthority(turnId, now());
      }
    },

    /**
     * 能接管就接管（任务 3.2/3.3）。
     *
     * - 运行中且通道声明 `resume`：按确定性回合身份接回执行器 journal，从 cursor 继续；
     * - 终态：按事实结算一次（CAS 保证不重复）；
     * - 通道没有接管能力或 structured/delivery：沿用「查询一次 + 按回执结算」；
     * - journal 缺失/运行时不可达：按原身份核对领域回执，仍不能证明则结算 failed（不重跑）。
     */
    async reconcileUnknown() {
      const unsettled = store.listUnsettledTurns();
      const reconciled = new Set<string>();
      for (const turn of unsettled) {
        const target = JSON.parse(turn.targetJson) as { delivery?: unknown; structuredInputHash?: unknown };
        // Candidate delivery 的权威回执在领域侧：只核对，不接管执行。
        if (target.delivery) continue;
        // structured 输出的权威回执也在领域侧：不进入接管，走只读核对。
        if (!target.structuredInputHash && await adopt(turn)) { reconciled.add(turn.turnId); continue; }
        const resolved = registry.resolve(undefined);
        const binding = store.getConversation(turn.conversationId);
        const bound = binding ? registry.resolve(binding.adapterId) : resolved;
        const query = bound.ok ? bound.handle.adapter.query : undefined;
        if (!query) { settleFailed(turn, "query-unavailable"); continue; }
        reconciled.add(turn.turnId);
        try {
          const outcome = await query({ owner: turn.owner, requestId: turn.requestId });
          if (!outcome) { settleFailed(turn, "receipt-missing"); continue; }
          if (target.structuredInputHash) {
            // A completion without its structured text cannot be adopted as a design result.
            if (outcome.status !== "succeeded" || outcome.assistantText?.trim()) finishTurn(turn, outcome);
            else settleFailed(turn, "structured-text-missing");
            continue;
          }
          finishTurn(turn, outcome);
        } catch (error) {
          log({ event: "agent-conversation-reconcile-failed", turnId: turn.turnId, message: error instanceof Error ? error.message : String(error) });
          settleFailed(turn, "query-failed");
        }
      }
      if (unsettled.length > 0) log({ event: "agent-conversation-restart-reconciled", count: unsettled.length, reconciled: reconciled.size });
      return unsettled;
    },

    async adoptTurn(turnId) {
      const turn = store.getTurn(turnId);
      if (!turn || isTerminalTurnStatus(turn.status)) return true;
      return adopt(turn);
    },

    turnAuthority(turnId) {
      return store.getTurnAuthority(turnId);
    },

    turnAuthorityByRequest(owner, requestId) {
      return store.getTurnAuthorityByRequest(owner, requestId);
    },

    recordHostMethods(turnId, methods) {
      if (methods.length > 0) store.recordTurnAuthorityHostMethods(turnId, methods);
    },

    deleteAll(input) {
      store.deleteAll({ owner: input.owner, canvasId: input.canvasId });
    }
  };

  return service;
}

