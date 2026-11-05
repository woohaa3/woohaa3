/**
 * 画布表面与瞬时交互辅助
 * （change: 2026-09-28-split-frontend-god-plugins，task 3 收尾；
 *   change: fix-model-focus-navigation-and-camera-parity）。
 *
 * 从 `interaction-controller.ts` 拆出的内聚一组：
 * - 取消尚未提交的瞬时手势（modal 打开 / 宿主显式取消）；
 * - 进入聚焦前结算 2D 视口预览；
 * - document 捕获阶段的滚轮 / Safari 捏合（聚焦相机缩放，只作用于主观察相机）；
 * - 窗口 resize 失效。
 *
 * 它们都只通过注入能力访问共享状态，不自建 pointer 监听或 viewport 副本；控制器仍是唯一
 * 的输入路由与坐标系 owner。
 */
import type { InteractionState, Viewport } from "./interaction-core.js";
import type { ModelGestureFamily } from "./model-gesture-family.js";
import { ContinuousWheelOwner, nativeWheelTarget } from "./input/continuous-wheel-owner.js";
import { setAlignmentGuides } from "./alignment-snap.js";

/** 拖动粘连 Q/E 路由与取消（change: add-drag-touch-connections）。 */
export type AttachKeyboardController = import("./interaction-core.js").DragAttachKeyboardController & {
  /** 取消聚合拉线手势并清空预览（不提交命令）。 */
  cancelAggregateConnect: () => void;
};

export type SurfaceInteractionDeps = {
  state: InteractionState;
  /** 目标窗口（含 document），测试桩可替换。 */
  target: Window & typeof globalThis;
  canvas: HTMLCanvasElement;
  model: ModelGestureFamily;
  imageFocused?: () => boolean;
  onWheel?: (event: WheelEvent) => void;
  /** 聚焦相机输入门禁（只有 modal Dialog 阻断）。 */
  focusInputBlocked: () => boolean;
  /** 当前活动视口（预览优先）。 */
  activeViewport: () => Viewport;
  /** 本地持久视口写入。 */
  localViewportSet: (viewport: Viewport) => void;
  /** 请求一帧重绘（置失效位）。 */
  schedule: () => void;
  /** 暂停 hover 视频播放。 */
  suspendHoverPlayback: () => void;
  /** 清除悬停态。 */
  clearHover: () => void;
  /** 清除聚焦 held input。 */
  clearHeldKeys: () => void;
  /** 拖动粘连路由（change: add-drag-touch-connections）。 */
  attach: AttachKeyboardController;
};

export type SurfaceInteractions = {
  cancelTransientGesture: () => void;
  settleViewportBeforeFocus: () => void;
  /** document capture 阶段滚轮/捏合处理器（注册/注销由控制器负责）。 */
  handlers: {
    onDocumentWheel: (event: WheelEvent) => void;
    onDocumentPointerDown: () => void;
    onDocumentFocusChange: () => void;
    onDocumentBlur: () => void;
    onDocumentVisibility: () => void;
    onGestureStart: (event: Event) => void;
    onGestureChange: (event: Event) => void;
    onGestureEnd: (event: Event) => void;
    onWindowResize: () => void;
  };
};

export function createSurfaceInteractions(deps: SurfaceInteractionDeps): SurfaceInteractions {
  const { state, target, canvas, model, focusInputBlocked, activeViewport, localViewportSet, schedule } = deps;
  const wheelOwner = new ContinuousWheelOwner<Element>();

  /**
   * 取消尚未提交的瞬时画布交互（design D6 / spec「打开弹窗时终止未完成的瞬时画布交互」）。
   * 只清本地 gesture/draft/preview，不撤销已提交的 pending Canvas command。
   */
  const cancelTransientGesture = () => {
    wheelOwner.reset();
    // 拖动粘连 / 聚合拉线手势必须走显式取消路径（清 held/preview 且不提交），
    // change: add-drag-touch-connections / add-multi-select-aggregate-connect，design D6。
    if (deps.attach.attachActive()) deps.attach.cancelDragGesture();
    if (state.gesture.kind === "aggregate-connect") deps.attach.cancelAggregateConnect();
    if (state.gesture.kind !== "none" && "pointerId" in state.gesture) {
      try {
        canvas.releasePointerCapture?.(state.gesture.pointerId);
      } catch {
        // 指针可能已释放。
      }
    }
    state.gesture = { kind: "none" };
    state.draft = null;
    state.localPositions = new Map();
    state.localSizes = new Map();
    // 取消瞬时手势后同样推进版本号：覆盖层据此撤下旧参考线。
    setAlignmentGuides(state, []);
    state.viewportPreview = null;
    // modal 从空变非空时也暂停 hover 视频播放并清理聚焦 held input（design D3/D7/D5）。
    deps.suspendHoverPlayback();
    deps.clearHover();
    deps.clearHeldKeys();
    schedule();
  };

  /**
   * 进入聚焦前结算当前 2D 视口预览。
   *
   * wheel/pan 的 preview 优先于 local viewport；若它跨过 focus session 留存，退出时即使
   * 恢复了 saved viewport，activeViewport 仍会继续返回旧 preview，表现为缩放和面板布局
   * 没有恢复。这里先保存用户最后看到的视口，再清理 timer/preview/gesture。
   */
  const settleViewportBeforeFocus = () => {
    wheelOwner.reset();
    const viewport = activeViewport();
    localViewportSet(viewport);
    state.viewportPreview = null;
    if (state.viewportCommitTimer !== null) target.clearTimeout?.(state.viewportCommitTimer);
    state.viewportCommitTimer = null;
    state.gesture = { kind: "none" };
  };

  /**
   * 聚焦查看的 document capture 阶段滚轮/Safari 捏合：委托 `model` family，
   * 覆盖层上的滚轮/捏合也必须只调相机、取消默认缩放。
   *
   * 门禁用 `focusInputBlocked()`（只有 modal Dialog 才阻断）：非模态 history/editor panel
   * 打开时仍可在 focus canvas 上滚轮/捏合缩放主观察相机（design D6）。
   */
  const locallyOwned = (event: Event) => (event.target as Element | null)?.closest?.('[data-canvas-input-owner="local"]') != null;
  const onDocumentWheel = (event: WheelEvent) => {
    if (locallyOwned(event)) return;
    if (deps.imageFocused?.()) {
      // canvas 本体仍由原生 wheel 监听处理；覆盖层也进入同一个画布输入入口。
      const target = event.target as HTMLElement | null;
      const region = target?.closest?.("[data-canvas-viewport]");
      if (!region || target?.closest?.("[data-canvas-viewport-control]")) return;
      event.preventDefault();
      if (region.getAttribute("data-canvas-viewport-blocked") !== "true") deps.onWheel?.(event);
      return;
    }
    if (model.active) {
      wheelOwner.reset();
      model.onDocumentWheel(event, focusInputBlocked());
      return;
    }
    const eventTarget = event.target && typeof (event.target as Element).closest === "function"
      ? event.target as Element
      : null;
    const panel = eventTarget?.closest(".node-execution-dock") ?? null;
    const inCanvas = !!eventTarget && (eventTarget === canvas || canvas.contains(eventTarget));
    if (!panel && !inCanvas) return;
    const owner = wheelOwner.resolve(event.timeStamp, () => {
      if (focusInputBlocked()) return { owner: "blocked" as const, target: null };
      const nativeTarget = panel ? nativeWheelTarget(eventTarget, panel) : null;
      return nativeTarget ? { owner: "native" as const, target: nativeTarget } : { owner: "canvas" as const, target: null };
    });
    if (owner.owner === "blocked") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (owner.owner === "native") {
      if (panel && owner.target?.contains(eventTarget)) return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (panel) {
      event.preventDefault();
      event.stopPropagation();
      deps.onWheel?.(event);
    }
  };

  const onDocumentPointerDown = () => wheelOwner.reset();
  const onDocumentFocusChange = () => wheelOwner.reset();
  const onDocumentBlur = () => wheelOwner.reset();
  const onDocumentVisibility = () => { if (target.document?.hidden) wheelOwner.reset(); };

  /**
   * 窗口 / 容器 resize：surface 尺寸是可见变化，必须失效并重建场景
   * （change: optimize-model-scene-snapshot-hot-path）。
   */
  const onWindowResize = () => {
    schedule();
  };

  return {
    cancelTransientGesture,
    settleViewportBeforeFocus,
    handlers: {
      onDocumentWheel,
      onDocumentPointerDown,
      onDocumentFocusChange,
      onDocumentBlur,
      onDocumentVisibility,
      onGestureStart: (event) => { if (!locallyOwned(event)) model.onGestureStart(event, focusInputBlocked()); },
      onGestureChange: (event) => { if (!locallyOwned(event)) model.onGestureChange(event, focusInputBlocked()); },
      onGestureEnd: (event) => { if (locallyOwned(event)) return; model.onGestureEnd(event); wheelOwner.reset(); },
      onWindowResize
    }
  };
}
