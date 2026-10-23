/** @vitest-environment jsdom */
// 验证挂载出口只按域状态选择叠加层，不自己造状态。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CompositionOverlay, MountedCompositionOverlay, COMPOSITION_OVERLAY_SLOTS } from "./overlays.js";
import { publishCompositionOverlay, releaseCompositionOverlay, resetCompositionOverlay, subscribeCompositionOverlay } from "./overlay-store.js";
import { identityWarpMesh } from "./warp-mesh.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); });

function render(state: Parameters<typeof CompositionOverlay>[0]["state"]) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<CompositionOverlay state={state} origin={{ x: 0, y: 0 }} zoom={1} />));
  return container;
}

it("槽位名与状态一对一并互斥", () => {
  expect(COMPOSITION_OVERLAY_SLOTS).toEqual(["composition.crop", "composition.rotate", "composition.warp"]);
  expect(render({ active: null }).children).toHaveLength(0);
});

it("裁剪状态渲染裁剪框，旋转状态渲染旋转预览，变形状态渲染网格，互不叠加", () => {
  const crop = render({ active: "crop", frame: { x: 0, y: 0, width: 20, height: 20 }, document: { width: 40, height: 30 } });
  expect(crop.querySelector("[data-crop-overlay]")).not.toBeNull();
  expect(crop.querySelector("[data-warp-overlay]")).toBeNull();

  const warp = render({
    active: "warp",
    rect: [0, 0, 40, 30],
    mesh: identityWarpMesh([0, 0, 40, 30])
  });
  expect(warp.querySelector("[data-warp-overlay]")).not.toBeNull();
  expect(warp.querySelector("[data-crop-overlay]")).toBeNull();

  const rotate = render({ active: "rotate", document: { width: 40, height: 30 }, angle: 30 });
  expect(rotate.querySelector("[data-rotation-overlay]")).not.toBeNull();
  expect(rotate.querySelector("[data-crop-overlay]")).toBeNull();
  expect(rotate.querySelector("[data-warp-overlay]")).toBeNull();
});

it("只读透传给当前叠加层", () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onFrameChange = vi.fn();
  act(() => root.render(
    <CompositionOverlay
      readonly
      origin={{ x: 0, y: 0 }}
      zoom={2}
      state={{ active: "crop", document: { width: 40, height: 30 }, frame: { x: 0, y: 0, width: 20, height: 20 }, onFrameChange }}
    />
  ));
  const overlay = container.querySelector<HTMLElement>("[data-crop-overlay]")!;
  expect(overlay.style.pointerEvents).toBe("none");
  onFrameChange.mockClear();
  expect(onFrameChange).not.toHaveBeenCalled();
});

it("挂载组件只订阅域状态：无状态时不渲染，发布后按状态渲染，撤回后清空", () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<MountedCompositionOverlay origin={{ x: 0, y: 0 }} zoom={1} />));
  expect(container.innerHTML).toBe("");

  act(() => publishCompositionOverlay({
    active: "rotate",
    document: { width: 40, height: 30 },
    angle: 15
  }));
  expect(container.querySelector("[data-rotation-overlay]")).not.toBeNull();

  // 换成裁剪：同一挂载点切换分支，不会残留上一个叠加层。
  act(() => publishCompositionOverlay({
    active: "crop",
    frame: { x: 0, y: 0, width: 20, height: 20 },
    document: { width: 40, height: 30 }
  }));
  expect(container.querySelector("[data-crop-overlay]")).not.toBeNull();
  expect(container.querySelector("[data-rotation-overlay]")).toBeNull();

  act(() => resetCompositionOverlay());
  expect(container.innerHTML).toBe("");
});

it("两个面板各自的槽位互不覆盖：高优先级在场时画它，撤回后回落到另一个", () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<MountedCompositionOverlay origin={{ x: 0, y: 0 }} zoom={1} />));

  // 裁剪面板与工作流面板同属一节、会同时挂载：各自发布自己那一份。
  act(() => publishCompositionOverlay({
    active: "rotate",
    document: { width: 40, height: 30 },
    angle: 15
  }, "composition.rotate"));
  act(() => publishCompositionOverlay({
    active: "warp",
    rect: [0, 0, 40, 30],
    mesh: identityWarpMesh([0, 0, 40, 30])
  }, "composition.warp"));
  // 显式进入的编辑会话压过副产物（角度预览），且后发布的两个不会互相清掉。
  expect(container.querySelector("[data-warp-overlay]")).not.toBeNull();
  expect(container.querySelector("[data-rotation-overlay]")).toBeNull();

  act(() => releaseCompositionOverlay("composition.warp"));
  expect(container.querySelector("[data-warp-overlay]")).toBeNull();
  expect(container.querySelector("[data-rotation-overlay]")).not.toBeNull();

  act(() => releaseCompositionOverlay("composition.rotate"));
  expect(container.innerHTML).toBe("");
});

it("同一槽位重复发布同一份状态不重复通知监听者", () => {
  resetCompositionOverlay();
  const seen: number[] = [];
  const unsubscribe = subscribeCompositionOverlay(() => { seen.push(1); });
  const state: Parameters<typeof publishCompositionOverlay>[0] = {
    active: "crop",
    frame: { x: 0, y: 0, width: 10, height: 10 },
    document: { width: 40, height: 30 }
  };
  publishCompositionOverlay(state, "composition.crop");
  publishCompositionOverlay(state, "composition.crop");
  unsubscribe();
  resetCompositionOverlay();
  expect(seen).toHaveLength(1);
});
