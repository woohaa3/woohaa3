/** @vitest-environment jsdom */
// 共享画布的修饰接线（change: 2026-10-22-add-photocraft-retouch-workflows，B1/B3）。
//
// 这里只验证**共享外壳**是否真的把区域手势交给调用方、把叠加层渲染出来；几何与命令语义在
// 域内模块（`region-gesture.ts` / `clone-overlay.ts` / Rust）里各自有独立回归。
import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PhotoCanvas, type PhotoCanvasHandle, type PhotoCanvasProps } from "../../photo-editor-canvas.js";
import { CloneSourceOverlay } from "./overlay.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });

function setup(props: Partial<PhotoCanvasProps> = {}) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  const ref = createRef<PhotoCanvasHandle>();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  function Harness({ value }: { value: Partial<PhotoCanvasProps> }) {
    const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
    return <PhotoCanvas ref={ref} documentWidth={160} documentHeight={120} tool="retouch"
      view={{ viewport, fitZoom: 1, transitioning: false, onChange: (next) => setViewport(next) }} {...value} />;
  }
  act(() => root.render(<Harness value={props} />));
  const stage = container.querySelector<HTMLDivElement>(".photo-editor-canvas")!;
  const captured = new Set<number>();
  stage.setPointerCapture = vi.fn((id: number) => { captured.add(id); });
  stage.hasPointerCapture = (id: number) => captured.has(id);
  stage.releasePointerCapture = vi.fn((id: number) => { captured.delete(id); });
  return { ref, stage, container };
}

function pointerEvent(type: string, x: number, y: number, id = 1) {
  const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true });
  Object.defineProperty(event, "pointerId", { value: id });
  return event;
}

function drag(stage: Element, from: [number, number], to: [number, number]) {
  act(() => stage.dispatchEvent(pointerEvent("pointerdown", from[0], from[1])));
  act(() => stage.dispatchEvent(pointerEvent("pointermove", to[0], to[1])));
  act(() => stage.dispatchEvent(pointerEvent("pointerup", to[0], to[1])));
}

it("区域手势把拖动起点/终点交给调用方，而不是落成一条普通笔迹", () => {
  const gesture = vi.fn();
  const stroke = vi.fn();
  const begin = vi.fn();
  const { stage } = setup({ regionGestureKind: "drag", onRegionGesture: gesture, onStroke: stroke, onStrokeStart: begin });
  // 画布在容器内居中：文档 160×120、容器 800×600、zoom 1 → origin (320, 240)。
  drag(stage, [340, 260], [380, 300]);
  expect(stroke).not.toHaveBeenCalled();
  expect(begin).not.toHaveBeenCalled();
  expect(gesture).toHaveBeenCalledTimes(1);
  const [from, to, moved] = gesture.mock.calls[0];
  expect(Math.round(from.x)).toBe(20);
  expect(Math.round(from.y)).toBe(20);
  expect(Math.round(to.x)).toBe(60);
  expect(Math.round(to.y)).toBe(60);
  expect(moved).toBe(true);
});

it("红眼是单击：按下即标记，不要求拖动距离", () => {
  const gesture = vi.fn();
  const stroke = vi.fn();
  const { stage } = setup({ regionGestureKind: "click", onRegionGesture: gesture, onStroke: stroke });
  act(() => stage.dispatchEvent(pointerEvent("pointerdown", 340, 260)));
  act(() => stage.dispatchEvent(pointerEvent("pointerup", 340, 260)));
  expect(stroke).not.toHaveBeenCalled();
  expect(gesture).toHaveBeenCalledTimes(1);
  const [from, to, moved] = gesture.mock.calls[0];
  expect(from).toEqual(to);
  expect(moved).toBe(false);
  expect(Math.round(from.x)).toBe(20);
});

it("没有区域入口时修饰工具仍走笔迹路径（旧宿主行为不回退）", () => {
  const stroke = vi.fn();
  const begin = vi.fn();
  const { stage } = setup({ onStroke: stroke, onStrokeStart: begin });
  drag(stage, [340, 260], [360, 280]);
  expect(begin).toHaveBeenCalledTimes(1);
  expect(stroke).toHaveBeenCalledTimes(1);
});

it("仿制源叠加取样框按四角与不透明度渲染，反相走差集混合", () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(
    <CloneSourceOverlay frame={{ corners: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 40 }, { x: 10, y: 40 }], opacity: 0.5, invert: true }} />
  ));
  const overlay = container.querySelector('[data-testid="clone-source-overlay"]')!;
  expect(overlay).toBeTruthy();
  expect(overlay.getAttribute("data-invert")).toBe("true");
  const polygon = overlay.querySelector("polygon")!;
  expect(polygon.getAttribute("points")).toBe("10,10 60,10 60,40 10,40");
  expect(polygon.getAttribute("stroke-opacity")).toBe("0.5");
});

// 真实走查发现的缺陷：叠加层 SVG 默认接收指针事件，盖在笔尖起点上，画布的 pointerdown
// 收不到 → 仿制图章/修复画笔落笔静默失败（既没提示也没历史）。叠加层只能当提示。
it("仿制源叠加框不拦截指针事件（否则会吃掉落笔起点）", () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(
    <CloneSourceOverlay frame={{ corners: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 40 }, { x: 10, y: 40 }], opacity: 1, invert: false }} />
  ));
  const overlay = container.querySelector<SVGSVGElement>('[data-testid="clone-source-overlay"]')!;
  expect(overlay.style.pointerEvents).toBe("none");
});

it("四角不足三个时不画（避免退化的取样框）", () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<CloneSourceOverlay frame={{ corners: [{ x: 1, y: 1 }], opacity: 1, invert: false }} />));
  expect(container.querySelector('[data-testid="clone-source-overlay"]')).toBeNull();
});
