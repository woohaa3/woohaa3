/** @vitest-environment jsdom */
// 只验证真实 DOM 事件路由与取景状态，运行时使用替身，不创建渲染上下文。
import { afterEach, expect, it, vi } from "vitest";
import { installInteractionController, type InteractionController } from "./interaction-controller.js";
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing } from "./test-support/controller-harness.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { ImageFocusStore } from "../canvas-runtime/image-focus-store.js";

installSharedSession();
let controller: InteractionController | undefined;
afterEach(() => { controller?.dispose(); controller = undefined; document.body.innerHTML = ""; });

function setup() {
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 20, y: 20 }]));
  const dom = harness();
  dom.target.document = document;
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => ({ left: 80, top: 40, width: 1000, height: 800 }) as DOMRect;
  document.body.append(canvas);
  const stage = document.createElement("div");
  stage.dataset.canvasViewport = "true";
  document.body.append(stage);
  const sidebar = document.createElement("div");
  document.body.append(sidebar);
  let focused = true;
  let blocked = false;
  let viewport = { x: 0, y: 0, zoom: 0.5 };
  const rect = { x: 52, y: 96, width: 864, height: 514 };
  const writes = vi.fn((next: typeof viewport) => { viewport = next; });
  const target = { read: () => ({ viewport, rect }), write: writes };
  const store = new ImageFocusStore();
  const unregister = store.registerViewportTarget(target);
  const captured = runtimeCapturing();
  controller = installInteractionController({
    canvas, target: dom.target as never, getRuntime: () => captured.runtime,
    getSession: () => getSession() as never,
    isImageFocused: () => focused,
    getImageViewportTarget: store.getViewportTarget,
    isFocusInputBlocked: () => blocked
  });
  const originalViewport = controller.viewport();
  return { canvas, stage, sidebar, store, unregister, writes, originalViewport,
    getViewport: () => viewport, setFocused: (value: boolean) => { focused = value; },
    setBlocked: (value: boolean) => { blocked = value; } };
}
function wheel(element: Element, init: WheelEventInit = {}, timeStamp = 1) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 650, clientY: 420, ...init });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  element.dispatchEvent(event);
  return event;
}

it("覆盖层与 canvas 本体都由画布原入口处理，双指平移只更新聚焦取景", () => {
  const s = setup();
  expect(wheel(s.stage, { deltaX: 12, deltaY: 8 }).defaultPrevented).toBe(true);
  expect(s.getViewport()).toEqual({ x: -12, y: -8, zoom: 0.5 });
  wheel(s.canvas, { deltaY: 60 }, 20);
  expect(s.getViewport()).toEqual({ x: -12, y: -68, zoom: 0.5 });
  expect(s.writes).toHaveBeenCalledTimes(2);
  expect(controller!.viewport()).toEqual(s.originalViewport);
});
it("原入口连续捏合保留指针下的文档坐标，同时取消浏览器页面缩放", () => {
  const s = setup();
  const event = wheel(s.stage, { ctrlKey: true, deltaY: -10 });
  const next = s.getViewport();
  expect(next.zoom).toBeCloseTo(0.5 * Math.exp(0.14));
  // 指针减去 canvas 客户位置与公共内容区中心，即 (86, 27)。
  expect((86 - next.x) / next.zoom).toBeCloseTo(86 / 0.5);
  expect((27 - next.y) / next.zoom).toBeCloseTo(27 / 0.5);
  expect(event.defaultPrevented).toBe(true);
  wheel(s.stage, { ctrlKey: true, deltaY: 10 }, 20);
  expect(s.getViewport().zoom).toBeCloseTo(0.5);
  expect(s.getViewport().x).toBeCloseTo(0);
  expect(controller!.viewport()).toEqual(s.originalViewport);
});
it("鼠标滚轮、连续事件与空事件仍使用原画布规则", () => {
  const s = setup();
  wheel(s.stage, { deltaMode: 1, deltaY: -3 });
  expect(s.getViewport().zoom).toBeCloseTo(0.55);
  const count = s.writes.mock.calls.length;
  wheel(s.stage);
  expect(s.writes).toHaveBeenCalledTimes(count);
  wheel(s.stage, { deltaX: 10, deltaY: 5 }, 300);
  wheel(s.stage, { deltaX: 10, deltaY: 5 }, 301);
  expect(s.getViewport().x).toBeCloseTo(-28.6);
  expect(s.getViewport().y).toBeCloseTo(-12.7);
});
it("侧栏与缩放控件保留原生事件；工具拖动、modal 与缺失目标不改变取景", () => {
  const s = setup();
  const control = document.createElement("div");
  control.dataset.canvasViewportControl = "true";
  s.stage.append(control);
  expect(wheel(s.sidebar, { deltaY: 4 }).defaultPrevented).toBe(false);
  expect(wheel(control, { deltaY: 4 }).defaultPrevented).toBe(false);
  s.stage.dataset.canvasViewportBlocked = "true";
  expect(wheel(s.stage, { ctrlKey: true, deltaY: -10 }).defaultPrevented).toBe(true);
  delete s.stage.dataset.canvasViewportBlocked;
  s.setBlocked(true);
  wheel(s.stage, { deltaX: 10 });
  s.setBlocked(false);
  s.unregister();
  wheel(s.stage, { deltaX: 10 });
  wheel(s.canvas, { deltaX: 10 });
  expect(s.writes).not.toHaveBeenCalled();
  expect(controller!.viewport()).toEqual(s.originalViewport);
});
it("退出聚焦后原画布继续操作概览，controller 释放后无残留监听", () => {
  const s = setup();
  s.setFocused(false);
  wheel(s.canvas, { deltaX: 10, deltaY: 5 });
  expect(controller!.viewport().x).toBe(s.originalViewport.x - 10);
  expect(s.writes).not.toHaveBeenCalled();
  controller!.dispose();
  controller = undefined;
  s.setFocused(true);
  expect(wheel(s.stage, { ctrlKey: true, deltaY: -10 }).defaultPrevented).toBe(false);
  expect(s.writes).not.toHaveBeenCalled();
});
it("更换取景目标后，旧 owner 的释放不清除新 owner", () => {
  const s = setup();
  const replacement = { read: () => ({ viewport: { x: 0, y: 0, zoom: 1 }, rect: { x: 0, y: 0, width: 1000, height: 800 } }), write: vi.fn() };
  const release = s.store.registerViewportTarget(replacement);
  s.unregister();
  expect(s.store.getViewportTarget()).toBe(replacement);
  wheel(s.stage, { deltaX: 10 });
  expect(replacement.write).toHaveBeenCalledWith({ x: -10, y: 0, zoom: 1 });
  release();
  expect(s.store.getViewportTarget()).toBeNull();
});

it("本地拥有滚轮的图片编辑器不经过捕获阶段相机路由，旧入口仍保持宿主导航",()=>{
 const s=setup();s.stage.dataset.canvasWheelOwner="local";
 expect(wheel(s.stage,{ctrlKey:true,deltaY:-10}).defaultPrevented).toBe(false);expect(s.writes).not.toHaveBeenCalled();
 delete s.stage.dataset.canvasWheelOwner;wheel(s.stage,{deltaX:8,deltaY:0});expect(s.writes).toHaveBeenCalled();
});
