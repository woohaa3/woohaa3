/**
 * 聚焦过渡 coordinator（Canvas Runtime scope）
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D6/D7）。
 *
 * 三类节点聚焦共同过渡的**唯一**时间源与状态机：
 * `overview → entering → focused → exiting → overview`。
 *
 * - 唯一时间源：沿唯一帧账本（rAF）采样绝对起始时间、方向、时长与当前位置；
 * - generation/transitionId：每次有效操作分配身份并绑定 scope/node/kind/runtime generation；
 * - 取消/反向：中途返回从当前已呈现进度反向推进，不从理论起点重启；旧 Promise 结算为 false；
 * - reduced motion：零时长，保持合法首末帧与结算语义；
 * - 资源准备与动画状态分离：`entering` 不等待资源 `ready`。
 *
 * 本模块只依赖纯几何与 runtime 契约，不 import 具体 editor/shell；由 Canvas Runtime host 持有。
 */
import { interpolateViewport, type FocusViewport, type FocusTransitionPort, type ViewportTransitionRequest } from "../../focus/media-transition.js";
import type { FocusContentRect } from "../../focus/types.js";
import { FOCUS_TRANSITION_VERSION, type BevyFocusTransition } from "@woohaa3/contracts";

export type FocusTransitionPhase = "overview" | "entering" | "focused" | "exiting";

/** 一次过渡的身份与绑定（design D6）：scope/node/kind/内容与 runtime generation。 */
export type FocusTransitionIdentity = {
  nodeId: string;
  kind: string;
  owner: "direct" | "history";
  contentIdentity?: string;
  runtimeGeneration: number;
};

export type FocusTransitionApply = {
  /** 应用二维取景（图片/视频 adapter）。 */
  viewport?: (view: FocusViewport, progress: number) => void;
  /** 目标切换/退出时是否反向（从当前进度）。 */
  reverse?: boolean;
};

export type FocusTransitionCoordinatorOptions = {
  /** 是否 reduced motion（缺省读 matchMedia）。 */
  prefersReducedMotion?: () => boolean;
  /** 默认时长（毫秒）。 */
  durationMs?: number;
  now?: () => number;
  raf?: (callback: (time: number) => void) => number;
  cancelRaf?: (handle: number) => void;
};

const DEFAULT_DURATION = 420;

type ActiveTransition = {
  id: number;
  identity: FocusTransitionIdentity;
  from: FocusViewport;
  to: FocusViewport;
  duration: number;
  startedAt: number;
  apply?: (view: FocusViewport, progress: number) => void;
  resolve: (completed: boolean) => void;
  frame: number;
};

/**
 * 公共进度快照（供 Rust 三维相机消费；design D6/D7）。
 *
 * `kind` 为 `"model"`（普通模型/extension 三维聚焦）时 Rust 按此进度求值；二维媒体聚焦
 * 仍直接投影 viewport，因此不发送进度以保持单一驱动。
 */
export type FocusTransitionSnapshot = {
  nodeId: string;
  kind: "model" | "extension";
  progress: number;
  runtimeGeneration: number;
  transitionId: number;
};

/**
 * 唯一 coordinator：持有当前过渡、时间源、generation 与取消/反向。
 *
 * 不修改 Navigation；只作为可丢弃的渲染瞬时态，由 adapter/feature 申请。
 */
export class FocusTransitionCoordinator {
  private phase: FocusTransitionPhase = "overview";
  private generation = 0;
  private current: ActiveTransition | null = null;
  /** 当前三维聚焦公共进度（供 Rust 消费；design D6/D7）。 */
  private trackedModel: { nodeId: string; kind: "model" | "extension"; runtimeGeneration: number; transitionId: number; progress: number } | null = null;
  private modelFrame = 0;
  private modelResolve: ((completed: boolean) => void) | null = null;
  private readonly options: Required<Pick<FocusTransitionCoordinatorOptions, "durationMs" | "now">> & FocusTransitionCoordinatorOptions;

  constructor(options: FocusTransitionCoordinatorOptions = {}) {
    this.options = { durationMs: options.durationMs ?? DEFAULT_DURATION, now: options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now())), ...options };
  }

  /** 当前阶段。 */
  currentPhase(): FocusTransitionPhase { return this.phase; }

  /** 当前过渡 identity（诊断/测试）；无活动过渡返回 null。 */
  activeIdentity(): FocusTransitionIdentity | null { return this.current?.identity ?? null; }

  /** runtime generation（scope/renderer 重建后递增，旧代请求据此丢弃）。 */
  bumpRuntimeGeneration(): number { return ++this.generation; }

  private duration(): number {
    const reduced = this.options.prefersReducedMotion?.() ?? (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    return reduced ? 0 : this.options.durationMs;
  }

  /**
   * 三维聚焦公共进度快照（design D6/D7）：由 Canvas Runtime 每帧投影进渲染快照，Rust 据此
   * 求值相机姿态。无活动三维过渡返回 null（Rust 回退既有内部计时）。
   */
  modelProgress(): BevyFocusTransition | null {
    const tracked = this.trackedModel;
    if (!tracked) return null;
    return {
      version: FOCUS_TRANSITION_VERSION,
      nodeId: tracked.nodeId,
      kind: tracked.kind,
      progress: Math.min(1, Math.max(0, tracked.progress)),
      runtimeGeneration: tracked.runtimeGeneration,
      transitionId: tracked.transitionId
    };
  }

  /**
   * 运行一次三维聚焦过渡：唯一的进度时间源（rAF）。`onProgress` 每帧收到 0..1 原始进度；
   * Rust 相机消费同一进度，**不再**启动独立 `Time.delta` 计时。返回是否正常完成。
   */
  runModel(input: { nodeId: string; kind?: "model" | "extension"; durationSeconds?: number; durationMs?: number; onProgress?: (progress: number) => void }): Promise<boolean> {
    this.cancel();
    const duration = input.durationMs ?? this.duration();
    const runtimeGeneration = this.generation;
    const transitionId = ++this.generation;
    const kind = input.kind ?? "model";
    const raf = this.options.raf ?? ((callback: (time: number) => void) => requestAnimationFrame(callback));
    const hasRaf = this.options.raf !== undefined || typeof requestAnimationFrame === "function";
    if (duration <= 0 || !hasRaf) {
      this.trackedModel = { nodeId: input.nodeId, kind, runtimeGeneration, transitionId, progress: 1 };
      this.phase = "focused";
      input.onProgress?.(1);
      return Promise.resolve(true);
    }
    this.phase = "entering";
    this.trackedModel = { nodeId: input.nodeId, kind, runtimeGeneration, transitionId, progress: 0 };
    return new Promise<boolean>((resolve) => {
      const start = this.options.now();
      const cancel = () => { this.modelResolve = null; this.trackedModel = null; resolve(false); };
      this.modelResolve = cancel;
      const step = (time: number) => {
        if (this.modelResolve !== cancel) return;
        const progress = Math.min(1, Math.max(0, (time - start) / duration));
        const tracked = this.trackedModel;
        if (tracked) tracked.progress = progress;
        input.onProgress?.(progress);
        if (progress === 1) { this.modelResolve = null; this.phase = "focused"; resolve(true); }
        else this.modelFrame = raf(step);
      };
      this.modelFrame = raf(step);
    });
  }

  /** 是否正在驱动三维公共进度。 */
  hasModelProgress(): boolean { return this.trackedModel !== null; }

  /** 当前驱动的三维聚焦节点 id；无活动返回 null。 */
  currentModelNodeId(): string | null { return this.trackedModel?.nodeId ?? null; }

  /** 当前驱动的三维聚焦 kind（model/extension）。 */
  currentModelKind(): "model" | "extension" { return this.trackedModel?.kind ?? "model"; }

  /**
   * 运行一次过渡。返回是否正常完成（取消/被替换返回 false）。
   *
   * `apply` 按公共进度推入；同一时间只有一个活动过渡，新过渡即时取消旧过渡并结算旧 Promise。
   */
  async run(input: {
    identity: FocusTransitionIdentity;
    from: FocusViewport;
    to: FocusViewport;
    apply?: (view: FocusViewport, progress: number) => void;
    /** 覆盖默认时长（如 reduced motion 测试）。 */
    durationMs?: number;
  }): Promise<boolean> {
    this.cancel();
    const duration = input.durationMs ?? this.duration();
    if (duration <= 0 || typeof requestAnimationFrame !== "function") {
      this.phase = "focused";
      input.apply?.(input.to, 1);
      return true;
    }
    const id = ++this.generation;
    this.phase = "entering";
    return new Promise<boolean>((resolve) => {
      const active: ActiveTransition = {
        id, identity: input.identity, from: input.from, to: input.to,
        duration, startedAt: this.options.now(), apply: input.apply, resolve, frame: 0
      };
      this.current = active;
      this.tick(active);
    });
  }

  /**
   * 从当前已呈现进度反向过渡到 `to`（中途返回/取消），不从理论起点重启。
   *
   * 保证旧 Promise 结算完成或取消，不悬挂。
   */
  reverseTo(input: {
    identity: FocusTransitionIdentity;
    to: FocusViewport;
    from: FocusViewport;
    apply?: (view: FocusViewport, progress: number) => void;
    durationMs?: number;
  }): Promise<boolean> {
    return this.run({ ...input, from: input.from, to: input.to });
  }

  /** 取消当前过渡（旧 Promise 结算为 false）。 */
  cancel(): void {
    const active = this.current;
    this.current = null;
    if (active) {
      if (this.options.cancelRaf) this.options.cancelRaf(active.frame);
      active.resolve(false);
    }
    // 三维公共进度同样结算并清除（旧请求不悬挂）。
    const modelResolve = this.modelResolve;
    this.modelResolve = null;
    if (this.modelFrame) {
      if (this.options.cancelRaf) this.options.cancelRaf(this.modelFrame);
      else if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.modelFrame);
    }
    this.modelFrame = 0;
    this.trackedModel = null;
    if (modelResolve) modelResolve(false);
    if (this.phase === "entering" || this.phase === "exiting") this.phase = "overview";
  }

  /** 进入聚焦完成（资源/相机交接后由 adapter 标记）。 */
  markFocused(): void { this.phase = "focused"; }
  /** 退出到 overview（清理完成后）。 */
  markOverview(): void { this.phase = "overview"; }

  /** 内容矩形重定位：不改动画重启，只重算剩余终点由 adapter 处理（design D7）。 */
  redirect(_rect: FocusContentRect): void { /* adapter 从当前取景重算剩余终点 */ }

  /** 作为 `FocusTransitionPort` 交给 feature（单一时间源）。 */
  port(): FocusTransitionPort {
    return {
      run: (request: ViewportTransitionRequest) => this.run({
        identity: { nodeId: request.key, kind: "media", owner: "direct", runtimeGeneration: this.generation },
        from: request.from,
        to: request.to,
        durationMs: request.duration,
        apply: request.apply
      }),
      cancel: () => this.cancel(),
      isActive: () => this.current !== null
    };
  }

  private tick(active: ActiveTransition): void {
    const raf = this.options.raf ?? ((callback) => requestAnimationFrame(callback));
    active.frame = raf((time) => {
      if (this.current !== active) return;
      const progress = Math.min(1, Math.max(0, (time - active.startedAt) / active.duration));
      active.apply?.(interpolateViewport(active.from, active.to, progress), progress);
      if (progress === 1) {
        this.current = null;
        this.phase = "focused";
        active.resolve(true);
        return;
      }
      this.tick(active);
    });
  }
}
