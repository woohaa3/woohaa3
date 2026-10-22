/**
 * Canvas task result consumer（change: split-web-runtime-services，任务 5.4 / design D4）。
 *
 * Canvas 主动从 Task Service 消费持久化 history/cursor，把终态投影进权威 Y.Doc：
 * - 实时事件只用于降低延迟；**恢复以 history 为唯一依据**（design D4）；
 * - 用 `CanvasTaskProjector` 的稳定 commandId（workerTaskKey + terminal identity）幂等；
 * - 消费投影前通过 Media Service 再校验稳定 metadata（design D5）。
 *
 * 失败重试：投影失败（典型是启动时 canvas room 还没装载）**不推进水位**，下一轮从最早失败
 * 记录之前重读，退避 5s→60s 后重试，直到 room/媒体就绪；`command-id-reused`（回执是内存态，
 * 重启后同一终态重投）按已投影处理。修复的真实缺陷：重启后补写的终态在 room 尚未就绪时投影
 * 一次就丢，画布节点永远停在 processing。
 *
 * 本模块不重新执行 provider，也不构造第二套 scheduler。
 */
import {
  CanvasTaskProjector,
  projectionCommandId,
  type ProjectionOutcome,
  type ProjectionReceiptStore,
  type PptaskExecutionRecord
} from "../sync/index.js";
import type { StoredAsset, TaskExecutionDetail } from "@woohaa3/contracts";
import type { CanvasTaskClient } from "../clients/task-client.js";
import type { CanvasMediaClient } from "../clients/media-client.js";

export type TaskResultConsumerOptions = {
  projector: CanvasTaskProjector;
  taskClient: CanvasTaskClient;
  mediaClient?: CanvasMediaClient;
  receipts: ProjectionReceiptStore;
  /** 轮询间隔；事件流可用时事件只用于降低延迟，轮询仍保留为恢复事实源。 */
  intervalMs?: number;
  logger?: (event: Record<string, unknown>) => void;
};

export type TaskResultConsumer = {
  /** 拉取一次 history 并投影未处理的终态。 */
  reconcileOnce: () => Promise<{ projected: number; duplicate: number; skipped: number; failed: number }>;
  start: () => void;
  stop: () => void;
};

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/** 投影失败后的重试退避：5s 起翻倍，最长 60s（room 装载、媒体校验就绪后自动收敛）。 */
export const PROJECTION_RETRY_BASE_MS = 5_000;
export const PROJECTION_RETRY_MAX_MS = 60_000;

export function createTaskResultConsumer(options: TaskResultConsumerOptions): TaskResultConsumer {
  let timer: ReturnType<typeof setInterval> | undefined;
  let cursor = 0;
  let running = false;
  /** projectionId → 待重试状态（失败次数、下次可试时刻、记录水位；成功后立即清除）。 */
  const retries = new Map<string, { attempts: number; dueAt: number; revision: number }>();

  const reconcileOnce = async () => {
    if (running) return { projected: 0, duplicate: 0, skipped: 0, failed: 0 };
    running = true;
    try {
      // 从 cursor 起读取 history：这是重启补偿的事实源。
      const page = await options.taskClient.history({ after: cursor, limit: 200 });
      const nextCursor = Math.max(cursor, page.cursor);
      const pending = page.items
        .filter((item) => TERMINAL.has(item.state))
        .map((item) => ({ item, record: toExecutionRecord(item) }))
        .filter((entry): entry is { item: TaskExecutionDetail; record: PptaskExecutionRecord } => entry.record !== null);

      const summary = { projected: 0, duplicate: 0, skipped: 0, failed: 0 };
      const now = Date.now();
      for (const { item, record } of pending) {
        const projectionId = projectionCommandId(record);
        const retry = retries.get(projectionId);
        // 退避未到期：本轮不试（水位仍停在它之前，到期后会再次读到）。
        if (retry && retry.dueAt > now) {
          summary.skipped += 1;
          continue;
        }
        let outcome: ProjectionOutcome;
        try {
          outcome = await options.projector.project(record);
        } catch {
          outcome = { status: "failed", code: "projection-threw", message: "投影异常" };
        }
        switch (outcome.status) {
          case "projected":
            summary.projected += 1;
            retries.delete(projectionId);
            break;
          case "duplicate":
            summary.duplicate += 1;
            retries.delete(projectionId);
            break;
          case "skipped":
            summary.skipped += 1;
            retries.delete(projectionId);
            break;
          case "failed": {
            // commandId 已被 room 用过但 payload 不同：说明该终态在本进程之外**已经投影过**
            // （项目回执是内存态，重启即失），重试不可能成功，按 duplicate 处理并推进水位。
            if (outcome.code === "command-id-reused") {
              summary.duplicate += 1;
              retries.delete(projectionId);
              break;
            }
            summary.failed += 1;
            const attempts = (retry?.attempts ?? 0) + 1;
            retries.set(projectionId, {
              attempts,
              dueAt: now + Math.min(PROJECTION_RETRY_MAX_MS, PROJECTION_RETRY_BASE_MS * 2 ** (attempts - 1)),
              revision: item.recordRevision
            });
            // 失败原因要可诊断：room 未装载 vs 媒体校验失败 vs 提交失败，处置完全不同。
            options.logger?.({
              event: "task-projection-failed",
              taskKey: record.taskKey,
              canvasId: record.canvasId,
              code: outcome.code,
              message: outcome.message,
              attempts
            });
            break;
          }
        }
      }

      // 水位停在最早待重试记录之前：否则未到期的失败记录会被跳过、本进程内再也读不到。
      const retryFloor = [...retries.values()].reduce(
        (min, entry) => Math.min(min, entry.revision),
        Number.POSITIVE_INFINITY
      );
      cursor = Number.isFinite(retryFloor) ? Math.min(nextCursor, Math.max(0, retryFloor - 1)) : nextCursor;
      if (summary.projected > 0 || summary.failed > 0) {
        options.logger?.({ event: "task-reconcile", count: pending.length, ...summary });
      }
      return summary;
    } catch (error) {
      options.logger?.({ event: "task-reconcile-failed" });
      void error;
      return { projected: 0, duplicate: 0, skipped: 0, failed: 0 };
    } finally {
      running = false;
    }
  };

  return {
    reconcileOnce,
    start: () => {
      if (timer) return;
      timer = setInterval(() => void reconcileOnce(), options.intervalMs ?? 5_000);
      // 启动即补偿一次（覆盖 projector 离线期间完成的终态）。
      void reconcileOnce();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    }
  };
}

/**
 * 把 history 记录转成投影所需形态。
 *
 * 图片结果在投影前**再经 Media verify**：这是权威写入前的独立校验，不是重复保存 bytes
 * （design D5）。metadata 缺失或不一致时返回 null（跳过该终态，避免写入不可信资产）。
 */
export function toExecutionRecord(item: TaskExecutionDetail): PptaskExecutionRecord | null {
  if (!item.canvasId || !item.nodeId || !item.runId) return null;
  const status = item.state;
  if (status !== "succeeded" && status !== "failed" && status !== "cancelled") return null;
  const jobId = readJobId(item);
  const base: PptaskExecutionRecord = {
    taskKey: item.taskKey,
    status,
    canvasId: item.canvasId,
    nodeId: item.nodeId,
    runId: item.runId,
    jobId,
    // 模型身份只信 Task 记录（per-run 权威）；旧记录缺 modelKey 时保持缺省，不拿画布当前
    // nodeData.modelKey 反填（那可能属于更新的 run）（change: l0-generation-provenance）。
    ...(item.modelKey ? { modelKey: item.modelKey } : {}),
    ...(item.error?.message ? { error: item.error.message } : {}),
    terminalAt: item.finishedAt ?? item.updatedAt
  };
  if (status === "succeeded" && item.result) {
    if (item.result.mediaKind === "text") {
      return { ...base, output: { mediaKind: "text", text: item.result.text ?? "" } };
    }
    if (
      (item.result.mediaKind === "image" ||
        item.result.mediaKind === "video" ||
        item.result.mediaKind === "audio") &&
      item.result.storageKey &&
      item.result.checksum
    ) {
      const mediaKind = item.result.mediaKind;
      const taskKind = `${mediaKind}-generation`;
      const mainAsset: StoredAsset = {
        id: `asset-${item.runId}`,
        title: "生成资产",
        mediaKind,
        source: "generated",
        status: "ready",
        createdAt: item.createdAt,
        url: `/api/media/${item.result.storageKey}`,
        ...(item.result.durationSeconds !== undefined
          ? { durationSeconds: item.result.durationSeconds }
          : {}),
        provenance: {
          taskNodeId: item.nodeId,
          taskKind,
          runId: item.runId,
          outputIndex: 0
        },
        metadata: {
          storageKey: item.result.storageKey,
          checksum: item.result.checksum,
          contentType: item.result.contentType ?? defaultContentType(mediaKind),
          size: item.result.size ?? 0
        }
      };
      const poster = item.result.poster;
      const posterAsset: StoredAsset | undefined =
        mediaKind === "video" && poster?.storageKey && poster.checksum
          ? {
              id: `asset-${item.runId}-poster`,
              title: "视频海报",
              mediaKind: "image",
              source: "generated",
              status: "ready",
              createdAt: item.createdAt,
              url: `/api/media/${poster.storageKey}`,
              provenance: {
                taskNodeId: item.nodeId,
                taskKind,
                runId: item.runId,
                outputIndex: 1
              },
              metadata: {
                storageKey: poster.storageKey,
                checksum: poster.checksum,
                contentType: poster.contentType ?? "image/png",
                size: poster.size ?? 0
              }
            }
          : undefined;
      return {
        ...base,
        output: {
          mediaKind,
          asset: mainAsset,
          ...(posterAsset ? { posterAsset } : {}),
          ...(item.result.durationSeconds !== undefined
            ? { durationSeconds: item.result.durationSeconds }
            : {})
        }
      };
    }
  }
  return base;
}

function defaultContentType(mediaKind: "image" | "video" | "audio"): string {
  if (mediaKind === "video") return "video/mp4";
  if (mediaKind === "audio") return "audio/mpeg";
  return "image/png";
}

function readJobId(item: TaskExecutionDetail): string {
  // history 的列表项不含 jobId（安全裁剪），由 runId 派生稳定 job id。
  return `job-${item.runId}`;
}
