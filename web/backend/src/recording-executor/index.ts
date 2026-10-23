/**
 * 本机录制执行器通道的公共出口
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 1.4 / 1.5）。
 *
 * 宿主只从这里取：路径规则、注册表、socket 服务端与执行器侧 client。
 * 具体任务调度/状态机在 `recording-jobs.ts`（任务 5），不混在本目录。
 */
export {
  checkoutIdFor,
  cleanRecordingExecutorDirectory,
  ensureRecordingExecutorDirectory,
  ownedByCurrentUser,
  recordingExecutorPaths,
  recordingExecutorPlatformSupported,
  type RecordingExecutorPathOptions,
  type RecordingExecutorPaths
} from "./paths.js";
export {
  RecordingExecutorRegistry,
  type RecordingExecutorCapability,
  type RecordingExecutorErrorCode,
  type RecordingExecutorRegistration,
  type RecordingExecutorRegistrationRecord
} from "./registry.js";
export {
  RECORDING_EXECUTOR_PROTOCOL_FRAME_VERSION,
  startRecordingExecutorServer,
  type RecordingExecutorInbound,
  type RecordingExecutorPeer,
  type RecordingExecutorServer,
  type RecordingExecutorServerOptions
} from "./server.js";
export {
  connectRecordingExecutor,
  type RecordingExecutorClient,
  type RecordingExecutorClientOptions
} from "./client.js";
export {
  RecordingJobCoordinator,
  RECORDING_TERMINAL_STATES,
  isTerminalState,
  statusFor,
  type RecordingJobError,
  type RecordingJobEvent,
  type RecordingJobIdentity,
  type RecordingJobRecord,
  type RecordingJobState,
  type RecordingCancelResult,
  type RecordingFailureStage
} from "./coordinator.js";
export {
  finalizeRecording,
  readFileChunks,
  validateArtifactClaim,
  verifyArtifactBytes,
  type RecordingArtifactClaim,
  type RecordingCommitDeps,
  type RecordingFinalizeResult,
  type RecordingFinalizeFailure,
  type RecordingUploadedArtifact
} from "./finalize.js";
export { sweepRecordingWorkRoot, type RecordingSweepOptions } from "./sweep.js";
export {
  compareArtifact,
  probeArtifact,
  sha256Hex,
  verifyArtifact,
  type ArtifactProbe,
  type ArtifactProbeFailure
} from "./probe.js";
export {
  ExplicitRecordingQueue,
  ReferenceRecordingScheduler,
  referenceClaimKey,
  type ReferenceJob,
  type ReferenceSourceKey,
  type ReferenceSourceState
} from "./scheduler.js";
