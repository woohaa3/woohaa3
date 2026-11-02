import { isFilmSetGroupNode } from "@woohaa3/contracts";
/**
 * 统一生成运行状态 store
 * （change: 2026-10-12-unify-generation-history-strip，design D1/D2）。
 *
 * 合并两类 owner：
 * - **server**：来自 Task Activity 的活动快照（`CanvasTaskActivity`），按 `(canvasId,nodeId)`
 *   归约为运行摘要。任务状态仍以 canonical `nodeData` 为权威；本 store 只做展示投影。
 * - **local**：浏览器本地生成操作（截图/帧捕获/视频导出/本地编码）经 `beginLocalOperation`
 *   注册，终态由返回的 `finish` 结算。
 *
 * 纯逻辑、可重放：不依赖 React/远端实现；不写 canonical；迟到输入按身份幂等。
 *
 * 并发与顺序：每个操作独立记录，终态互相独立；`task.activity.finished` 的本地拒绝
 * （`local-rejection`）映射为 `failed(localFailure)`。同一 `(canvasId,nodeId)` 可有多个操作；
 * 门禁查询用 `isBusy`（任一非终态即忙），聚合遮罩用 `aggregateRunning`。
 */
import {
  normalizeFilmSetRunFeedback, readFilmSetConversionNodeStatus, isFilmSetNode,
  reportedProgressPercent,
  type ConversationTurn, type FilmSetConversionStatus,
  isActiveTaskState,
  type CanvasNodeRunSummary,
  type CanvasOperationKind,
  type CanvasOperationRecord,
  type CanvasOperationState,
  type CanvasTaskActivity,
  type CanvasTaskModelType
} from "@woohaa3/contracts";
import {
  isAggregateRunNode,
  summarizeNodeRunState
} from "@woohaa3/contracts";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import type {
  TaskActivityFinished,
  TaskActivityStarted,
  TaskActivityUpdated
} from "../../events/task-activity.js";
import { isLocalRejection } from "../../events/task-activity.js";
import { AGENT_TURN_OPERATION_PREFIX } from "./agent-turn-projection.js";

/** 操作身份（内部）：canvasId + nodeId + operationId。 */
type OpKey = string;

export type RunStateSnapshot = {
  canvasId: string;
  records: CanvasOperationRecord[];
  summaries: Map<string, CanvasNodeRunSummary>;
};

export type RunStateStoreOptions = {
  canvasId: string;
  now?: () => number;
  /** 聚合节点判定（缺省用契约谓词；测试可注入）。 */
  isAggregateNode?: (node: { type: string }) => boolean;
  /**
   * 节点类型解析器：local/server 记录要判定聚合性需知道节点类型；缺失时回退非聚合。
   * page scope 从 working canvas 读取。
   */
  nodeTypeOf?: (nodeId: string) => string | undefined;
};

export class RunStateStore {
  private readonly canvasId: string;
  private readonly now: () => number;
  private readonly isAggregate: (node: { type: string }) => boolean;
  private nodeTypeOf: (nodeId: string) => string | undefined;
  /** 操作记录按 opKey 索引；保持插入顺序。 */
  private readonly records = new Map<OpKey, CanvasOperationRecord>();
  /**
   * 每条记录**最后一次由服务端活动提供**的 `updatedAt`（opKey → ISO）。
   *
   * 乱序保护只能比较服务端时间：`reconcileCanonical` 会先用本地时钟造占位记录，若拿它的
   * `updatedAt`（本地 now）去比较，第一条真正的活动更新就会被判成"迟到"而丢弃 —— 节点既拿不到
   * 上报进度，也拿不到真实开始时刻，只能按本地时钟从 0 估算，与活动面板长期不一致
   * （change: 2026-10-31-unify-node-and-activity-progress）。
   */
  private readonly serverUpdatedAt = new Map<OpKey, string>();
  /** optimistic started 的本地元数据（taskKey -> operationId 映射由 runId 承担）。 */
  private readonly listeners = new Set<() => void>();
  private snapshot: RunStateSnapshot = { canvasId: "", records: [], summaries: new Map() };
  private disposed = false;
  private filmCanvas: { document: { nodes: readonly { id: string }[] }; nodeData: Record<string, unknown> } | null = null;
  private filmTurns = new Map<string, ConversationTurn>();
  private filmPending: Readonly<Record<string, import("@woohaa3/contracts").AgentEntryIntent>> = {};
  private filmConversions = new Map<string, FilmSetConversionStatus>();

  syncFilmSetTurns(turns: readonly ConversationTurn[], pending: typeof this.filmPending = {}): void {
    if (this.disposed) return;
    this.filmPending = pending;
    for (const turn of turns) {
      if (turn.target.canvasId !== this.canvasId || turn.target.mode !== "film-set") continue;
      const previous = this.filmTurns.get(turn.requestId);
      const settled = (t: ConversationTurn) => ["succeeded", "failed", "cancelled", "partial"].includes(t.status);
      if (previous && (settled(previous) || previous.updatedAt > turn.updatedAt)) continue;
      this.filmTurns.set(turn.requestId, turn);
    }
    const settled = [...this.filmTurns.values()].filter(t => !["queued", "running", "committing", "unknown"].includes(t.status));
    for (const turn of settled.slice(0, Math.max(0, settled.length - 256))) this.filmTurns.delete(turn.requestId);
    this.publish();
  }

  constructor(options: RunStateStoreOptions) {
    this.canvasId = options.canvasId;
    this.now = options.now ?? (() => Date.now());
    this.isAggregate = options.isAggregateNode ?? ((node) => isAggregateRunNode(node));
    this.nodeTypeOf = options.nodeTypeOf ?? (() => undefined);
    this.snapshot = { canvasId: this.canvasId, records: [], summaries: new Map() };
  }

  getSnapshot = (): RunStateSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 更新节点类型解析器（canvas 变化或节点增删后由插件刷新）。 */
  setNodeTypeResolver(resolver: (nodeId: string) => string | undefined): void {
    this.nodeTypeOf = resolver;
  }

  getNodeSummary(nodeId: string): CanvasNodeRunSummary | null {
    return this.snapshot.summaries.get(nodeId) ?? null;
  }

  isBusy(nodeId: string): boolean {
    return this.getNodeSummary(nodeId)?.active != null;
  }

  /**
   * “当前生效版本”对应的操作身份映射（有界派生）
   * （change: 2026-10-12-unify-generation-history-strip，design D4）。
   *
   * 只用 working canvas 的 `nodeData.activeRunId` 与该节点已成功结算的服务端操作匹配；
   * 失败/取消记录永不成为当前；不读取完整历史，不本地猜测。
   */
  currentOperationIds(): Map<string, string> {
    const out = new Map<string, string>();
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    if (!canvas) return out;
    for (const node of canvas.document.nodes) {
      const data = canvas.nodeData[node.id] as { activeRunId?: unknown } | undefined;
      const activeRunId = typeof data?.activeRunId === "string" ? data.activeRunId : null;
      if (!activeRunId) continue;
      const record = this.records.get(opKey(this.canvasId, node.id, activeRunId));
      if (record?.state === "succeeded") out.set(node.id, activeRunId);
    }
    return out;
  }

  /** 统一事件入口（供 plugin listener 调用）。 */
  applyEvent(
    event:
      | { name: "task.activity.started"; payload: TaskActivityStarted }
      | { name: "task.activity.updated"; payload: TaskActivityUpdated }
      | { name: "task.activity.finished"; payload: TaskActivityFinished }
  ): void {
    if (this.disposed) return;
    switch (event.name) {
      case "task.activity.started":
        this.applyStarted(event.payload);
        return;
      case "task.activity.updated":
        this.applyServerActivity(event.payload.activity, event.payload.cursor);
        return;
      case "task.activity.finished":
        if (isLocalRejection(event.payload)) {
          this.applyLocalRejection(event.payload);
          return;
        }
        this.applyServerActivity(event.payload.activity, event.payload.cursor);
        return;
    }
  }

  /** 提交即出现的 optimistic 运行态（server owner）。 */
  applyStarted(input: TaskActivityStarted): void {
    if (this.disposed) return;
    const createdAt = input.createdAt || new Date(this.now()).toISOString();
    const key = opKey(this.canvasId, input.nodeId, input.runId);
    const existing = this.records.get(key);
    const kind = operationKindForModelType(input.modelType);
    if (existing) {
      return;
    }
    this.records.set(key, {
      operationId: input.runId,
      canvasId: this.canvasId,
      nodeId: input.nodeId,
      kind,
      state: "queued",
      owner: "server",
      createdAt,
      updatedAt: createdAt
    });
    this.publish();
  }

  /** 权威非终态/终态活动（server owner）。 */
  applyServerActivity(activity: CanvasTaskActivity, _cursor: number): void {
    if (this.disposed) return;
    if (!activity.runId || !activity.nodeId) return;
    const key = opKey(this.canvasId, activity.nodeId, activity.runId);
    const existing = this.records.get(key);
    const state = serverState(activity.state);
    if (existing && existing.state !== "queued" && existing.state !== "running"
      && (state === "queued" || state === "running")) return;
    // 只和服务端时间比较（见 `serverUpdatedAt`）：canonical 占位记录的本地 `updatedAt` 不参与。
    const lastServerUpdate = this.serverUpdatedAt.get(key);
    if (existing && lastServerUpdate !== undefined && activity.updatedAt && activity.updatedAt < lastServerUpdate) return;
    const kind = existing?.kind ?? operationKindForModelType(activity.modelType);
    // 活动面按 0..1 分数承载进度，节点读模型与渲染协议要 0..100；不转换会让节点把 0.42
    // 当成 0.42% 直接夹到下限，看起来永远停在时间估算上
    // （change: 2026-10-31-unify-node-and-activity-progress，design D1）。
    const progress = reportedProgressPercent(activity.progress);
    const updatedAt = activity.updatedAt ?? new Date(this.now()).toISOString();
    this.serverUpdatedAt.set(key, updatedAt);
    this.records.set(key, {
      operationId: activity.runId,
      canvasId: this.canvasId,
      nodeId: activity.nodeId,
      kind,
      state,
      owner: "server",
      ...(progress !== undefined ? { progress } : {}),
      ...(activity.error?.message ? { error: activity.error.message } : {}),
      createdAt: earliestIso(existing?.createdAt, activity.createdAt) ?? new Date(this.now()).toISOString(),
      updatedAt
    });
    this.publish();
  }

  private applyLocalRejection(input: Extract<TaskActivityFinished, { source: "local-rejection" }>): void {
    const key = opKey(this.canvasId, input.activity.nodeId, input.activity.runId);
    const existing = this.records.get(key);
    if (!existing) return;
    this.records.set(key, {
      ...existing,
      state: "failed",
      localFailure: true,
      error: input.activity.error.message,
      updatedAt: input.activity.updatedAt
    });
    this.publish();
  }

  /**
   * 注册一个浏览器本地生成操作；返回结算回调。本地操作不写 canonical，也不经 Task Service。
   */
  beginLocalOperation(input: {
    nodeId: string;
    kind: CanvasOperationKind;
    progress?: number;
  }): { operationId: string; finish: (outcome?: { error?: string; progress?: number }) => void } {
    const operationId = `local-${createLocalId()}`;
    const key = opKey(this.canvasId, input.nodeId, operationId);
    const startedAt = new Date(this.now()).toISOString();
    this.records.set(key, {
      operationId,
      canvasId: this.canvasId,
      nodeId: input.nodeId,
      kind: input.kind,
      state: "running",
      owner: "local",
      ...(typeof input.progress === "number" ? { progress: input.progress } : {}),
      createdAt: startedAt,
      updatedAt: startedAt
    });
    this.publish();
    let settled = false;
    return {
      operationId,
      finish: (outcome) => {
        if (this.disposed || settled) return;
        settled = true;
        const current = this.records.get(key);
        if (!current) return;
        const updatedAt = new Date(this.now()).toISOString();
        if (outcome?.error) {
          this.records.set(key, { ...current, state: "failed", error: outcome.error, updatedAt });
        } else {
          this.records.set(key, {
            ...current,
            state: "succeeded",
            ...(typeof outcome?.progress === "number" ? { progress: outcome.progress } : { progress: 100 }),
            updatedAt
          });
        }
        this.publish();
      }
    };
  }

  /**
   * 用权威 `nodeData` 结算运行态（change: 2026-10-12-unify-generation-history-strip，design D2）。
   *
   * canonical `nodeData` 是任务状态的权威事实源，且经 Yjs 通道可靠回流（画布 hydration 同源）。
   * 活动通道可能因重连/时序丢失终态记录，因此每次 canonical 画布更新时按
   * `activeRunId + taskStatus` 结算对应操作：终态 → succeeded/failed/cancelled（灰点变绿/红），
   * 非终态 → running。已有终态记录不被回退；同一身份已结算则不重复加点。
   */
  reconcileCanonical(canvas: { document: { nodes: readonly { id: string; type?: string }[] }; nodeData: Record<string, unknown> } | null): void {
    if (this.disposed) return;
    this.filmCanvas = canvas;
    if (!canvas) { this.filmTurns.clear(); this.filmConversions.clear(); this.publish(); return; }
    for (const node of canvas.document.nodes) {
      const data = canvas.nodeData[node.id] as { activeRunId?: unknown; taskStatus?: unknown } | undefined;
      const runId = typeof data?.activeRunId === "string" ? data.activeRunId : null;
      if (!runId) continue;
      const canonical = canonicalState(data?.taskStatus);
      if (canonical === null) continue;
      const key = opKey(this.canvasId, node.id, runId);
      const existing = this.records.get(key);
      if (existing?.state === canonical) continue;
      // 已有终态记录不回退为运行态（避免乱序 canonical 覆盖终态）。
      if (existing && !isActiveOperation(existing) && canonical === "running") continue;
      const kind = existing?.kind ?? (node.type === "text" ? "text" : "image");
      const updatedAt = new Date(this.now()).toISOString();
      this.records.set(key, {
        operationId: runId,
        canvasId: this.canvasId,
        nodeId: node.id,
        kind,
        state: canonical,
        owner: "server",
        createdAt: existing?.createdAt ?? updatedAt,
        updatedAt
      });
    }
    this.publish();
  }

  /**
   * 用 Agent 回合投影同步运行中记录
   * （change: show-agent-turn-running-state-on-node）。
   *
   * Agent 回合不经 `task.activity.*`，但同样需要节点上的执行中呈现。这里按**操作身份前缀**
   * 整批替换：先移除已不在投影中的助手记录，再 upsert 当前投影。
   *
   * - 只处理 `agent:` / `text-run:` 前缀身份，绝不触碰 Task/本地操作记录；
   * - 终态回合不进入投影，因此节点在回合结束后立即回到正常呈现（不留"执行中"）；
   * - 身份用 `requestId`，同一回合的重复同步是幂等的，不新增第二条。
   */
  syncAgentOperations(records: readonly CanvasOperationRecord[]): void {
    if (this.disposed) return;
    const next = new Map<OpKey, CanvasOperationRecord>();
    for (const record of records) {
      if (!record.operationId.startsWith(AGENT_TURN_OPERATION_PREFIX) && !record.operationId.startsWith("text-run:")) continue;
      if (record.canvasId !== this.canvasId) continue;
      next.set(opKey(this.canvasId, record.nodeId, record.operationId), record);
    }
    let changed = false;
    for (const [key, existing] of this.records) {
      if (!existing.operationId.startsWith(AGENT_TURN_OPERATION_PREFIX) && !existing.operationId.startsWith("text-run:")) continue;
      if (next.has(key)) continue;
      this.records.delete(key);
      changed = true;
    }
    for (const [key, record] of next) {
      const existing = this.records.get(key);
      if (existing) {
        if (
          existing.state === record.state &&
          existing.progress === record.progress &&
          existing.updatedAt === record.updatedAt
        ) {
          continue;
        }
        this.records.set(key, { ...existing, ...record });
      } else {
        this.records.set(key, record);
      }
      changed = true;
    }
    if (changed) this.publish();
  }

  /** 移除非终态记录（例如节点删除或 scope 释放时清理）；终态保留以服务历史展示。 */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.serverUpdatedAt.clear();
  }

  private publish(): void {
    if (this.disposed) return;
    const records = [...this.records.values()];
    const summaries = new Map<string, CanvasNodeRunSummary>();
    const byNode = new Map<string, CanvasOperationRecord[]>();
    for (const record of records) {
      const list = byNode.get(record.nodeId);
      if (list) list.push(record);
      else byNode.set(record.nodeId, [record]);
    }
    for (const [nodeId, nodeRecords] of byNode) {
      const nodeType = this.nodeTypeOf(nodeId);
      summaries.set(
        nodeId,
        summarizeNodeRunState({
          canvasId: this.canvasId,
          nodeId,
          isAggregate: nodeType ? this.isAggregate({ type: nodeType }) : false,
          records: nodeRecords
        })
      );
    }
    for (const node of this.filmCanvas?.document.nodes ?? []) {
      const data = this.filmCanvas!.nodeData[node.id];
      const type = this.nodeTypeOf(node.id);
      if (!isFilmSetNode(type, data) && !isFilmSetGroupNode(type ? { type } : undefined, data)) continue;
      let conversion = readFilmSetConversionNodeStatus(data);
      const old = this.filmConversions.get(node.id);
      const sameSettledConversion = old && conversion && conversion.requestId === old.requestId && old.execution?.attemptId === conversion.execution?.attemptId
        && old.execution?.turnRequestId === conversion.execution?.turnRequestId
        && ["completed", "failed", "cancelled"].includes(old.status);
      if (sameSettledConversion && old && conversion) {
        // 已结算的转换（含 failed）保持原终态；同一请求的迟到 running 快照不能重新点亮扫描。
        conversion = old;
      }
      // Retain the terminal observation: repeated save-retry snapshots keep the settled failure visible.
      if (conversion && !sameSettledConversion) this.filmConversions.set(node.id, conversion);
      const summary = summaries.get(node.id) ?? summarizeNodeRunState({ canvasId: this.canvasId, nodeId: node.id, isAggregate: true, records: [] });
      summary.filmSetFeedback = normalizeFilmSetRunFeedback({ canvasId: this.canvasId, nodeId: node.id, conversion,
        turns: [...this.filmTurns.values()], records: byNode.get(node.id),
        pendingRequestId: Object.entries(this.filmPending).find(([, entry]) => entry.canvasId === this.canvasId && entry.nodeId === node.id && entry.mode === "film-set" && entry.action !== "discuss")?.[0],
        legacyTaskStatus: (data as { taskStatus?: unknown } | undefined)?.taskStatus });
      summaries.set(node.id, summary);
    }
    const liveNodes = new Set(this.filmCanvas?.document.nodes.map(n => n.id));
    for (const [key, turn] of this.filmTurns) if (!liveNodes.has(turn.target.nodeId ?? "")) this.filmTurns.delete(key);
    for (const key of this.filmConversions.keys()) if (!liveNodes.has(key)) this.filmConversions.delete(key);
    if (records.length === this.snapshot.records.length && records.every((record, index) => record === this.snapshot.records[index])
      && summaries.size === this.snapshot.summaries.size && [...summaries].every(([id, summary]) => {
        const previous = this.snapshot.summaries.get(id);
        return previous && previous.active === summary.active && previous.isAggregate === summary.isAggregate
          && previous.aggregateRunning === summary.aggregateRunning
          && ("filmSetFeedback" in previous) === ("filmSetFeedback" in summary)
          && JSON.stringify(previous.filmSetFeedback) === JSON.stringify(summary.filmSetFeedback);
      })) return;
    this.snapshot = { canvasId: this.canvasId, records, summaries };
    for (const listener of this.listeners) listener();
  }
}

function opKey(canvasId: string, nodeId: string, operationId: string): string {
  return `${canvasId}\u0000${nodeId}\u0000${operationId}`;
}

/**
 * 同一 run 的「开始时刻」取两者中更早的那个（ISO 字符串）。
 *
 * 活动面板按活动记录自己的 `createdAt` 估算，节点进度环必须用同一时刻，否则两边从不同起点
 * 推算，同一任务会显示两个百分比（change: 2026-10-31-unify-node-and-activity-progress）。
 *
 * 需要「更早」而不是直接覆盖的原因：`reconcileCanonical` 在活动快照到达前就会按 canonical
 * 造一条记录，`createdAt` 只能是当时的本地时间，比真实开始晚；活动快照到达后必须回到活动
 * 记录的真实创建时刻。反过来，提交时的乐观记录早于服务端 `createdAt`，保留乐观时间才能和
 * 面板（同样保留首次提交时间）保持一致。不可解析的一律忽略。
 */
function earliestIso(a: string | undefined, b: string | undefined): string | undefined {
  const aMs = a === undefined ? Number.NaN : Date.parse(a);
  const bMs = b === undefined ? Number.NaN : Date.parse(b);
  if (!Number.isFinite(aMs)) return Number.isFinite(bMs) ? b : undefined;
  if (!Number.isFinite(bMs)) return a;
  return aMs <= bMs ? a : b;
}

/** 任务模型类型 → 操作种类（缺省按 image 兜底）。 */
function operationKindForModelType(modelType: CanvasTaskModelType | undefined): CanvasOperationKind {
  switch (modelType) {
    case "language":
      return "text";
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    default:
      return "image";
  }
}

/**
 * 规范 `taskStatus` → 统一操作状态；未知/缺省返回 null（不结算）。
 *
 * `successed` 是 canvas 域词表拼写（历史遗留），映射为操作 `succeeded`。
 */
function canonicalState(taskStatus: unknown): CanvasOperationState | null {
  switch (taskStatus) {
    case "unknown": return "interrupted";
    case "pending":
    case "queued":
      return "queued";
    case "processing":
    case "running":
      return "running";
    case "successed":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

/**
 * 任务执行状态 → 统一操作状态。
 *
 * `succeeded`（任务词表）映射为操作 `succeeded`；活动链路不会产生 `partial`/`interrupted`
 * （它们由聚合与重连派生），这里保持一一映射。
 */
function serverState(state: CanvasTaskActivity["state"]): CanvasOperationState {
  switch (state) {
    case "queued":
      return "queued";
    case "pending":
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

/** 本地操作 id：优先 crypto.randomUUID，回退时间戳 + 随机。 */
function createLocalId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 供测试/门禁：会话是否仍活跃（非终态）。 */
export function isActiveOperation(record: CanvasOperationRecord): boolean {
  return record.state === "queued" || record.state === "running" || record.state === "interrupted";
}

/** 是否终态（供活动面展示）。 */
export function isTerminalOperation(record: CanvasOperationRecord): boolean {
  return !isActiveOperation(record);
}

/** 复用 contracts 的活动态判定（供 display 一致性）。 */
export { isActiveTaskState };
