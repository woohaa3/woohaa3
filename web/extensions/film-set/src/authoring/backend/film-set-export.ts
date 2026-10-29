/**
 * agent 发起片场导出（change: 2026-10-19-extend-film-set-for-motion-graphics，D8）。
 *
 * MCP 只提交**意图**：canvasId / nodeId / clipId / profile / requestId / precondition。
 * 像素、播放头与浏览器句柄一概不进入这里；任务由本机宿主的原生录制完成，并按 requestId 幂等。
 *
 * 宿主没有原生录制端口时立即返回 `recording-unavailable` 与具体原因，不驱动浏览器页面取帧。
 */
import type { CanvasAuthority, CanvasRecordingPort, McpExportFilmSetClipOutcome, McpExportFilmSetClipRequest, McpGetFilmSetExportOutcome, McpGetFilmSetExportRequest, RecordingStatusView } from "@woohaa3/contracts";
import { readFilmSetAnimationProjection, filmSetAnimationsOf, filmSetContentHash } from "@woohaa3/contracts";

export type FilmSetExportServiceDependencies = {
  resolveRoom: (canvasId: string) => Promise<CanvasAuthority | null>;
  /** 宿主原生录制端口；缺失表示纯浏览器宿主。 */
  recording?: () => CanvasRecordingPort | undefined;
  /** 原生能力不可用的具体原因（宿主能力探测结果）。 */
  unavailableReason?: () => { code: string; message: string } | null;
  /** 主题镜头背景的具体色；`backdrop: "theme"` 时使用。 */
  themeBackdrop?: () => string;
};

/** 无原生录制时的稳定错误码与具体原因。 */
export const RECORDING_UNAVAILABLE = "recording-unavailable";

export class FilmSetExportService {
  constructor(private readonly deps: FilmSetExportServiceDependencies) {}

  async startExport(input: McpExportFilmSetClipRequest): Promise<McpExportFilmSetClipOutcome> {
    const canvasId = input.canvasId?.trim() ?? "";
    const nodeId = input.nodeId?.trim() ?? "";
    const clipId = input.clipId?.trim() ?? "";
    const requestId = input.requestId?.trim() ?? "";
    if (canvasId === "" || nodeId === "" || clipId === "" || requestId === "") {
      return { ok: false, code: "malformed-request", message: "canvasId / nodeId / clipId / requestId 不能为空" };
    }
    const port = this.recordingPort();
    if (!port) return unavailable(this.deps.unavailableReason?.() ?? null);
    const room = await this.deps.resolveRoom(canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${canvasId} 不存在` };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };
    const animation = readFilmSetAnimationProjection(exported.canvas, nodeId);
    if (!animation) return { ok: false, code: "invalid-animation-node", message: "片场分组或资源无法解析" };
    const clip = filmSetAnimationsOf(animation).clips.find(entry => entry.id === clipId);
    if (!clip) return { ok: false, code: "unknown-clip", message: `拍摄镜头 ${clipId} 不存在` };
    if (!(clip.timeline.duration > 0)) {
      return { ok: false, code: "recording-source-invalid", message: "该镜头没有可导出的正时长" };
    }
    if (input.expectedContentHash && input.expectedContentHash !== filmSetContentHash(animation.filmSetContent)) {
      return { ok: false, code: "stale-content", message: "片场内容已被并发修改，请重新读取后重试" };
    }
    const submission = await port.submit({
      canvasId,
      body: {
        requestId: `mcp-export:${canvasId}:${nodeId}:${clipId}:${requestId}`,
        purpose: "export",
        nodeId,
        clipId,
        profile: input.profile,
        ...(this.deps.themeBackdrop ? { themeBackdrop: this.deps.themeBackdrop() } : {})
      }
    });
    if (!submission.ok) return { ok: false, code: submission.code, message: submission.message };
    return {
      ok: true,
      canvasId,
      nodeId,
      clipId,
      jobId: submission.jobId,
      state: submission.state,
      duplicate: submission.duplicate
    };
  }

  async getExport(input: McpGetFilmSetExportRequest): Promise<McpGetFilmSetExportOutcome> {
    const canvasId = input.canvasId?.trim() ?? "";
    const jobId = input.jobId?.trim() ?? "";
    if (canvasId === "" || jobId === "") {
      return { ok: false, code: "malformed-request", message: "canvasId / jobId 不能为空" };
    }
    const port = this.recordingPort();
    if (!port) return unavailable(this.deps.unavailableReason?.() ?? null);
    const result = await port.status({ canvasId, jobId });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    const status = result.status;
    return {
      ok: true,
      canvasId,
      jobId: status.jobId,
      state: status.state,
      completedFrames: status.completedFrames,
      totalFrames: status.totalFrames,
      ...(status.progress === undefined ? {} : { progress: status.progress }),
      // 成功只在视频节点原子提交后成立：宿主状态里带的就是新节点 id。
      ...(status.state === "succeeded" && status.nodeId ? { nodeId: status.nodeId } : {}),
      ...(status.error
        ? { error: { code: status.error.code, message: status.error.message, ...(status.error.stage ? { stage: status.error.stage } : {}) } }
        : {})
    };
  }

  private recordingPort(): CanvasRecordingPort | undefined {
    const port = this.deps.recording?.();
    return port;
  }
}

/** 统一 `recording-unavailable`：带宿主给出的具体原因，不换成语焉不详的通用文案。 */
function unavailable(reason: { code: string; message: string } | null): { ok: false; code: string; message: string } {
  if (reason) return { ok: false, code: reason.code, message: reason.message };
  return {
    ok: false,
    code: RECORDING_UNAVAILABLE,
    message: "当前宿主未提供原生录制能力（纯浏览器或平台不支持），请改用界面上的「生成视频」走浏览器导出"
  };
}

/** 供结果映射：终态判定与活动浮层同源。 */
export function isExportTerminal(state: RecordingStatusView["state"]): boolean {
  return state === "succeeded" || state === "cancelled" || state === "failed" || state === "stale";
}
