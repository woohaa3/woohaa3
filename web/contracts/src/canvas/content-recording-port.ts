/**
 * 原生录制的宿主 HTTP 端口（change: 2026-10-17-add-native-offscreen-film-set-recording）
 *
 * 放在 contracts 里：canvas-service 与 backend 都要依赖它，跨包引用实现文件会破坏依赖方向。
 *
 * 原生录制的宿主 HTTP 端口
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 7.1）。
 *
 * 前端只做 submit / cancel / status 三件事：
 * - 不传逐帧像素、不驱动录制时钟、不轮询取帧；
 * - 桌面任务不因切片段/退出聚焦/页面重载/窗口最小化而取消（取消只能显式请求）；
 * - 状态查询只读，不回填活动历史。
 *
 * 实现由宿主装配注入（`CanvasServiceOptions.recording`），本文件只定义形状与解码。
 */

/** 提交请求：稳定身份 + 用途 + profile；不包含任何像素或播放状态。 */
export type RecordingSubmitRequest = {
  /** 幂等请求 id；重试同一 id 不会创建第二个任务。 */
  requestId: string;
  purpose: "reference" | "export";
  nodeId: string;
  clipId: string;
  /** 期望的 profile key（扩展决定是否支持）。 */
  profileKey?: string;
  /** 提交时前端已知的内容版本（仅用于「提交时版本」展示，不作为权威）。 */
  displayVersion?: string;
};

/** 任务状态投影（只读，可重连查询）。 */
export type RecordingStatusView = {
  jobId: string;
  requestId: string;
  purpose: "reference" | "export";
  state:
    | "queued"
    | "preparing"
    | "rendering"
    | "paused"
    | "encoding"
    | "uploading"
    | "committing"
    | "succeeded"
    | "cancelled"
    | "failed"
    | "stale";
  completedFrames: number;
  totalFrames: number;
  /** 0..1；缺失表示不确定。 */
  progress?: number;
  /**
   * 冻结时得到的展示标题（如「导演场 · 岩洞潜行 · 12秒」）。
   *
   * 宿主是唯一知道标题的一方；前端活动浮层不能自己拼业务标题，只用这里透出的值。
   * 内存任务记录被清理或重启后缺失，调用方须自带兜底文案。
   */
  title?: string;
  /** 提交时冻结的内容版本（供 UI 标注「提交时版本」）。 */
  submittedVersion?: string;
  /** 显式导出成功后创建的节点 id。 */
  nodeId?: string;
  error?: {
    stage: string;
    code: string;
    message: string;
    frameIndex?: number;
    sampleTime?: number;
  };
  updatedAt: string;
};

export type RecordingSubmitOutcome =
  | { ok: true; jobId: string; state: RecordingStatusView["state"]; duplicate: boolean }
  | { ok: false; code: string; message: string };

export type RecordingCancelOutcome =
  | { ok: true; cancelled: true }
  | { ok: false; code: "recording-too-late" | "recording-unknown-job" | string; message: string };

export type RecordingStatusOutcome =
  | { ok: true; status: RecordingStatusView }
  | { ok: false; code: string; message: string };

/** 宿主注入的端口实现。 */
export type CanvasRecordingPort = {
  submit(input: { canvasId: string; body: RecordingSubmitRequest }): Promise<RecordingSubmitOutcome>;
  cancel(input: { canvasId: string; jobId: string }): Promise<RecordingCancelOutcome>;
  status(input: { canvasId: string; jobId: string }): Promise<RecordingStatusOutcome>;
  /** 当前画布仍在跟踪的任务（页面重连用）；不回填历史。 */
  list(input: { canvasId: string }): Promise<RecordingStatusView[]>;
};

/** 解码提交请求；非法结构返回 `null`，由路由给 400。 */
export function decodeRecordingSubmitRequest(value: unknown): RecordingSubmitRequest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : "");
  const requestId = text("requestId");
  const nodeId = text("nodeId");
  const clipId = text("clipId");
  const purpose = record.purpose === "reference" || record.purpose === "export" ? record.purpose : null;
  if (!requestId || !nodeId || !clipId || !purpose) return null;
  const profileKey = text("profileKey");
  const displayVersion = text("displayVersion");
  return {
    requestId,
    purpose,
    nodeId,
    clipId,
    ...(profileKey ? { profileKey } : {}),
    ...(displayVersion ? { displayVersion } : {})
  };
}

/**
 * Native 录制的 profile 身份（change: 2026-10-17-add-native-offscreen-film-set-recording）。
 *
 * 与浏览器侧 `shotReferenceProfileKey`（`…-r2`）**不共享**：旧缓存仍是合法历史引用，但不会被
 * native 任务命中，native 产物也不会覆盖浏览器缓存。渲染/编译/编码语义版本都进入 key，
 * 任一变化即产生新版本。
 */
export const NATIVE_RECORDING_RENDERER_VERSION = "bevy-shot-recorder-1";
export const NATIVE_RECORDING_COMPILER_VERSION = "film-set-compiler-1";
export const NATIVE_RECORDING_CODEC_VERSION = "openh264-0.9.9";
export const NATIVE_RECORDING_COLOR_REVISION = "srgb-bt709-limited-1";
export const NATIVE_RECORDING_FRAME_RATE = 30;

/** 录制输出尺寸：短边 720、偶数、保持镜头画幅（与浏览器导出同一规则）。 */
export function nativeRecordingVideoSize(aspect: string): { width: number; height: number } {
  const [width, height] = aspect.split(":").map(Number);
  const ratio = width > 0 && height > 0 ? width / height : 16 / 9;
  return ratio >= 1
    ? { width: Math.round((720 * ratio) / 2) * 2, height: 720 }
    : { width: 720, height: Math.round(720 / ratio / 2) * 2 };
}

/** native profile key：尺寸 + 帧率 + 渲染/编译/编码/色彩版本。 */
export function nativeRecordingProfileKey(aspect: string): string {
  const size = nativeRecordingVideoSize(aspect);
  return [
    "native-v1",
    `${size.width}x${size.height}@${NATIVE_RECORDING_FRAME_RATE}`,
    NATIVE_RECORDING_RENDERER_VERSION,
    NATIVE_RECORDING_COMPILER_VERSION,
    NATIVE_RECORDING_CODEC_VERSION,
    NATIVE_RECORDING_COLOR_REVISION
  ].join("-");
}
