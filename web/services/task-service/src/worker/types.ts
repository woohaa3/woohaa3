/**
 * Task worker 运行时：类型与选项
 * （自 `runtime.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R25）。
 */
import type {
  PptaskDispatchNotifier,
  PptaskTaskStore,
  PptaskWorkerServer
} from "@sdppp/pptask-worker-server";
import type { PptaskJobRepository, PptaskProvider } from "@sdppp/pptask";
import type { SqliteTaskHistoryRepository } from "../repository/history-repository.js";
import type { MediaClient } from "../clients/media-client.js";

export type TaskRuntimeOptions = {
  taskStore: PptaskTaskStore;
  history: SqliteTaskHistoryRepository;
  provider: PptaskProvider;
  providerId: string;
  /** 多 Provider：按 providerId 解析（提供时优先于单一 provider）。 */
  resolveProvider?: import("@sdppp/pptask-worker-server").PptaskWorkerOptions["resolveProvider"];
  mediaClient?: MediaClient;
  jobRepository?: PptaskJobRepository;
  /** 共享 dispatch notifier；submit/cancel 发布 hint，dispatcher 订阅。 */
  notifier?: PptaskDispatchNotifier;
  concurrency?: number;
  leaseMs?: number;
  /** 低频、带抖动的 recovery sweep 周期（安全网，不是正常吞吐路径）。 */
  recoveryIntervalMs?: number;
  recoveryJitterMs?: number;
  retryLimit?: number;
  retryBaseMs?: number;
  /** 优雅停机等待 active executor 的有界宽限。 */
  shutdownGraceMs?: number;
  now?: () => Date;
  logger?: (event: {
    event: string;
    status?: number;
    code?: string;
    taskKey?: string;
    pending?: number;
    /** 采纳/落库走的是哪条路（locator 还是稳定键）；排障时先看这个。 */
    via?: string;
    /** 媒体转存涉及的模型类别（安全枚举，不含 prompt/URL）。 */
    modelType?: string;
  }) => void;
  /** 注入 worker server（测试用）。 */
  server?: PptaskWorkerServer;
  /** 按 taskKey 解析业务关联（canvasId/nodeId/runId/jobId）；由 submit 路径登记。 */
  resolveAssociation?: (taskKey: string) => TaskAssociation | undefined;
};

export type TaskAssociation = {
  canvasId: string;
  nodeId: string;
  runId: string;
  jobId: string;
};

/**
 * 媒体转存所需的最小运行时上下文。
 *
 * 重启后的终态对账要在**没有 worker、没有 provider** 的情况下把 durable 结果重新转存
 * Media，所以转存/投影入口只依赖这几个成员，而不是完整的 `TaskRuntimeOptions`。
 */
export type MaterializationContext = Pick<
  TaskRuntimeOptions,
  "taskStore" | "history" | "mediaClient" | "logger"
>;

export type TaskRuntime = {
  server: PptaskWorkerServer;
  /** 停止认领循环并等待在飞执行收尾；grace 超时后 abort 上游 drive。 */
  close: () => Promise<void>;
};

/** 需要 Media 持久化的二进制媒体类型。 */
export type BinaryModelType = "image" | "audio" | "video";
