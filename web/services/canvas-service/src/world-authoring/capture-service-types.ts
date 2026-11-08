/**
 * Public and internal state shapes for the T10 capture scheduler.
 */
import type {
  WorldCaptureFramingStatus,
  WorldCaptureGenerationBinding,
  WorldCaptureMediaSavePort,
  WorldCaptureProducer,
  WorldCaptureProducerRegistration,
  WorldCaptureRefreshOutcome,
  WorldCaptureVersionKey
} from "@woohaa3/contracts";

export const DEFAULT_FREEZE_TIMEOUT_MS = 15_000;
export const DEFAULT_CLAIM_TTL_MS = 10 * 60_000;

export type WorldCaptureServiceOptions = {
  resultStore?: import("./capture-result-store.js").CaptureResultStore;
  resolveRoom(canvasId: string): Promise<import("../sync/room.js").CanvasRoom | null>;
  /** Trusted save port (host injects the media service adapter). Missing means fail closed. */
  mediaSave?: WorldCaptureMediaSavePort;
  /** Trusted video save port for dynamic shots; missing means no video can be frozen. */
  videoMediaSave?: import("@woohaa3/contracts").WorldCaptureVideoMediaSavePort;
  /** 动态输出长边（像素），默认 1024。 */
  dynamicOutputLongEdge?: number;
  /** 动态默认帧率，默认 24。 */
  dynamicFps?: number;
  /** Static capture long edge in pixels; host configuration, never a browser claim. */
  outputLongEdge?: number;
  /** How long generation acceptance may wait for one exact key. */
  freezeTimeoutMs?: number;
  /** Frozen binding claim lifetime. */
  claimTtlMs?: number;
  now?: () => number;
  logger?: (event: Record<string, unknown>) => void;
};

export type WorldCaptureClaimInput = {
  canvasId: string;
  requestId: string;
  binding: WorldCaptureGenerationBinding;
};

export type WorldCaptureClaimResult =
  | { ok: true; binding: WorldCaptureGenerationBinding }
  | { ok: false; code: "unknown-capture" | "capture-expired" | "capture-mismatch"; message: string };

/** 页面渲染路径的预备结果：输出尺寸 + 当前 canonical 版本键。 */
export type WorldCapturePagePrepareOutcome =
  | { ok: true; key: WorldCaptureVersionKey; width: number; height: number; attemptId: string }
  | { ok: false; code: string; message: string };

/**
 * 页面渲染路径的待取景项：宿主已观察到该镜头当前 canonical 版本，等待前端渲染并提交。
 * 页面按它渲染后走 commit 接口回填，宿主只做版本校验、可信 Media 保存与冻结。
 */
export type PendingPageCapture = {
  attemptId?: string;
  canvasId: string;
  cameraId: string;
  /** 基础六字段键（静态图片或动态视频共享）。 */
  key: WorldCaptureVersionKey;
  width: number;
  height: number;
  requestId?: string;
  /** `dynamic` 时页面逐帧渲染并由浏览器 WebCodecs 编码成 MP4。 */
  kind?: "static" | "dynamic";
  /** 动态镜头的完整冻结键（含动画/区间/fps），页面提交视频时必须原样回传。 */
  dynamicKey?: import("@woohaa3/contracts").WorldCaptureDynamicVersionKey;
  fps?: number;
  timeRange?: import("@woohaa3/contracts").WorldCaptureTimeRange;
  /** 需要动画采样的导演区节点；页面按时间固定采样后逐帧捕获。 */
  animationNodeId?: string;
};

export type WorldCaptureVideoProducer = {
  producerId: string;
  captureVideo: NonNullable<WorldCaptureProducer["captureVideo"]>;
  resolveContent?: WorldCaptureProducer["resolveContent"];
};

export type WorldCaptureService = {
  registerProducer(producer: WorldCaptureProducer): WorldCaptureProducerRegistration;
  /**
   * 注册动态镜头视频生产者（原生编码）。与静态图片 producer 分开：缺少它时动态镜头
   * 显式不可用，静态页面取景不受影响。
   */
  registerVideoProducer(producer: WorldCaptureVideoProducer): WorldCaptureProducerRegistration;
  notifyResourcesReady(notice: import("@woohaa3/contracts").WorldCaptureResourceReadyNotice): void;
  /** Observe a committed canonical snapshot; only a changed authoring key starts work. */
  observeCanonical(input: { canvasId: string; canvas: import("@woohaa3/contracts").ServerCanvas; startup?: boolean }): void;
  refresh(input: { canvasId: string; cameraId: string; force?: boolean }): Promise<WorldCaptureRefreshOutcome>;
  status(input: { canvasId: string; cameraId: string }): WorldCaptureFramingStatus;
  /** 当前画布全部已观察镜头的状态；供卡片显示 preview/ready/stale/failed。 */
  statuses(canvasId: string): WorldCaptureFramingStatus[];
  freezeForGeneration(input: {
    canvasId: string;
    cameraId: string;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<import("@woohaa3/contracts").WorldCaptureFreezeOutcome>;
  /**
   * 页面渲染路径的预备：解析当前 canonical 取景，返回输出尺寸与版本键；页面据此渲染。
   * 不启动原生 producer，也不改变原生产者的取景状态机。
   */
  preparePageCapture(input: { canvasId: string; cameraId: string }): Promise<WorldCapturePagePrepareOutcome>;
  /**
   * 页面渲染路径的提交：校验页面渲染版本仍是当前 canonical 取景，经可信 Media 端口保存后
   * 冻结并申领 binding；版本不一致返回 superseded，不产生替代画面。
   */
  /**
   * 动态镜头的页面视频提交：校验当前动态键、经可信视频端口保存后冻结并申领 binding。
   */
  commitPageVideoCapture(input: {
    attemptId?: string;
    canvasId: string;
    cameraId: string;
    key: import("@woohaa3/contracts").WorldCaptureDynamicVersionKey;
    video: import("@woohaa3/contracts").WorldCaptureVideo;
  }): Promise<import("@woohaa3/contracts").WorldCaptureFreezeOutcome>;
  commitPageCapture(input: {
    attemptId?: string;
    canvasId: string;
    cameraId: string;
    key: WorldCaptureVersionKey;
    png: Uint8Array;
    width: number;
    height: number;
  }): Promise<import("@woohaa3/contracts").WorldCaptureFreezeOutcome>;
  /**
   * 页面驱动渲染的待取景清单：宿主观察到镜头/世界版本变化的项，供前端主动渲染并提交。
   * 无待取景项时返回空数组。
   */
  pendingPageCaptures(canvasId: string): PendingPageCapture[];
  reportPageProgress(canvasId: string, input: import("@woohaa3/contracts").WorldCapturePageProgress): boolean;
  /** Validate a completed freeze immediately before durable run acceptance. */
  claimForGeneration(input: WorldCaptureClaimInput): WorldCaptureClaimResult;
  forgetCanvas(canvasId: string): void;
  dispose(): void;
};

export type Attempt = {
  attemptId: number;
  requestId: string;
  key: WorldCaptureVersionKey;
  controller: AbortController;
  promise: Promise<void>;
};

export type FramingState = {
  pageAttemptId?: string;
  pageProgressAt?: number;
  pageProgress?: import("@woohaa3/contracts").WorldCapturePageProgress;
  canvasId: string;
  cameraId: string;
  /** 静态镜头是静态键；动态镜头是基础六字段键（outputVersion 已覆盖动画/区间/fps）。 */
  key: WorldCaptureVersionKey | null;
  /** 动态镜头的完整冻结键；静态镜头为 null。 */
  dynamicKey?: import("@woohaa3/contracts").WorldCaptureDynamicVersionKey | null;
  kind: "static" | "dynamic";
  phase: WorldCaptureFramingStatus["phase"];
  stale: boolean;
  frozen?: import("@woohaa3/contracts").WorldCaptureFrozenInput;
  frozenVideo?: import("@woohaa3/contracts").WorldCaptureVideoFrozenInput;
  /** 动态镜头关联的动画时长（秒），供卡片显示。 */
  durationSeconds?: number;
  lastRequestId?: string;
  lastContentFingerprint?: string;
  width?: number;
  height?: number;
  reason?: string;
  attempt?: Attempt;
  attemptCounter: number;
  observation?: import("./capture-snapshot.js").CameraObservation;
};

export type Claim = {
  binding: WorldCaptureGenerationBinding;
  createdAt: number;
};

export function statusOf(state: FramingState): WorldCaptureFramingStatus {
  const frozen = state.frozen;
  const video = state.frozenVideo;
  return {
    canvasId: state.canvasId,
    cameraId: state.cameraId,
    key: state.key,
    phase: state.phase,
    stale: state.stale,
    shotKind: state.kind,
    ...(state.durationSeconds !== undefined ? { durationSeconds: state.durationSeconds } : {}),
    ...(state.lastRequestId ? { requestId: state.lastRequestId } : {}),
    ...(state.lastContentFingerprint ? { contentFingerprint: state.lastContentFingerprint } : {}),
    ...(frozen ? { input: { key: frozen.key, mediaId: frozen.media.mediaId, checksum: frozen.media.checksum } } : {}),
    ...(video ? { video: video.media } : {}),
    ...(video && state.phase === "ready" && !state.stale && state.dynamicKey ? { dynamicKey: state.dynamicKey } : {}),
    ...(state.width !== undefined ? { width: state.width } : {}),
    ...(state.height !== undefined ? { height: state.height } : {}),
    ...(state.reason ? { reason: state.reason } : {})
  };
}

export function emptyStatus(canvasId: string, cameraId: string): WorldCaptureFramingStatus {
  return { canvasId, cameraId, key: null, phase: "empty", stale: false };
}
