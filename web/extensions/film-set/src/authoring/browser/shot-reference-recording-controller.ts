/**
 * 镜头参考录制调度器的扩展接线
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 8.3–8.5 / design D9）。
 *
 * 把调度器接到宿主服务：画布/工作副本变化、聚焦导航变化、模型聚焦变化与页面恢复都会
 * `reconcile`；不因为 hover、重命名、布局或缩放触发（内容身份已排除它们）。录制失败后由调度器
 * 按退避自动重试（有界），因此**进入画布时**渲染器/媒体尚未就绪不会让旧画布永远缺录制数据。
 *
 * 版本缓存（8.5）与生产录制器（8.4）在此装配；`recorder` 可被测试注入替代。渲染器/媒体能力
 * 不可用时不空转：调度器保留 dirty 集，状态仍可观察。
 */
import type { FilmSetHostContext as Context } from "../../state/browser/host-ports.js";
import { isFilmSetNode, isFilmSetGroupNode } from "@woohaa3/contracts";
import { ShotReferenceRecordingScheduler, type ShotReferenceRecordResult, type ShotReferenceRecorder } from "./shot-reference-recording-scheduler.js";
import { ShotReferenceActivity } from "./shot-reference-activity.js";
import { ShotReferenceVersionCache, createMemoryShotReferenceCacheStore, hydrateShotReferenceCacheFromCanvas, type ShotReferenceVersionAsset } from "./shot-reference-version-cache.js";
import { createShotReferenceRecorder, SHOT_REFERENCE_PROFILE_KEY, shotReferenceTargetFor, type ShotReferencePlaybackPort } from "./shot-reference-recording-runtime.js";
import { planShotReferenceFreeze } from "./shot-reference-canonical.js";
import { createNativeReferenceRecorder, createReferenceDriver } from "./native-reference-recorder.js";
import { nativeRecordingAvailable } from "./native-recording-availability.js";

export type ShotReferenceRecordingController = {
  scheduler: ShotReferenceRecordingScheduler;
  cache: ShotReferenceVersionCache;
  /** 下游请求补排（8.6）：把某镜头当前版本加入 dirty 集并触发。 */
  requestRecord(filmSetNodeId: string, clipId: string): void;
  /** 某镜头当前版本是否已有可复用的 ready 视频资产。 */
  readyAsset(filmSetNodeId: string, clipId: string, contentIdentity: string): ShotReferenceVersionAsset | null;
  dispose(): void;
};

export type ShotReferenceRecordingOptions = {
  /** 录制驱动的播放时钟端口（`FilmSetPlaybackService` 满足）；注入 `recorder` 时可省。 */
  playback?: ShotReferencePlaybackPort;
  /** 覆盖录制器（测试用）；不传则用生产录制器。 */
  recorder?: ShotReferenceRecorder | null;
  /** 覆盖版本缓存（测试/持久化用）。 */
  cache?: ShotReferenceVersionCache;
};

/** 装配调度器并连接触发。 */
export function installShotReferenceRecording(
  ctx: Context,
  options: ShotReferenceRecordingOptions = {}
): ShotReferenceRecordingController {
  const cache = options.cache ?? new ShotReferenceVersionCache(createMemoryShotReferenceCacheStore());
  cache.recoverInterrupted();

  // 页面刷新/重启后内存缓存归零，但录制完成即登记的镜头参考资产仍在权威画布 `assets` 里
  // （录制登记与下游冻结均使用 `asset.upsert`）。每次 reconcile 先回填（幂等、只补缺失版本），再让调度器
  // 判断是否需要录制；资产晚到也能在下一轮补上，避免已录好的镜头被迫重录。
  const hydrateCache = () => {
    // 仅回填已提交成功的权威资产，不能把乐观工作副本提前发布为 ready。
    const canvas = ctx.canvasState.getCanvas();
    if (!canvas) return;
    const hydrated = hydrateShotReferenceCacheFromCanvas(cache, canvas as never);
    if (hydrated > 0) console.info(`[shot-reference] 已从画布回填 ${hydrated} 条镜头参考缓存`);
  };

  const usesNative = options.recorder === undefined && nativeRecordingAvailable();

  // ---- 后台活动投影（任务活动浮层） -------------------------------------
  // 录制是扩展拥有的后台工作，不是 durable 任务：用稳定 id 发布 upsert 事件，由
  // task-activity 浮层按画布展示；进度与状态规则见 ShotReferenceActivity。
  // 原生任务由 recording-activity-mirror 按宿主 attempt 发布；浏览器活动不能再发布一份。
  const activity = usesNative ? null : new ShotReferenceActivity({
    titleOf: (job) => shotReferenceTargetFor(ctx, job)?.title ?? "镜头参考",
    emit: (job) => ctx.emit("extension.activity.updated", { job })
  });

  /**
   * 录制器选择（change: 2026-10-17-add-native-offscreen-film-set-recording，任务 7.2）。
   *
   * 桌面壳走宿主任务（不 acquire 捕捉门、不 seek 可见播放头）；浏览器-only 保留原逐帧循环。
   * 两条路径由 `nativeRecordingAvailable()` 单一判据切换，不会并行生产同一参考。
   */
  const nativeDriver = usesNative
    ? createReferenceDriver({
        remote: ctx.canvasRemote as never,
        canvasId: ctx.canvasState.getCanvas()?.id ?? ""
      })
    : null;
  const baseRecorder = options.recorder === undefined
    ? usesNative && nativeDriver
      ? ((job: Parameters<ShotReferenceRecorder>[0], signal?: AbortSignal) => {
          // 宿主任务成功只表示「已保存」；版本缓存仍由权威资产回填后发布。
          return createNativeReferenceRecorder({
            driver: nativeDriver,
            canvasId: job.canvasId,
            contentIdentityOf: target => target.contentIdentity
          })(targetForJob(job), signal).then(result =>
            result.ok
              ? { ok: true as const }
              : { ok: false as const, error: result.error, transient: result.transient }
          );
        }) as ShotReferenceRecorder
      : createShotReferenceRecorder(ctx, cache, requiredPlayback(options.playback), {
          onProgress: (job, progress) => activity?.progress(job, progress.completed, progress.total)
        })
    : options.recorder;
  const recorder: ShotReferenceRecorder | null = baseRecorder === null
    ? null
    : async (job, signal) => {
        if (!shotReferenceTargetFor(ctx, job)) return { ok: false, error: "shot-kind-unsupported: 只有动态镜头可录制视频", transient: false };
        activity?.start(job);
        let result: ShotReferenceRecordResult;
        try {
          result = await baseRecorder(job, signal);
        } catch (cause) {
          result = { ok: false, error: cause instanceof Error ? cause.message : "镜头录制失败" };
        }
        // 即使被取消也交回真实结论：录制在取消信号到达前已发布资产时 `result.ok` 为真，
        // 此时静默丢弃会让活动投影把它算成「取消」，而画布上的参考视频其实已就绪。
        // 页面已释放时不再发布活动（失活 context 不能再解析页面服务）。
        if (!disposed) activity?.finish(job, result);
        return result;
      };

  /** 页面释放标记：异步录制收尾晚于 scope 释放时，不得再解析页面服务。 */
  let disposed = false;

  /** 把已 ready 的镜头版本冻结登记到权威画布（幂等）。 */
  let lastFreezeError = "";
  const reportFreezeFailure = (reason: string) => {
    // 同一原因只报一次：失败会随每次 reconcile 重试，逐次打印会淹没控制台。
    if (reason === lastFreezeError) return;
    lastFreezeError = reason;
    console.warn("[shot-reference] 冻结登记失败", reason);
  };
  const applyFreeze = () => {
    if (!ctx.canvasSession.isWritable()) return;
    const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
    if (!canvas) return;
    const plan = planShotReferenceFreeze({
      canvas: canvas as never,
      readyAsset: (request) => cache.readyAsset(request),
      now: () => new Date().toISOString()
    });
    if (!plan.commands.length) return;
    const submitted = ctx.canvasSession.submitCommands(plan.commands, `shot-reference-freeze-${crypto.randomUUID()}`);
    if (!submitted.ok) {
      reportFreezeFailure(`${submitted.code ?? "failed"}: ${submitted.reason}`);
      return;
    }
    // 服务端拒绝是异步结果（例如资产校验失败）；不观察就只剩「一直等待」的界面表现。
    void submitted.handle.settled.then((handle) => {
      if (handle.state === "rejected") reportFreezeFailure(handle.error ?? "rejected");
      else lastFreezeError = "";
    });
  };

  const scheduler = new ShotReferenceRecordingScheduler({
    canvasId: () => ctx.canvasState.getCanvas()?.id ?? "",
    canvas: () => ctx.canvasState.getCanvas() as never,
    focusedFilmSetId: () => focusedFilmSetId(ctx),
    recorder,
    isCachedReady: (ref) => cache.readyAsset(ref) !== null,
    // 失败后按退避自动重试：进入画布时渲染器/媒体往往尚未就绪，旧画布不能因此永远缺录制数据。
    scheduleRetry: (run, delayMs) => setTimeout(run, delayMs),
    cancelRetry: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    // 队列状态变化只用于即时冻结已 ready 的版本。**不**在这里 invalidate 复合资产：
    // 录制状态不属于画布内容，invalidate 会连带触发模型场景重算与画布投影更新，又回到
    // `canvasState.subscribe(reconcile)`，在任何失败录制存在时形成永不停止的重试环。
    onStateChange: () => {
      if (disposed) return;
      applyFreeze();
      const snapshot = scheduler.snapshot();
      // 进行中的 job 不能因为「暂时不在 dirty」就被标成取消：录制成功后发布资产会先让 job
      // 离开 dirty 集，`finish` 随后才把它结算为成功（2026-10-29 活动面板误显示「取消」）。
      activity?.syncQueued(snapshot.dirty, snapshot.inflight);
    }
  });

  const reconcile = () => {
    if (disposed) return;
    hydrateCache();
    scheduler.reconcile();
    applyFreeze();
  };
  const onVisibility = () => {
    if (!document.hidden) reconcile();
  };

  const unsubscribeCanvas = ctx.canvasState.subscribe(reconcile);
  const unsubscribeNavigation = ctx.canvasNavigation.subscribe(reconcile);
  const unsubscribeFocus = ctx.canvasRuntime.subscribeModelFocus(reconcile);
  document.addEventListener("visibilitychange", onVisibility);
  reconcile();

  return {
    scheduler,
    cache,
    requestRecord: (filmSetNodeId, clipId) => {
      if (!disposed) scheduler.requestRecord(filmSetNodeId, clipId);
    },
    readyAsset(filmSetNodeId, clipId, contentIdentity) {
      const canvasId = ctx.canvasState.getCanvas()?.id ?? "";
      if (!canvasId) return null;
      return cache.readyAsset({ canvasId, filmSetNodeId, clipId, contentIdentity, profileKey: SHOT_REFERENCE_PROFILE_KEY });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribeCanvas();
      unsubscribeNavigation();
      unsubscribeFocus();
      scheduler.dispose();
    }
  };
}

/**
 * 调度器 job → 录制目标。
 *
 * native 路径只需要稳定身份（画布/片场/片段/内容/profile），不需要预览节点 id 与像素尺寸；
 * 这里复用同一构造以免两套身份口径。
 */
function targetForJob(
  job: Parameters<ShotReferenceRecorder>[0]
): import("./shot-reference-recorder.js").ShotReferenceRecordTarget & { contentIdentity: string } {
  return {
    canvasId: job.canvasId,
    filmSetNodeId: job.filmSetNodeId,
    clipId: job.clipId,
    previewNodeId: "",
    contentIdentity: job.contentIdentity,
    profileKey: job.profileKey,
    duration: 0,
    aspect: "16:9",
    title: "",
    width: 0,
    height: 0
  };
}

/** 生产录制器必须有播放时钟端口；缺失时明确失败，不退回有装配陷阱的服务解析。 */
function requiredPlayback(playback: ShotReferencePlaybackPort | undefined): ShotReferencePlaybackPort {
  if (!playback) throw new Error("镜头参考录制需要播放时钟端口（installShotReferenceRecording 的 playback）");
  return playback;
}

/**
 * 当前聚焦编辑的**片场**节点 id；未聚焦片场返回 `null`。
 *
 * 只认 `node-focus` 上 kind 为 `extension`（复合资产/纯模型扩展节点）且引用真实片场的聚焦；
 * 图片/视频/普通模型聚焦不产生镜头参考录制。
 */
function focusedFilmSetId(ctx: Context): string | null {
  const mode = ctx.canvasNavigation.getSnapshot().mode;
  if (mode.type !== "node-focus") return null;
  const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
  const node = canvas?.document.nodes.find((entry) => entry.id === mode.nodeId);
  if (!node || (!isFilmSetNode(node.type, canvas?.nodeData[node.id]) && !isFilmSetGroupNode(node, canvas?.nodeData[node.id]))) return null;
  return mode.nodeId;
}
