/**
 * 宿主录制任务 → 画布活动浮层（change: 2026-10-17-add-native-offscreen-film-set-recording，任务 5.5）。
 *
 * 纯投影逻辑的唯一来源在 `@woohaa3/contracts`（`task/recording-activity`）：前端也要用它把
 * 宿主状态投影成浮层事件，放在 backend 会让扩展前端反向依赖宿主包。
 */
export {
  RecordingActivityProjector,
  activityDetail,
  activityStatus,
  recordingActivityId,
  toActivityJob,
  type HostRecordingActivityInput,
  type HostRecordingState
} from "@woohaa3/contracts";
