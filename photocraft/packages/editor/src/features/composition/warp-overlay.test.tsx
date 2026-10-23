/** @vitest-environment jsdom */
// 只验证指针事件与网格数据回报；像素结果由内核测试覆盖。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { identityWarpMesh, moveMeshPoint } from "./warp-mesh.js";
import { WarpOverlay } from "./warp-overlay.js";
import type { TransformRect } from "./workflows.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); });

const rect: TransformRect = [10, 20, 70, 60];

function setup(overrides: Partial<Parameters<typeof WarpOverlay>[0]> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const mesh = overrides.mesh ?? identityWarpMesh([10, 20, 70, 60], 1, 1);
  const onMeshChange = vi.fn();
  const onApply = vi.fn();
  const onSplit = vi.fn();
  const onGestureChange = vi.fn();
  act(() => root.render(
    <WarpOverlay
      rect={rect}
      mesh={mesh}
      origin={{ x: 5, y: 7 }}
      zoom={2}
      onMeshChange={onMeshChange}
      onApply={onApply}
      onSplit={onSplit}
      onGestureChange={onGestureChange}
      {...overrides}
    />
  ));
  const overlay = container.querySelector<HTMLElement>("[data-warp-overlay]")!;
  const captured = new Set<number>();
  overlay.setPointerCapture = (id) => { captured.add(id); };
  overlay.hasPointerCapture = (id) => captured.has(id);
  overlay.releasePointerCapture = (id) => { captured.delete(id); };
  const send = (target: Element, type: string, point: { x: number; y: number }) => {
    const event = new MouseEvent(type, { button: 0, clientX: point.x * 2 + 5, clientY: point.y * 2 + 7, bubbles: true });
    Object.defineProperty(event, "pointerId", { value: 1 });
    act(() => target.dispatchEvent(event));
  };
  const point = (index: number) => container.querySelector(`[data-mesh-point="${index}"]`)!;
  return { container, overlay, mesh, point, send, onMeshChange, onApply, onSplit, onGestureChange };
}

it("显示 4×4 控制点与 24 条网格线，变形框按 origin/zoom 定位", () => {
  const { container, overlay } = setup();
  expect(container.querySelectorAll("[data-mesh-point]")).toHaveLength(16);
  expect(container.querySelectorAll("[data-warp-mesh-lines] line")).toHaveLength(24);
  expect(overlay.dataset.warpPoints).toBe("16");
  // rect (10,20) → origin(5,7) + (10,20)×2。
  expect(overlay.style.left).toBe("25px");
  expect(overlay.style.top).toBe("47px");
  expect(overlay.style.width).toBe("120px");
  expect(overlay.style.height).toBe("80px");
});

it("拖动控制点只改该点，实时回报并在松手时标记「有改动」", () => {
  const { overlay, point, send, mesh, onMeshChange, onApply, onGestureChange } = setup();
  // 第 5 个点 = 第二行第二列，恒等网格下是 (30, 20+40/3)。
  send(point(5), "pointerdown", { x: 30, y: 33 });
  expect(onGestureChange).toHaveBeenCalledWith(true);
  send(overlay, "pointermove", { x: 25, y: 40 });
  const next = onMeshChange.mock.calls.at(-1)![0];
  expect(next.points[5][0]).toBeCloseTo(25);
  expect(next.points[5][1]).toBeCloseTo(40);
  expect(next.points[0]).toEqual(mesh.points[0]);
  expect(onApply).not.toHaveBeenCalled();
  send(overlay, "pointerup", { x: 25, y: 40 });
  expect(onApply).toHaveBeenCalledOnce();
  expect(onApply.mock.calls.at(-1)![1]).toBe(true);
  expect(onGestureChange).toHaveBeenLastCalledWith(false);
});

it("没拖动实质位移时松手报告无改动，界面因此不提交", () => {
  const { overlay, point, send, onApply } = setup();
  send(point(0), "pointerdown", { x: 10, y: 20 });
  send(overlay, "pointerup", { x: 10, y: 20 });
  expect(onApply).toHaveBeenCalledOnce();
  expect(onApply.mock.calls.at(-1)![1]).toBe(false);
});

it("双击回报分割点；只读时不接管指针与双击", () => {
  const { overlay, point, send, onSplit } = setup();
  send(point(0), "pointerdown", { x: 10, y: 20 });
  send(overlay, "pointerup", { x: 10, y: 20 });
  const double = new MouseEvent("dblclick", { clientX: 50 * 2 + 5, clientY: 40 * 2 + 7, bubbles: true });
  act(() => overlay.dispatchEvent(double));
  expect(onSplit).toHaveBeenCalledWith([50, 40]);

  const readonly = setup({ readonly: true });
  readonly.send(readonly.point(0), "pointerdown", { x: 10, y: 20 });
  readonly.send(readonly.overlay, "pointermove", { x: 30, y: 30 });
  expect(readonly.onMeshChange).not.toHaveBeenCalled();
  expect(readonly.onGestureChange).not.toHaveBeenCalled();
});

it("预设样式模式只画变形框，不渲染控制点", () => {
  const { container } = setup({ showMesh: false });
  expect(container.querySelectorAll("[data-mesh-point]")).toHaveLength(0);
  expect(container.querySelectorAll("[data-warp-mesh-lines] line")).toHaveLength(0);
});

it("cancel 丢弃预览且不提交；已拖动的网格仍可继续拖另一点", () => {
  const { overlay, point, send, onApply, onGestureChange } = setup();
  send(point(1), "pointerdown", { x: 30, y: 20 });
  send(overlay, "pointermove", { x: 40, y: 25 });
  send(overlay, "pointercancel", { x: 40, y: 25 });
  expect(onApply).not.toHaveBeenCalled();
  expect(onGestureChange).toHaveBeenLastCalledWith(false);
  // 再拖一次仍然只从初始网格出发（取消不污染状态）。
  send(point(1), "pointerdown", { x: 30, y: 20 });
  send(overlay, "pointerup", { x: 30, y: 20 });
  expect(onApply).toHaveBeenCalledOnce();
  expect(onApply.mock.calls.at(-1)![1]).toBe(false);
});

it("外部传入已改动网格时，松手判定为有改动", () => {
  const base = identityWarpMesh([10, 20, 70, 60], 1, 1);
  const warped = moveMeshPoint(base, 15, [100, 100]);
  const { overlay, point, send, onApply } = setup({ mesh: warped });
  send(point(0), "pointerdown", { x: 10, y: 20 });
  send(overlay, "pointerup", { x: 10, y: 20 });
  expect(onApply.mock.calls.at(-1)![1]).toBe(true);
});
