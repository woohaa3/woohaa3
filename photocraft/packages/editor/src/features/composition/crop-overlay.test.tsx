/** @vitest-environment jsdom */
// 只验证指针事件与几何回报，不执行像素合成或截图。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CropOverlay } from "./crop-overlay.js";
import type { CropFrameRect } from "./crop-frame.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); });

const frame: CropFrameRect = { x: 10, y: 20, width: 100, height: 80 };
const documentSize = { width: 140, height: 120 };

function setup(overrides: Partial<Parameters<typeof CropOverlay>[0]> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onFrameChange = vi.fn();
  const onStraightenChange = vi.fn();
  const onApply = vi.fn();
  const onGestureChange = vi.fn();
  act(() => root.render(
    <CropOverlay
      frame={frame}
      document={documentSize}
      origin={{ x: 5, y: 7 }}
      zoom={2}
      grid="thirds"
      onFrameChange={onFrameChange}
      onStraightenChange={onStraightenChange}
      onApply={onApply}
      onGestureChange={onGestureChange}
      {...overrides}
    />
  ));
  const overlay = container.querySelector<HTMLElement>("[data-crop-overlay]")!;
  const captured = new Set<number>();
  overlay.setPointerCapture = (id) => { captured.add(id); };
  overlay.hasPointerCapture = (id) => captured.has(id);
  overlay.releasePointerCapture = (id) => { captured.delete(id); };
  // jsdom 的 getBoundingClientRect 恒为 0，指针换算因此等价于 (client - origin) / zoom。
  const send = (target: Element, type: string, point: { x: number; y: number }, init: MouseEventInit = {}) => {
    const event = new MouseEvent(type, { button: 0, clientX: point.x * 2 + 5, clientY: point.y * 2 + 7, bubbles: true, ...init });
    Object.defineProperty(event, "pointerId", { value: 1 });
    act(() => target.dispatchEvent(event));
  };
  const handle = (name: string) => container.querySelector(`[data-crop-handle="${name}"]`)!;
  return { container, overlay, handle, send, onFrameChange, onStraightenChange, onApply, onGestureChange };
}

it("九个手柄与遮罩、三分线都在，框位置按 origin/zoom 投影", () => {
  const { container, overlay } = setup();
  expect(container.querySelectorAll("[data-crop-handle]")).toHaveLength(9);
  expect(overlay.dataset.cropFrame).toBe("10,20,100,80");
  // 遮罩用 even-odd：整幅画布 + 裁剪框两条子路径。
  const mask = container.querySelector(".photo-editor-crop__mask")!;
  expect(mask.getAttribute("fill-rule")).toBe("evenodd");
  expect(mask.getAttribute("d")!.match(/M/g)!.length).toBe(2);
  // 三分线 = 两条竖 + 两条横。
  expect(container.querySelectorAll(".photo-editor-crop__grid line")).toHaveLength(4);
  // 左上角手柄：origin(5,7) + (10,20)×2。
  const nw = container.querySelector<HTMLElement>('[data-crop-handle="nw"]')!;
  expect(nw.style.left).toBe("25px");
  expect(nw.style.top).toBe("47px");
});
it("拖角手柄缩放：实时回报并只在松手时提交一次", () => {
  const { overlay, handle, send, onFrameChange, onApply, onGestureChange } = setup();
  send(handle("se"), "pointerdown", { x: 110, y: 100 });
  expect(onGestureChange).toHaveBeenCalledWith(true);
  send(overlay, "pointermove", { x: 130, y: 120 });
  expect(onFrameChange).toHaveBeenLastCalledWith({ x: 10, y: 20, width: 120, height: 100 });
  expect(onApply).not.toHaveBeenCalled();
  send(overlay, "pointerup", { x: 130, y: 120 });
  expect(onApply).toHaveBeenCalledOnce();
  expect(onApply).toHaveBeenCalledWith({ x: 10, y: 20, width: 120, height: 100 }, 0);
  expect(onGestureChange).toHaveBeenLastCalledWith(false);
});

it("拖动框内平移，框外按下不接管画布手势", () => {
  const { overlay, send, onFrameChange, onApply, onGestureChange } = setup();
  send(overlay, "pointerdown", { x: 130, y: 115 }); // 框外
  expect(onGestureChange).not.toHaveBeenCalled();
  send(overlay, "pointermove", { x: 60, y: 60 }); // 框内
  expect(onFrameChange).not.toHaveBeenCalled();
  send(overlay, "pointerdown", { x: 60, y: 60 });
  send(overlay, "pointermove", { x: 65, y: 70 });
  expect(onFrameChange).toHaveBeenLastCalledWith({ x: 15, y: 30, width: 100, height: 80 });
  send(overlay, "pointerup", { x: 65, y: 70 });
  expect(onApply).toHaveBeenLastCalledWith({ x: 15, y: 30, width: 100, height: 80 }, 0);
});

it("旋转手柄给出拉直角度并显示读数，角度随松手一起提交", () => {
  const { container, overlay, handle, send, onStraightenChange, onApply } = setup();
  // 框中心 (60,60)；指针在正右方 → 顺时针 45°（夹在 ±45°）。
  send(handle("rotate"), "pointerdown", { x: 60, y: 20 });
  send(overlay, "pointermove", { x: 200, y: 60 });
  expect(onStraightenChange).toHaveBeenLastCalledWith(45);
  expect(container.querySelector("[data-crop-angle]")!.textContent).toBe("45.0°");
  send(overlay, "pointerup", { x: 200, y: 60 });
  expect(onApply).toHaveBeenCalledWith(frame, 45);
});

it("比例约束在拖动时生效，非法框不提交", () => {
  const { overlay, handle, send, onFrameChange, onApply } = setup({ ratio: 1 });
  send(handle("e"), "pointerdown", { x: 110, y: 60 });
  send(overlay, "pointermove", { x: 130, y: 60 });
  const next = onFrameChange.mock.calls.at(-1)![0] as CropFrameRect;
  expect(next.width).toBe(next.height);
  send(overlay, "pointerup", { x: 130, y: 60 });
  expect(onApply).toHaveBeenCalledOnce();
  // 指针没动过（宽高未变）仍会提交，但框必须合法。
  const applied = onApply.mock.calls.at(-1)![0] as CropFrameRect;
  expect(applied.width).toBeGreaterThanOrEqual(1);
});

it("只读时不接管指针，cancel 丢弃预览而不提交", () => {
  const { overlay, handle, send, onFrameChange, onGestureChange } = setup({ readonly: true });
  send(handle("se"), "pointerdown", { x: 110, y: 100 });
  send(overlay, "pointermove", { x: 120, y: 110 });
  expect(onGestureChange).not.toHaveBeenCalled();
  expect(onFrameChange).not.toHaveBeenCalled();

  const active = setup();
  active.send(active.handle("se"), "pointerdown", { x: 110, y: 100 });
  active.send(active.overlay, "pointermove", { x: 130, y: 120 });
  active.send(active.overlay, "pointercancel", { x: 130, y: 120 });
  expect(active.onApply).not.toHaveBeenCalled();
  expect(active.onGestureChange).toHaveBeenLastCalledWith(false);
});

it("网格切换与网格线数量随设置变化", () => {
  const none = setup({ grid: "none" });
  expect(none.container.querySelectorAll(".photo-editor-crop__grid line")).toHaveLength(0);
  const grid = setup({ grid: "grid" });
  // 40×30 的框按 zoom=2 → 步长 8 文档像素，横竖各若干条。
  expect(grid.container.querySelectorAll(".photo-editor-crop__grid line").length).toBeGreaterThan(4);
});
