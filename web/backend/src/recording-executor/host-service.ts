/**
 * 宿主原生录制服务
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 6.1 / 6.2 / 6.3 / 7.1）。
 *
 * 一次提交的完整链路：
 *
 * ```text
 * submit（幂等 requestId）
 *   → 冻结快照（扩展的 ContentRecordingRuntime.freeze，读已提交权威数据）
 *   → 排队并登记到协调器（状态机 / 取消线性化）
 *   → 通过执行器通道下发（submitJob）→ worker 渲染编码
 *   → 收到成片事实 → 宿主重新解析字节复核
 *   → Media 端口流式上传（stable storageKey）
 *   → 扩展 planCommit 构造单个命令批次 → 权威事务提交（固定 commandId）
 * ```
 *
 * 不写 durable 任务历史、不拼画布命令、不碰前端像素。
 */
import { createHash } from "node:crypto";
import type {
  CanvasCommand,
  CanvasContentRuntime,
  ContentRecordingCommitRequest,
  ContentRecordingSnapshot
} from "@woohaa3/contracts";
import {
  RecordingJobCoordinator,
  isTerminalState,
  type RecordingJobIdentity,
  type RecordingJobRecord
} from "./coordinator.js";
import { finalizeRecording, type RecordingArtifactClaim, type RecordingCommitDeps } from "./finalize.js";
import type { CanvasRecordingPort, RecordingStatusView, RecordingSubmitRequest } from "@woohaa3/contracts";
import type { RecordingExecutorChannel } from "./channel.js";
import type { ReferenceRecordingScheduler } from "./scheduler.js";

/** 冻结输入提供方（片场扩展实现）。 */
export type RecordingFreezeSource = {
  freeze(input: {
    canvasId: string;
    nodeId: string;
    clipId: string;
    purpose: "reference" | "export";
    profileKey: string;
    sourceIncarnation: string;
    canvas: {
      revision: number;
      assets: readonly { id: string; storageKey?: string; checksum?: string; contentType?: string; size?: number; metadata?: unknown }[];
      nodeData: unknown;
      read?: (storageKey: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
    };
  }): Promise<
    | { ok: true; snapshot: ContentRecordingSnapshot }
    | { ok: false; code: string; message: string }
  >;
  planCommit(input: ContentRecordingCommitRequest & {
    sourcePosition?: { x: number; y: number; width: number } | null;
  }): Promise<
    | { ok: true; commands: CanvasCommand[]; commandId: string; nodeId?: string }
    | { ok: false; code: string; message: string }
  >;
  describe(input: { nodeData: unknown; clipId: string }): { title: string; duration: number; aspect: string };
};

/** 权威画布读取（宿主自己的能力，不让扩展碰 Y.Doc）。 */
export type RecordingCanvasReader = {
  /** 读取已提交画布快照。 */
  read(input: { canvasId: string; nodeId: string }): Promise<
    | {
        ok: true;
        revision: number;
        assets: readonly { id: string; storageKey?: string; checksum?: string; contentType?: string; size?: number; metadata?: unknown }[];
        nodeData: unknown;
        node?: { width?: number; height?: number };
        /** 来源 incarnation：删除后重建同 id 必须不同。 */
        sourceIncarnation: string;
        /** 来源节点布局（提交时再读一次，用于放置右侧节点）。 */
        layout: { x: number; y: number; width: number };
        writable: boolean;
        readOnly?: boolean;
        hasPendingDraft?: boolean;
      }
    | { ok: false; code: string; message: string }
  >;
  /** 提交时重新读取的布局与存活检查。 */
  currentLayout(input: { canvasId: string; nodeId: string }): Promise<{ x: number; y: number; width: number } | null>;
  /** 固定 commandId 的权威提交。 */
  submit(input: { canvasId: string; commandId: string; commands: CanvasCommand[] }): Promise<
    { ok: true; duplicate: boolean } | { ok: false; code: string; message: string }
  >;
  /**
   * 读取稳定媒体字节（有界、经授权）。
   *
   * 第二个参数是素材所属画布：远端画布的字节只在服务端托管存储里（键 `<canvasId>/media/<key>`），
   * 必须按画布作用域读；调用方（{@link HostRecordingService}）在冻结时用请求的 canvasId 绑定，
   * 省略表示与画布无关（保持旧行为）。
   */
  readMedia?: (storageKey: string, canvasId?: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
};

/** 把成片字节上传到 Media，得到 stable storageKey。 */
export type RecordingUploader = (input: {
  chunks: AsyncIterable<Uint8Array>;
  contentType: string;
  sizeBytes: number;
  fileName: string;
  /** 成片属于哪张画布：远端画布的字节必须写进托管存储，否则只有本机能读。 */
  canvasId: string;
  signal: AbortSignal;
}) => Promise<
  | { ok: true; artifact: { storageKey: string; checksum: string; contentType: string; size: number } }
  | { ok: false; code: string; message: string }
>;

/** 向执行器下发任务并等待成片事实。 */
export type RecordingDispatcher = (input: {
  identity: RecordingJobIdentity;
  snapshot: ContentRecordingSnapshot;
  purpose: "reference" | "export";
  leaseMs: number;
  onProgress(completedFrames: number, totalFrames: number): void;
  signal: AbortSignal;
}) => Promise<
  | { ok: true; claim: RecordingArtifactClaim }
  | { ok: false; stage: string; code: string; message: string; transient: boolean }
>;

/** 带结构化阶段/错误码的内部异常：让 `execute` 的 catch 能原样透出，而不是猜 message。 */
class RecordingStageError extends Error {
  constructor(
    readonly stage: string,
    readonly code: string,
    message: string,
    readonly transient = false
  ) {
    super(message);
    this.name = "RecordingStageError";
  }
}

export type HostRecordingServiceOptions = {
  runtime: CanvasContentRuntime;
  canvas: RecordingCanvasReader;
  upload: RecordingUploader;
  dispatch: RecordingDispatcher;
  cleanupAttempt?: (identity: RecordingJobIdentity) => Promise<void>;
  coordinator?: RecordingJobCoordinator;
  scheduler?: ReferenceRecordingScheduler;
  executor?: RecordingExecutorChannel | null;
  now?: () => number;
  /** 活动浮层投影（每 attempt 一条记录）。 */
  publishActivity?: (job: import("@woohaa3/contracts").BackgroundActivityJob) => void;
  logger?: (event: Record<string, unknown>) => void;
  /** 单任务预算。 */
  /** 执行器租约（存活检测）时长；不是任务总时长额度。 */
  limits?: { leaseMs?: number };
};

/** 任务 → 冻结/提交所需的上下文（内存，仅当前进程）。 */
type JobContext = {
  request: RecordingSubmitRequest;
  snapshot: ContentRecordingSnapshot;
  identity: RecordingJobIdentity;
  title: string;
  canvasId: string;
  /** 冻结时的内容身份（进入提交计划的 origin 与资产身份）。 */
  contentIdentity: string;
  referenceIdentity?: ContentRecordingCommitRequest["referenceIdentity"];
};

/**
 * 宿主录制服务：把 `submit/cancel/status/list` 映射到协调器与执行链路。
 */
export class HostRecordingService implements CanvasRecordingPort {
  private readonly coordinator: RecordingJobCoordinator;
  private readonly contexts = new Map<string, JobContext>();
  private readonly inflight = new Map<string, AbortController>();
  private readonly pending: string[] = [];
  private executing = false;
  private readonly now: () => number;
  private readonly log: (event: Record<string, unknown>) => void;

  constructor(private readonly options: HostRecordingServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.log = options.logger ?? (() => undefined);
    this.coordinator =
      options.coordinator ??
      new RecordingJobCoordinator({
        now: this.now,
        ...(options.publishActivity ? { publishActivity: options.publishActivity } : {}),
        logger: this.log
      });
  }

  /** 当前协调器（测试与诊断）。 */
  jobs(): RecordingJobRecord[] {
    return this.coordinator.list();
  }

  async submit(input: { canvasId: string; body: RecordingSubmitRequest }): Promise<
    | { ok: true; jobId: string; state: RecordingStatusView["state"]; duplicate: boolean }
    | { ok: false; code: string; message: string }
  > {
    const { canvasId, body } = input;
    const ability = this.checkAbility();
    if (!ability.ok) return ability;

    // 幂等：同一 requestId 已接受则直接返回原任务。
    const existing = this.findByRequestId(canvasId, body.requestId);
    if (existing) {
      return { ok: true, jobId: existing.identity.jobId, state: existing.state, duplicate: true };
    }

    if (this.pending.length >= 8) return { ok: false, code: "recording-executor-busy", message: "录制队列已满，请稍后重试" };
    let frozen: Awaited<ReturnType<HostRecordingService["freeze"]>>;
    try { frozen = await this.freeze(body.purpose === "export" ? "export" : "reference", canvasId, body); }
    catch (error) {
      this.log({ event: "recording-freeze-failed", message: error instanceof Error ? error.message : String(error) });
      return { ok: false, code: "recording-source-invalid", message: "录制快照编译失败，请检查片场内容" };
    }
    if (!frozen.ok) return frozen;

    const identity: RecordingJobIdentity = {
      jobId: `recording-${body.requestId}`,
      attemptId: `attempt-${this.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      executorInstanceId: ability.executorInstanceId,
      executionEpoch: ability.executionEpoch,
      snapshotHash: frozen.snapshotHash,
      contentIdentity: frozen.contentIdentity,
      profileKey: frozen.snapshot.profile.profileKey
    };
    const totalFrames = Math.max(1, Math.ceil(frozen.duration * frozen.snapshot.timing.frameRateNumer / frozen.snapshot.timing.frameRateDenom));
    const accepted = this.coordinator.accept({
      identity,
      purpose: body.purpose,
      canvasId,
      nodeId: body.nodeId,
      clipId: body.clipId,
      totalFrames,
      title: frozen.title
    });
    if (!accepted.ok) return accepted;

    this.contexts.set(identity.jobId, {
      request: body,
      snapshot: frozen.snapshot,
      identity,
      title: frozen.title,
      canvasId,
      contentIdentity: frozen.contentIdentity,
      ...(frozen.referenceIdentity ? { referenceIdentity: frozen.referenceIdentity } : {})
    });
    this.coordinator.setTitle(identity.jobId, frozen.title);
    if (body.purpose === "export") this.options.scheduler?.setExplicitActive(true);

    // 异步执行：HTTP 立刻返回 202，前端通过 status 查询进度。
    this.pending.push(identity.jobId);
    void this.drain();
    return { ok: true, jobId: identity.jobId, state: "queued", duplicate: false };
  }

  async cancel(input: { canvasId: string; jobId: string }): Promise<
    { ok: true; cancelled: true } | { ok: false; code: string; message: string }
  > {
    const job = this.coordinator.get(input.jobId);
    if (!job || job.canvasId !== input.canvasId) {
      return { ok: false, code: "recording-unknown-job", message: "任务不存在或已过期" };
    }
    const result = this.coordinator.cancel(input.jobId);
    if (!result.ok) return result;
    // 取消先胜出：中止上传/派发，worker 由 supervisor 终止。
    this.inflight.get(input.jobId)?.abort();
    this.inflight.delete(input.jobId);
    this.contexts.delete(input.jobId);
    if (job.purpose === "export") this.options.scheduler?.setExplicitActive(false);
    return { ok: true, cancelled: true };
  }

  async status(input: { canvasId: string; jobId: string }): Promise<
    { ok: true; status: RecordingStatusView } | { ok: false; code: string; message: string }
  > {
    const job = this.coordinator.get(input.jobId);
    if (!job || job.canvasId !== input.canvasId) {
      return { ok: false, code: "recording-unknown-job", message: "任务不存在或已过期" };
    }
    return { ok: true, status: toView(job, this.contexts.get(input.jobId), this.coordinator.titleOf(input.jobId)) };
  }

  async list(input: { canvasId: string }): Promise<RecordingStatusView[]> {
    return this.coordinator
      .listForCanvas(input.canvasId)
      .map(job => toView(job, this.contexts.get(job.identity.jobId), this.coordinator.titleOf(job.identity.jobId)));
  }

  /** 能力检查：执行器通道 + 真实 GPU。缺哪一项就报哪一项，不静默降级。 */
  private checkAbility():
    | { ok: true; executorInstanceId: string; executionEpoch: number }
    | { ok: false; code: string; message: string } {
    const runtime = this.options.runtime.recording;
    if (!runtime) {
      return { ok: false, code: "recording-unavailable", message: "当前构建未启用原生录制能力" };
    }
    const executor = this.options.executor;
    if (!executor || !executor.available) {
      return {
        ok: false,
        code: "recording-executor-unavailable",
        message: "本机录制执行器未就绪，请从桌面应用启动后重试"
      };
    }
    const registered = executor.registry.list();
    const live = registered.find(record => !record.capability.softwareAdapter && record.capability.gpuAdapter !== "");
    if (!live) {
      return registered.length
        ? {
            ok: false,
            code: "recording-executor-software-gpu",
            message: "当前只有软件渲染适配器，不能产出可验收的录制画面"
          }
        : { ok: false, code: "recording-executor-unavailable", message: "本机录制执行器未注册" };
    }
    return {
      ok: true,
      executorInstanceId: live.capability.executorInstanceId,
      executionEpoch: live.executionEpoch
    };
  }

  private findByRequestId(canvasId: string, requestId: string): RecordingJobRecord | undefined {
    return this.coordinator
      .listForCanvas(canvasId)
      .find(job => job.identity.jobId === `recording-${requestId}`);
  }

  /** 冻结权威输入。只读历史/未提交草稿/权限都在这里拒绝。 */
  private async freeze(
    purpose: "reference" | "export",
    canvasId: string,
    body: RecordingSubmitRequest
  ): Promise<
    | {
        ok: true;
        snapshot: ContentRecordingSnapshot;
        snapshotHash: string;
        contentIdentity: string;
        referenceIdentity?: ContentRecordingCommitRequest["referenceIdentity"];
        duration: number;
        title: string;
      }
    | { ok: false; code: string; message: string }
  > {
    const runtime = this.options.runtime.recording!;
    const canvas = await this.options.canvas.read({ canvasId, nodeId: body.nodeId });
    if (!canvas.ok) return canvas;
    if (!canvas.writable) {
      return { ok: false, code: "recording-source-invalid", message: "画布不可写，无法录制" };
    }
    const described = runtime.describe({ nodeData: canvas.nodeData, clipId: body.clipId });
    const profileKey = body.profileKey ?? "";
    const themeBackdrop = body.themeBackdrop;
    const frozen = await runtime.freeze({
      requestId: body.requestId,
      purpose,
      canvasId,
      nodeId: body.nodeId,
      clipId: body.clipId,
      profileKey,
      ...(body.profile === undefined ? {} : { profile: body.profile }),
      sourceIncarnation: canvas.sourceIncarnation,
      readOnly: canvas.readOnly === true,
      hasPendingDraft: canvas.hasPendingDraft === true,
      canvas: {
        revision: canvas.revision,
        assets: canvas.assets,
        nodeData: canvas.nodeData,
        ...(canvas.node ? { node: canvas.node } : {}),
        ...(themeBackdrop === undefined ? {} : { themeBackdrop }),
        // 素材读取必须带上本次积木所属画布：远端画布的素材只在托管存储里，绑错作用域会 404。
        // freeze 还没产出快照，所以用请求的 canvasId（它随后写入 snapshot.origin.canvasId）。
        ...(this.options.canvas.readMedia
          ? { read: (storageKey: string) => this.options.canvas.readMedia!(storageKey, canvasId) }
          : {})
      }
    });
    if (!frozen.ok) return frozen;
    const snapshot = frozen.snapshot;
    const duration = snapshot.timing.durationNumer / snapshot.timing.durationDenom;
    return {
      ok: true,
      snapshot,
      snapshotHash: canonicalSnapshotHash(snapshot),
      ...(frozen.referenceIdentity ? { referenceIdentity: frozen.referenceIdentity } : {}),
      contentIdentity: `${snapshot.origin.sourceIdentity}:${snapshot.motionJson.length}:${snapshot.sceneIrJson.length}`,
      duration,
      title: described.title
    };
  }

  /** One worker at a time; explicit exports precede waiting automatic references. */
  private async drain(): Promise<void> {
    if (this.executing) return;
    this.executing = true;
    try {
      while (this.pending.length) {
        const explicit = this.pending.findIndex(id => this.contexts.get(id)?.request.purpose === "export");
        const [id] = this.pending.splice(explicit >= 0 ? explicit : 0, 1);
        const job = this.coordinator.get(id!);
        if (job && !isTerminalState(job.state)) await this.execute(id!);
      }
    } finally {
      this.executing = false;
      this.options.scheduler?.setExplicitActive(false);
    }
  }

  /** 执行：派发 → 复核 → 上传 → 提交。失败按阶段写入任务状态。 */
  private async execute(jobId: string): Promise<void> {
    const context = this.contexts.get(jobId);
    const job = this.coordinator.get(jobId);
    if (!context || !job) return;
    const controller = new AbortController();
    this.inflight.set(jobId, controller);
    try {
      this.coordinator.apply(jobId, context.identity, { kind: "state", state: "preparing" });
      this.coordinator.apply(jobId, context.identity, { kind: "state", state: "rendering" });

      const dispatched = await this.options.dispatch({
        identity: context.identity,
        snapshot: context.snapshot,
        purpose: context.request.purpose,
        leaseMs: this.options.limits?.leaseMs ?? 120_000,
        onProgress: (completedFrames, totalFrames) => {
          this.coordinator.apply(jobId, context.identity, {
            kind: "progress",
            completedFrames,
            totalFrames,
            sampleTime: 0
          });
        },
        signal: controller.signal
      });
      if (!dispatched.ok) {
        this.coordinator.apply(jobId, context.identity, {
          kind: "terminal",
          state: dispatched.code === "recording-cancelled" ? "cancelled" : "failed",
          error: {
            stage: dispatched.stage as never,
            code: dispatched.code,
            message: dispatched.message,
            transient: dispatched.transient
          }
        });
        return;
      }

      this.coordinator.apply(jobId, context.identity, { kind: "state", state: "uploading" });
      // 提交前重新读来源布局：位置取**提交时**的权威布局。
      const layout = await this.options.canvas.currentLayout({
        canvasId: context.canvasId,
        nodeId: context.request.nodeId
      });
      // 显式导出必须在提交时源仍存在：删除后再建同 id 不继承旧任务（design D7）。
      if (context.request.purpose === "export" && !layout) {
        this.coordinator.apply(jobId, context.identity, {
          kind: "terminal",
          state: "failed",
          error: {
            stage: "RECORDING_ERROR_STAGE_COMMIT",
            code: "recording-source-removed",
            message: "源片场在录制期间被删除，视频未保存",
            transient: false
          }
        });
        return;
      }
      this.coordinator.beginCommit(jobId);

      const commitRequest: ContentRecordingCommitRequest = {
        requestId: context.request.requestId,
        purpose: context.request.purpose,
        canvasId: context.canvasId,
        nodeId: context.request.nodeId,
        clipId: context.request.clipId,
        sourceIncarnation: context.snapshot.origin.sourceIncarnation,
        contentIdentity: context.contentIdentity,
        profileKey: context.snapshot.profile.profileKey,
        title: context.title,
        ...(context.referenceIdentity ? { referenceIdentity: context.referenceIdentity } : {}),
        artifact: {
          storageKey: "",
          checksum: "",
          mimeType: "video/mp4",
          sizeBytes: dispatched.claim.sizeBytes,
          width: dispatched.claim.width,
          height: dispatched.claim.height,
          durationSeconds: dispatched.claim.durationSeconds,
          frameRate: context.snapshot.timing.frameRateNumer / context.snapshot.timing.frameRateDenom,
          hasAudio: false
        }
      };
      const deps: RecordingCommitDeps = {
        openArtifact: async ({ path, sizeBytes }) => readFileChunksLazy(path, sizeBytes),
        upload: this.options.upload,
        submit: this.options.canvas.submit,
        // 提交计划由内容扩展构造（宿主不拼业务命令）。
        planCommit: input => this.options.runtime.recording!.planCommit(input),
        log: this.log
      };
      const finalized = await finalizeRecording({
        identity: context.identity,
        claim: dispatched.claim,
        commitRequest,
        sourcePosition: context.request.purpose === "export" ? layout : null,
        limits: {
          expectedWidth: dispatched.claim.width,
          expectedHeight: dispatched.claim.height,
          expectedDurationSeconds: dispatched.claim.durationSeconds,
          expectedFrameRate: context.snapshot.timing.frameRateNumer / context.snapshot.timing.frameRateDenom
        },
        deps,
        signal: controller.signal,
        readArtifactBytes: async ({ path }) => {
          const { readFile } = await import("node:fs/promises");
          try {
            return new Uint8Array(await readFile(path));
          } catch (error) {
            // 成片文件不存在/不可读：明确报成片缺失，而不是伪装成通用内部错误。
            throw new RecordingStageError(
              "RECORDING_ERROR_STAGE_MUX",
              "recording-artifact-unreadable",
              `成片不可读：${error instanceof Error ? error.message : "unknown"}`
            );
          }
        }
      });
      if (!finalized.ok) {
        this.coordinator.apply(jobId, context.identity, {
          kind: "terminal",
          state: "failed",
          error: {
            stage: finalized.stage,
            code: finalized.code,
            message: finalized.message,
            // 上传/传输类失败可重试；输入/权限类不可。
            transient: finalized.stage === "RECORDING_ERROR_STAGE_UPLOAD"
          }
        });
        return;
      }
      this.coordinator.apply(jobId, context.identity, { kind: "terminal", state: "succeeded" });
      // 成功后**保留** context：状态查询仍要能报告「提交时版本」与标题，
      // 直到协调器按 TTL/上限清理该终态记录。
      this.contexts.set(jobId, context);
      if (context.request.purpose === "export") this.options.scheduler?.setExplicitActive(false);
    } catch (error) {
      const aborted = controller.signal.aborted;
      if (aborted) {
        this.coordinator.apply(jobId, context.identity, {
          kind: "terminal",
          state: "cancelled",
          error: {
            stage: "RECORDING_ERROR_STAGE_CAPABILITY",
            code: "recording-cancelled",
            message: "录制已取消",
            transient: false
          }
        });
        return;
      }
      // 结构化失败原样透出；只有真正的意外异常才归为内部错误。
      const structured = error instanceof RecordingStageError ? error : null;
      const message = error instanceof Error ? error.message : "录制失败";
      this.coordinator.apply(jobId, context.identity, {
        kind: "terminal",
        state: "failed",
        error: {
          stage: (structured?.stage ?? "RECORDING_ERROR_STAGE_COMMIT") as never,
          code: structured?.code ?? "recording-internal-error",
          message,
          transient: structured?.transient ?? false
        }
      });
    } finally {
      this.inflight.delete(jobId);
      await this.options.cleanupAttempt?.(context.identity).catch(error => this.log({ event: "recording-cleanup-failed", message: String(error) }));
    }
  }
}

function toView(job: RecordingJobRecord, context: JobContext | undefined, title?: string): RecordingStatusView {
  const totalFrames = job.totalFrames;
  // 标题属于任务：协调器的标题表优先，其次才是本次查询的上下文。
  const displayTitle = title ?? context?.title;
  return {
    jobId: job.identity.jobId,
    requestId: context?.request.requestId ?? job.identity.jobId.replace(/^recording-/, ""),
    purpose: job.purpose,
    state: job.state,
    completedFrames: job.completedFrames,
    totalFrames,
    ...(totalFrames > 0 ? { progress: Math.min(1, job.completedFrames / totalFrames) } : {}),
    // 标题由宿主冻结时确定；活动浮层必须用它，不能自己拼业务文案。
    ...(displayTitle ? { title: displayTitle } : {}),
    ...(context?.request.displayVersion ? { submittedVersion: context.request.displayVersion } : {}),
    ...(job.error
      ? {
          error: {
            stage: job.error.stage,
            code: job.error.code,
            message: job.error.message,
            ...(job.error.frameIndex !== undefined ? { frameIndex: job.error.frameIndex } : {}),
            ...(job.error.sampleTime !== undefined ? { sampleTime: job.error.sampleTime } : {})
          }
        }
      : {}),
    updatedAt: new Date(job.updatedAt).toISOString()
  };
}

/** 规范快照 hash：key 排序后的 JSON 再摘要。 */
function canonicalSnapshotHash(snapshot: ContentRecordingSnapshot): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, normalize(record[key])]));
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(normalize(snapshot))).digest("hex");
}

async function* readFileChunksLazy(path: string, sizeBytes: number): AsyncGenerator<Uint8Array> {
  const { open } = await import("node:fs/promises");
  const handle = await open(path, "r");
  try {
    const chunk = 512 * 1024;
    let offset = 0;
    while (offset < sizeBytes) {
      const length = Math.min(chunk, sizeBytes - offset);
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

/** 供调用方判断任务是否已终结。 */
export { isTerminalState };
