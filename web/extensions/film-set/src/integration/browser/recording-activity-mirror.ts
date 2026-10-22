/**
 * 宿主录制任务 → 画布活动浮层（前端侧）
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 5.5 / design D9）。
 *
 * 归属说明：`extension.activity.updated` 是**页面 scope** 的事件，只有前端能发。
 * 因此宿主只提供权威状态（`GET /recording`），这里把它投影成后台活动：
 *
 * - **进入页面不回填**：先读一次高水位作为基线，只投影**之后**变化的任务；
 * - **每次尝试一条**：activity id 含 attemptId；
 * - **5% 节流**：复用 `toActivityJob` 的分桶；
 * - **终态不复活**：由 `RecordingActivityProjector` 保证；
 * - **不写 durable 历史**：只发事件。
 *
 * 断开（切画布/卸载/隐藏）只停止观察，不取消原生任务。
 */
import type { BackgroundActivityJob, RecordingStatusView } from "@woohaa3/contracts";
import { RecordingActivityProjector, type HostRecordingState } from "@woohaa3/contracts";

export type RecordingActivityMirrorOptions = {
  canvasId: () => string;
  /** 读取当前任务列表（宿主权威状态）。 */
  list: (canvasId: string) => Promise<RecordingStatusView[]>;
  /** 发布活动（`ctx.emit("extension.activity.updated", { job })`）。 */
  emit: (job: BackgroundActivityJob) => void;
  pollIntervalMs?: number;
  /** 出现在进入页面之前、且已终态的任务视为「历史」，不回填。 */
  isHistorical?: (status: RecordingStatusView) => boolean;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

/** 把宿主状态映射成投影器输入。 */
export function toActivityInput(
  status: RecordingStatusView,
  canvasId: string,
  /** 显式标题优先于宿主透出的 `status.title`；两者都没有才退回兜底文案。 */
  title?: string
): {
  jobId: string;
  attemptId: string;
  canvasId: string;
  nodeId: string;
  title: string;
  purpose: "reference" | "export";
  state: HostRecordingState;
  completedFrames: number;
  totalFrames: number;
  error?: string;
  updatedAt: string;
} {
  return {
    jobId: status.jobId,
    // 同一 jobId 的成功重试会换 attempt；状态里没有 attemptId 时用 jobId 兜底，
    // 保证「每次尝试一条」在可见层面成立。
    attemptId: (status as { attemptId?: string }).attemptId ?? status.jobId,
    canvasId,
    nodeId: status.nodeId ?? "",
    title: title ?? status.title ?? "片场录制",
    purpose: status.purpose,
    state: status.state as HostRecordingState,
    completedFrames: status.completedFrames,
    totalFrames: status.totalFrames,
    ...(status.error ? { error: status.error.message } : {}),
    updatedAt: status.updatedAt
  };
}

/**
 * 活动镜像：轮询宿主状态并投影成浮层事件。
 *
 * 返回 `stop()`：只停止观察（不取消任务）。
 */
export function startRecordingActivityMirror(options: RecordingActivityMirrorOptions): { stop: () => void } {
  const projector = new RecordingActivityProjector(options.emit);
  const interval = Math.max(250, options.pollIntervalMs ?? 1_000);
  const setTimer = options.setTimeoutImpl ?? setTimeout;
  const clearTimer = options.clearTimeoutImpl ?? clearTimeout;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 进入页面时已存在的任务 id → 视为基线（不补出历史）。 */
  const baseline = new Set<string>();
  let baselined = false;

  const isHistorical =
    options.isHistorical ??
    ((status: RecordingStatusView) =>
      status.state === "succeeded" ||
      status.state === "cancelled" ||
      status.state === "failed" ||
      status.state === "stale");

  const tick = async () => {
    if (stopped) return;
    const canvasId = options.canvasId();
    if (!canvasId) {
      schedule();
      return;
    }
    let statuses: RecordingStatusView[] = [];
    try {
      statuses = await options.list(canvasId);
    } catch {
      // 查询失败不阻塞：下一轮再试，且不改动已发布状态。
      schedule();
      return;
    }
    if (!baselined) {
      // 高水位：进入页面时**已终态**的任务不回填（运行中的仍要显示，否则会永久缺记录）。
      for (const status of statuses) {
        if (isHistorical(status)) baseline.add(status.jobId);
      }
      baselined = true;
    }
    for (const status of statuses) {
      if (baseline.has(status.jobId)) continue;
      projector.publish(toActivityInput(status, canvasId));
    }
    schedule();
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimer(() => void tick(), interval);
  };

  void tick();

  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    }
  };
}
