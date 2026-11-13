/**
 * 重启后的终态对账：调度 store 已终结、执行历史仍非终态时重放终态投影
 * （修复：重启落在「provider 已成功、结果转存 Media + 写 history」窗口，终态只留在调度 store）。
 *
 * 背景：二进制成功结果必须先经 Media 转存才允许写 `succeeded`（spec 不变式），这条路径是
 * 进程内异步的（见 `worker/runtime.ts` 的 subscribe 分支与 `worker/media-materialization.ts`）。
 * 进程若在转存途中被重启，durable 调度记录是 `completed`，而 history 永远停在 `running`：
 * 监控面显示「执行中」且耗时无限累加，画布补偿只消费终态 history，于是节点永久 processing。
 *
 * 本模块在启动时做一次**单向对账**：以调度 store 的终态为事实，把丢失的终态重放到 history。
 * - 图片/音频：优先用 durable `result` 里的原始字节重新转存 Media（不依赖 provider 地址是否过期），
 *   字节不可用（超限/缺失）时回退 provider 返回的受控地址；视频只接受地址。
 * - 有 Media 但无法转存时按 spec 落 `failed`，绝不落「没有产物的 succeeded」；未配置 Media 时
 *   与运行期一致按原样投影。
 * - 只处理「调度侧终态 + history 非终态」的组合；仍在执行/排队/重试中的记录不碰（交给
 *   dispatcher 的 lease 接管），没有调度记录的提交前失败交给孤儿对账。
 *
 * 幂等：写完终态后该记录不再是非终态，下次启动不会重复处理；写入前再读一次 history 状态，
 * 避免覆盖其它路径（如本进程刚完成的转存）已经推进的结果。
 */
import type { PptaskModelType } from "@sdppp/pptask";
import type { PptaskTaskRecord, PptaskTaskStore } from "@sdppp/pptask-worker-server";
import { extractExecutionResult, type ExecutionRecord } from "@sdppp/pptask-worker-server/history";
import type { TaskExecutionState, TaskExecutionSummary } from "@woohaa3/contracts";
import type { MediaClient } from "../clients/media-client.js";
import type { SqliteTaskHistoryRepository } from "../repository/history-repository.js";
import { projectExecutionRecord } from "./execution-projection.js";
import {
  materializeBinaryResult,
  materializeStableMediaResult,
  readRawBinaryBytes,
  readRawDurationSeconds,
  readRawPosterUrl,
  readStableMediaResult
} from "./media-materialization.js";
import type { BinaryModelType, MaterializationContext, TaskAssociation } from "./types.js";

/** 对账补写的终态事件阶段（展示层映射为「重启后补记」）。 */
export const TERMINAL_RECOVERY_EVENT_STAGE = "pptask.recovered";

/** 一次启动最多对账的记录数（非终态积压不阻塞启动，剩余留到下次启动）。 */
export const DEFAULT_TERMINAL_RECOVERY_LIMIT = 200;

export type TerminalRecoveryOptions = {
  taskStore: PptaskTaskStore;
  history: SqliteTaskHistoryRepository;
  mediaClient?: MediaClient;
  logger?: (event: Record<string, unknown>) => void;
  /** 单次对账处理的记录上限（积压时留到下次启动，避免阻塞启动）。 */
  limit?: number;
};

export type TerminalRecoverySummary = {
  scanned: number;
  recovered: number;
  skipped: number;
  failed: number;
};

const TERMINAL_TASK_STATUS = new Set(["completed", "failed", "cancelled"]);

/**
 * 启动对账入口：扫描非终态 history，把调度侧已经终结的记录补写成终态。
 *
 * 单条失败只记日志、不中断整批；返回值用于启动日志汇总。
 */
export async function recoverTerminalHistory(options: TerminalRecoveryOptions): Promise<TerminalRecoverySummary> {
  const summary: TerminalRecoverySummary = { scanned: 0, recovered: 0, skipped: 0, failed: 0 };
  let candidates: TaskExecutionSummary[];
  try {
    candidates = options.history.listUnsettled(options.limit ?? DEFAULT_TERMINAL_RECOVERY_LIMIT);
  } catch (error) {
    options.logger?.({ event: "task-terminal-recovery-scan-failed", message: messageOf(error) });
    return summary;
  }
  summary.scanned = candidates.length;
  for (const candidate of candidates) {
    try {
      const outcome = await recoverOne(options, candidate);
      if (outcome === "recovered") summary.recovered += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.failed += 1;
      options.logger?.({
        event: "task-terminal-recovery-failed",
        taskKey: candidate.taskKey,
        message: messageOf(error)
      });
    }
  }
  if (summary.recovered > 0 || summary.failed > 0) {
    options.logger?.({ event: "task-terminal-recovery", ...summary });
  }
  return summary;
}

async function recoverOne(
  options: TerminalRecoveryOptions,
  candidate: TaskExecutionSummary
): Promise<"recovered" | "skipped"> {
  const taskKey = candidate.taskKey;
  const task = await options.taskStore.find(taskKey);
  // 提交前失败（从未进入调度 store）：孤儿对账负责，不在这里伪造终态。
  if (!task) return "skipped";
  // 仍在排队/执行/重试：交给 dispatcher 的 lease 接管与重试，不判终态。
  if (!TERMINAL_TASK_STATUS.has(task.status)) return "skipped";
  // 别的路径（本进程刚完成的转存、并发对账）已经推进过：不覆盖。
  if (options.history.stateOf(taskKey) !== candidate.state) return "skipped";

  const state = mapTaskStatus(task.status);
  const finishedAt = task.updatedAt.toISOString();
  const modelType = readTaskModelType(task) ?? candidate.modelType;
  const association = toAssociation(candidate);
  const execution = toExecutionRecord(task, candidate, state, modelType, finishedAt);

  if (state === "succeeded") {
    // 稳定媒体结果（远端托管生成）：重启后重新 verify-and-adopt，不依赖 provider 地址，
    // 也不把已采用过的对象当「没有可转存来源」误判失败。
    const stableMedia = readStableMediaResult(execution);
    const binaryKind = binaryKindOf(modelType) ?? inferBinaryKind(task.result);
    if (stableMedia && options.mediaClient) {
      await materializeStableMediaResult(materializationContext(options), execution, association, stableMedia.media);
    } else if (binaryKind && options.mediaClient) {
      const materialized = await rematerializeBinaryOutput(options, execution, association, binaryKind, task.result);
      if (!materialized) {
        // spec 不变式：二进制结果未经 Media 转存不得落 succeeded。
        projectExecutionRecord(options.history, execution, association, { mediaKind: binaryKind }, "failed", {
          name: "MediaRecoveryError",
          message: "进程重启后无法恢复生成结果（没有可转存的字节或地址）"
        });
      }
    } else if (binaryKind) {
      // 没有配置 Media（独立部署/未装配媒体能力）：与运行期保持一致，按原样投影终态，
      // 不伪造资产；此时「succeeded 无产物」是既有语义，不是本次对账引入的。
      projectExecutionRecord(options.history, execution, association);
    } else {
      // 文本任务（或没有二进制产物）：按调度侧终态直接补写。
      projectExecutionRecord(options.history, execution, association);
    }
  } else if (state === "failed") {
    projectExecutionRecord(options.history, execution, association, undefined, "failed", {
      name: "TerminalProjectionLost",
      message: "进程重启中断：调度侧已失败，执行历史缺少失败详情（由启动对账补写）"
    });
  } else {
    projectExecutionRecord(options.history, execution, association, undefined, "cancelled");
  }

  options.logger?.({
    event: "task-terminal-recovered",
    taskKey,
    state,
    ...(modelType ? { modelType } : {}),
    attempt: task.attempt
  });
  return "recovered";
}

/**
 * 重新转存 durable 结果：优先字节（不依赖签名地址是否过期），其次受控地址。
 *
 * 返回 `false` 表示没有可用来源；`materializeBinaryResult` 自身失败时会写 failed，
 * 因此返回 `true` 只表示「已经交给转存路径并落定终态」。
 */
async function rematerializeBinaryOutput(
  options: TerminalRecoveryOptions,
  execution: ExecutionRecord,
  association: Partial<TaskAssociation> | undefined,
  kind: BinaryModelType,
  rawResult: unknown
): Promise<boolean> {
  const context = materializationContext(options);
  if (kind !== "video") {
    const bytes = await readRawBinaryBytes(options.taskStore, execution.id, kind).catch(() => undefined);
    if (bytes) {
      await materializeBinaryResult(context, execution, association, { ...bytes, modelType: kind });
      return true;
    }
  }
  const url = readOutputUrl(rawResult, kind);
  if (!url) return false;
  const durationSeconds = readRawDurationSeconds(rawResult);
  if (kind === "video") {
    const posterUrl = readRawPosterUrl(rawResult);
    await materializeBinaryResult(
      context,
      execution,
      association,
      { kind: "url", url, modelType: "video", ...(posterUrl ? { posterUrl } : {}) },
      durationSeconds
    );
    return true;
  }
  await materializeBinaryResult(context, execution, association, { kind: "url", url, modelType: kind }, durationSeconds);
  return true;
}

function materializationContext(options: TerminalRecoveryOptions): MaterializationContext {
  return {
    taskStore: options.taskStore,
    history: options.history,
    ...(options.mediaClient ? { mediaClient: options.mediaClient } : {}),
    ...(options.logger ? { logger: options.logger } : {})
  };
}

function toExecutionRecord(
  task: PptaskTaskRecord,
  candidate: TaskExecutionSummary,
  state: TaskExecutionState,
  modelType: PptaskModelType | undefined,
  finishedAt: string
): ExecutionRecord {
  const params = isRecord(task.params) ? task.params : {};
  const modelId = typeof params.modelId === "string" ? params.modelId : undefined;
  const createdAt = task.createdAt.toISOString();
  const result = isRecord(task.result) ? extractExecutionResult(task.result) : undefined;
  return {
    id: candidate.taskKey,
    providerId: task.providerId,
    ...(modelType ? { modelType } : {}),
    ...(modelId ? { modelId } : {}),
    state,
    ...(result ? { result } : {}),
    // 时间线补一条「重启后补记」，让「为什么现在才终结」在详情里可追溯。
    events: [
      {
        at: finishedAt,
        stage: TERMINAL_RECOVERY_EVENT_STAGE,
        kind: "execution",
        detail: { recoveredFrom: "task-store", taskStatus: task.status, attempt: task.attempt }
      }
    ],
    attempt: task.attempt,
    createdAt,
    updatedAt: finishedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(createdAt))
  };
}

/** 调度侧状态 → 对外执行状态。 */
function mapTaskStatus(status: string): TaskExecutionState {
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  return "cancelled";
}

function readTaskModelType(task: PptaskTaskRecord): PptaskModelType | undefined {
  const params = isRecord(task.params) ? task.params : {};
  const value = params.modelType;
  return value === "language" || value === "image" || value === "video" || value === "audio" || value === "motion" ? value : undefined;
}

/** history 已给出 modelType 时优先使用（调度 store 的 params 更权威，两者一致）。 */
function binaryKindOf(modelType: PptaskModelType | undefined): BinaryModelType | undefined {
  return modelType === "image" || modelType === "audio" || modelType === "video" || modelType === "motion" ? modelType : undefined;
}

/** 没有 modelType 时按原始结果的容器键推断二进制类型（旧记录/扩展任务）。 */
function inferBinaryKind(raw: unknown): BinaryModelType | undefined {
  if (!isRecord(raw)) return undefined;
  if (Array.isArray(raw.images) && raw.images.length > 0) return "image";
  if (Array.isArray(raw.motions) && raw.motions.length > 0) return "motion";
  if (Array.isArray(raw.audios) && raw.audios.length > 0) return "audio";
  if (Array.isArray(raw.videos) && raw.videos.length > 0) return "video";
  return undefined;
}

/** provider 原始结果里的受控输出地址（顶层媒体项或 providerMetadata）。 */
function readOutputUrl(raw: unknown, kind: BinaryModelType): string | undefined {
  if (!isRecord(raw)) return undefined;
  const key = kind === "image" ? "images" : kind === "audio" ? "audios" : kind === "motion" ? "motions" : "videos";
  const direct = raw[key];
  if (Array.isArray(direct)) {
    for (const item of direct) {
      if (typeof item === "string" && /^https?:\/\//i.test(item)) return item;
      if (isRecord(item) && typeof item.url === "string" && item.url !== "") return item.url;
    }
  }
  const metadata = raw.providerMetadata;
  if (isRecord(metadata)) {
    for (const entry of Object.values(metadata)) {
      if (!isRecord(entry)) continue;
      const list = entry[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (isRecord(item) && typeof item.url === "string" && item.url !== "") return item.url;
      }
    }
  }
  return undefined;
}

/** 从 history 快照取业务关联（jobId 只在 store 里，画布/节点/run 足以定位投影）。 */
function toAssociation(candidate: TaskExecutionSummary): Partial<TaskAssociation> | undefined {
  const association: Partial<TaskAssociation> = {
    ...(candidate.canvasId ? { canvasId: candidate.canvasId } : {}),
    ...(candidate.nodeId ? { nodeId: candidate.nodeId } : {}),
    ...(candidate.runId ? { runId: candidate.runId } : {})
  };
  return Object.keys(association).length > 0 ? association : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
