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
  /** 可用画布尺寸（CSS 像素）+ DPR；见 `interaction-controller.ts` 的包含块说明。 */
  surfaceSize: () => { width: number; height: number; pixelRatio: number };
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
}): SurfaceMetrics {
  const { canvas, target, activeViewport } = input;
  const surfaceSize = () => {
    const host = canvas.parentElement ?? canvas;
    const rect = host.getBoundingClientRect();
    const width = rect.width || host.clientWidth || canvas.clientWidth || 1;
    const height = rect.height || host.clientHeight || canvas.clientHeight || 1;
    const pixelRatio = Math.min(3, target.devicePixelRatio || 1);
    return { width, height, pixelRatio };
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
