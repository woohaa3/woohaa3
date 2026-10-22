/**
 * 动画节点播放控制器（纯状态机）
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 4.1）。
 *
 * 持有活动动画节点的**本地时钟**与播放门禁，并按帧推进到 `CanvasRuntime.setAnimationPlayback`。
 * 时钟不写 canonical 数据；切换节点/定义变化时取消旧会话（generation 前进），忽略迟到结果。
 * 求值本身由 Bevy 按 Motion IR 完成，本控制器只负责「何时、对哪个节点、播放到第几秒」。
 */
import { compileFilmSetClip, resolveFilmSetClip, filmSetClipHash, checkAnimationMotion, resolveAnimationGate, type FilmSetClipView, type FilmSetNodeData, type AnimationValidationState, type BevyAnimationPlayback } from "@woohaa3/contracts";

export type AnimationPlaybackControllerDeps = {
  /** 读取节点当前动画定义（不完整/非法返回 null）。 */
  readAnimation: (nodeId: string) => FilmSetNodeData | null;
  /** 提交播放投影（null 表示无活动动画节点）。 */
  publish: (playback: BevyAnimationPlayback | null) => void;
  /**
   * 播放头推进通知（change: 2026-10-08-make-film-set-model-only）。
   *
   * 每次 publish 后回调，携带节点 id、当前时间与是否播放，供片场媒体会话跟随同一时钟。
   */
  onTime?: (input: { nodeId: string | null; time: number; playing: boolean }) => void;
  /** 每帧调度（默认 rAF）；返回取消函数。 */
  schedule?: (run: () => void) => () => void;
  /** 当前时间源（毫秒）；测试可注入。 */
  now?: () => number;
};

type Session = {
  nodeId: string;
  snapshotHash: string;
  /** 当前片段视图（绑定已投影到 items；不写回 canonical）。 */
  view: FilmSetClipView;
  state: AnimationValidationState;
  time: number;
  playing: boolean;
  projection: BevyAnimationPlayback;
  clipId: string;
  diagnostics: string[];
  /**
   * hover 拍摄预览强制循环（design D6）：**不改**保存的 `timeline.loop`，只让本次会话在
   * duration 处回绕。focus 显式播放不设置它，仍按保存的 loop 结算。
   */
  forceLoop: boolean;
  /** 上次推进的时间源毫秒；暂停/未运行时为 null。 */
  lastTickMs: number | null;
};

export class AnimationPlaybackController {
  private readonly deps: Required<Pick<AnimationPlaybackControllerDeps, "readAnimation" | "publish">> & AnimationPlaybackControllerDeps;
  private session: Session | null = null;
  private generation = 0;
  private startupFrames = 0;
  private startupPublishedAt = 0;
  private startupSamples: Record<string, unknown>[] = [];
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private recordStartup(kind: string, sample: Record<string, unknown>): void {
    if (this.startupSamples.length < 240) this.startupSamples.push({ kind, ...sample, atBrowserMs: performance.now() });
  }
  private flushStartup(reason: string): void {
    if (this.startupTimer !== null) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.startupFrames = 0;
    this.startupSamples.forEach((sample, index) => console.info("[shot-startup] js-batch " + JSON.stringify({ reason, part: index + 1, parts: this.startupSamples.length, samples: [sample] })));
    this.startupSamples = [];
  }
  private cancelFrame: (() => void) | null = null;
  private running = false;
  private error: string | null = null;
  private compilations = 0;
  private readonly compiledClips = new Map<string, {
    state: AnimationValidationState;
    gate: ReturnType<typeof resolveAnimationGate>;
    compiled: ReturnType<typeof compileFilmSetClip> | null;
  }>();
  compilationCount(): number { return this.compilations; }
  diagnostics(): string[] { return this.session?.diagnostics ?? (this.error ? [this.error] : []); }

  constructor(deps: AnimationPlaybackControllerDeps) {
    this.deps = deps;
  }

  /** 当前播放的节点 id；无则 null。 */
  activeNodeId(): string | null {
    return this.session?.nodeId ?? null;
  }

  /** 当前是否正在推进（用于测试/UI）。 */
  isPlaying(): boolean {
    return this.session?.playing === true;
  }

  /** 当前播放时间（秒）；无会话为 0。 */
  time(): number {
    return this.session?.time ?? 0;
  }

  /** 校验状态（供 UI 显示失效原因）；无会话为 null。 */
  validation(): AnimationValidationState | null {
    return this.session?.state ?? null;
  }

  /**
   * 选择活动动画节点。同一节点且 snapshotHash 未变时保留时钟；否则重建会话并取消旧结果
   * （generation 前进）。
   *
   * `viewMode` 明确本会话的输入/输出来源（design D6）：
   * - `overview-observer`：普通 hover 模型；
   * - `focus-preview`：聚焦显式预览（尊重保存 loop）；
   * - `shot-node-preview`：画布拍摄预览卡片（**输入**为所属片场 nodeId + clipId，**输出**目标为
   *   该卡片；`targetPreviewNodeId` 由调用方给出，缺失即不路由）。
   *
   * `forceLoop` 只对 hover 拍摄预览生效：会话时钟在 duration 处回绕，但**不写**保存的
   * `timeline.loop`；focus 显式播放不传它。
   */
  select(
    nodeId: string | null,
    snapshotHash?: string,
    options: {
      clipId?: string;
      paused?: boolean;
      viewMode?: "overview-observer" | "focus-preview" | "shot-node-preview";
      /** `shot-node-preview` 的输出目标卡片 canonical 节点 id。 */
      targetPreviewNodeId?: string;
      /** hover 预览强制循环（不改保存 loop）。 */
      forceLoop?: boolean;
    } = {}
  ): void {
    if (nodeId === null) {
      this.disposeSession();
      return;
    }
    const startedAt = performance.now();
    const source = this.deps.readAnimation(nodeId);
    const readAt = performance.now();
    const animation = source ? resolveFilmSetClip(source, options.clipId) : null;
    if (!animation) {
      console.info("[shot-startup] select-rejected " + JSON.stringify({ nodeId, reason: "clip-unavailable" }));
      this.disposeSession();
      return;
    }
    const clip = animation.clip;
    const hash = snapshotHash ?? `${animation.content.items.length}:${filmSetClipHash({ ...clip, name: "" })}:${JSON.stringify(animation.content)}`;
    const viewMode = options.viewMode ?? "overview-observer";
    const targetPreviewNodeId = options.targetPreviewNodeId ?? null;
    if (
      this.session &&
      this.session.nodeId === nodeId &&
      this.session.snapshotHash === hash &&
      this.session.clipId === clip.id &&
      this.session.projection.viewMode === viewMode &&
      (this.session.projection.targetPreviewNodeId ?? null) === targetPreviewNodeId &&
      this.session.forceLoop === (options.forceLoop === true)
    ) {
      // 定义未变：保留当前时钟与播放状态。
      this.session.view = animation;
      const totalMs = performance.now() - startedAt;
      if (this.startupFrames > 0 && totalMs >= 4) this.recordStartup("js-select-reuse", {
        nodeId, clipId: clip.id, generation: this.generation, totalMs,
        readMs: readAt - startedAt, resolveHashMs: performance.now() - readAt
      });
      return;
    }
    this.error = null;
    const cacheKey = JSON.stringify([nodeId, hash, clip.id]);
    const resolvedAt = performance.now();
    let validationMs = 0;
    let compileMs = 0;
    let prepared = this.compiledClips.get(cacheKey);
    const cacheHit = !!prepared;
    if (prepared) {
      this.compiledClips.delete(cacheKey);
      this.compiledClips.set(cacheKey, prepared);
    } else {
      const validationAt = performance.now();
      const state = checkAnimationMotion(animation);
      const gate = resolveAnimationGate(state);
      const compileAt = performance.now();
      validationMs = compileAt - validationAt;
      const compiled = gate.canPreview ? compileFilmSetClip(nodeId, animation) : null;
      compileMs = performance.now() - compileAt;
      if (compiled) this.compilations++;
      prepared = { state, gate, compiled };
      this.compiledClips.set(cacheKey, prepared);
      if (this.compiledClips.size > 16) this.compiledClips.delete(this.compiledClips.keys().next().value!);
    }
    const { state, gate, compiled } = prepared;
    // 检查未通过时不建立可播放会话：保留节点身份，但冻结在第 0 秒且不发布投影。
    if (!gate.canPreview) {
      this.error = gate.reason;
      console.info("[shot-startup] select-rejected " + JSON.stringify({ nodeId, clipId: clip.id, reason: gate.reason }));
      this.disposeSession();
      return;
    }
    if (!compiled) { this.disposeSession(); return; }
    if (!compiled.ok) { console.info("[shot-startup] select-rejected " + JSON.stringify({ nodeId, clipId: clip.id, reason: compiled.reason })); this.error = compiled.reason; this.disposeSession(); return; }
    this.stopLoop();
    this.deps.publish(null);
    this.generation += 1;
    // 投影的 looped 字段承载**本次会话**的循环语义（hover 拍摄预览强制循环），
    // 不写回 canonical timeline.loop（design D6）。
    const forceLoop = options.forceLoop === true;
    this.session = {
      nodeId,
      snapshotHash: hash,
      view: animation,
      state,
      time: 0,
      playing: !options.paused && animation.timeline.duration > 0,
      projection: {
        ...compiled.projection,
        clipId: clip.id,
        sourceIdentity: hash,
        generation: this.generation,
        viewMode,
        looped: compiled.projection.looped || forceLoop,
        ...(targetPreviewNodeId ? { targetPreviewNodeId } : {})
      },
      clipId: clip.id,
      diagnostics: compiled.diagnostics,
      forceLoop,
      lastTickMs: null
    };
    const publishAt = performance.now();
    this.publish();
    this.startupPublishedAt = performance.now();
    this.flushStartup("session-replaced");
    this.startupFrames = 120;
    this.startupTimer = setTimeout(() => this.flushStartup("window-complete"), 3000);
    console.info("[shot-startup] js-select " + JSON.stringify({
      nodeId, clipId: clip.id, generation: this.generation, targetPreviewNodeId,
      cacheHit, readMs: readAt - startedAt, resolveHashMs: resolvedAt - readAt,
      validationMs, compileMs, publishMs: this.startupPublishedAt - publishAt,
      totalMs: this.startupPublishedAt - startedAt, atBrowserMs: this.startupPublishedAt
    }));
    this.ensureRunning();
  }

  /** 定义变化：重建会话（取消旧时钟）。 */
  invalidate(): void {
    if (!this.session) return;
    const nodeId = this.session.nodeId;
    this.session = null;
    this.select(nodeId);
  }

  play(): void {
    if (!this.session) return;
    if (this.session.view.timeline.duration <= 0) return;
    if (this.session.time >= this.session.view.timeline.duration) this.session.time = 0;
    this.session.playing = true;
    this.publish();
    this.ensureRunning();
  }

  pause(): void {
    if (!this.session) return;
    this.stopLoop();
    this.session.playing = false;
    this.session.lastTickMs = null;
    this.publish();
  }

  /** 停止并回到第 0 秒重新求值。 */
  stop(): void {
    if (!this.session) return;
    this.stopLoop();
    this.session.playing = false;
    this.session.time = 0;
    this.session.lastTickMs = null;
    this.publish();
  }

  /** 时间定位：钳制在 `[0, duration]` 并暂停。 */
  seek(time: number): void {
    if (!this.session) return;
    const duration = this.session.view.timeline.duration;
    this.session.time = clampTime(time, duration);
    this.stopLoop();
    this.session.playing = false;
    this.session.lastTickMs = null;
    this.publish();
  }

  /**
   * 截帧固定：把会话定位到 `time` 并**冻结**（截图读取该画面），返回一个恢复函数。
   *
   * 截图成功或失败后调用恢复函数回到冻结前的播放状态与时间。冻结期间 `publish` 仍发生，
   * 使 Bevy 渲染出该时刻的姿态；迟到结果由调用方按 snapshotHash 校验（design「截图固定本节点」）。
   */
  pinForCapture(time: number): (() => void) | null {
    const session = this.session;
    if (!session) return null;
    this.stopLoop();
    const previousTime = session.time;
    const wasPlaying = session.playing;
    const duration = session.view.timeline.duration;
    session.time = clampTime(time, duration);
    session.playing = false;
    session.lastTickMs = null;
    this.publish();
    return () => {
      if (this.session !== session) return;
      session.time = previousTime;
      session.playing = wasPlaying;
      session.lastTickMs = null;
      this.publish();
      if (wasPlaying) this.ensureRunning();
    };
  }

  /** 当前会话的完整版本标识（截图记录实际版本用）；无会话为 null。 */
  snapshotHash(): string | null {
    return this.session?.snapshotHash ?? null;
  }

  /** 推进时钟（毫秒增量）；`playing` 时按循环/非循环结算。 */
  tick(nowMs: number): void {
    const session = this.session;
    if (!session || !session.playing) {
      if (session) session.lastTickMs = null;
      return;
    }
    const traceFrame = this.startupFrames > 0;
    if (traceFrame) {
      this.recordStartup("js-frame", {
        nodeId: session.nodeId, clipId: session.clipId, generation: this.generation,
        frame: 121 - this.startupFrames, sincePublishMs: performance.now() - this.startupPublishedAt,
        rafGapMs: session.lastTickMs === null ? null : nowMs - session.lastTickMs
      });
      this.startupFrames--;
    }
    if (session.lastTickMs === null) {
      session.lastTickMs = nowMs;
      return;
    }
    const deltaSeconds = Math.max(0, (nowMs - session.lastTickMs) / 1000);
    session.lastTickMs = nowMs;
    const duration = session.view.timeline.duration;
    if (duration <= 1e-6) {
      session.time = 0;
    } else if (session.view.timeline.loop || session.forceLoop) {
      // hover 拍摄预览强制循环：只影响本会话时钟，不改保存的 timeline.loop（design D6）。
      session.time = wrap(session.time + deltaSeconds, duration);
    } else if (session.time + deltaSeconds >= duration) {
      session.time = duration;
      session.playing = false;
    } else {
      session.time += deltaSeconds;
    }
    const publishStarted = performance.now();
    this.publish();
    if (traceFrame) this.recordStartup("js-tick-publish", {
      nodeId: session.nodeId, generation: this.generation, frame: 120 - this.startupFrames,
      publishMs: performance.now() - publishStarted
    });
  }

  dispose(): void {
    this.flushStartup("disposed");
    this.compiledClips.clear();
    this.stopLoop();
    this.session = null;
  }

  private disposeSession(): void {
    this.flushStartup("session-ended");
    this.stopLoop();
    this.generation += 1;
    if (!this.session) {
      this.deps.publish(null);
      return;
    }
    this.session = null;
    this.deps.publish(null);
    this.deps.onTime?.({ nodeId: null, time: 0, playing: false });
  }

  private publish(): void {
    const session = this.session;
    if (!session) {
      this.deps.publish(null);
      this.deps.onTime?.({ nodeId: null, time: 0, playing: false });
      return;
    }
    this.deps.publish({ ...session.projection, time: session.time, playing: session.playing });
    this.deps.onTime?.({ nodeId: session.nodeId, time: session.time, playing: session.playing });
  }

  private ensureRunning(): void {
    if (this.running || !this.session?.playing) return;
    this.running = true;
    const schedule = this.deps.schedule ?? defaultSchedule;
    const loop = (): void => {
      if (!this.running) return;
      const now = this.deps.now?.() ?? Date.now();
      this.tick(now);
      if (this.session?.playing) this.cancelFrame = schedule(loop);
      else this.stopLoop();
    };
    this.cancelFrame = schedule(loop);
  }

  private stopLoop(): void {
    this.running = false;
    this.cancelFrame?.();
    this.cancelFrame = null;
  }
}

function defaultSchedule(run: () => void): () => void {
  if (typeof globalThis.requestAnimationFrame === "function") {
    const handle = globalThis.requestAnimationFrame(run);
    return () => globalThis.cancelAnimationFrame(handle);
  }
  const handle = setTimeout(run, 16);
  return () => clearTimeout(handle);
}

function clampTime(time: number, duration: number): number {
  if (!Number.isFinite(time)) return 0;
  return Math.min(Math.max(0, time), duration);
}

function wrap(value: number, duration: number): number {
  return ((value % duration) + duration) % duration;
}
