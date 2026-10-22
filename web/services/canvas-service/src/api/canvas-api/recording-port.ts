/**
 * 原生录制 HTTP 端口（change: 2026-10-17-add-native-offscreen-film-set-recording）。
 *
 * 类型唯一来源在 `@woohaa3/contracts`（`content-recording-port`）；这里只做本包内部转发，
 * 避免 canvas-service 与 backend 互相引用实现文件。
 */
export {
  decodeRecordingSubmitRequest,
  type CanvasRecordingPort,
  type RecordingCancelOutcome,
  type RecordingStatusOutcome,
  type RecordingStatusView,
  type RecordingSubmitOutcome,
  type RecordingSubmitRequest
} from "@woohaa3/contracts";
