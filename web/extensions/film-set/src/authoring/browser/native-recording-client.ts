/**
 * 桌面「生成视频」的宿主任务适配
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 7.1 / 7.3）。
 *
 * 与浏览器路径的区别：
 * - 提交后**不再**占用可见播放器，也不接管播放头；
 * - 取消是显式请求，切片段/重载/隐藏不取消任务；
 * - 状态来自宿主查询，不是本地进度模拟；
 * - 能力缺失时给出具体原因，不显示「换个浏览器」。
 *
 * 浏览器-only 部署继续用 `film-set-video-export.ts`（不动）。
 */
import type { CanvasRemoteService, NodeHistoryResult } from "@woohaa3/frontend/extension-api";
import type { RecordingStatusView } from "@woohaa3/contracts";

/** 原生录制是否可用；不可用时带上具体原因。 */
export type NativeRecordingAvailability =
  | { available: true }
  | { available: false; reason: string; code: string };

/** 后端能力码 → 可读原因（保留浏览器 AVC 提示的独立性）。 */
export function describeRecordingFailure(code: string, message: string): string {
  switch (code) {
    case "recording-unavailable":
      return "当前构建未启用原生录制能力，无法生成视频";
    case "recording-executor-unavailable":
      return "本机录制执行器未就绪，请从桌面应用启动后重试";
    case "recording-executor-software-gpu":
      return "当前只有软件渲染适配器，不能产出可验收的录制画面";
    case "recording-capability-missing":
      return message || "本机缺少录制所需的编码或解码能力";
    case "recording-profile-unsupported":
      return message || "录制规格与片段比例不匹配，请重新提交";
    case "recording-source-invalid":
      return message || "当前片段没有可导出的有效时长或内容";
    case "recording-source-removed":
      return "源片场或片段已删除，无法保存视频";
    case "recording-budget-exceeded":
      return "素材或时长超出录制预算，请缩短片段后重试";
    case "recording-too-late":
      return "视频已在保存阶段，无法取消";
    case "recording-cancelled":
      return "已取消生成";
    default:
      // 后端给了具体 message 就透出，不替换成笼统文案。
      return message || "视频生成失败，请重试";
  }
}

/** 提交时冻结的版本信息：用于在进度中标注「提交时版本」。 */
export type RecordingSubmission = {
  jobId: string;
  /** 提交时选中的 clip/内容版本（仅展示）。 */
  submittedVersion?: string;
  initialState: RecordingStatusView["state"];
};

export type RecordingDriverDeps = {
  remote: Pick<CanvasRemoteService, "recordingSubmit" | "recordingStatus" | "recordingCancel">;
  canvasId: string;
  now?: () => number;
  /** 轮询间隔（毫秒）。 */
  pollIntervalMs?: number;
  /** 等待上限：超时后提示但仍保留查询入口（任务继续）。 */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type RecordingDriver = {
  /** 提交一次显式导出；返回任务 id 与提交时版本。 */
  submit(input: {
    requestId: string;
    nodeId: string;
    clipId: string;
    profileKey?: string;
    /** 显式导出 profile（D7）；参考录制固定 standard。 */
    profile?: import("@woohaa3/contracts").FilmSetExportProfile;
    /** 主题镜头背景的具体色（D6）；镜头背景为 theme 时使用。 */
    themeBackdrop?: string;
    purpose?: "reference" | "export";
    displayVersion?: string;
    onProgress?: (status: RecordingStatusView) => void;
  }): Promise<
    | { ok: true; submission: RecordingSubmission }
    | { ok: false; code: string; message: string }
  >;
  /** 等待终态；超时返回 `pending`（任务仍在跑，可继续查询）。 */
  wait(jobId: string, onProgress?: (status: RecordingStatusView) => void): Promise<
    | { ok: true; status: RecordingStatusView }
    | { ok: false; code: string; message: string }
    | { ok: false; code: "recording-still-running"; message: string; status: RecordingStatusView }
  >;
  /** 取消；`too-late` 原样返回，不谎称取消成功。 */
  cancel(jobId: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /** 重连后查询（不启动新任务）。 */
  status(jobId: string): Promise<NodeHistoryResult<{ status: RecordingStatusView }>>;
};

export function createRecordingDriver(deps: RecordingDriverDeps): RecordingDriver {
  const now = deps.now ?? (() => Date.now());
  const pollIntervalMs = Math.max(100, deps.pollIntervalMs ?? 400);
  const timeoutMs = Math.max(1_000, deps.timeoutMs ?? 10 * 60_000);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  return {
    async submit(input) {
      const result = await deps.remote.recordingSubmit({
        canvasId: deps.canvasId,
        request: {
          requestId: input.requestId,
          purpose: input.purpose ?? "export",
          nodeId: input.nodeId,
          clipId: input.clipId,
          ...(input.profileKey ? { profileKey: input.profileKey } : {}),
          ...(input.profile ? { profile: input.profile } : {}),
          ...(input.themeBackdrop ? { themeBackdrop: input.themeBackdrop } : {}),
          ...(input.displayVersion ? { displayVersion: input.displayVersion } : {})
        }
      });
      if (!result.ok) {
        return {
          ok: false,
          code: result.code,
          message: describeRecordingFailure(result.code, result.error)
        };
      }
      return {
        ok: true,
        submission: {
          jobId: result.value.jobId,
          ...(input.displayVersion ? { submittedVersion: input.displayVersion } : {}),
          initialState: result.value.state
        }
      };
    },

    async wait(jobId, onProgress) {
      const deadline = now() + timeoutMs;
      let last: RecordingStatusView | null = null;
      while (now() < deadline) {
        const result = await deps.remote.recordingStatus({ canvasId: deps.canvasId, jobId });
        if (!result.ok) {
          return {
            ok: false,
            code: result.code,
            message: describeRecordingFailure(result.code, result.error)
          };
        }
        last = result.value.status;
        onProgress?.(last);
        if (isTerminal(last.state)) {
          if (last.state === "succeeded") return { ok: true, status: last };
          return {
            ok: false,
            code: last.error?.code ?? `recording-${last.state}`,
            message: describeRecordingFailure(last.error?.code ?? "", last.error?.message ?? "")
          };
        }
        await sleep(pollIntervalMs);
      }
      // 超时不取消任务：它仍在宿主里跑，用户可以继续查询。
      return {
        ok: false,
        code: "recording-still-running",
        message: "视频仍在后台生成，可稍后在活动浮层查看结果",
        status: last ?? {
          jobId,
          requestId: "",
          purpose: "export",
          state: "rendering",
          completedFrames: 0,
          totalFrames: 0,
          updatedAt: new Date(now()).toISOString()
        }
      };
    },

    async cancel(jobId) {
      const result = await deps.remote.recordingCancel({ canvasId: deps.canvasId, jobId });
      if (!result.ok) {
        return {
          ok: false,
          code: result.code,
          message: describeRecordingFailure(result.code, result.error)
        };
      }
      return { ok: true };
    },

    status(jobId) {
      return deps.remote.recordingStatus({ canvasId: deps.canvasId, jobId });
    }
  };
}

/** 终态判定（与宿主状态机一致）。 */
export function isTerminal(state: RecordingStatusView["state"]): boolean {
  return state === "succeeded" || state === "cancelled" || state === "failed" || state === "stale";
}

/** 阶段中文标签（活动浮层与按钮共用）。 */
export function recordingStageLabel(status: RecordingStatusView): string {
  switch (status.state) {
    case "queued":
      return "排队中";
    case "preparing":
      return "准备场景";
    case "rendering": {
      const percent = Math.floor((status.progress ?? 0) * 100);
      return `生成视频 ${percent}%`;
    }
    case "paused":
      return "已暂停（等待交互结束）";
    case "encoding":
      return "编码中";
    case "uploading":
      return "上传视频中";
    case "committing":
      return "保存视频中";
    case "succeeded":
      return "视频已生成";
    case "cancelled":
      return "已取消";
    case "stale":
      return "内容已更新，本次录制作废";
    case "failed":
      return status.error?.message ?? "视频生成失败";
  }
}
