/**
 * 节点生成历史应用服务公共入口
 * （change: add-canvas-node-generation-history，任务 1.2 / 1.3 / 1.4 / design D1–D3、D6；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R02 —— 拆分为
 *  当前状态、纯资产、登记、查询、容量与恢复协作者，本文件保留薄 facade）。
 *
 * 拥有画布级历史的领域校验、幂等登记、容量清理与原子恢复。它只依赖后端无关的
 * `NodeHistoryRepository` 与只读 room 端口；不接触 Y.Doc 结构、不产生媒体 bytes。
 *
 * 关键约束：
 * - 登记历史不推进 canvas revision、不广播 room update；
 * - 恢复重新读取最新画布，校验写权限、节点类型、归属、可解析与无 active generation；
 * - 恢复以稳定 operation identity 提交**单个**原子 command batch，保留 `modelPlacement`
 *   且不改动 prompt / panelPrompt / parameters / inputMapping。
 */
import {
  decodeModelPlacement,
  isMergeEligibleNode,
  type CanvasGenerationHistoryListPage,
  type NodeGenerationHistoryDetail,
  type NodeGenerationHistoryEntry,
  type NodeGenerationHistoryListPage,
  type NodeGenerationKind,
  type NodeHistoryMediaPayload
} from "@woohaa3/contracts";
import {
  currentIdentityOf,
  historyKindForNodeType,
  isActiveGeneration
} from "./node-history-service/current-state.js";
import {
  buildModelEditEntry,
  buildModelHistoryEntry,
  buildTaskFailureEntry,
  buildTaskHistoryEntry,
  mediaPayload
} from "./node-history-service/registration.js";
import {
  deleteCanvasHistory,
  deleteNodeHistory,
  enforceCapacity as enforceCapacityImpl
} from "./node-history-service/capacity.js";
import {
  getNodeHistoryDetail,
  getNodeHistoryEntry,
  isMediaResolvable,
  listCanvasHistory,
  listNodeHistory
} from "./node-history-service/queries.js";
import {
  restoreNodeHistory,
  snapshotCurrentModelEdit,
  type RestoreDependencies
} from "./node-history-service/restore.js";
import { ensureCurrentImageHistory } from "./node-history-service/backfill.js";
import {
  mergeNodeHistory as mergeNodeHistoryImpl,
  type MergeDependencies
} from "./node-history-service/merge.js";
import type {
  ClearNodeHistoryInput,
  MergeNodeHistoryInput,
  MergeNodeHistoryOutcome,
  NodeHistoryApplicationServiceOptions,
  NodeHistoryClearOutcome,
  NodeHistoryRestoreOutcome,
  NodeHistoryServiceContext,
  RegisterModelEditInput,
  RegisterModelHistoryInput,
  RegisterTaskFailureInput,
  RegisterTaskHistoryInput
} from "./node-history-service/types.js";

export type {
  NodeHistoryRoomPort,
  NodeHistoryRestoreOutcome,
  NodeHistoryApplicationServiceOptions,
  NodeHistoryServiceContext,
  NodeHistoryClearOutcome,
  ClearNodeHistoryInput,
  MergeNodeHistoryInput,
  MergeNodeHistoryOutcome,
  RegisterTaskHistoryInput,
  RegisterModelHistoryInput,
  RegisterModelEditInput,
  RegisterTaskFailureInput
} from "./node-history-service/types.js";
export type {
  CurrentNodeState
} from "./node-history-service/current-state.js";
export {
  entryMatchesCurrent,
  currentNodeStateOf,
  currentIdentityOf,
  animationDefinitionIdentity
} from "./node-history-service/current-state.js";
export {
  mediaAssetIdFor,
  imageEditBaseAssetIdFor,
  imageEditBaseAssetFor
} from "./node-history-service/assets.js";
export { buildRestoreCommands } from "./node-history-service/restore-commands.js";

export class NodeHistoryApplicationService {
  private readonly context: NodeHistoryServiceContext;
  private readonly restoreDeps: RestoreDependencies;
  private readonly mergeDeps: MergeDependencies;
  /** 便于测试/诊断访问底层 repository（与 context 同一实例）。 */
  private readonly repository: NodeHistoryServiceContext["repository"];
  /** 未结算编辑会话探测；未注入时视为无会话。 */
  private readonly hasActiveEditSession?: (canvasId: string, nodeId: string) => Promise<boolean>;

  constructor(options: NodeHistoryApplicationServiceOptions) {
    this.context = {
      repository: options.repository,
      resolveRoom: options.resolveRoom,
      ...(options.mediaVerifier ? { mediaVerifier: options.mediaVerifier } : {}),
      log: options.logger ?? (() => undefined),
      now: options.now ?? (() => new Date().toISOString())
    };
    this.repository = options.repository;
    this.hasActiveEditSession = options.hasActiveEditSession;
    this.restoreDeps = {
      context: this.context,
      registerModelEdit: (input) => this.registerModelEdit(input),
      enforceCapacity: (canvasId, nodeId) => this.enforceCapacity(canvasId, nodeId)
    };
    this.mergeDeps = {
      context: this.context,
      registerModelEdit: (input) => this.registerModelEdit(input),
      enforceCapacity: (canvasId, nodeId) => this.enforceCapacity(canvasId, nodeId),
      ...(this.hasActiveEditSession ? { hasActiveEditSession: this.hasActiveEditSession } : {})
    };
  }

  // --- 登记 ---------------------------------------------------------------

  /**
   * 以 runId 幂等登记文本/媒体版本。
   */
  async registerTaskResult(input: RegisterTaskHistoryInput): Promise<{ status: "inserted" | "duplicate"; entryId: string }> {
    const payload = input.output.mediaKind === "text"
      ? { kind: "text" as const, text: input.output.text }
      : mediaPayload(input.output);
    const entry = buildTaskHistoryEntry({
      canvasId: input.canvasId,
      nodeId: input.nodeId,
      runId: input.runId,
      ...(input.taskKey ? { taskKey: input.taskKey } : {}),
      ...(input.modelKey ? { modelKey: input.modelKey } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      kind: input.kind,
      createdAt: input.createdAt,
      payload
    });
    const result = await this.insertWithCapacity(entry);
    return { status: result.status, entryId: entry.entryId };
  }

  /**
   * 以 runId 幂等登记失败/取消/中断归档
   * （change: 2026-10-12-unify-generation-history-strip，design D3）。
   *
   * 失败记录不可恢复，不覆盖当前内容；同一 run 的重复终态只登记一次。基线引用在 read 时
   * 从权威画布导出（提交失败后当前内容仍是提交时内容）。
   */
  async registerTaskFailure(input: RegisterTaskFailureInput): Promise<{ status: "inserted" | "duplicate"; entryId: string }> {
    const baseline = input.baseline ?? (await this.readFailureBaseline(input.canvasId, input.nodeId)) ?? undefined;
    // taskKey / modelKey 属于溯源身份，随 input 原样透传到 source（change: l0-generation-provenance）。
    const entry = buildTaskFailureEntry({ ...input, ...(baseline ? { baseline } : {}) });
    const result = await this.insertWithCapacity(entry);
    return { status: result.status, entryId: entry.entryId };
  }

  /**
   * 读取失败归档所需的提交时基线引用
   * （change: 2026-10-12-unify-generation-history-strip，design D3）。
   *
   * `identity` 取当前 canonical 内容身份；`entryId` 取与当前身份一致的既有可恢复版本（供
   * “恢复执行前内容”）。节点缺失或无内容返回 null。
   */
  async readFailureBaseline(
    canvasId: string,
    nodeId: string
  ): Promise<{ identity: string; nodeType: string; entryId?: string; outputAssetId?: string } | null> {
    const room = await this.context.resolveRoom(canvasId);
    if (!room) return null;
    const exported = room.exportCanvas();
    if (!exported.ok) return null;
    const node = exported.canvas.document.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return null;
    const kind = historyKindForNodeType(node.type, exported.canvas.nodeData[nodeId]);
    if (!kind) return null;
    const identity = currentIdentityOf(exported.canvas, nodeId, kind);
    const data = exported.canvas.nodeData[nodeId] as Record<string, unknown> | undefined;
    const outputAssetId = typeof data?.outputAssetId === "string" ? data.outputAssetId : undefined;
    let entryId: string | undefined;
    if (identity) {
      const entries = await this.repository.listForNode(canvasId, nodeId);
      entryId = entries.find((entry) => entry.currentIdentity === identity && entry.recoverable)?.entryId;
    }
    return {
      identity: identity ?? `baseline:none`,
      nodeType: node.type,
      ...(entryId ? { entryId } : {}),
      ...(outputAssetId ? { outputAssetId } : {})
    };
  }

  /** 以 source hash + 稳定 command identity 幂等登记模型版本。 */
  async registerModelScript(input: RegisterModelHistoryInput): Promise<{ status: "inserted" | "duplicate"; entryId: string }> {
    // 生成版本也纳入当时节点的摆放（若有）：与编辑版本同一套「当前」判定。
    const placement = input.placement ?? (await this.readNodePlacement(input.canvasId, input.nodeId)) ?? undefined;
    const entry = buildModelHistoryEntry({
      canvasId: input.canvasId,
      nodeId: input.nodeId,
      sourceHash: input.sourceHash,
      modelScript: input.modelScript,
      language: input.language,
      version: input.version,
      createdAt: input.createdAt,
      ...(placement ? { placement } : {})
    });
    const result = await this.insertWithCapacity(entry);
    return { status: result.status, entryId: entry.entryId };
  }

  /**
   * 「回退/恢复」留档：把即将被替换的当前模型状态存为一条编辑版本（change: 模型编辑历史）。
   */
  async registerModelEdit(input: RegisterModelEditInput): Promise<{ status: "inserted" | "duplicate"; entryId: string }> {
    const entry = buildModelEditEntry(input);
    const result = await this.insertWithCapacity(entry);
    return { status: result.status, entryId: entry.entryId };
  }

  /**
   * 构造（不插入）一条模型编辑版本条目
   * （change: 图片聚焦编辑，design D5/D6 的固定 snapshot outbox 复用）。
   */
  buildModelEditEntry(input: RegisterModelEditInput): NodeGenerationHistoryEntry {
    return buildModelEditEntry(input);
  }

  private async insertWithCapacity(entry: NodeGenerationHistoryEntry): Promise<{ status: "inserted" | "duplicate" }> {
    const result = await this.repository.insert(entry);
    if (result.status === "inserted") {
      await this.enforceCapacity(entry.canvasId, entry.nodeId);
    }
    return { status: result.status };
  }

  /**
   * 幂等登记一条完整历史条目（供编辑完成 outbox 补偿使用）
   * （change: 图片聚焦编辑，design D6）。容量清理在插入后执行。
   */
  async registerEntry(entry: NodeGenerationHistoryEntry): Promise<{ status: "inserted" | "duplicate"; entryId: string }> {
    const result = await this.insertWithCapacity(entry);
    return { status: result.status, entryId: entry.entryId };
  }

  /** 某节点全部条目（倒序）；供编辑完成判定是否已有基线。 */
  async listEntriesForNode(canvasId: string, nodeId: string): Promise<NodeGenerationHistoryEntry[]> {
    return this.repository.listForNode(canvasId, nodeId);
  }

  /**
   * 为画布内所有“已经显示”的图片节点补登当前版本
   * （修复导入/粘贴/画布脚本创建的图片没有 `current` 历史，合并时无法作为来源）。
   *
   * 只登记可合并的普通图片节点；托管/预览/组不处理。已有匹配成功条目的节点返回
   * duplicate，不重复写入；没有 output 资产的占位节点跳过。补登不推进画布 revision。
   */
  async backfillCurrentImageHistory(canvasId: string): Promise<{
    inserted: string[];
    duplicates: string[];
    skipped: Array<{ nodeId: string; reason: string }>;
  }> {
    const room = await this.context.resolveRoom(canvasId);
    if (!room) return { inserted: [], duplicates: [], skipped: [] };
    const exported = room.exportCanvas();
    if (!exported.ok) return { inserted: [], duplicates: [], skipped: [] };
    const canvas = exported.canvas;
    const nodes = canvas.document.nodes.filter((node) =>
      node.type === "image"
      && isMergeEligibleNode({ node, data: canvas.nodeData[node.id] })
    );
    const inserted: string[] = [];
    const duplicates: string[] = [];
    const skipped: Array<{ nodeId: string; reason: string }> = [];
    for (const node of nodes) {
      const outcome = await ensureCurrentImageHistory(this.restoreDeps, canvas, node.id);
      if (outcome.status === "inserted") {
        inserted.push(node.id);
        await this.enforceCapacity(canvasId, node.id);
      } else if (outcome.status === "duplicate") {
        duplicates.push(node.id);
      } else {
        skipped.push({ nodeId: node.id, reason: outcome.reason });
      }
    }
    this.context.log({
      event: "node-history-image-backfilled",
      canvasId,
      inserted: inserted.length,
      duplicates: duplicates.length,
      skipped: skipped.length
    });
    return { inserted, duplicates, skipped };
  }

  // --- 查询 ---------------------------------------------------------------

  /** 画布授权的分页列表；调用方已校验画布读权限。 */
  async list(input: {
    canvasId: string;
    nodeId: string;
    limit?: number;
    cursor?: string;
  }): Promise<NodeGenerationHistoryListPage> {
    return listNodeHistory(this.context, (canvasId, nodeId) => this.readCurrentNodeState(canvasId, nodeId), input);
  }

  /** 归属校验后的完整详情。 */
  async getDetail(input: { canvasId: string; nodeId: string; entryId: string }): Promise<NodeGenerationHistoryDetail> {
    return getNodeHistoryDetail(this.context, (entry) => this.refreshRecoverability(entry), input);
  }

  /** 读取条目（预览端点用），返回完整 payload。 */
  async getEntry(input: { canvasId: string; nodeId: string; entryId: string }): Promise<NodeGenerationHistoryEntry> {
    return getNodeHistoryEntry(this.context, input);
  }

  /**
   * 画布级分页列表（change: add-canvas-generation-history-dialog）。
   */
  async listCanvas(input: {
    canvasId: string;
    summary?: boolean; summaryNodeId?: string;
    limit?: number;
    kind?: NodeGenerationKind;
    cursor?: string;
  }): Promise<CanvasGenerationHistoryListPage> {
    return listCanvasHistory(this.context, input);
  }

  // --- 恢复 ---------------------------------------------------------------

  /**
   * 原子恢复历史版本。
   */
  async restore(input: {
    canvasId: string;
    nodeId: string;
    entryId: string;
    expectedCurrentIdentity?: string;
  }): Promise<NodeHistoryRestoreOutcome> {
    return restoreNodeHistory(this.restoreDeps, input);
  }

  /**
   * 同类型节点合并：来源历史并入目标，目标切换到来源当前版本，来源节点删除
   * （change: 2026-10-27-merge-same-type-node-history，任务 3.3）。
   *
   * `operationId` 由调用方生成；同一身份重试返回首次回执，参数不同则拒绝。
   */
  async mergeNodeHistory(input: MergeNodeHistoryInput): Promise<MergeNodeHistoryOutcome> {
    return mergeNodeHistoryImpl(this.mergeDeps, input);
  }

  /**
   * 把当前模型状态留档为编辑版本（change: 模型编辑历史）。
   */
  async recordCurrentModelVersion(input: {
    canvasId: string;
    nodeId: string;
  }): Promise<{ ok: true; status: "inserted" | "duplicate"; entryId: string } | { ok: false; code: string; message: string }> {
    const room = await this.context.resolveRoom(input.canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${input.canvasId} 不存在` };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
    const node = exported.canvas.document.nodes.find((candidate) => candidate.id === input.nodeId);
    if (!node) return { ok: false, code: "unknown-node", message: `节点 ${input.nodeId} 不存在` };
    const data = exported.canvas.nodeData[input.nodeId] as Record<string, unknown> | undefined;
    const recorded = await snapshotCurrentModelEdit(this.restoreDeps, input.canvasId, input.nodeId, data);
    if (!recorded) return { ok: false, code: "unrecoverable", message: "当前模型无可留档内容" };
    return { ok: true, status: recorded.status, entryId: recorded.entryId };
  }

  // --- 生命周期与容量 -----------------------------------------------------

  /**
   * 用户显式清空某节点的历史。
   *
   * 与 `onNodeDeleted` 的区别：这是**写操作**，必须先确认节点仍然存在且类型受支持，
   * 并且没有进行中的编辑会话或生成（否则清空会删掉正在结算的归档义务）。只清历史索引，
   * 不动画布内容、当前输出资产与 Media 对象。
   */
  async clearNodeHistory(input: ClearNodeHistoryInput): Promise<NodeHistoryClearOutcome> {
    const canvasId = input.canvasId.trim();
    const nodeId = input.nodeId.trim();
    if (canvasId === "" || nodeId === "") return { ok: false, code: "malformed-request", message: "canvasId 与 nodeId 不能为空" };
    const room = await this.context.resolveRoom(canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${canvasId} 不存在` };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
    const node = exported.canvas.document.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return { ok: false, code: "unknown-node", message: `节点 ${nodeId} 不存在` };
    if (!historyKindForNodeType(node.type, exported.canvas.nodeData[nodeId])) {
      return { ok: false, code: "invalid-node-type", message: `节点 ${nodeId} 不提供历史版本` };
    }
    const data = exported.canvas.nodeData[nodeId] as Record<string, unknown> | undefined;
    if (isActiveGeneration(data)) {
      return { ok: false, code: "conflict", message: "节点存在进行中的生成，无法清空历史" };
    }
    if (this.hasActiveEditSession && (await this.hasActiveEditSession(canvasId, nodeId))) {
      return { ok: false, code: "conflict", message: "节点存在未结算的编辑会话，无法清空历史" };
    }
    const before = await this.repository.listForNode(canvasId, nodeId);
    await deleteNodeHistory(this.context, canvasId, nodeId);
    this.context.log({ event: "node-history-cleared", canvasId, nodeId, removed: before.length });
    return { ok: true, removed: before.length };
  }

  /** 节点删除：清理该节点全部历史。 */
  async onNodeDeleted(canvasId: string, nodeId: string): Promise<void> {
    await deleteNodeHistory(this.context, canvasId, nodeId);
  }

  /** 画布删除：清理该画布全部历史。 */
  async onCanvasDeleted(canvasId: string): Promise<void> {
    await deleteCanvasHistory(this.context, canvasId);
  }

  /**
   * 生成开始前把节点**当前**图片登记为历史基线（单节点版 `backfillCurrentImageHistory`）。
   *
   * 生成成功会把节点的 `outputAssetId` 换成新图；没有这一步，原来的图（上传的原图、没有生成历史的
   * 已有图片）就只剩资产还在，节点里再也找不回来。已有匹配条目返回 duplicate，不重复写入；
   * 没有输出资产或不可解析时 skipped。失败不抛出：这是旁路保护，不能挡住生成。
   */
  async ensureCurrentImageBaseline(canvasId: string, nodeId: string): Promise<void> {
    try {
      const room = await this.context.resolveRoom(canvasId);
      if (!room) return;
      const exported = room.exportCanvas();
      if (!exported.ok) return;
      const outcome = await ensureCurrentImageHistory(this.restoreDeps, exported.canvas, nodeId);
      if (outcome.status === "inserted") await this.enforceCapacity(canvasId, nodeId);
    } catch (error) {
      this.context.log({
        event: "node-history-baseline-failed",
        canvasId,
        nodeId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * 确定性容量清理。
   */
  async enforceCapacity(canvasId: string, nodeId?: string): Promise<void> {
    await enforceCapacityImpl(this.context, (c, n) => this.readCurrentIdentity(c, n), canvasId, nodeId);
  }

  /** 校验媒体可解析性并更新 recoverable/previewable（缺失对象进入不可恢复态）。 */
  private async refreshRecoverability(entry: NodeGenerationHistoryEntry): Promise<void> {
    if (entry.kind === "text" || entry.kind === "model") return;
    if (!entry.recoverable) return;
    const resolvable = await isMediaResolvable(this.context, entry.payload as NodeHistoryMediaPayload, {
      canvasId: entry.canvasId
    });
    if (!resolvable) {
      await this.repository.markUnrecoverable(entry.canvasId, entry.nodeId, entry.entryId);
    }
  }

  /** 读取节点当前生效 output identity（与历史 currentIdentity 同构）。 */
  private async readCurrentIdentity(canvasId: string, nodeId: string): Promise<string | null> {
    const state = await this.readCurrentNodeState(canvasId, nodeId);
    return state?.identity ?? null;
  }

  /** 读取节点当前显式摆放（无则 null；room 缺失时 null）。 */
  private async readNodePlacement(canvasId: string, nodeId: string) {
    const room = await this.context.resolveRoom(canvasId);
    if (!room) return null;
    const exported = room.exportCanvas();
    if (!exported.ok) return null;
    const data = exported.canvas.nodeData[nodeId] as Record<string, unknown> | undefined;
    if (!data || data.modelPlacement === undefined || data.modelPlacement === null) return null;
    return decodeModelPlacement(data.modelPlacement);
  }

  /**
   * 读取节点当前生效状态（供条目级当前判定）。
   */
  private async readCurrentNodeState(
    canvasId: string,
    nodeId: string
  ): Promise<{ identity: string | null; placement: import("@woohaa3/contracts").NodeHistoryModelPlacement | null } | null> {
    const room = await this.context.resolveRoom(canvasId);
    if (!room) return null;
    const exported = room.exportCanvas();
    if (!exported.ok) return null;
    const node = exported.canvas.document.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return null;
    const kind = historyKindForNodeType(node.type, exported.canvas.nodeData[nodeId]);
    if (!kind) return null;
    const data = exported.canvas.nodeData[nodeId] as Record<string, unknown> | undefined;
    const rawPlacement = data?.modelPlacement;
    const placement = rawPlacement === undefined || rawPlacement === null
      ? null
      : decodeModelPlacement(rawPlacement);
    return { identity: currentIdentityOf(exported.canvas, nodeId, kind), placement };
  }

  async health(): Promise<{ ok: boolean; backend: string; reason?: string }> {
    return this.repository.health();
  }
}

// 保持外部可能引用的工具可用（供上层 composition/测试）。
export { currentStatesFor } from "./node-history-service/current-state.js";
export { readAnimationHistoryPayload, readModelCamerasSnapshot } from "./node-history-service/registration.js";
export { snapshotCurrentImageEdit, snapshotCurrentModelEdit } from "./node-history-service/restore.js";
