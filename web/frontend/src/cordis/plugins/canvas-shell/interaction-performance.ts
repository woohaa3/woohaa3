/// <reference types="vite/client" />
import { appPublicUrl } from "../../services/app-base-path";
import type { NativeInputTiming } from "../canvas-runtime/native-input-timing.js";
import { submissionSequence, submissionsSince, type SubmissionDiagnostic } from "./frame-submission-diagnostics.js";
import { encodeInteractionBatch } from "./interaction-batch-encoding.js";
import type { ResourceDiagnostics } from "../canvas-runtime/resource-diagnostics.js";
import { createCommandConfirmation } from "./interaction-command-confirmation.js";

import { sceneDiagnostics, sceneDiagnosticsSnapshot } from "../canvas-runtime/scene-diagnostics.js";

/**
 * 开发交互采集（change: 2026-10-10-optimize-canvas-interaction-hot-path，design D1）。
 *
 * 从**共享输入入口**计时：wheel 计时早于前置 `modelPreviewWheel` 命中/坐标换算，pointer 在
 * 共享路由进入时读取同一单调时钟。按实际消费的 kind/source/phase 分类；范围外的模型预览
 * 消费不会被记成普通 pan/zoom。记录带口径版本、recorder、timeOrigin、DPR、实际 surface、
 * 构建身份与丢失数；未知身份显式标注。输入中不联网、不序列化；批次有界、字段白名单。
 *
 * 帧诊断与长任务观察：`frame` 记录一帧内实际发生的构建/提交/几何工作增量；受支持的
 * `PerformanceObserver("longtask")` 把长任务时长关联到重叠的输入区间，不支持时明确
 * `unavailable`，不把「没有数据」解释成「没有长任务」。只记录时间与时长，不上传内容。
 */
export type InteractionKind = "pan" | "zoom" | "drag" | "model-preview" | "history";

/** 可选的输入分段（毫秒）；可缺省，未覆盖余量由 handlerMs 减去已知分段标明。 */
export type InteractionSegments = {
  /** 坐标换算（pointerWorld / clientToWorld）。 */
  coordinatesMs?: number;
  historyWheelMs?: number;
  viewportWheelMs?: number;
  /** 前置命中查询（Rust interaction snapshot）。 */
  hitQueryMs?: number;
  /** DOM rect 读取（getBoundingClientRect）。 */
  domRectMs?: number;
  /** selection/gesture 初始化与 origin 解析。 */
  selectionMs?: number;
  /** 释放时 drop/reparent 规划。 */
  dropPlanMs?: number;
  /** Pure movement/reparent command planning, excluding drop dispatch and submit. */
  positionPlanMs?: number;
  /** Revalidation and planning of Q/E attachment edges. */
  attachPlanMs?: number;
  historyPlanMs?: number;
  pendingProjectionMs?: number;
  commandWireMs?: number;
  statePublishMs?: number;
  /** 提交同步段（受保护编辑/命令规划）。 */
  editSubmitSyncMs?: number;
  /** Scheduling wait; excludes presentation/GPU time. */
  rafWaitMs?: number;
  /** 与该样本区间重叠的最长受支持长任务时长（毫秒）；无观察支持/无重叠时缺省。 */
  longTaskMs?: number;
};

/** 构建身份；未知时显式 "unknown"（不猜测）。 */
export type InteractionBuildIdentity = {
  js: string;
  wasm: string;
  mode: string;
};

/** 帧诊断增量：一帧内实际发生的构建/提交/几何工作。 */
export type InteractionFrameDiagnostics = {
  /** Recorder diagnostic refresh + snapshot CPU wall; outside handlerMs. */
  diagnosticsReadMs: number;
  diagnosticsReads: number;
  submissions?: SubmissionDiagnostic[];
  omittedSubmissions?: number;
  rustRenderMs?: number;
  rustRenderFrames?: number;
  rustRenderQueueMs?: number;
  rustRenderPrepareMs?: number;
  rustRenderPrepareFrames?: number;
  rustGeometryBuilds?: number;
  rustGeometryBuildMs?: number;
  rustGeometryCacheHits?: number;
  sceneBuilds: number;
  sceneSubmits: number;
  sceneDedupes: number;
  sceneStringify: number;
  fingerprintBuilds: number;
  viewportSubmits: number;
  observerSubmits: number;
  positionSubmits: number;
  modelRegistrations: number;
  worldSnapshotBuilds?: number;
  pickCandidateBuilds?: number;
  meshBuilds?: number;
  cardBlockBuilds?: number;
  cardDecorationBuilds?: number;
  edgeBlockBuilds?: number;
  containerBlockBuilds?: number;
  intervalId: number;
  intervalMs: number;
  frameExecutions: number;
  frameExecutionMs: number;
  sceneBuildMs: number;
  fingerprintMs: number;
  stringifyMs: number;
  wasmAcceptMs: number;

};

export type InteractionRelease = "click" | "no-change" | "move-submit" | "reparent-submit" | "attach-submit" | "extension-consumed" | "cancelled" | "release-error";

export type InteractionSample = {
  kind: InteractionKind;
  source: string;
  phase: string;
  release?: InteractionRelease;
  commandId?: number;
  command?: { outcome: "committed" | "rejected" | "unavailable"; waitMs: number };
  startedAt: number;
  handlerMs: number;
  nextRafMs: number | null;
  hidden: boolean;
  bridge?: NativeInputTiming;
  segments?: InteractionSegments;
  frame?: InteractionFrameDiagnostics;
  intervalId?: number;
  context?: { identity: InteractionBuildIdentity; pixelRatio: number; surface?: { width: number; height: number }; resources?: ResourceDiagnostics };
};

/** 口径版本：v2 起 wheel 覆盖前置命中查询、新增分段/帧诊断/构建身份/长任务观察。 */
export const INTERACTION_TIMING_SCHEMA = 4;

/**
 * 默认构建身份 provider：优先读取运行时/构建注入的全局身份（WASM 产物身份由构建脚本/
 * 运行时写入 `globalThis.__woohaaBuildIdentity`），否则显式 unknown（不猜测）。
 * `mode` 取 Vite `import.meta.env.MODE`。
 */
export function defaultBuildIdentity(): InteractionBuildIdentity {
  const injected = (globalThis as { __woohaaBuildIdentity?: Partial<InteractionBuildIdentity> }).__woohaaBuildIdentity;
  const pick = (value: unknown) => (typeof value === "string" && value.length > 0 && value.length <= 128 ? value : "unknown");
  return {
    js: pick(injected?.js ?? import.meta.env.VITE_WOOHAA_JS_IDENTITY),
    wasm: pick(injected?.wasm ?? import.meta.env.VITE_WOOHAA_WASM_IDENTITY),
    mode: pick(injected?.mode ?? import.meta.env.MODE)
  };
}

const ENDPOINT = "/__dev/performance/interactions";
const MAX_SAMPLES = 2048;
const BATCH_SIZE = 256;
/** 保留的长任务记录上限（只保留最近窗口，供重叠判定）。 */
const MAX_LONG_TASKS = 128;
const LONG_TASK_SETTLEMENT_MS = 100;

export type InteractionRecorderOptions = {
  /** Refresh cumulative Rust counters at interval boundaries, never per sample. */
  refreshDiagnostics?: () => void;
  /** Cached Rust samples cannot be attributed to an input/rAF interval. */
  backgroundDiagnostics?: () => boolean;
  resources?: () => ResourceDiagnostics | undefined;
  /** 构建身份 provider；缺省全 "unknown"。 */
  identity?: () => InteractionBuildIdentity;
  /** 实际 canvas surface provider（CSS 像素）；缺省不记录。 */
  surface?: () => { width: number; height: number };
  /** 详细分段/帧诊断开关（默认开；关闭时只保留 handler/nextRaf）。 */
  detailed?: () => boolean;
};

type RecorderInternal = InteractionSample & { sequence: number; endedAt?: number };
type LongTask = { start: number; duration: number };

/** 长任务观察支持状态；不支持的浏览器显式标注，不当作“没有长任务”。 */
export type LongTaskSupport = "observed" | "unavailable";

/** 只观察 timeOrigin 相对的 startTime/duration；不支持时返回 unsupported 观察器。 */
function createLongTaskObserver(target: Window & typeof globalThis) {
  let support: LongTaskSupport = "unavailable";
  let tasks: LongTask[] = [];
  let observer: PerformanceObserver | null = null;
  const performance = target.performance as Performance & {
    PerformanceObserver?: typeof PerformanceObserver;
  };
  const Observer = target.PerformanceObserver ?? performance?.PerformanceObserver;
  const consume = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      if (!Number.isFinite(entry.startTime) || !Number.isFinite(entry.duration) || entry.duration < 0) continue;
      if (!tasks.some(task => task.start === entry.startTime && task.duration === entry.duration))
        tasks.push({ start: entry.startTime, duration: entry.duration });
    }
    if (tasks.length > MAX_LONG_TASKS) tasks = tasks.slice(-MAX_LONG_TASKS);
  };
  const supportedType = typeof Observer === "function"
    && (Observer.supportedEntryTypes?.includes("longtask") ?? false);
  if (supportedType) {
    try {
      observer = new Observer((list) => consume(list.getEntries()));
      observer.observe({ entryTypes: ["longtask"] });
      support = "observed";
    } catch {
      support = "unavailable";
    }
  }
  /** 与 [start,end] 重叠的任务里的最长时长；无重叠/不支持返回 undefined。 */
  const longestOverlapping = (start: number, end: number): number | undefined => {
    if (support !== "observed") return undefined;
    consume(observer?.takeRecords?.() ?? []);
    let longest: number | undefined;
    for (const task of tasks) {
      if (task.start + task.duration < start || task.start > end) continue;
      longest = Math.max(longest ?? 0, task.duration);
    }
    return longest;
  };
  return {
    support: () => support,
    longestOverlapping,
    dispose: () => { observer?.disconnect(); observer = null; }
  };
}

/** One bounded buffer per controller; no network or serialization in input handlers. */
export function createInteractionRecorder(
  target: Window & typeof globalThis,
  options: InteractionRecorderOptions = {}
) {
  if (!import.meta.env.DEV || import.meta.env.VITE_WOOHAA_PERFORMANCE === "0"
    || typeof target.fetch !== "function" || !target.performance
    || typeof target.requestAnimationFrame !== "function") return undefined;

  const recorderId = target.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const pageLoadId = `${target.performance.timeOrigin}`;
  let samples: RecorderInternal[] = [];
  let pending: RecorderInternal[] = [];
  let dropped = 0;
  let sequence = 0;
  let raf: number | null = null;
  let sending = false;
  let disposed = false;
  let warned = false;
  let closingRequested = false;
  let settlementTimer: number | null = null;
  const now = () => target.performance.now();
  const identity = (): InteractionBuildIdentity =>
    options.identity?.() ?? { js: "unknown", wasm: "unknown", mode: import.meta.env.MODE };
  const detailed = () => options.detailed?.() ?? true;
  const longTasks = createLongTaskObserver(target);
  const context = () => {
    const resources = options.resources?.();
    return { identity: identity(), pixelRatio: target.devicePixelRatio,
      ...(options.surface ? { surface: options.surface() } : {}), ...(resources ? { resources } : {}) };
  };
  const confirmation = createCommandConfirmation(target, now, context, sample => {
    if (disposed) return;
    if (samples.length + pending.length >= MAX_SAMPLES) { dropped += 1; return; }
    samples.push({ ...sample, hidden: target.document.hidden, sequence, endedAt: now() });
  });
  /**
   * 帧诊断基线：第一条待结算样本记录时读取 JS 侧计数；结算时用差值附到本帧样本。
   * WASM 在区间起止读取 Rust 累计诊断；native 仅取 JS 计数，Rust 由后台采样。
   * 该跨边界读取有采集开销；不把它计入输入 handler 或 GPU 执行。
   */
  let firstSubmission = 0;
  let frameBaseline: ReturnType<typeof sceneDiagnosticsSnapshot> | null = null;
  let diagnosticsReadMs = 0;
  let diagnosticsReads = 0;
  const diagnostics = () => {
    const started = now();
    if (detailed() && !options.backgroundDiagnostics?.()) {
      try { options.refreshDiagnostics?.(); } catch { /* Diagnostics never interrupt input. */ }
    }
    const snapshot = sceneDiagnosticsSnapshot();
    diagnosticsReadMs += Math.max(0, now() - started);
    diagnosticsReads++;
    return snapshot;
  };

  let intervalId = 0;
  const settle = (withFrame: boolean, rafWaitMs: number) => {
    const end = now();
    const after = withFrame ? diagnostics() : null;
    const currentInterval = intervalId++;
    for (const [sampleIndex, sample] of pending.entries()) {
      sample.intervalId = currentInterval;
      sample.endedAt = end;
      sample.nextRafMs = withFrame ? Math.max(0, end - sample.startedAt) : null;
      const overlap = longTasks.longestOverlapping(sample.startedAt, end);
      if (overlap !== undefined && detailed()) {
        sample.segments = { ...sample.segments, longTaskMs: Math.round(overlap * 100) / 100 };
      }
      if (withFrame && after && frameBaseline) {
        sample.segments = { ...sample.segments, rafWaitMs: Math.round(rafWaitMs * 100) / 100 };
        // Only one sample owns the interval counters.
        if (sampleIndex === 0 && detailed()) sample.frame = {
          diagnosticsReadMs,
          diagnosticsReads,
          rustRenderMs: after.rustRenderMs !== undefined && frameBaseline.rustRenderMs !== undefined
            ? after.rustRenderMs - frameBaseline.rustRenderMs : undefined,
          rustRenderFrames: after.rustRenderFrames !== undefined && frameBaseline.rustRenderFrames !== undefined
            ? after.rustRenderFrames - frameBaseline.rustRenderFrames : undefined,
          rustRenderQueueMs: after.rustRenderQueueMs - frameBaseline.rustRenderQueueMs,
          rustRenderPrepareMs: after.rustRenderPrepareMs - frameBaseline.rustRenderPrepareMs,
          rustRenderPrepareFrames: after.rustRenderPrepareFrames - frameBaseline.rustRenderPrepareFrames,
          rustGeometryBuilds: after.rustGeometryBuilds - frameBaseline.rustGeometryBuilds,
          rustGeometryBuildMs: after.rustGeometryBuildMs - frameBaseline.rustGeometryBuildMs,
          rustGeometryCacheHits: after.rustGeometryCacheHits - frameBaseline.rustGeometryCacheHits,
          sceneBuilds: after.sceneBuilds - frameBaseline.sceneBuilds,
          sceneSubmits: after.sceneSubmits - frameBaseline.sceneSubmits,
          sceneDedupes: after.sceneDedupes - frameBaseline.sceneDedupes,
          sceneStringify: after.sceneStringify - frameBaseline.sceneStringify,
          fingerprintBuilds: after.fingerprintBuilds - frameBaseline.fingerprintBuilds,
          viewportSubmits: after.viewportSubmits - frameBaseline.viewportSubmits,
          observerSubmits: after.observerSubmits - frameBaseline.observerSubmits,
          positionSubmits: after.positionSubmits - frameBaseline.positionSubmits,
          modelRegistrations: after.modelRegistrations - frameBaseline.modelRegistrations,
          worldSnapshotBuilds: after.worldSnapshotBuilds - frameBaseline.worldSnapshotBuilds,
          pickCandidateBuilds: after.pickCandidateBuilds - frameBaseline.pickCandidateBuilds,
          meshBuilds: after.meshBuilds - frameBaseline.meshBuilds,
          cardBlockBuilds: after.cardBlockBuilds - frameBaseline.cardBlockBuilds,
          cardDecorationBuilds: after.cardDecorationBuilds - frameBaseline.cardDecorationBuilds,
          edgeBlockBuilds: after.edgeBlockBuilds - frameBaseline.edgeBlockBuilds,
          containerBlockBuilds: after.containerBlockBuilds - frameBaseline.containerBlockBuilds,
          intervalId: currentInterval,
          intervalMs: Math.round(rafWaitMs * 100) / 100,
          frameExecutions: after.frameExecutions - frameBaseline.frameExecutions,
          frameExecutionMs: after.frameExecutionMs - frameBaseline.frameExecutionMs,
          sceneBuildMs: after.sceneBuildMs - frameBaseline.sceneBuildMs,
          fingerprintMs: after.fingerprintMs - frameBaseline.fingerprintMs,
          stringifyMs: after.stringifyMs - frameBaseline.stringifyMs,
          wasmAcceptMs: after.wasmAcceptMs - frameBaseline.wasmAcceptMs
        };
        if (sample.frame) {
          const submissions = submissionsSince(firstSubmission);
          sample.frame.submissions = submissions.entries;
          sample.frame.omittedSubmissions = submissions.omitted;
          if (options.backgroundDiagnostics?.()) {
            // These are low-frequency cached values, not work caused by this input.
            for (const key of Object.keys(sample.frame))
              if (key.startsWith("rust") || ["worldSnapshotBuilds", "pickCandidateBuilds", "meshBuilds", "cardBlockBuilds", "cardDecorationBuilds", "edgeBlockBuilds", "containerBlockBuilds"].includes(key))
                delete (sample.frame as unknown as Record<string, unknown>)[key];
          }
        }
      }
    }
    samples.push(...pending);
    pending = [];
    frameBaseline = null;
    diagnosticsReadMs = 0;
    diagnosticsReads = 0;
  };

  const flush = async (closing = false) => {
    closingRequested ||= closing;
    if (closingRequested && settlementTimer !== null) {
      target.clearTimeout(settlementTimer);
      settlementTimer = null;
    }
    if (sending || (!samples.length && !dropped)) return;
    // A bounded grace window allows observer callbacks from the input/rAF task
    // to arrive before upload. Closing bypasses the delay and drains takeRecords.
    let eligible = samples.length;
    if (!closingRequested && !disposed && longTasks.support() === "observed"
        && typeof target.setTimeout === "function") {
      const firstWaiting = samples.findIndex(sample => now() < (sample.endedAt ?? now()) + LONG_TASK_SETTLEMENT_MS);
      if (firstWaiting >= 0) {
        eligible = firstWaiting;
        if (settlementTimer === null) {
          const remaining = Math.max(0, (samples[firstWaiting]!.endedAt ?? now()) + LONG_TASK_SETTLEMENT_MS - now());
          settlementTimer = target.setTimeout(() => { settlementTimer = null; void flush(); }, remaining);
        }
      }
      if (!eligible && !dropped) return;
    }
    // Reassociate after observer delivery; takeRecords covers closing early.
    for (const sample of samples) {
      if (sample.phase === "settled") continue;
      const overlap = longTasks.longestOverlapping(sample.startedAt, sample.endedAt ?? now());
      if (overlap !== undefined && detailed()) sample.segments = { ...sample.segments, longTaskMs: Math.round(overlap * 100) / 100 };
    }
    const batch = samples.splice(0, Math.min(BATCH_SIZE, eligible));
    const lost = dropped;
    dropped = 0;
    sending = true;
    let uploaded = false;
    try {
      const surface = options.surface?.();
      const encoded = encodeInteractionBatch({
        recorderId,
        sequence: sequence++,
        metadata: {
          timeOrigin: target.performance.timeOrigin,
          userAgent: target.navigator.userAgent,
          width: target.innerWidth,
          height: target.innerHeight,
          pixelRatio: target.devicePixelRatio,
          timingSchema: INTERACTION_TIMING_SCHEMA,
          loadId: pageLoadId,
          identity: identity(),
          longTaskSupport: longTasks.support(),
          ...(surface ? { surface } : {})
        },
        samples: batch,
        dropped: lost
      }, closing);
      samples.unshift(...encoded.remainder);
      const response = await target.fetch(appPublicUrl(ENDPOINT), {
        method: "POST", headers: { "content-type": "application/json" },
        body: encoded.body,
        keepalive: closing
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      uploaded = true;
    } catch (error) {
      // Failed uploads are explicit gaps, rather than unbounded retry buffers.
      dropped += batch.length + lost;
      if (!warned) {
        warned = true;
        target.console.warn("[performance] 性能数据上传失败；丢失数量将在后续报告中记录。", error);
      }
    } finally {
      sending = false;
      if (uploaded && (samples.length || dropped)) void flush(closingRequested || disposed);
      else if (uploaded) closingRequested = false;
    }
  };

  const record = (
    kind: InteractionKind,
    source: string,
    phase: string,
    startedAt: number,
    segments?: InteractionSegments,
    release?: InteractionRelease,
    commandId?: number,
    bridge?: NativeInputTiming
  ) => {
    if (disposed) return;
    const end = now();
    if (samples.length + pending.length >= MAX_SAMPLES) { dropped += 1; return; }
    pending.push({
      kind, source, phase, startedAt,
      ...(release ? { release } : {}),
      ...(commandId !== undefined ? { commandId } : {}),
      handlerMs: Math.max(0, end - startedAt),
      nextRafMs: null,
      hidden: target.document.hidden,
      context: context(),
      ...(bridge ? { bridge } : {}),
      ...(detailed() && segments ? { segments } : {}),
      sequence: sequence
    });
    // 帧诊断基线：第一条待结算样本（= 本帧第一次输入）记录时建立。
    if (!frameBaseline) { firstSubmission = submissionSequence(); frameBaseline = diagnostics(); }
    if (raf === null) {
      const frameStart = now();
      raf = target.requestAnimationFrame(() => {
        raf = null;
        settle(true, now() - frameStart);
      });
    }
  };

  const finishPending = () => {
    if (raf !== null) target.cancelAnimationFrame(raf);
    raf = null;
    settle(false, 0);
  };
  const onPageHide = () => { finishPending(); void flush(true); };
  const onVisibilityChange = () => { if (target.document.hidden) onPageHide(); };
  const timer = target.setInterval(() => { void flush(); }, 5000);
  target.addEventListener("pagehide", onPageHide);
  target.document.addEventListener("visibilitychange", onVisibilityChange);

  return {
    now, record,
    observeCommand: confirmation.observe,
    /** 显式重置帧计数基线（可选；缺省按第一条待结算样本惰性建立）。 */
    beginFrame() { firstSubmission = submissionSequence(); diagnosticsReadMs = 0; diagnosticsReads = 0; frameBaseline = diagnostics(); },
    /** 帧计数快照读取（可选：详细模式或测试用）。 */
    diagnostics,
    /** 长任务观察支持状态（诊断/测试）。 */
    longTaskSupport: longTasks.support,
    dispose() {
      confirmation.dispose();
      disposed = true;
      target.clearInterval(timer);
      target.removeEventListener("pagehide", onPageHide);
      target.document.removeEventListener("visibilitychange", onVisibilityChange);
      finishPending();
      void flush(true);
      longTasks.dispose();
    }
  };
}

export type InteractionRecorder = ReturnType<typeof createInteractionRecorder>;

type PointerHandlers = {
  onPointerDown: (event: PointerEvent) => void;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  onPointerCancel: (event: PointerEvent) => void;
};

/** Classify from the actual gesture, including right-button transitions to pan. */
export function instrumentPointerHandlers<T extends PointerHandlers>(
  input: T,
  recorder: InteractionRecorder,
  gesture: () => { kind: string; pointerId?: number },
  modelActive: () => boolean,
  segments?: () => InteractionSegments | undefined,
  release?: () => InteractionRelease | undefined,
  commandId?: () => number | undefined
): T {
  if (!recorder) return input;
  const wrap = (handler: (event: PointerEvent) => void, phase: string) => (event: PointerEvent) => {
    const before = gesture();
    const focused = modelActive();
    const start = recorder.now();
    try { handler(event); } finally {
      const active = phase === "down" || phase === "move" ? gesture() : before;
      if (!focused && (active.kind === "pan" || active.kind === "drag") && active.pointerId === event.pointerId) {
        recorder.record(active.kind, "pointer", phase, start, segments?.(), active.kind === "drag" ? phase === "cancel" ? "cancelled" : phase === "up" ? release?.() : undefined : undefined, phase === "up" ? commandId?.() : undefined);
      }
    }
  };
  return { ...input,
    onPointerDown: wrap(input.onPointerDown, "down"),
    onPointerMove: wrap(input.onPointerMove, "move"),
    onPointerUp: wrap(input.onPointerUp, "up"),
    onPointerCancel: wrap(input.onPointerCancel, "cancel")
  };
}

/** 供控制器/测试读取当前 JS 侧帧计数（不含 Rust 计数）。 */
export function interactionFrameCounters() {
  return sceneDiagnosticsSnapshot();
}

/** 全局计数容器导出（控制器在 setScene 后写 Rust 镜像计数）。 */
export { sceneDiagnostics };
