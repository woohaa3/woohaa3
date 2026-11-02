/**
 * 画布表面尺寸与 client/world 坐标换算
 * （change: split-frontend-god-plugins；合并 change: 2026-10-08-integrate-render-performance-and-model-preview
 * 后 `interaction-controller.ts` 接近文件体积守卫，抽出本纯逻辑模块）。
 *
 * 只依赖 canvas/target 与当前视口，不持有瞬时态、不安排调度。
 */
import { screenToWorld, type Point } from "./hit-test.js";
import type { Viewport } from "./interaction-core.js";

export type CanvasBounds = { left: number; top: number; width: number; height: number };

export type SurfaceMetrics = {
  /**
   * 可用画布尺寸（CSS 像素）+ DPR，以及相对视口的原点。
   * 见 `interaction-controller.ts` 的包含块说明。桌面顶栏把包含块下移时，原点不是 (0, 0)。
   */
  surfaceSize: () => { width: number; height: number; pixelRatio: number; originX: number; originY: number };
  /**
   * 读取 canvas 外框（一次同步布局读取）。同一事件可复用它传给 `pointerWorld` /
   * `clientToWorld` / `worldToClient`，避免重复 `getBoundingClientRect`
   * （change: 2026-10-10-optimize-canvas-interaction-hot-path，任务 5.2）。
   */
  readBounds: () => CanvasBounds;
  clientToWorld: (client: { x: number; y: number }, bounds?: CanvasBounds) => Point;
  pointerWorld: (event: Pick<PointerEvent, "clientX" | "clientY">, bounds?: CanvasBounds) => Point;
  worldToClient: (world: { x: number; y: number }, bounds?: CanvasBounds) => Point;
};

/**
 * 可用画布尺寸（CSS 像素）+ DPR。
 *
 * 关键：Bevy/winit 在 `fit_canvas_to_parent` 下会把**行内像素尺寸**写到 canvas 元素上
 * （如 `width: 1600px`）。一旦窗口放大，`canvas.getBoundingClientRect()` 就被这个行内尺寸
 * 钉死；窗口再缩小时它仍返回旧尺寸，`sync_surface` 于是把窗口强行拉回旧值，形成
 * 「放大后缩不回去」的反馈环。因此这里测量 canvas 的**包含块**（父容器，canvas 以 100%
 * 填满它）作为可用尺寸，避免被 canvas 自身的行内尺寸污染；无父容器（测试桩）时回退到
 * canvas 自身。
 */
export function createSurfaceMetrics(input: {
  canvas: HTMLCanvasElement;
  target: Window & typeof globalThis;
  activeViewport: () => Viewport;
  /**
   * 是否桌面原生壳。缺省视为否（浏览器 iframe）。
   *
   * `surfaceSize()` 在热路径上被调用十几次（含每帧的场景指纹），而「是否原生」在一次
   * realm 生命周期内是常量 —— 不要在这里每次现读 DOM，由调用方在建立 controller 时决定：
   * `hasNativeBootstrap(target) || document.documentElement.dataset.nativeCanvas === "true"`。
   * 两个来源缺一不可：`importModule` 注入路径不建 realm，不会写 DOM 属性；而属性在
   * 原生 realm 销毁时会被清掉，此时宿主仍是桌面壳。
   */
  native?: boolean;
}): SurfaceMetrics {
  const { canvas, target, activeViewport, native = false } = input;
  const surfaceSize = () => {
    const host = canvas.parentElement ?? canvas;
    const rect = host.getBoundingClientRect();
    const width = rect.width || host.clientWidth || canvas.clientWidth || 1;
    const height = rect.height || host.clientHeight || canvas.clientHeight || 1;
    const pixelRatio = Math.min(3, target.devicePixelRatio || 1);
    /*
     * 原点只对**桌面原生壳**有意义：那里交换链（Metal NSView）铺满整个窗口，
     * Bevy 把窗口设成 `origin + 宽`、再用相机视口对齐到偏移后的画布洞
     * （`place_native_surface`，见 `ac175552` / `18e36db0` 的顶栏偏移修复）。
     *
     * 浏览器里渲染器跑在 `.bevy-canvas-surface` 内的 iframe 中，**iframe 自己就是那个洞**，
     * 已经被宿主布局摆在 (left, top)。这时再传原点，Bevy 会把位图撑成 `origin + 宽`，
     * 超出 iframe 的部分被裁掉 —— 实测超出量恒等于资源轨宽度（展开 248 / 收起 64），
     * 表现为卡片被整齐地切掉一块、整幅画面左偏。
     */
    // 无布局时的回退尺寸没有可对齐的原点。
    const laidOut = rect.width > 0;
    const appliesOrigin = native && laidOut;
    return {
      width,
      height,
      pixelRatio,
      originX: appliesOrigin ? Math.round(rect.left) : 0,
      originY: appliesOrigin ? Math.round(rect.top) : 0,
    };
  };
  const readBounds = (): CanvasBounds => {
    const rect = canvas.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };
  const clientToWorld = (client: { x: number; y: number }, bounds?: CanvasBounds): Point => {
    const rect = bounds ?? readBounds();
    return screenToWorld({ x: client.x - rect.left, y: client.y - rect.top }, activeViewport());
  };
  const pointerWorld = (
    event: Pick<PointerEvent, "clientX" | "clientY">,
    bounds?: CanvasBounds
  ): Point => clientToWorld({ x: event.clientX, y: event.clientY }, bounds);
  const worldToClient = (world: { x: number; y: number }, bounds?: CanvasBounds): Point => {
    const rect = bounds ?? readBounds();
    const viewport = activeViewport();
    return { x: world.x * viewport.zoom + viewport.x + rect.left, y: world.y * viewport.zoom + viewport.y + rect.top };
  };
  return { surfaceSize, readBounds, clientToWorld, pointerWorld, worldToClient };
}
