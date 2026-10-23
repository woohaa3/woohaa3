/** @vitest-environment jsdom */
// 验证旋转预览叠加层：预览不改文档、只读不响应指针、松手才提交角度。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RotationOverlay } from "./rotation-overlay.js";
import { rotationFootprint } from "./rotation-frame.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); });

function render(props: Partial<Parameters<typeof RotationOverlay>[0]> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(
    <RotationOverlay document={{ width: 40, height: 30 }} origin={{ x: 0, y: 0 }} zoom={1} angle={0} {...props} />
  ));
  const overlay = container.querySelector<HTMLElement>("[data-rotation-overlay]")!;
  const captured = new Set<number>();
  overlay.setPointerCapture = (id) => { captured.add(id); };
  overlay.hasPointerCapture = (id) => captured.has(id);
  overlay.releasePointerCapture = (id) => { captured.delete(id); };
  // jsdom 的 getBoundingClientRect 恒为 0：client 坐标即文档坐标（origin 0 / zoom 1）。
  const send = (target: Element, type: string, point: { x: number; y: number }) => {
    const event = new MouseEvent(type, { button: 0, clientX: point.x, clientY: point.y, bubbles: true });
    Object.defineProperty(event, "pointerId", { value: 1 });
    act(() => target.dispatchEvent(event));
  };
  return { container, overlay, send };
}

it("按角度渲染新画布尺寸与四个角", () => {
  const { container, overlay } = render({ angle: 45 });
  expect(overlay.dataset.rotationCanvas).toBe("50,50");
  expect(overlay.dataset.rotationAngle).toBe("45.000");
  expect(container.querySelectorAll("[data-rotation-corner]")).toHaveLength(4);
  expect(container.querySelector("[data-rotation-handle]")).not.toBeNull();
  // 未拖动时不显示角度标签，也不提前回报回调。
  expect(container.querySelector("[data-rotation-label]")).toBeNull();
});

it("拖动只预览并回报角度，松手才 onApply", () => {
  const onAngleChange = vi.fn();
  const onApply = vi.fn();
  const { container, overlay, send } = render({ onAngleChange, onApply });
  // 画布中心 (20,15)：从正上方拖到正右方 = 顺时针 90°。
  send(overlay, "pointerdown", { x: 20, y: -5 });
  send(overlay, "pointermove", { x: 45, y: 15 });
  expect(onAngleChange).toHaveBeenCalled();
  expect(onApply).not.toHaveBeenCalled();
  expect(container.querySelector("[data-rotation-label]")).not.toBeNull();
  send(overlay, "pointerup", { x: 45, y: 15 });
  expect(onApply).toHaveBeenCalledTimes(1);
  expect(onApply.mock.calls[0][0]).toBeCloseTo(90, 6);
  // 松手后回到上层角度，标签消失。
  expect(container.querySelector("[data-rotation-label]")).toBeNull();
});

it("只读时不响应指针，也不提交", () => {
  const onApply = vi.fn();
  const { overlay, send } = render({ readonly: true, onApply });
  expect(overlay.style.pointerEvents).toBe("none");
  send(overlay, "pointerdown", { x: 20, y: -5 });
  send(overlay, "pointerup", { x: 45, y: 15 });
  expect(onApply).not.toHaveBeenCalled();
});

it("取消手势回到上层角度，不提交", () => {
  const onApply = vi.fn();
  const onGestureChange = vi.fn();
  const { container, send, overlay } = render({ onApply, onGestureChange });
  send(overlay, "pointerdown", { x: 20, y: -5 });
  send(overlay, "pointermove", { x: 40, y: 0 });
  send(overlay, "pointercancel", { x: 40, y: 0 });
  expect(onApply).not.toHaveBeenCalled();
  expect(onGestureChange).toHaveBeenLastCalledWith(false);
  expect(container.querySelector("[data-rotation-label]")).toBeNull();
});

it("预览框几何与 rotationFootprint 一致", () => {
  const footprint = rotationFootprint({ width: 40, height: 30 }, 30);
  const { container } = render({ angle: 30 });
  const canvas = container.querySelector<SVGRectElement>("rect.photo-editor-rotation__canvas")!;
  expect(Number(canvas.getAttribute("width"))).toBeCloseTo(footprint.size.width, 6);
  expect(Number(canvas.getAttribute("height"))).toBeCloseTo(footprint.size.height, 6);
  expect(container.querySelector("[data-rotation-overlay]")!.getAttribute("data-rotation-canvas"))
    .toBe(`${footprint.size.width},${footprint.size.height}`);
});
