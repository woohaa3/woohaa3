import type { RecordingStatusView } from "@woohaa3/contracts";
import { recordingThemeBackdrop } from "./recording-theme-backdrop.js";
import type { FilmSetHostContext as Context } from "../../state/browser/host-ports.js";

/**
 * 原生「生成视频」的参数组装（change: 2026-10-19-extend-film-set-for-motion-graphics，D6/D7）。
 *
 * 前端是唯一持有当前主题与本地导出偏好的地方：这里把 profile 与主题镜头背景解析成**具体值**
 * 交给宿主，宿主与扩展不再自行猜测。纯函数，便于单测。
 */
export function nativeExportSubmission(input: {
  target: { nodeId: string; clipId: string; displayVersion?: string };
  profile: import("@woohaa3/contracts").FilmSetExportProfile;
  themeBackdrop: string;
}): { nodeId: string; clipId: string; profile: import("@woohaa3/contracts").FilmSetExportProfile; themeBackdrop: string; displayVersion?: string } {
  return {
    nodeId: input.target.nodeId,
    clipId: input.target.clipId,
    profile: input.profile,
    themeBackdrop: input.themeBackdrop,
    ...(input.target.displayVersion ? { displayVersion: input.target.displayVersion } : {})
  };
}

/** 当前页面的主题镜头背景（供原生导出控件调用）。 */
export function nativeExportThemeBackdrop(ctx: Context): string {
  return recordingThemeBackdrop(ctx);
}

/**
 * 任务状态是否仍属于「这个提交」：`requestId` 一致才认，避免把同 canvas 的旧任务当成本次结果。
 *
 * 成功时返回时带上的 `nodeId` 就是新视频节点（D8：成功只在节点提交后成立）。
 */
export function sameExportJob(status: RecordingStatusView, requestId: string): boolean {
  return status.requestId === requestId;
}
