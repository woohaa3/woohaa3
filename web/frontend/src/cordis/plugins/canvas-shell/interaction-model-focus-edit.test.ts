/**
 * 交互控制器：模型聚焦编辑测试
 * （由 interaction-controller.test.ts 机械拆分，断言不变）。
 */
import { describe, expect, it } from "vitest";
import {
  focusGizmoGeometry,
  makeFocusProjector,
  MODEL_FOCUS_FOV,
  type CanvasCommand,
  type SceneV2Op
} from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import { modelBounds } from "./model-focus-session.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { parameterPreviewStore } from "../../services/parameter-preview.js";
import {
  domFire, getSession, harness, installSharedSession, runtimeCapturing, submitted
} from "./test-support/controller-harness.js";
import { focusHarness, modelCanvas, modelCenter, modelPickForTargets, targetFor, unitBox } from "./test-support/model-focus-harness.js";

installSharedSession();

describe("模型聚焦编辑（change: add-model-focus-viewing / editing）", () => {
  it("双击实际模型 AABB 进入聚焦并设为 primary selection", () => {
    const h = focusHarness();
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    expect(h.controller.isModelFocused()).toBe(true);
    expect(h.controller.focusProjection()?.nodeId).toBe("m1");
    expect(nodeSelectionStore.getSnapshot().primaryNodeId).toBe("m1");
    // 投影已上报且参与渲染快照。
    expect(h.projections.at(-1)?.nodeId).toBe("m1");
    h.controller.dispose();
  });

  it("双击模型卡片进入聚焦（网格在卡片下方，射线可以不打中 AABB）", () => {
    const h = focusHarness();
    domFire(h.dom, "dblclick", { clientX: 205, clientY: 105 });
    expect(h.controller.isModelFocused()).toBe(true);
    expect(h.controller.focusProjection()?.nodeId).toBe("m1");
    h.controller.dispose();
  });

  it("双击卡片和模型之外的空白不进入聚焦", () => {
    const h = focusHarness();
    domFire(h.dom, "dblclick", { clientX: 20, clientY: 20 });
    expect(h.controller.isModelFocused()).toBe(false);
    expect(h.projections).toHaveLength(0);
    h.controller.dispose();
  });

  it("双击不在 targets 中的节点（pending-only）不进入聚焦", () => {
    const canvas = modelCanvas();
    const h = focusHarness({ canvas, targets: () => [] });
    const point = modelCenter(targetFor(canvas));
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    expect(h.controller.isModelFocused()).toBe(false);
    h.controller.dispose();
  });

  it("content rect 只按像素比例平移，不因 surface 高度缺失把目标推出取景", () => {
    const h = focusHarness();
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    expect(h.controller.isModelFocused()).toBe(true);
    const before = h.controller.focusProjection()!;

    // 右侧历史 drawer 宽 400px：同一 surface（1000×800）下偏移应为
    // (400/2) * worldPerPixel，远小于模型自身尺度，绝非「整屏之外」。
    h.controller.setContentRect({ right: 400 });
    const after = h.controller.focusProjection()!;
    const shift = Math.hypot(after.target[0] - before.target[0], after.target[2] - before.target[2]);
    // 若 surface 高度退化为 1px，偏移按 800× 膨胀（约 6.5e4）；这里断言它保持在
    // 与遮挡像素同量级的合理范围（数百以内），从而锁死该回归。
    expect(shift).toBeGreaterThan(0);
    expect(shift).toBeLessThan(500);
    h.controller.dispose();
  });

  it("聚焦时拖动模型本体不产生 2D node.update，也不写 modelPlacement", () => {
    const h = focusHarness();
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    expect(h.controller.isModelFocused()).toBe(true);
    submitted.length = 0;

    // 主键拖动模型本体：不再进入 placement 手势，既不产生 2D node.update 也不提交
    // nodeData.patch（change: replace-model-node-focus-interactions）。
    domFire(h.dom, "pointerdown", { button: 0, clientX: point.x, clientY: point.y });
    domFire(h.dom, "pointermove", { clientX: point.x + 200, clientY: point.y });
    domFire(h.dom, "pointerup", { clientX: point.x + 200, clientY: point.y });
    h.controller.flush();

    expect(submitted.some((command) => command.type === "node.update")).toBe(false);
    expect(submitted.filter((command) => command.type === "nodeData.patch")).toHaveLength(0);
    h.controller.dispose();
  });

  it("聚焦时 Shift 拖动模型本体同样不写 modelPlacement", () => {
    const h = focusHarness();
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    expect(h.controller.isModelFocused()).toBe(true);
    submitted.length = 0;

    domFire(h.dom, "pointerdown", { button: 0, shiftKey: true, clientX: point.x, clientY: point.y });
    domFire(h.dom, "pointermove", { clientX: point.x + 50, clientY: point.y + 100 });
    domFire(h.dom, "pointerup", { clientX: point.x + 50, clientY: point.y + 100 });
    h.controller.flush();

    expect(submitted.filter((command) => command.type === "nodeData.patch")).toHaveLength(0);
    h.controller.dispose();
  });

  it("左键未命中 gizmo 时不导航，右键仅旋转观察相机", () => {
    const events: string[] = [];
    const canvas = modelCanvas();
    const target = targetFor(canvas);
    const worldCenter = modelBounds(target)!.center;
    // 镜头位于 focus 上方 45°、距离 6；屏幕投影后原点与焦点不同。
    const h = focusHarness({
      canvas,
      targets: () => [target],
      getModelEditor: () => ({
        version: "woohaa-model-editor-v2",
        nodeId: "m1",
        toolMode: "camera",
        cameraId: "cam-a",
        focus: worldCenter,
        radius: 2,
        shot: {
          position: [worldCenter[0], worldCenter[1] + 4, worldCenter[2] + 4],
          focus: worldCenter,
          fov: MODEL_FOCUS_FOV,
          azimuth: 0,
          elevation: Math.PI / 4,
          distance: 6,
          aspect: "16:9"
        }
      }),
      shotGesture: {
        begin: () => {
          events.push("begin");
          return true;
        },
        move: () => events.push("move"),
        end: () => events.push("end"),
        cancel: () => events.push("cancel")
      }
    });
    const enter = modelCenter(target);
    domFire(h.dom, "dblclick", { clientX: enter.x, clientY: enter.y });
    expect(h.controller.isModelFocused()).toBe(true);
    submitted.length = 0;

    const before = h.controller.focusProjection()!;
    domFire(h.dom, "pointerdown", { button: 0, clientX: 400, clientY: 300 });
    domFire(h.dom, "pointermove", { clientX: 460, clientY: 320 });
    domFire(h.dom, "pointerup", { button: 0, clientX: 460, clientY: 320 });
    h.controller.flush();
    expect(events).toEqual([]);
    expect(h.controller.focusProjection()!.yaw).toBe(before.yaw);
    expect(submitted.filter((command) => command.type === "nodeData.patch")).toHaveLength(0);

    domFire(h.dom, "pointerdown", { button: 2, clientX: 400, clientY: 300 });
    domFire(h.dom, "pointermove", { clientX: 460, clientY: 320 });
    domFire(h.dom, "pointerup", { button: 2, clientX: 460, clientY: 320 });
    expect(events).toEqual([]);
    expect(h.controller.focusProjection()!.yaw).not.toBe(before.yaw);
    h.controller.dispose();
  });

  it("显式方位工具以主按钮拖动写镜头，观察相机保持不变", () => {
    const events: string[] = [];
    const canvas = modelCanvas();
    const target = targetFor(canvas);
    const worldCenter = modelBounds(target)!.center;
    const h = focusHarness({
      canvas,
      targets: () => [target],
      getModelEditor: () => ({
        version: "woohaa-model-editor-v2",
        nodeId: "m1",
        toolMode: "camera",
        cameraTool: "orbit",
        cameraId: "cam-a",
        focus: worldCenter,
        radius: 2,
        shot: {
          position: [worldCenter[0], worldCenter[1] + 4, worldCenter[2] + 4],
          focus: worldCenter,
          fov: MODEL_FOCUS_FOV,
          azimuth: 0,
          elevation: Math.PI / 4,
          distance: 6,
          aspect: "16:9"
        }
      }),
      shotGesture: {
        begin: () => {
          events.push("begin");
          return true;
        },
        move: () => events.push("move"),
        end: () => events.push("end"),
        cancel: () => events.push("cancel")
      }
    });
    const enter = modelCenter(target);
    domFire(h.dom, "dblclick", { clientX: enter.x, clientY: enter.y });
    expect(h.controller.isModelFocused()).toBe(true);
    const before = h.controller.focusProjection()!;
    domFire(h.dom, "pointerdown", { button: 0, clientX: 500, clientY: 700 });
    domFire(h.dom, "pointermove", { clientX: 540, clientY: 700 });
    domFire(h.dom, "pointerup", { button: 0, clientX: 540, clientY: 700 });
    h.controller.flush();
    expect(events).toEqual(["begin", "move", "move", "end"]);
    expect(h.controller.focusProjection()!.yaw).toBe(before.yaw);
    h.controller.dispose();
  });

  it("注视点三轴响应左键拖动且不移动观察相机", () => {
    const events: string[] = [];
    const canvas = modelCanvas();
    const target = targetFor(canvas);
    const worldCenter = modelBounds(target)!.center;
    const editor = {
      version: "woohaa-model-editor-v2" as const,
      nodeId: "m1",
      toolMode: "camera" as const,
      cameraTool: "focus" as const,
      cameraId: "cam-a",
      focus: worldCenter,
      radius: 2,
      shot: {
        position: worldCenter,
        focus: worldCenter,
        fov: MODEL_FOCUS_FOV,
        azimuth: 0,
        elevation: Math.PI / 4,
        distance: 6,
        aspect: "16:9" as const
      }
    };
    const h = focusHarness({
      canvas,
      targets: () => [target],
      getModelEditor: () => editor,
      focusGesture: {
        begin: () => {
          events.push("begin");
          return true;
        },
        move: () => events.push("move"),
        end: () => events.push("end"),
        cancel: () => events.push("cancel")
      }
    });
    const enter = modelCenter(target);
    domFire(h.dom, "dblclick", { clientX: enter.x, clientY: enter.y });
    expect(h.controller.isModelFocused()).toBe(true);
    submitted.length = 0;

    // 用与控制器相同的聚焦投影器计算 X 轴中点屏幕坐标。
    const projection = h.controller.focusProjection()!;
    const camera = {
      target: projection.target,
      yaw: projection.yaw,
      pitch: projection.pitch,
      distance: projection.distance,
      flySpeed: 6
    };
    const geometry = focusGizmoGeometry({ focus: editor.shot.focus, radius: editor.radius });
    const project = makeFocusProjector({ camera, surface: { width: 1000, height: 800 }, fov: MODEL_FOCUS_FOV });
    const xMid = project([(geometry.x[0] + geometry.origin[0]) / 2, (geometry.x[1] + geometry.origin[1]) / 2, (geometry.x[2] + geometry.origin[2]) / 2]);
    expect(xMid).not.toBeNull();
    const before = h.controller.focusProjection()!;
    domFire(h.dom, "pointerdown", { button: 0, clientX: xMid!.x, clientY: xMid!.y });
    domFire(h.dom, "pointermove", { clientX: xMid!.x + 30, clientY: xMid!.y });
    domFire(h.dom, "pointerup", { clientX: xMid!.x + 30, clientY: xMid!.y });
    h.controller.flush();
    expect(events).toEqual(["begin", "move", "move", "end"]);
    expect(h.controller.focusProjection()!.yaw).toBe(before.yaw);
    expect(submitted.filter((command) => command.type === "nodeData.patch")).toHaveLength(0);
    h.controller.dispose();
  });

  it("聚焦拖动模型本体不提交命令", () => {
    const h = focusHarness();
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    submitted.length = 0;

    domFire(h.dom, "pointerdown", { button: 0, clientX: point.x, clientY: point.y });
    domFire(h.dom, "pointermove", { clientX: point.x + 120, clientY: point.y + 40 });
    domFire(h.dom, "pointerup", { clientX: point.x + 120, clientY: point.y + 40 });
    h.controller.flush();

    expect(submitted.filter((command) => command.type === "nodeData.patch")).toHaveLength(0);
    h.controller.dispose();
  });

  it("聚焦拖动回到起点释放不提交命令", () => {
    const h = focusHarness();
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    submitted.length = 0;

    domFire(h.dom, "pointerdown", { button: 0, clientX: point.x, clientY: point.y });
    domFire(h.dom, "pointermove", { clientX: point.x + 80, clientY: point.y });
    domFire(h.dom, "pointermove", { clientX: point.x, clientY: point.y });
    domFire(h.dom, "pointerup", { clientX: point.x, clientY: point.y });
    h.controller.flush();

    expect(submitted.filter((command) => command.type === "nodeData.patch")).toHaveLength(0);
    h.controller.dispose();
  });

  it("pointercancel 取消编辑：清理 preview 且不提交", () => {
    const h = focusHarness();
    const point = modelCenter(h.target);
    domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
    submitted.length = 0;

    domFire(h.dom, "pointerdown", { button: 0, clientX: point.x, clientY: point.y });
    domFire(h.dom, "pointermove", { clientX: point.x + 120, clientY: point.y });
    domFire(h.dom, "pointercancel", { pointerId: 1 });
    h.controller.flush();

    expect(submitted.filter((command) => command.type === "nodeData.patch")).toHaveLength(0);
    expect(parameterPreviewStore.get("m1")).toBeUndefined();
    h.controller.dispose();
  });

  it("只读会话聚焦拖动不进入 placement 手势", () => {
    const canvas = modelCanvas();
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
    const dom = harness();
    const { runtime } = runtimeCapturing({ modelPick: modelPickForTargets([targetFor(canvas)], canvas) });
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      getModelFocusTargets: () => [targetFor(canvas)],
      getModelFocus: () => controller.focusProjection(),
      target: dom.target as never,
      isWritable: () => false
    });
    const point = modelCenter(targetFor(canvas));
    domFire(dom, "dblclick", { clientX: point.x, clientY: point.y });
    expect(controller.isModelFocused()).toBe(true);
    submitted.length = 0;
    domFire(dom, "pointerdown", { button: 0, clientX: point.x, clientY: point.y });
    domFire(dom, "pointermove", { clientX: point.x + 120, clientY: point.y });
    domFire(dom, "pointerup", { clientX: point.x + 120, clientY: point.y });
    controller.flush();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });

  it("非 canonical 临时快照禁用 placement 编辑", () => {
    const canvas = modelCanvas();
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
    const dom = harness();
    const { runtime } = runtimeCapturing({ modelPick: modelPickForTargets([targetFor(canvas)], canvas) });
    const target = { ...targetFor(canvas), nonCanonical: true };
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      getModelFocusTargets: () => [target],
      getModelFocus: () => controller.focusProjection(),
      target: dom.target as never
    });
    const point = modelCenter(target);
    domFire(dom, "dblclick", { clientX: point.x, clientY: point.y });
    expect(controller.isModelFocused()).toBe(true);
    submitted.length = 0;
    domFire(dom, "pointerdown", { button: 0, clientX: point.x, clientY: point.y });
    domFire(dom, "pointermove", { clientX: point.x + 120, clientY: point.y });
    domFire(dom, "pointerup", { clientX: point.x + 120, clientY: point.y });
    controller.flush();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });

  it("聚焦拖动模型本体始终不写命令（内容替换与否均不影响）", () => {
    let ops = [unitBox()];
    const canvas = modelCanvas();
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
    const dom = harness();
    const { runtime } = runtimeCapturing({ modelPick: modelPickForTargets([targetFor(canvas)], canvas) });
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      getModelFocusTargets: () => [{ ...targetFor(canvas), ops: ops as never }],
      getModelFocus: () => controller.focusProjection()
    });
    const point = modelCenter(targetFor(canvas));
    domFire(dom, "dblclick", { clientX: point.x, clientY: point.y });
    submitted.length = 0;
    domFire(dom, "pointerdown", { button: 0, clientX: point.x, clientY: point.y });
    domFire(dom, "pointermove", { clientX: point.x + 120, clientY: point.y });
    // 内容替换（换 ops）→ flush 期间不应产生任何 placement 命令。
    ops = [{ ...unitBox(), size: [2, 2, 2] } as SceneV2Op];
    controller.flush();
    domFire(dom, "pointerup", { clientX: point.x + 120, clientY: point.y });
    controller.flush();
    expect(submitted.filter((command) => command.type === "nodeData.patch")).toHaveLength(0);
    expect(parameterPreviewStore.get("m1")).toBeUndefined();
    controller.dispose();
  });

  it("拖动模型本体不产生 preview（命令被拒绝场景不再适用）", () => {
    // 会话拒绝所有命令：控制器不建立 placement 手势，因此也不会留下 preview。
    const canvas = modelCanvas();
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
    const dom = harness();
    const { runtime } = runtimeCapturing({ modelPick: modelPickForTargets([targetFor(canvas)], canvas) });
    const rejecting = {
      isWritable: () => true,
      submitCommands: (commands: CanvasCommand[]) => {
        submitted.push(...commands);
        return { ok: false, reason: "rejected" };
      }
    };
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => rejecting as never,
      target: dom.target as never,
      getModelFocusTargets: () => [targetFor(canvas)],
      getModelFocus: () => controller.focusProjection()
    });
    const point = modelCenter(targetFor(canvas));
    domFire(dom, "dblclick", { clientX: point.x, clientY: point.y });
    domFire(dom, "pointerdown", { button: 0, clientX: point.x, clientY: point.y });
    domFire(dom, "pointermove", { clientX: point.x + 120, clientY: point.y });
    domFire(dom, "pointerup", { clientX: point.x + 120, clientY: point.y });
    controller.flush();
    expect(submitted.filter((command) => command.type === "nodeData.patch")).toHaveLength(0);
    expect(parameterPreviewStore.get("m1")).toBeUndefined();
    // 聚焦会话继续可用。
    expect(controller.isModelFocused()).toBe(true);
    controller.dispose();
  });

});

it.each(["pointercancel", "lostpointercapture", "blur"])("%s cancels the installed object gesture and late release cannot commit", interrupted => {
  const events: string[] = [];
  const h = focusHarness({ getModelEditor: () => ({ version: "woohaa-model-editor-v2", nodeId: "m1", toolMode: "object", itemId: "binding", focus: [0, 0, 0], radius: 2 }) });
  h.controller.setFilmSetObjectGesture({ active: () => true, select: () => false,
    begin: () => { events.push("begin"); return true; }, move: () => { events.push("move"); },
    end: () => { events.push("end"); }, cancel: () => { events.push("cancel"); } });
  const point = modelCenter(h.target);
  domFire(h.dom, "dblclick", { clientX: point.x, clientY: point.y });
  domFire(h.dom, "pointerdown", { button: 0, clientX: 400, clientY: 300 });
  domFire(h.dom, "pointermove", { clientX: 440, clientY: 300 });
  domFire(h.dom, interrupted, { pointerId: 1 });
  domFire(h.dom, "pointerup", { button: 0, clientX: 440, clientY: 300 });
  expect(events).toEqual(["begin", "move", "cancel"]);
  h.controller.dispose();
});
