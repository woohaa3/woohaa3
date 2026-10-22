/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { makeFocusProjector, MODEL_FOCUS_FOV, type BevyModelEditor } from "@woohaa3/contracts";
import { modelBounds } from "./model-focus-session.js";
import { domFire, installSharedSession } from "./test-support/controller-harness.js";
import { focusHarness, modelCanvas, modelCenter, targetFor } from "./test-support/model-focus-harness.js";

installSharedSession();

describe("拍摄模式 gizmo 输入", () => {
  for (const rotated of [false, true]) {
    for (const part of ["camera", "ring", "center"] as const) {
      it(`${rotated ? "旋转观察视角后" : "默认视角"}左键拖 ${part} 只编辑对应 rig 参数`, () => {
        const canvas = modelCanvas();
        const target = targetFor(canvas);
        const { center, radius } = modelBounds(target)!;
        const editor: BevyModelEditor = {
          version: "woohaa-model-editor-v1", nodeId: "m1", toolMode: "camera", cameraId: "cam",
          focus: center, radius,
          shot: {
            position: [center[0] + radius * 0.8, center[1] + radius * 0.8, center[2]],
            focus: center, fov: MODEL_FOCUS_FOV, azimuth: Math.PI / 2,
            elevation: Math.PI / 4, distance: radius * Math.SQRT2 * 0.8, aspect: "16:9"
          }
        };
        const calls: string[] = [];
        const h = focusHarness({ canvas, targets: () => [target], getModelEditor: () => editor,
          focusGesture: {
            begin: (handle) => { calls.push(handle); return true; },
            move: (handle) => { calls.push(`move:${handle}`); },
            end: () => { calls.push("end"); }, cancel: () => { calls.push("cancel"); }
          },
          shotGesture: {
            begin: (handle) => { calls.push(handle); return true; },
            move: (handle) => { calls.push(`move:${handle}`); },
            end: () => { calls.push("end"); }, cancel: () => { calls.push("cancel"); }
          }
        });
        const enter = modelCenter(target);
        domFire(h.dom, "dblclick", { clientX: enter.x, clientY: enter.y });
        if (rotated) {
          domFire(h.dom, "pointerdown", { button: 2, clientX: 400, clientY: 300 });
          domFire(h.dom, "pointermove", { clientX: 480, clientY: 320 });
          domFire(h.dom, "pointerup", { button: 2, clientX: 480, clientY: 320 });
        }
        const before = h.controller.focusProjection()!;
        const project = makeFocusProjector({ camera: { ...before, flySpeed: 6 }, surface: target.surface, fov: before.fov });
        // 球笼半径 = 相机到焦点的完整距离（水平投影为 radius*0.8，故完整距离为半径的 √2 倍）。
        const shotDistance = radius * 0.8 * Math.SQRT2;
        const world = part === "center"
          ? center
          : part === "camera"
            ? editor.shot!.position
            : ([center[0] - shotDistance, center[1], center[2]] as [number, number, number]);
        const point = project(world)!;
        expect(point).not.toBeNull();
        domFire(h.dom, "pointerdown", { button: 0, clientX: point.x, clientY: point.y });
        domFire(h.dom, "pointermove", { clientX: point.x + 30, clientY: point.y + 20 });
        domFire(h.dom, "pointerup", { button: 0, clientX: point.x + 30, clientY: point.y + 20 });
        const handle = part === "center" ? "center" : part === "ring" ? "orbit-ring" : "distance";
        expect(calls).toEqual([handle, `move:${handle}`, "end"]);
        expect(h.controller.focusProjection()).toEqual(before);
        h.controller.dispose();
      });
    }
  }

  it("左键拖竖直半圆编辑仰角且不改主观察相机（change: add-shot-camera-elevation-control）", () => {
    const canvas = modelCanvas();
    const target = targetFor(canvas);
    const { center, radius } = modelBounds(target)!;
    const editor: BevyModelEditor = {
      version: "woohaa-model-editor-v1", nodeId: "m1", toolMode: "camera", cameraId: "cam",
      focus: center, radius,
      shot: {
        position: [center[0] + radius * 0.8, center[1] + radius * 0.8, center[2]],
        focus: center, fov: MODEL_FOCUS_FOV, azimuth: Math.PI / 2,
        elevation: Math.PI / 4, distance: radius * Math.SQRT2 * 0.8, aspect: "16:9"
      }
    };
    const calls: string[] = [];
    const h = focusHarness({ canvas, targets: () => [target], getModelEditor: () => editor,
      shotGesture: {
        begin: (handle) => { calls.push(handle); return true; },
        move: (handle) => { calls.push(`move:${handle}`); },
        end: () => { calls.push("end"); }, cancel: () => { calls.push("cancel"); }
      }
    });
    const enter = modelCenter(target);
    domFire(h.dom, "dblclick", { clientX: enter.x, clientY: enter.y });
    const before = h.controller.focusProjection()!;
    const project = makeFocusProjector({ camera: { ...before, flySpeed: 6 }, surface: target.surface, fov: before.fov });
    // 相机水平镜像在 +X，故竖直半圆的方位径向为 +X；弧半径为完整距离 0.8r√2，取 20° 仰角处方。
    const cageRadius = radius * 0.8 * Math.SQRT2;
    const angle = (20 * Math.PI) / 180;
    const world: [number, number, number] = [
      center[0] + Math.cos(angle) * cageRadius,
      center[1] + Math.sin(angle) * cageRadius,
      center[2]
    ];
    const point = project(world)!;
    expect(point).not.toBeNull();
    domFire(h.dom, "pointerdown", { button: 0, clientX: point.x, clientY: point.y });
    domFire(h.dom, "pointermove", { clientX: point.x, clientY: point.y - 20 });
    domFire(h.dom, "pointerup", { button: 0, clientX: point.x, clientY: point.y - 20 });
    expect(calls).toEqual(["elevation-ring", "move:elevation-ring", "end"]);
    expect(h.controller.focusProjection()).toEqual(before);
    h.controller.dispose();
  });
});
