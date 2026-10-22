/**
 * Task Service 运行时（change: split-web-runtime-services，任务 4.1 / 4.2 / 4.5；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R25 —— 抽出类型、
 *  execution 投影与 Media 持久化，本文件保留唯一 worker/subscription owner）。
 *
 * 独占 pptask scheduling、provider 调用、claim/lease、重试、恢复与持久化 status/history。
 * 组合：
 * - durable `PptaskTaskStore`（SQLite）；
 * - `pptask-worker-server`（调度/认领/恢复）；
 * - execution history projection → durable history read model（供 history 页与 Canvas 补偿）；
 * - Media Service client（输入签名 + 输出转存）。
 *
 * **不写 Canvas、不回调 Canvas**（design D4）。任务终态由 Canvas 主动消费 history。
 */
import { createPptaskWorkerServer, createInProcessDispatchNotifier } from "@sdppp/pptask-worker-server";
import { createMemoryJobRepository } from "@sdppp/pptask";
import { safeProviderMessage, stripSecrets } from "./normalize.js";
import type { TaskRuntime, TaskRuntimeOptions } from "./types.js";
import {
  isTerminalRecord,
  hasTextOutput,
  projectExecutionRecord,
  readBinaryOutputUrl
} from "./execution-projection.js";
import {
  materializeBinaryBytesFromStore,
  materializeBinaryResult,
  materializeStableMediaResult,
  materializeVideoResult,
  readStableMediaResult
} from "./media-materialization.js";

const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

export type { TaskRuntime, TaskRuntimeOptions, TaskAssociation, BinaryModelType } from "./types.js";
export { projectExecutionRecord } from "./execution-projection.js";
export { resultFromMedia } from "./media-materialization.js";

export async function createTaskRuntime(options: TaskRuntimeOptions): Promise<TaskRuntime> {
  const jobRepository = options.jobRepository ?? createMemoryJobRepository();
  const notifier = options.notifier ?? createInProcessDispatchNotifier();
  const server =
    options.server ??
    (await createPptaskWorkerServer({
      taskStore: options.taskStore,
      jobRepository,
      resolveProvider: options.resolveProvider ?? (() => options.provider),
      notifier,
      concurrency: options.concurrency,
      leaseMs: options.leaseMs,
      recoveryIntervalMs: options.recoveryIntervalMs,
      recoveryJitterMs: options.recoveryJitterMs,
      retryLimit: options.retryLimit,
      retryBaseMs: options.retryBaseMs,
      now: options.now,
      log: (stage, details) => {
        options.logger?.({
          event: `worker.${stage}`,
          ...(typeof details.code === "string" ? { code: details.code } : {}),
          ...(typeof details.key === "string" ? { taskKey: details.key } : {}),
          // 失败原因必须可诊断：此前只映射 code/key，`worker.task-error` 的 message 被整体丢弃，
          // 「为什么没跑出来」在日志里完全看不见（2026-10-21 现场）。
          ...(typeof details.error === "string" ? { message: stripSecrets(details.error) } : {}),
          ...(typeof details.providerId === "string" ? { providerId: details.providerId } : {})
        });
      },
      onDispatchMetric: (metric) => {
        options.logger?.({
          event: `dispatch.${metric.event}`,
          ...(metric.reason ? { code: metric.reason } : {}),
          ...(typeof metric.key === "string" ? { taskKey: metric.key } : {}),
          ...(typeof metric.durationMs === "number" ? { status: metric.durationMs } : {})
        });
      }
    }));

  // 已成功转存/已终结的 taskKey：避免重复 import，也避免重复写终态。
  const settled = new Set<string>();

  // 终态写 history 依赖这些异步转存（`void materialize*(...)`）。停机时必须等它们收尾：
  // 否则进程在「provider 已成功、history 还没写」之间退出，重启后没有任何路径补写终态
  // （修复的真实缺陷：监控面永远显示执行中、画布节点永久 processing）。
  const pendingMaterializations = new Set<Promise<void>>();
  const trackMaterialization = (work: Promise<void>): void => {
    pendingMaterializations.add(work);
    void work.then(
      () => pendingMaterializations.delete(work),
      () => pendingMaterializations.delete(work)
    );
  };

  // 订阅 worker 的 execution-history projection，落到 durable read model。
  const unsubscribe = server.subscribe((record) => {
    const association = options.resolveAssociation?.(record.id);

    // 已认领终态：不再投影。图片转存是**异步**的，而 worker 之后还会再广播一次
    // scheduling `task-completed`（state 同样是 succeeded）。若那次落到普通投影路径，
    // 就会先写一条「无资产」的终态记录，projector 据此生成 receipt；等真正的图片结果
    // 到达时 commandId 相同 → 被判 duplicate，资产永远进不了画布（真实缺陷，已修）。
    if (settled.has(record.id)) return;

    // provider 二进制输出必须先经 Media import 转成稳定对象，之后才允许写 succeeded
    // （spec「所有二进制生成结果先经 Media Service 持久化」）。只有**终态 succeeded** 才
    // 需要转存；其它状态按普通投影走，不能被吞掉。
    if (options.mediaClient && record.state === "succeeded") {
      // 稳定媒体结果（远端托管生成：只有 storageKey + metadata，没有字节/URL）先走
      // verify-and-adopt：确认对象在画布作用域可读后直接写 summary，不搬运字节。必须在
      // URL/bytes 判断之前，否则会落到 bytes 回退并写成「无产物 succeeded」。
      const stableMedia = readStableMediaResult(record);
      if (stableMedia) {
        settled.add(record.id);
        trackMaterialization(materializeStableMediaResult(options, record, association, stableMedia.media));
        return;
      }
      const modelType = record.modelType;
      if (modelType === "image" || modelType === "video" || modelType === "audio") {
        const url = readBinaryOutputUrl(record, modelType);
        if (url) {
          settled.add(record.id);
          if (modelType === "video") {
            // 海报/末帧只在 provider 原始结果里（providerMetadata），投影不携带。
            trackMaterialization(materializeVideoResult(options, record, association, url));
            return;
          }
          // 图片/音频的字节同样在 durable 记录里：受控下载失败时 materializeBinaryResult 会用
          // 同一份字节回退转存，provider 地址过期/超时不会把已生成的结果判死。
          trackMaterialization(materializeBinaryResult(options, record, association, { kind: "url", url, modelType }));
          return;
        }
        if (!hasTextOutput(record)) {
          settled.add(record.id);
          trackMaterialization(materializeBinaryBytesFromStore(options, record, association, modelType));
          return;
        }
      }
      // 文本任务/无二进制输出：不需要转存，直接投影。
    }
    try {
      if (isTerminalRecord(record)) settled.add(record.id);
      projectExecutionRecord(options.history, record, association);
    } catch (error) {
      options.logger?.({ event: "history-projection-failed", code: safeProviderMessage(error) });
    }
  });

  return {
    server,
    close: async () => {
      unsubscribe();
      // 优雅停机（D8）：停止接受新任务与新 claim，在 grace 内等待 active executor；
      // 超时后 abort 上游 drive，不伪造终态（executing + lease 留给下个进程接管）。
      server.stop();
      const graceMs = positiveInteger(options.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS);
      const deadline = Date.now() + graceMs;
      await Promise.race([
        server.drained(),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, graceMs);
          timer.unref?.();
        })
      ]);
      server.abortAll?.();
      await server.drained().catch(() => undefined);
      // executor 已收尾不代表终态已落库：二进制结果还在 Media 转存。同一 grace 预算内等它们。
      await waitForMaterializations(pendingMaterializations, options.logger, Math.max(0, deadline - Date.now()));
      await server.close().catch(() => undefined);
    }
  };
}

/**
 * 停机时等待在飞媒体转存（终态写 history 依赖它们）。
 *
 * 超时只记日志、不阻塞退出：说明记录仍未终结，下次启动的终态对账会补写。
 */
async function waitForMaterializations(
  pending: ReadonlySet<Promise<void>>,
  logger: TaskRuntimeOptions["logger"],
  budgetMs: number
): Promise<void> {
  if (pending.size === 0) return;
  if (budgetMs <= 0) {
    logger?.({ event: "runtime-shutdown-materialization-timeout", pending: pending.size });
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
    timer.unref?.();
  });
  await Promise.race([Promise.allSettled([...pending]).then(() => undefined), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (pending.size > 0) logger?.({ event: "runtime-shutdown-materialization-timeout", pending: pending.size });
}

