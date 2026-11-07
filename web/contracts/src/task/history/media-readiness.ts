/**
 * 任务媒体就绪派生（change: 2026-11-06-fix-media-output-readiness）。
 *
 * 节点输出、预览、下载与活动项都从这一处判断「媒体能不能用」，避免每个入口各猜一遍
 * 任务状态。规则只有一条：二进制成功后必须同时有稳定 `storageKey` 与 `checksum` 才算
 * ready；任务仍是非终态、或 provider 已产出但 worker 正在转存时是 preparing；终态失败
 * 是 failed。没有稳定身份的「成功」结果永远不会被判 ready。
 */
import type { TaskExecutionState, TaskModelType, TaskResultSummary } from "./types.js";

/** 统一媒体就绪状态。 */
export type TaskMediaReadiness =
  /** 非媒体结果（文本），没有媒体入口需要门禁。 */
  | "not-media"
  /** 媒体任务仍在排队/执行（provider 尚未给出结果）。 */
  | "pending"
  /** provider 已给出结果，正在转存稳定媒体；成功媒体入口必须禁用。 */
  | "preparing"
  /** 稳定媒体身份完整，可以预览/下载/作为成功输出。 */
  | "ready"
  /** 任务失败/取消，且没有可用的稳定输出。 */
  | "failed";

export type TaskMediaReadinessInput = {
  state: TaskExecutionState;
  modelType?: TaskModelType;
  result?: Pick<TaskResultSummary, "mediaKind" | "mediaState" | "storageKey" | "checksum" | "poster">;
};

function isBinaryKind(value: string | undefined): value is "image" | "video" | "audio" {
  return value === "image" || value === "video" || value === "audio";
}

/** 该任务是否属于二进制媒体任务（模型类型或结果都可用于判定）。 */
export function isBinaryTaskMedia(input: Pick<TaskMediaReadinessInput, "modelType" | "result">): boolean {
  if (input.modelType === "language") return false;
  if (isBinaryKind(input.modelType)) return true;
  const kind = input.result?.mediaKind;
  return isBinaryKind(kind);
}

/** 结果是否带完整稳定媒体身份；文本/缺字段一律 false。 */
export function hasStableMediaMetadata(
  result: Pick<TaskResultSummary, "storageKey" | "checksum"> | undefined
): boolean {
  return typeof result?.storageKey === "string" && result.storageKey !== ""
    && typeof result.checksum === "string" && result.checksum !== "";
}

/**
 * 派生媒体就绪状态。
 *
 * - 失败/取消优先：没有成功媒体入口可开；
 * - materializing 先于状态：provider 已返回、worker 正在转存时即使记录仍 running 也显示准备中；
 * - succeeded 的二进制结果必须有稳定身份才算 ready，缺失时保持 preparing（不伪造成功）。
 */
export function taskMediaReadiness(input: TaskMediaReadinessInput): TaskMediaReadiness {
  if (input.state === "failed" || input.state === "cancelled") return "failed";
  const binary = isBinaryTaskMedia(input);
  if (!binary) return "not-media";
  if (input.result?.mediaState === "materializing") return "preparing";
  if (input.state !== "succeeded") return "pending";
  return hasStableMediaMetadata(input.result) ? "ready" : "preparing";
}

/**
 * 画布资产的就绪判定（节点输出/预览/下载共用）。
 *
 * 除 `status: ready` 外还要求稳定 `storageKey`（受控同源地址的来源）：历史记录里可能出现
 * 只带地址占位的「成功」资产，它们不能开启下载入口。`checksum` 是可选校验信息，旧资产
 * 可能没有，不能因此把可用媒体判死。
 */
export function hasReadyMediaAsset(asset: {
  status?: string;
  metadata?: { storageKey?: unknown; checksum?: unknown };
} | null | undefined): boolean {
  if (!asset || asset.status !== "ready") return false;
  return typeof asset.metadata?.storageKey === "string" && asset.metadata.storageKey !== "";
}
