/** @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { autoFrameDistance, MODEL_FOCUS_FOV } from "@woohaa3/contracts";
import { modelPreviewStore } from "../../services/model-preview-store.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import {
  domFire,
  installSharedSession,
} from "./test-support/controller-harness.js";
import {
  focusHarness,
  modelCanvas,
  targetFor,
} from "./test-support/model-focus-harness.js";
import {
  modelBounds,
  renderedModelNodeSize,
  ModelFocusSession,
} from "./model-focus-session.js";
import {
  emptyWorldModelAnchor,
  worldInstancePresentation,
} from "./model-world-presentation.js";
import { worldModelSelectionFromPick } from "../canvas-runtime/model-world-presentation.js";
import {
  clampPreviewDistanceScale,
  restorePreviewObserver,
  syncPreviewObserver,
} from "./model-preview-focus.js";

installSharedSession();
afterEach(() => {
  modelPreviewStore.clear();
  nodeSelectionStore.reset();
});
const cardView = {
  azimuth: 1.1,
  elevation: 0.4,
  distanceScale: 1.3,
  targetOffset: [0.2, 0.3, -0.1] as [number, number, number],
};
function modelTarget() {
  const canvas = modelCanvas();
  canvas.document.nodes[0].type = "model3d";
  return targetFor(canvas);
}
function expectedDistance(target: ReturnType<typeof modelTarget>) {
  const size = renderedModelNodeSize(target.canvas.document.nodes[0]);
  return autoFrameDistance(
    modelBounds(target)!.radius,
    MODEL_FOCUS_FOV,
    (size.width - 32) / (size.height - 68),
  );
}

it("frames a world instance independently of card layout and rejects unknown versions", () => {
  const target = modelTarget();
  const data = target.canvas.nodeData.m1;
  data.sharedWorldInstance = {
    kind: "world-instance", version: "shared-world-v1", instanceId: "instance-1",
    transform: { version: "shared-world-v1", position: { u: 2, v: 3, h: 4 }, rotation: [0, 0, 0, 1], scale: 2 }
  };
  const before = modelBounds(target)!;
  expect(before.anchor).toEqual([128, 256, -192]);
  target.canvas.document.nodes[0].position = { x: 1000, y: -900 };
  expect(modelBounds(target)).toEqual(before);
  data.sharedWorldInstance = { ...data.sharedWorldInstance, version: "shared-world-v2" };
  expect(modelBounds(target)).toBeNull();
});
it("keeps the original card-preview path for legacy unconverted models", () => {
  const target = modelTarget();
  // No sharedWorldInstance: the legacy model still resolves bounds and its normal
  // card preview; the world projection must not take it over.
  expect(target.canvas.nodeData.m1.sharedWorldInstance).toBeUndefined();
  expect(modelBounds(target)).not.toBeNull();
  expect(worldInstancePresentation(target.canvas, "m1")).toBeNull();
  const view = { ...cardView };
  modelPreviewStore.set("m1", view);
  expect(modelPreviewStore.get("m1")).toEqual(view);
});

it("selects a world model from the renderer pick without reading card geometry", () => {
  const target = modelTarget();
  target.canvas.document.nodes[0].position = { x: 1200, y: -800 };
  target.canvas.nodeData.m1.sharedWorldInstance = {
    kind: "world-instance", version: "shared-world-v1", instanceId: "instance-1",
    transform: { version: "shared-world-v1", position: { u: 2, v: 3, h: 4 }, rotation: [0, 0, 0, 1], scale: 2 }
  };
  const presentation = worldInstancePresentation(target.canvas, "m1");
  expect(presentation?.anchor).toEqual([128, 256, -192]);
  expect(presentation?.aabb).toBeNull();
  expect(emptyWorldModelAnchor(target.canvas, "m1")).toEqual([128, 256, -192]);
  expect(worldModelSelectionFromPick({
    canvas: target.canvas,
    pick: { ok: true, value: { nodeId: "m1" } },
    selected: ["other"]
  })).toEqual(["m1"]);
  expect(worldModelSelectionFromPick({
    canvas: target.canvas,
    pick: { ok: true, value: { nodeId: "m1" } },
    selected: ["other", "m1"],
    additive: true
  })).toEqual(["other"]);
  expect(worldModelSelectionFromPick({
    canvas: target.canvas,
    pick: { ok: true, value: { nodeId: "not-world" } },
    selected: []
  })).toBeNull();
});

function assertView(
  camera: NonNullable<ReturnType<ModelFocusSession["cameraSnapshot"]>>,
  target: ReturnType<typeof modelTarget>,
) {
  const view = modelPreviewStore.get("m1"),
    bounds = modelBounds(target)!;
  expect(view.azimuth).toBeCloseTo(camera.yaw);
  expect(view.elevation).toBeCloseTo(-camera.pitch);
  expect(view.distanceScale * expectedDistance(target)).toBeCloseTo(
    camera.distance,
  );
  camera.target.forEach((value, index) =>
    expect(bounds.center[index] + view.targetOffset![index]).toBeCloseTo(value),
  );
}

it("卡片旋转、距离和观察位置恢复到聚焦观察相机，侧栏补偿不写入视角", () => {
  const target = modelTarget(),
    bounds = modelBounds(target)!;
  modelPreviewStore.set("m1", cardView);
  const focus = new ModelFocusSession();
  focus.enter({
    nodeId: "m1",
    target: bounds.center,
    radius: bounds.radius,
    distance: 10,
    saved: {},
  });
  restorePreviewObserver(focus, [target]);
  const camera = focus.cameraSnapshot()!;
  expect(camera.yaw).toBeCloseTo(cardView.azimuth);
  expect(camera.pitch).toBeCloseTo(-cardView.elevation);
  expect(camera.distance).toBeCloseTo(
    expectedDistance(target) * cardView.distanceScale,
  );
  camera.target.forEach((value, index) =>
    expect(value).toBeCloseTo(
      bounds.center[index] + cardView.targetOffset[index],
    ),
  );
  focus.setContentRect({ right: 600, surfaceHeight: 800 });
  expect(focus.projection()!.target).not.toEqual(camera.target);
  syncPreviewObserver(focus, [target]);
  assertView(camera, target);
});

it("聚焦旋转、滚轮和中键平移同步卡片；退出再进入恢复同一观察镜头", () => {
  const target = modelTarget();
  modelPreviewStore.set("m1", cardView);
  const h = focusHarness({ canvas: target.canvas });
  try {
    expect(h.controller.enterModelFocusForNode("m1")).toBe(true);
    const before = h.controller.focusProjection()!;
    domFire(h.dom, "pointerdown", { button: 2, clientX: 400, clientY: 300 });
    domFire(h.dom, "pointermove", { clientX: 470, clientY: 330 });
    domFire(h.dom, "pointerup", { button: 2, clientX: 470, clientY: 330 });
    domFire(h.dom, "wheel", {
      deltaX: 0,
      deltaY: -120,
      deltaMode: 0,
      clientX: 400,
      clientY: 300,
    });
    domFire(h.dom, "pointerdown", { button: 1, clientX: 400, clientY: 300 });
    domFire(h.dom, "pointermove", { clientX: 440, clientY: 320 });
    domFire(h.dom, "pointerup", { button: 1, clientX: 440, clientY: 320 });
    const after = h.controller.focusProjection()!;
    expect(after.yaw).not.toBe(before.yaw);
    expect(after.distance).toBeLessThan(before.distance);
    expect(after.target).not.toEqual(before.target);
    assertView({ ...after, flySpeed: 6 }, target);
    domFire(h.dom, "keydown", { key: "Escape" });
    expect(h.controller.isModelFocused()).toBe(false);
    h.controller.enterModelFocusForNode("m1");
    const restored = h.controller.focusProjection()!;
    expect(restored.yaw).toBeCloseTo(after.yaw);
    expect(restored.pitch).toBeCloseTo(after.pitch);
    expect(restored.distance).toBeCloseTo(after.distance);
    restored.target.forEach((value, index) =>
      expect(value).toBeCloseTo(after.target[index]),
    );
  } finally {
    h.controller.dispose();
  }
});

it("历史只读观察不覆盖普通模型的卡片视角", () => {
  const target = modelTarget();
  let mode: "edit" | "history" = "edit";
  const h = focusHarness({
    canvas: target.canvas,
    getModelFocusMode: () => mode,
  });
  try {
    h.controller.enterModelFocusForNode("m1");
    const directView = { ...modelPreviewStore.get("m1") };
    mode = "history";
    domFire(h.dom, "pointerdown", { button: 2, clientX: 400, clientY: 300 });
    domFire(h.dom, "pointermove", { clientX: 470, clientY: 330 });
    domFire(h.dom, "pointerup", { button: 2, clientX: 470, clientY: 330 });
    expect(h.controller.focusProjection()!.yaw).not.toBe(directView.azimuth);
    expect(modelPreviewStore.get("m1")).toEqual(directView);
    const focus = new ModelFocusSession(),
      bounds = modelBounds(target)!;
    focus.enter({
      nodeId: "m1",
      target: bounds.center,
      radius: bounds.radius,
      distance: 10,
      saved: {},
    });
    restorePreviewObserver(focus, [{ ...target, nonCanonical: true }]);
    syncPreviewObserver(focus, [{ ...target, nonCanonical: true }]);
    expect(modelPreviewStore.get("m1")).toEqual(directView);
  } finally {
    h.controller.dispose();
  }
});

it.each([1e-12, 1e12])(
  "卡片极限缩放进入聚焦时距离不跳变（scale=%s）",
  (scale) => {
    const target = modelTarget(),
      bounds = modelBounds(target)!;
    const distanceScale = clampPreviewDistanceScale("m1", scale, [target]);
    modelPreviewStore.set("m1", { ...cardView, distanceScale });
    const focus = new ModelFocusSession();
    focus.enter({
      nodeId: "m1",
      target: bounds.center,
      radius: bounds.radius,
      distance: 10,
      saved: {},
    });
    restorePreviewObserver(focus, [target]);
    expect(focus.cameraSnapshot()!.distance).toBeCloseTo(
      distanceScale * expectedDistance(target),
    );
  },
);
