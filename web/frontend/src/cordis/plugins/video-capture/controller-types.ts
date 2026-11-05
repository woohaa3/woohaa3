/**
 * 视频编辑入口能力契约（由 video-capture Plugin 提供）
 * （change: 2026-09-28-split-frontend-god-plugins，task 5）。
 *
 * Task Execution 的 `edit_video` 面板按 `VIDEO_EDIT_SERVICE` capability 消费本接口；
 * 实现由 video-capture Plugin 注入（Dialog/Media/Canvas 服务）。
 */
import type { ExecutionPanelData } from "../task-execution/execution-panel/types.js";
import type { ServerCanvas } from "@woohaa3/contracts";

/**
 * 视频编辑入口/删除能力（由 video-capture Plugin 实现，经注入的 Dialog/Media/Canvas 服务）。
 */
export type VideoEditController = {
  /** 解析节点当前 canonical ready 视频；不可编辑时返回禁用原因。 */
  resolveEntry(input: {
    canvas: ServerCanvas | null;
    nodeId: string;
    writable: boolean;
    pending: boolean;
    taskPending: boolean;
  }): { ok: true } | { ok: false; reason: string };
  /** 打开编辑 dialog（`intentId` 提供时预选）。 */
  openEdit(input: { canvas: ServerCanvas | null; nodeId: string; intentId?: string; ownOutput?: boolean }): void;
  /** 打开截帧 dialog（从 `edit_video` 面板的帧捕获入口）。 */
  openFrameCapture(input: { canvas: ServerCanvas | null; nodeId: string }): { ok: boolean; error?: string };
  /** 删除单个 intent。 */
  removeIntent(input: { canvas: ServerCanvas | null; nodeId: string; intentId: string }): void;
  /** 投影面板 chips（含稳定同源 preview URL）。 */
  projectIntents(canvas: ServerCanvas | null, nodeId: string): NonNullable<ExecutionPanelData["videoEditIntents"]>;
};

export type VideoEditEntryResolution = { ok: true } | { ok: false; reason: string };
