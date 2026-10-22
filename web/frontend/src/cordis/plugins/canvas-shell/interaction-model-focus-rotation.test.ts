/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { MODEL_FOCUS_FOV, type BevyModelEditor } from "@woohaa3/contracts";
import { domFire, installSharedSession } from "./test-support/controller-harness.js";
import { focusHarness, modelCenter } from "./test-support/model-focus-harness.js";

installSharedSession();

const shotEditor: BevyModelEditor = {
  version: "woohaa-model-editor-v1",
  nodeId: "m1",
  toolMode: "camera",
  cameraId: "cam",
  focus: [0, 0, 0],
  radius: 1,
  shot: {
    position: [0, 1, 1], focus: [0, 0, 0], fov: MODEL_FOCUS_FOV,
    azimuth: 0, elevation: Math.PI / 4, distance: 4, aspect: "16:9"
  }
};

describe("聚焦观察相机的鼠标与触摸板旋转", () => {
  it("Alt/Option + 左键拖动旋转观察相机，优先于 gizmo 且释放后停止", () => {
    const handles: string[] = [];
    const h = focusHarness({
      getModelEditor: () => shotEditor,
      shotGesture: {
        begin: (handle) => { handles.push(handle); return true; },
        move() {}, end() {}, cancel() {}
      }
    });
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    const before = h.controller.focusProjection()!;
    const viewport = h.controller.viewport();
    domFire(h.dom, "pointerdown", { button: 0, altKey: true, clientX: point.x, clientY: point.y });
    domFire(h.dom, "pointermove", { clientX: point.x + 60, clientY: point.y + 20 });
    domFire(h.dom, "pointerup", { button: 0, clientX: point.x + 60, clientY: point.y + 20 });
    const after = h.controller.focusProjection()!;
    expect(after.yaw).not.toBe(before.yaw);
    expect(after.pitch).not.toBe(before.pitch);
    expect(after.distance).toBe(before.distance);
    expect(after.target).toEqual(before.target);
    expect(handles).toEqual([]);
    expect(h.controller.viewport()).toEqual(viewport);
    domFire(h.dom, "pointermove", { clientX: point.x + 120, clientY: point.y + 40 });
    expect(h.controller.focusProjection()).toEqual(after);
    h.controller.dispose();
  });

  it("双指滑动无需修饰键即可连续旋转，Ctrl 捏合优先缩放", () => {
    const h = focusHarness({ getModelEditor: () => shotEditor });
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    const before = h.controller.focusProjection()!;
    const viewport = h.controller.viewport();
    domFire(h.dom, "wheel", { deltaX: 60, deltaY: 20, deltaMode: 0 });
    const after = h.controller.focusProjection()!;
    expect(after.yaw).not.toBe(before.yaw);
    expect(after.pitch).not.toBe(before.pitch);
    expect(after.distance).toBe(before.distance);
    expect(after.target).toEqual(before.target);
    expect(h.controller.viewport()).toEqual(viewport);
    // 正反方向滑动可回到原观察角度。
    domFire(h.dom, "wheel", { deltaX: -60, deltaY: -20, deltaMode: 0 });
    expect(h.controller.focusProjection()!.yaw).toBeCloseTo(before.yaw);
    expect(h.controller.focusProjection()!.pitch).toBeCloseTo(before.pitch);
    domFire(h.dom, "wheel", { ctrlKey: true, deltaX: 60, deltaY: -100, deltaMode: 0 });
    const pinched = h.controller.focusProjection()!;
    expect(pinched.yaw).toBeCloseTo(before.yaw);
    expect(pinched.pitch).toBeCloseTo(before.pitch);
    expect(pinched.distance).toBeLessThan(before.distance);
    h.controller.dispose();
  });

  it("双指滑动在抽屉或 modal 打开时不旋转观察相机", () => {
    let modal = false;
    const h = focusHarness({ isModalActive: () => modal });
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    const before = h.controller.focusProjection()!;
    const drawer = document.createElement("div");
    drawer.className = "node-history";
    h.dom.fire("wheel", { deltaX: 60, deltaY: 20, deltaMode: 0, target: drawer });
    expect(h.controller.focusProjection()).toEqual(before);
    modal = true;
    domFire(h.dom, "wheel", { deltaX: 60, deltaY: 20, deltaMode: 0 });
    expect(h.controller.focusProjection()).toEqual(before);
    h.controller.dispose();
  });

  it("竖直双指滑动与惯性连续旋转，并限制俯仰角防止翻转", () => {
    const h = focusHarness();
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    const before = h.controller.focusProjection()!;
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: 10, deltaMode: 0, timeStamp: 0 });
    expect(h.controller.focusProjection()!.pitch).not.toBe(before.pitch);
    expect(h.controller.focusProjection()!.distance).toBe(before.distance);
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: 80, deltaMode: 0, timeStamp: 16 });
    expect(h.controller.focusProjection()!.distance).toBe(before.distance);
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: -90, deltaMode: 0, timeStamp: 32 });
    expect(h.controller.focusProjection()!.yaw).toBeCloseTo(before.yaw);
    expect(h.controller.focusProjection()!.pitch).toBeCloseTo(before.pitch);
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: 100000, deltaMode: 0, timeStamp: 48 });
    expect(Math.abs(h.controller.focusProjection()!.pitch)).toBeLessThan(Math.PI / 2);
    const limited = h.controller.focusProjection()!;
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: 100000, deltaMode: 0, timeStamp: 64 });
    expect(h.controller.focusProjection()).toEqual(limited);
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: -20, deltaMode: 0, timeStamp: 80 });
    expect(h.controller.focusProjection()!.pitch).toBeGreaterThan(limited.pitch);
    h.controller.dispose();
  });

  it("触摸板手势结束后鼠标滚轮恢复缩放，捏合不影响来源识别", () => {
    const h = focusHarness();
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    domFire(h.dom, "wheel", { deltaX: 10, deltaY: 5, deltaMode: 0, timeStamp: 0 });
    const rotated = h.controller.focusProjection()!;
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: -120, deltaMode: 0, timeStamp: 300 });
    const zoomed = h.controller.focusProjection()!;
    expect(zoomed.yaw).toBe(rotated.yaw);
    expect(zoomed.pitch).toBe(rotated.pitch);
    expect(zoomed.distance).toBeLessThan(rotated.distance);
    domFire(h.dom, "wheel", { ctrlKey: true, deltaX: 0, deltaY: -5, deltaMode: 0, timeStamp: 316 });
    const pinched = h.controller.focusProjection()!;
    domFire(h.dom, "wheel", { deltaX: 0, deltaY: 3, deltaMode: 1, timeStamp: 332 });
    expect(h.controller.focusProjection()!.pitch).toBe(pinched.pitch);
    expect(h.controller.focusProjection()!.distance).toBeGreaterThan(pinched.distance);
    h.controller.dispose();
  });

});
