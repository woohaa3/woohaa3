/**
 * 通过执行器通道派发录制任务
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 6.1 / 6.3）。
 *
 * 把冻结快照投影成 proto JSON 的 `submitJob`，经私有 socket 发给 supervisor/worker，
 * 等待 `stateChanged` 的成片事实或失败阶段，并把 progress 转给宿主协调器。
 *
 * 不传像素（只有 IR/媒体声明），不驱动时钟（时间表在快照里），不信任 worker 的自报尺寸
 * ——宿主随后用 `probe.ts` 从实际字节复核。
 *
 * change: 2026-10-22-remove-agent-execution-limits，任务 7.5 / design D7：这里原本有一个
 * 「等待成片的总预算」（缺省 10 分钟），到点即判定执行器丢失。它是任务**总时长**额度，
 * 会截断合法的大成片与慢解码。现在改为**执行器存活 watchdog**：只要仍在收到该 attempt 的
 * 进度或消息就持续等待；只有在一段完全没有活动（或连接关闭）后才报告执行器失联。
 * 活跃且有进度的执行不会因固定租约年龄被截断。
 */
import type { ContentRecordingSnapshot } from "@woohaa3/contracts";
import { RECORDING_PROTOCOL_VERSION } from "@woohaa3/contracts";
import type { RecordingArtifactClaim } from "./finalize.js";
import type { RecordingDispatcher } from "./host-service.js";
import type { RecordingJobIdentity } from "./coordinator.js";

export type ExecutorDispatcherOptions = {
  /** 发一条控制消息并返回是否写出成功。 */
  send: (message: Record<string, unknown>) => boolean;
  /** 订阅执行器回传的消息（由宿主把 socket 收到的 payload 转进来）。 */
  subscribe: (listener: (payload: Record<string, unknown>) => void) => () => void;
  /** 递增 sequence（同一连接单调）。 */
  nextSequence: () => number;
  logger?: (event: Record<string, unknown>) => void;
  /**
   * 执行器失联的**无活动**窗口（毫秒）。缺省 10 分钟；每收到该 attempt 的任何消息即重置。
   * 这是存活检测，不是任务总时长额度：持续有进度/心跳时永不触发。
   */
  idleTimeoutMs?: number;
};

/** 冻结快照 → proto JSON 的 `submitJob`。 */
export function toSubmitJobMessage(input: {
  sequence: number;
  requestId: string;
  identity: RecordingJobIdentity;
  snapshot: ContentRecordingSnapshot;
  purpose: "reference" | "export";
  leaseMs: number;
}): Record<string, unknown> {
  const { snapshot, identity } = input;
  return {
    protocolVersion: RECORDING_PROTOCOL_VERSION,
    sequence: String(input.sequence),
    submitJob: {
      sequence: String(input.sequence),
      requestId: input.requestId,
      purpose: input.purpose === "export" ? "RECORDING_PURPOSE_EXPORT" : "RECORDING_PURPOSE_REFERENCE",
      priority: input.purpose === "export" ? "RECORDING_PRIORITY_EXPORT" : "RECORDING_PRIORITY_REFERENCE",
      leaseMs: String(input.leaseMs),
      job: {
        jobId: identity.jobId,
        attemptId: identity.attemptId,
        executorInstanceId: identity.executorInstanceId,
        executionEpoch: String(identity.executionEpoch),
        snapshotHash: identity.snapshotHash,
        contentIdentity: identity.contentIdentity,
        profileKey: identity.profileKey
      },
      snapshot: {
        schemaVersion: snapshot.schemaVersion,
        compilerVersion: snapshot.compilerVersion,
        rendererVersion: snapshot.rendererVersion,
        origin: snapshot.origin,
        profile: {
          profileKey: snapshot.profile.profileKey,
          container: "RECORDING_CONTAINER_MP4",
          codec: "RECORDING_VIDEO_CODEC_H264",
          width: snapshot.profile.width,
          height: snapshot.profile.height,
          bitrate: snapshot.profile.bitrate,
          fastStart: snapshot.profile.fastStart,
          includeAudio: snapshot.profile.includeAudio,
          rendererVersion: snapshot.profile.rendererVersion,
          compilerVersion: snapshot.profile.compilerVersion,
          codecVersion: snapshot.profile.codecVersion,
          colorRevision: snapshot.profile.colorRevision
        },
        timing: {
          frameRateNumer: snapshot.timing.frameRateNumer,
          frameRateDenom: snapshot.timing.frameRateDenom,
          durationNumer: String(snapshot.timing.durationNumer),
          durationDenom: String(snapshot.timing.durationDenom)
        },
        // IR 是 UTF-8 JSON 文本；proto 侧是 bytes，经 ProtoJSON 传 base64。
        sceneIrJson: Buffer.from(snapshot.sceneIrJson, "utf8").toString("base64"),
        motionJson: Buffer.from(snapshot.motionJson, "utf8").toString("base64"),
        initialCamera: snapshot.initialCamera,
        aspect: snapshot.aspect,
        background: snapshot.background,
        resources: snapshot.resources.map(resource => ({
          resourceId: resource.resourceId,
          storageKey: resource.storageKey,
          checksum: resource.checksum,
          contentType: resource.contentType,
          sizeBytes: String(resource.sizeBytes),
          startTime: resource.playback.startTime,
          timeScale: resource.playback.timeScale,
          looped: resource.playback.looped,
          endTime: resource.playback.endTime,
          mediaDuration: resource.playback.mediaDuration
        }))
      }
    }
  };
}

/** 从 `stateChanged` payload 读取成片事实。 */
export function readArtifactClaim(payload: Record<string, unknown>): RecordingArtifactClaim | null {
  const artifact = payload.artifact;
  if (!artifact || typeof artifact !== "object") return null;
  const record = artifact as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : "");
  const num = (key: string) => {
    const value = record[key];
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number(value);
    return Number.NaN;
  };
  const path = text("path");
  const contentSha256 = text("contentSha256");
  const sizeBytes = num("sizeBytes");
  const width = num("width");
  const height = num("height");
  const frameCount = num("frameCount");
  const durationNumer = num("durationNumer");
  const durationDenom = num("durationDenom");
  if (!path || !/^[0-9a-f]{64}$/.test(contentSha256)) return null;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (!Number.isFinite(frameCount) || frameCount <= 0) return null;
  if (!Number.isFinite(durationNumer) || !Number.isFinite(durationDenom) || durationDenom === 0) return null;
  return {
    path,
    sizeBytes,
    contentSha256,
    width,
    height,
    frameCount,
    durationSeconds: durationNumer / durationDenom,
    mimeType: text("mimeType") || "video/mp4"
  };
}

/**
 * 创建 dispatcher。
 *
 * 只按 `attemptId` 归并消息：旧 attempt 的回执被丢弃（不覆盖新任务）。
 */
export function createExecutorDispatcher(options: ExecutorDispatcherOptions): RecordingDispatcher {
  const log = options.logger ?? (() => undefined);
  const idleTimeoutMs = Math.max(10_000, options.idleTimeoutMs ?? 10 * 60_000);
  return async input => {
    const requestId = `${input.identity.jobId}:${input.identity.attemptId}`;
      let settled = false;
    let unsubscribe: () => void = () => undefined;

    const result = await new Promise<
      | { ok: true; claim: RecordingArtifactClaim }
      | { ok: false; stage: string; code: string; message: string; transient: boolean }
    >(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (
        outcome:
          | { ok: true; claim: RecordingArtifactClaim }
          | { ok: false; stage: string; code: string; message: string; transient: boolean }
      ) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(outcome);
      };
      // 存活 watchdog：任何该 attempt 的消息都证明执行器仍在工作，重置无活动窗口。
      const armWatchdog = () => {
        if (settled) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          finish({
            ok: false,
            stage: "RECORDING_ERROR_STAGE_EXECUTOR_LOST",
            code: "recording-executor-unresponsive",
            message: "录制执行器长时间没有任何活动，判定失联",
            transient: true
          });
        }, idleTimeoutMs);
        if (typeof timer === "object" && timer !== null && "unref" in timer) (timer as { unref?: () => void }).unref?.();
      };
      armWatchdog();

      unsubscribe = options.subscribe(payload => {
        armWatchdog();
        // progress：只认本 attempt。
        const progress = payload.progress as Record<string, unknown> | undefined;
        if (progress && sameAttempt(progress.job as Record<string, unknown> | undefined, input.identity)) {
          const completed = Number(progress.completedFrames ?? 0);
          const total = Number(progress.totalFrames ?? 0);
          if (Number.isFinite(completed) && Number.isFinite(total)) {
            input.onProgress(completed, total);
          }
          return;
        }
        const changed = payload.stateChanged as Record<string, unknown> | undefined;
        if (!changed) return;
        if (!sameAttempt(changed.job as Record<string, unknown> | undefined, input.identity)) return;
        const state = changed.state;
        if (state === "RECORDING_JOB_STATE_SUCCEEDED") {
          const claim = readArtifactClaim(changed);
          if (claim) {
            finish({ ok: true, claim });
          } else {
            finish({
              ok: false,
              stage: "RECORDING_ERROR_STAGE_MUX",
              code: "recording-artifact-unverified",
              message: "执行器报告的成片事实不完整",
              transient: false
            });
          }
          return;
        }
        if (state === "RECORDING_JOB_STATE_CANCELLED") {
          finish({
            ok: false,
            stage: "RECORDING_ERROR_STAGE_CAPABILITY",
            code: "recording-cancelled",
            message: "录制已取消",
            transient: false
          });
          return;
        }
        if (state === "RECORDING_JOB_STATE_FAILED") {
          const error = (changed.error ?? {}) as Record<string, unknown>;
          finish({
            ok: false,
            stage: typeof error.stage === "string" ? error.stage : "RECORDING_ERROR_STAGE_CAPABILITY",
            code: typeof error.code === "string" ? error.code : "recording-failed",
            message: typeof error.message === "string" ? error.message : "录制失败",
            transient: error.transient === true
          });
        }
      });

      const sent = options.send(
        toSubmitJobMessage({
          sequence: options.nextSequence(),
          requestId,
          identity: input.identity,
          snapshot: input.snapshot,
          purpose: input.purpose,
          leaseMs: input.leaseMs
        })
      );
      if (!sent) {
        finish({
          ok: false,
          stage: "RECORDING_ERROR_STAGE_EXECUTOR_LOST",
          code: "recording-executor-unavailable",
          message: "无法向录制执行器发送任务",
          transient: true
        });
      }
      input.signal.addEventListener("abort", () => {
        options.send({
          protocolVersion: RECORDING_PROTOCOL_VERSION,
          sequence: String(options.nextSequence()),
          cancelJob: {
            sequence: String(options.nextSequence()),
            requestId,
            reason: "宿主取消",
            job: {
              jobId: input.identity.jobId,
              attemptId: input.identity.attemptId,
              executorInstanceId: input.identity.executorInstanceId,
              executionEpoch: String(input.identity.executionEpoch),
              snapshotHash: input.identity.snapshotHash,
              contentIdentity: input.identity.contentIdentity,
              profileKey: input.identity.profileKey
            }
          }
        });
      });
    });
    log({
      event: "recording-dispatch-settled",
      jobId: input.identity.jobId,
      attemptId: input.identity.attemptId,
      ok: result.ok
    });
    return result;
  };
}

function sameAttempt(job: Record<string, unknown> | undefined, identity: RecordingJobIdentity): boolean {
  if (!job) return false;
  return (
    job.jobId === identity.jobId &&
    job.attemptId === identity.attemptId &&
    job.executorInstanceId === identity.executorInstanceId &&
    String(job.executionEpoch) === String(identity.executionEpoch)
  );
}
