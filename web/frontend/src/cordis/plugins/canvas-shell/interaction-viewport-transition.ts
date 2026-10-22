/**
 * 视口平移过渡（change: 2026-10-09-improve-canvas-workflow，任务 4.1）。
 *
 * 从 `interaction-controller` 抽出以保持在文件体积守卫内。只做纯调度：
 * 依赖注入的读写视口回调、渲染帧回调、减少动态效果门禁与 rAF 时钟。
 * 过渡期间写瞬时预览（不落盘）；结束或取消时恢复/提交。
 */
export type Viewport = { x: number; y: number; zoom: number };

export type ViewportTransitionDeps = {
  target: Window & typeof globalThis;
  /** 当前生效视口（预览优先）。 */
  activeViewport: () => Viewport;
  /** 读取瞬时预览。 */
  getPreview: () => Viewport | null;
  /** 写瞬时预览（null 清除）。 */
  setPreview: (viewport: Viewport | null) => void;
  /** 提交到本地存储。 */
  commit: (viewport: Viewport) => void;
  /** 标记场景失效并请求一次渲染。 */
  invalidate: () => void;
  /** 强制渲染一帧。 */
  renderFrame: () => void;
  /** 用户减少动态效果偏好。 */
  reducedMotion: () => boolean;
  /** 默认过渡时长（毫秒）。 */
  defaultDurationMs?: number;
};

export type ViewportTransition = {
  /** 带动画地平移到目标（保持传入 zoom）；duration<=0 或减少动态效果时瞬时。 */
  pan: (to: Viewport, options?: { durationMs?: number }) => void;
  /** 取消进行中的过渡并清除瞬时预览。 */
  cancel: () => void;
  /** 是否有过渡进行中。 */
  isActive: () => boolean;
};

type Transition = {
  from: Viewport;
  to: Viewport;
  startMs: number;
  durationMs: number;
  frame: number | null;
  lastPreview: Viewport | null;
};

const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const sameViewport = (a: Viewport, b: Viewport): boolean => a.x === b.x && a.y === b.y && a.zoom === b.zoom;

export function createViewportTransition(deps: ViewportTransitionDeps): ViewportTransition {
  let active: Transition | null = null;

  const nowMs = (): number =>
    typeof deps.target.performance?.now === "function" ? deps.target.performance.now() : Date.now();

  const cancel = (): void => {
    if (!active) return;
    if (active.frame !== null && typeof deps.target.cancelAnimationFrame === "function") {
      deps.target.cancelAnimationFrame(active.frame);
    }
    active = null;
    deps.setPreview(null);
  };

  const pan = (to: Viewport, options: { durationMs?: number } = {}): void => {
    cancel();
    const durationMs = options.durationMs ?? deps.defaultDurationMs ?? 320;
    const requested: Viewport = { x: to.x, y: to.y, zoom: to.zoom };
    if (durationMs <= 0 || deps.reducedMotion() || typeof deps.target.requestAnimationFrame !== "function") {
      deps.setPreview(null);
      deps.commit(requested);
      deps.invalidate();
      return;
    }
    active = {
      from: deps.activeViewport(),
      to: requested,
      startMs: nowMs(),
      durationMs,
      frame: null,
      lastPreview: null
    };
    const step = () => {
      const transition = active;
      if (!transition) return;
      // 用户在本帧之间手动改了视口（滚轮/拖拽/缩放）：让位，停止动画。
      const preview = deps.getPreview();
      if (transition.lastPreview && preview && !sameViewport(transition.lastPreview, preview)) {
        cancel();
        return;
      }
      const elapsed = nowMs() - transition.startMs;
      const t = Math.max(0, Math.min(1, elapsed / transition.durationMs));
      const eased = easeInOutCubic(t);
      const next: Viewport = {
        x: transition.from.x + (transition.to.x - transition.from.x) * eased,
        y: transition.from.y + (transition.to.y - transition.from.y) * eased,
        zoom: transition.from.zoom + (transition.to.zoom - transition.from.zoom) * eased
      };
      deps.setPreview(next);
      transition.lastPreview = next;
      deps.invalidate();
      deps.renderFrame();
      if (t >= 1) {
        active = null;
        deps.setPreview(null);
        deps.commit(transition.to);
        deps.invalidate();
        return;
      }
      if (typeof deps.target.requestAnimationFrame === "function") {
        transition.frame = deps.target.requestAnimationFrame(step);
      }
    };
    if (typeof deps.target.requestAnimationFrame === "function") {
      active.frame = deps.target.requestAnimationFrame(step);
    }
  };

  return { pan, cancel, isActive: () => active !== null };
}
