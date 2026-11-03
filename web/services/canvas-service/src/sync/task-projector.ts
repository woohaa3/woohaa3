/**
 * 服务端画布任务投影器（任务 7.3–7.7 / design D10）。
 *
 * 职责边界（design D10 明确）：
 * - 任务的**队列、provider 调用、重试、恢复**仍由既有 `pptask-worker-server` 负责；
 * - 本模块只把 worker 的终态记录**投影**进权威 Y.Doc：校验、规范化、写单次 transaction。
 * - **不**实现第二套 scheduler / provider runner / 任务恢复队列。
 *
 * 幂等（spec「worker 结果投影可幂等补偿」）：
 * 投影 commandId 由 `workerTaskKey + 终态标识` 确定性生成，因此实时订阅、重启扫描与
 * 补偿扫描观察到同一终态时只会写一次。
 *
 * latest-run-wins：runId 已非节点 activeRunId 时丢弃节点结果，但**记录 receipt**，
 * 防止旧终态被永久重试。
 */
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import type { CanvasRoom } from "./room.js";
import type { CanvasCommand } from "@woohaa3/contracts";
import type { CanvasNodeData, ServerCanvas, StoredAsset, StoredJob } from "@woohaa3/contracts";

/** worker 终态记录（从 pptask status/history 归一化而来）。 */
export type PptaskExecutionRecord = {
  /** worker 侧稳定 task key（本 change 里就是客户端生成的 runId）。 */
  taskKey: string;
  /** 终态标识：status + 版本/完成时间，参与 commandId 派生。 */
  status: "succeeded" | "failed" | "cancelled";
  /** 业务侧关联信息。 */
  canvasId: string;
  nodeId: string;
  runId: string;
  jobId: string;
  /**
   * 该次执行使用的模型身份（change: l0-generation-provenance）。
   *
   * 取自 Task 记录（per-run 权威，而不是画布 nodeData.modelKey —— 后者可能已被更新的
   * run 覆盖）。旧记录缺失时不写，绝不猜测。
   */
  modelKey?: string;
  /** 失败/取消时的安全错误信息。 */
  error?: string;
  /** 成功时的输出。 */
  output?: {
    mediaKind: "text" | "image" | "video" | "audio";
    text?: string;
    asset?: StoredAsset;
    /** 视频海报资产（稳定引用）。 */
    posterAsset?: StoredAsset;
    durationSeconds?: number;
  };
  /** 终态发生时间（参与 terminal identity）。 */
  terminalAt: string;
};

export type ProjectionOutcome =
  | { status: "projected"; revision: number; noop: boolean }
  | { status: "duplicate"; revision: number }
  | { status: "skipped"; reason: "stale-run" | "unknown-node" }
  /** `permanent`：重试不可能成功（例如画布文档已不存在），消费方应直接放弃而不是退避重试。 */
  | { status: "failed"; code: string; message: string; permanent?: boolean };

/** receipt 查询/记录：由注入的实现持久化（运维补偿用）。 */
export type ProjectionReceiptStore = {
  /** 是否已有该 projection 的 receipt。 */
  has(canvasId: string, projectionId: string): Promise<boolean>;
  record(input: {
    canvasId: string;
    projectionId: string;
    taskKey: string;
    status: PptaskExecutionRecord["status"];
    outcome: "projected" | "skipped-stale" | "skipped-unknown-node";
    revision: number | null;
    recordedAt: string;
  }): Promise<void>;
};

export type CanvasTaskProjectorOptions = {
  /** 按 canvasId 取 room（由 room registry 提供）。 */
  resolveRoom: (canvasId: string) => Promise<CanvasRoom | null>;
  receipts: ProjectionReceiptStore;
  /**
   * 成功终态的历史登记端口
   * （change: add-canvas-node-generation-history，任务 2.1）。
   *
   * 在 latest-run-wins 判定**之前**以 runId 幂等登记；旧 run 也保留为历史版本，
   * 但不覆盖当前节点。登记失败不阻断当前节点投影（由补偿扫描重试）。
   */
  registerHistory?: (record: PptaskExecutionRecord) => Promise<void>;
  /**
   * 失败/取消/中断归档端口
   * （change: 2026-10-12-unify-generation-history-strip，design D3）。
   *
   * 在 latest-run-wins 判定**之前**以 runId 幂等登记；旧 run 的失败也保留为不可恢复归档，
   * 但不覆盖当前节点。登记失败不阻断当前节点投影（由补偿扫描重试）。
   */
  registerFailure?: (record: PptaskExecutionRecord) => Promise<void>;
  /**
   * Skill 尝试结算端口（change: 2026-10-28-add-agent-skill-media-regeneration，任务 3.1）。
   *
   * 只接收权威终态记录；不阻断画布投影，查询路径可用 Canvas 权威状态再次复核。
   */
  onSettled?: (record: PptaskExecutionRecord) => void;
  now?: () => string;
};

/**
 * 确定性生成投影 commandId。
 *
 * 同一 worker task key + 同一终态 ⇒ 同一 commandId ⇒ room 的 commandId 幂等记录保证
 * 「至多改一次」。
 */
export function projectionCommandId(record: Pick<PptaskExecutionRecord, "taskKey" | "status" | "terminalAt">): string {
  return `projection:${record.taskKey}:${record.status}:${record.terminalAt}`;
}

/**
 * 由终态记录构造命令批次内容。
 *
 * `currentCanvas` 用于 latest-run-wins 判定（runId 是否仍是 active run）与节点存在性检查。
 */
export function buildProjectionCommands(input: {
  record: PptaskExecutionRecord;
  currentCanvas: ServerCanvas;
}): { ok: true; commands: CanvasCommand[] } | { ok: false; reason: "stale-run" | "unknown-node"; message: string } {
  const { record, currentCanvas } = input;
  const node = currentCanvas.nodeData[record.nodeId] as CanvasNodeData | undefined;
  if (!node || !currentCanvas.document.nodes.some((entry) => entry.id === record.nodeId)) {
    return { ok: false, reason: "unknown-node", message: `节点 ${record.nodeId} 不存在` };
  }

  // latest-run-wins：只有在节点 active run 仍是本 run 时才写节点结果。
  // 注意 activeRunId 缺失时（例如 begin 未落盘）保守地视为「不是当前 run」，
  // 避免把过期结果写进画布。
  if (node.activeRunId !== record.runId) {
    return {
      ok: false,
      reason: "stale-run",
      message: `run ${record.runId} 已不是节点 ${record.nodeId} 的 active run`
    };
  }

  const commands: CanvasCommand[] = [];

  if (record.status === "succeeded") {
    if (record.output?.mediaKind === "image" || record.output?.mediaKind === "video" || record.output?.mediaKind === "audio") {
      if (!record.output.asset) {
        return { ok: false, reason: "unknown-node", message: `${record.output.mediaKind} 结果缺少资产` };
      }
      commands.push({ type: "asset.upsert", asset: record.output.asset });
      // 视频海报：独立图片资产，通过稳定 posterAssetId 关联。
      if (record.output.mediaKind === "video" && record.output.posterAsset) {
        commands.push({ type: "asset.upsert", asset: record.output.posterAsset });
      }
      commands.push({
        type: "nodeData.patch",
        nodeId: record.nodeId,
        value: {
          taskStatus: "successed",
          outputAssetId: record.output.asset.id,
          ...(record.output.mediaKind === "video" && record.output.posterAsset
            ? { posterAssetId: record.output.posterAsset.id }
            : {}),
          resourceKind: record.output.asset.mediaKind,
          ...(record.output.durationSeconds !== undefined
            ? { durationSeconds: record.output.durationSeconds }
            : {}),
          progress: 100,
          error: null,
          errorMessage: null
        }
      });
    } else {
      // 文本结果：直接写进 nodeData（没有媒体 bytes，不需要 COS）。
      commands.push({
        type: "nodeData.patch",
        nodeId: record.nodeId,
        value: {
          taskStatus: "successed",
          progress: 100,
          error: null,
          errorMessage: null,
          result: { kind: "text", text: record.output?.text ?? "" }
        }
      });
    }
  } else {
    // failed / cancelled：保留原 outputAssetId（只更新任务状态与安全错误）。
    commands.push({
      type: "nodeData.patch",
      nodeId: record.nodeId,
      value: {
        taskStatus: record.status === "cancelled" ? "cancelled" : "failed",
        progress: 100,
        error: record.error ?? "任务未成功完成",
        errorMessage: record.error ?? "任务未成功完成"
      }
    });
  }

  const existingJobInput = currentCanvas.jobs.find((job) => job.id === record.jobId)?.input;
  commands.push({
    type: "job.upsert",
    job: {
      id: record.jobId,
      nodeId: record.nodeId,
      taskId: record.taskKey,
      runId: record.runId,
      // 模型身份随 job 落盘：产物 → provenance.runId → jobs[].taskId 之外还要能直接读模型
      // （change: l0-generation-provenance）。旧记录缺省即不写。
      ...(record.modelKey ? { modelKey: record.modelKey } : {}),
      ...(existingJobInput ? { input: existingJobInput } : {}),
      status: record.status === "succeeded" ? "success" : "failed",
      error: record.status === "succeeded" ? undefined : record.error,
      updatedAt: record.terminalAt
    } satisfies StoredJob
  });

  return { ok: true, commands };
}

/**
 * 画布任务投影器。
 *
 * 单个终态的投影流程：
 * 1. 查 receipt：已有则直接 duplicate（实时订阅与补偿扫描重复观察）。
 * 2. 取 room，导出当前规范聚合。
 * 3. latest-run-wins / 节点存在性校验。
 * 4. 经 room 提交命令批次（room 负责持久化先于广播与 commandId 幂等）。
 * 5. 记录 receipt（含 skipped 情况，避免旧终态永久重试）。
 */
export class CanvasTaskProjector {
  private readonly resolveRoom: (canvasId: string) => Promise<CanvasRoom | null>;
  private readonly receipts: ProjectionReceiptStore;
  private readonly registerHistory?: (record: PptaskExecutionRecord) => Promise<void>;
  private readonly registerFailure?: (record: PptaskExecutionRecord) => Promise<void>;
  private readonly onSettled?: (record: PptaskExecutionRecord) => void;
  private readonly now: () => string;

  constructor(options: CanvasTaskProjectorOptions) {
    this.resolveRoom = options.resolveRoom;
    this.receipts = options.receipts;
    this.registerHistory = options.registerHistory;
    this.registerFailure = options.registerFailure;
    this.onSettled = options.onSettled;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async project(record: PptaskExecutionRecord): Promise<ProjectionOutcome> {
    const projectionId = projectionCommandId(record);

    // 1) receipt 幂等：同一终态只处理一次。
    if (await this.receipts.has(record.canvasId, projectionId)) {
      return { status: "duplicate", revision: -1 };
    }

    // 1.5) 终态先登记历史（独立于 latest-run-wins）：成功版本与失败/取消/中断归档都保留。
    // 失败登记失败不阻断当前节点投影；receipt 未写，补偿扫描会连同登记重试。
    if (record.status === "succeeded" && record.output && this.registerHistory) {
      try {
        await this.registerHistory(record);
      } catch {
        return { status: "failed", code: "history-register-failed", message: "节点历史登记失败" };
      }
    } else if (record.status !== "succeeded" && this.registerFailure) {
      try {
        await this.registerFailure(record);
      } catch {
        return { status: "failed", code: "failure-history-register-failed", message: "失败历史登记失败" };
      }
    }

    // 1.75) Skill 步骤结算：迟到旧 run 只写自己的历史，不影响当前节点投影。
    try { this.onSettled?.(record); } catch { /* 查询复核兜底 */ }

    // 2) 取 room。
    const room = await this.resolveRoom(record.canvasId);
    if (!room) {
      return { status: "failed", code: "room-not-found", message: `room ${record.canvasId} 不存在` };
    }

    // 3) 导出当前聚合做校验。
    const exported = room.exportCanvas();
    if (!exported.ok) {
      // 文档不存在 = 画布已被删除（dev 库里任务还在、画布没了很常见）。重试永远不可能成功，
      // 标成 permanent 让消费方推进水位并停止每轮 44 行的重试日志。
      if (exported.code === "not-found") {
        return { status: "failed", code: "canvas-not-found", message: exported.message, permanent: true };
      }
      return { status: "failed", code: "canvas-unavailable", message: exported.message };
    }

    const built = buildProjectionCommands({ record, currentCanvas: exported.canvas });
    if (!built.ok) {
      // Each accepted run owns its job even when a newer run owns the node output.
      const job = exported.canvas.jobs.find(job => job.id === record.jobId && job.nodeId === record.nodeId && job.runId === record.runId);
      if (built.reason === "stale-run" && job && job.status === "running") {
        const settled = await room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
          canvasId: record.canvasId, commandId: `${projectionId}:job`, baseRevision: exported.canvas.revision,
          actorId: "task-projector", commands: [{ type: "job.upsert", job: { ...job,
            status: record.status === "succeeded" ? "success" : "failed", error: record.error, updatedAt: record.terminalAt } }] });
        if (!settled.ok) return { status: "failed", code: settled.code, message: settled.message };
      }
      // 跳过但仍记 receipt：旧终态不应被永久重试（design D10）。
      await this.receipts.record({
        canvasId: record.canvasId,
        projectionId,
        taskKey: record.taskKey,
        status: record.status,
        outcome: built.reason === "stale-run" ? "skipped-stale" : "skipped-unknown-node",
        revision: exported.canvas.revision,
        recordedAt: this.now()
      });
      return { status: "skipped", reason: built.reason };
    }

    // 4) 经 room 提交（room 会在最新 published 状态上串行执行并持久化）。
    const result = await room.submitDerived({
      commandId: projectionId,
      derive: canvas => {
        const latest = buildProjectionCommands({ record, currentCanvas: canvas });
        return latest.ok ? { ok: true, batch: { protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
          canvasId: record.canvasId, commandId: projectionId, baseRevision: canvas.revision,
          actorId: "task-projector", commands: latest.commands } } : { ok: false, code: latest.reason, message: latest.message };
      }
    });

    if (!result.ok) {
      // A newer begin may have committed between the initial read and our authority turn.
      // Re-read once through the normal stale path to settle only this run's job/receipt.
      if (result.code === "stale-run" || result.code === "unknown-node") return this.project(record);
      // 暂时失败：不记 receipt，允许后续补偿重试同一 projectionId。
      return { status: "failed", code: result.code, message: result.message };
    }

    // 5) 记 receipt。
    await this.receipts.record({
      canvasId: record.canvasId,
      projectionId,
      taskKey: record.taskKey,
      status: record.status,
      outcome: "projected",
      revision: result.revision,
      recordedAt: this.now()
    });

    return {
      status: result.status === "duplicate" ? "duplicate" : "projected",
      revision: result.revision,
      noop: result.noop
    };
  }

  /**
   * 补偿投影（任务 7.6）：对一批终态逐个投影。
   *
   * 只恢复画布投影；**不**重新执行 provider —— 终态来自 worker 的持久化 status/history。
   * 返回汇总便于运维观测。
   */
  async reconcile(records: readonly PptaskExecutionRecord[]): Promise<{
    projected: number;
    duplicate: number;
    skipped: number;
    failed: number;
  }> {
    const summary = { projected: 0, duplicate: 0, skipped: 0, failed: 0 };
    for (const record of records) {
      const outcome = await this.project(record);
      switch (outcome.status) {
        case "projected":
          summary.projected += 1;
          break;
        case "duplicate":
          summary.duplicate += 1;
          break;
        case "skipped":
          summary.skipped += 1;
          break;
        case "failed":
          summary.failed += 1;
          break;
      }
    }
    return summary;
  }
}

/** 内存 receipt 存储（测试与单实例部署）。 */
export class InMemoryProjectionReceiptStore implements ProjectionReceiptStore {
  private readonly receipts = new Map<string, { revision: number | null }>();

  async has(canvasId: string, projectionId: string): Promise<boolean> {
    return this.receipts.has(`${canvasId}:${projectionId}`);
  }

  async record(input: {
    canvasId: string;
    projectionId: string;
    taskKey: string;
    status: PptaskExecutionRecord["status"];
    outcome: string;
    revision: number | null;
    recordedAt: string;
  }): Promise<void> {
    this.receipts.set(`${input.canvasId}:${input.projectionId}`, { revision: input.revision });
  }

  get size(): number {
    return this.receipts.size;
  }
}

/**
 * 从 worker 的终态记录派生投影所需信息。
 *
 * worker 记录形态与画布业务字段（canvasId/nodeId/runId/jobId）需要显式关联：这些由
 * run request handler 在提交任务时写入 worker 记录的 metadata。缺少任一字段时视为
 * 无法投影（返回 null），而不是猜测。
 */
export function readExecutionRecord(workerTaskKey: string, payload: unknown): PptaskExecutionRecord | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const status = record.status;
  if (status !== "succeeded" && status !== "failed" && status !== "cancelled") return null;
  const canvasId = typeof record.canvasId === "string" ? record.canvasId : null;
  const nodeId = typeof record.nodeId === "string" ? record.nodeId : null;
  const runId = typeof record.runId === "string" ? record.runId : null;
  const jobId = typeof record.jobId === "string" ? record.jobId : null;
  if (!canvasId || !nodeId || !runId || !jobId) return null;
  return {
    taskKey: workerTaskKey,
    status,
    canvasId,
    nodeId,
    runId,
    jobId,
    ...(typeof record.modelKey === "string" && record.modelKey !== "" ? { modelKey: record.modelKey } : {}),
    error: typeof record.error === "string" ? record.error : undefined,
    output: isOutput(record.output) ? record.output : undefined,
    terminalAt: typeof record.terminalAt === "string"
      ? record.terminalAt
      : typeof record.updatedAt === "string"
        ? record.updatedAt
        : new Date(0).toISOString()
  };
}

function isOutput(value: unknown): value is PptaskExecutionRecord["output"] {
  if (typeof value !== "object" || value === null) return false;
  const output = value as Record<string, unknown>;
  return (
    output.mediaKind === "text" ||
    output.mediaKind === "image" ||
    output.mediaKind === "video" ||
    output.mediaKind === "audio"
  );
}
