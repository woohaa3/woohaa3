/**
 * 统一节点定位服务测试（change: 2026-10-09-improve-canvas-workflow，任务 4.1）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { createCanvasLocateService } from "./canvas-locate.js";

const NOW = "2026-10-09T00:00:00.000Z";

function canvas(): ServerCanvas {
  const value = createEmptyWoohaa3ServerCanvas("c1", NOW);
  value.document.nodes = [
    { id: "a", type: "text", position: { x: 0, y: 0 }, width: 260, height: 195 },
    { id: "b", type: "image", position: { x: 800, y: 400 }, width: 260, height: 195 }
  ];
  return value;
}

function controller() {
  const selected: string[] = [];
  const viewports: Array<{ x: number; y: number; zoom: number }> = [];
  return {
    selected,
    viewports,
    selectNode: (id: string) => { selected.push(id); return true; },
    restoreViewport: (viewport: { x: number; y: number; zoom: number }) => { viewports.push(viewport); },
    viewport: () => ({ x: 0, y: 0, zoom: 1 }),
    surface: () => ({ width: 1000, height: 800, pixelRatio: 1 })
  };
}

describe("createCanvasLocateService", () => {
  it("定位收起组或隐藏后代时，使用可见紧凑组的中心", () => {
    const source = canvas();
    source.document.nodes = [
      {id:"g",type:"group",position:{x:100,y:100},width:600,height:400},
      {id:"nested",type:"group",parentId:"g",position:{x:40,y:40},width:300,height:200},
      {id:"member",type:"text",parentId:"nested",position:{x:40,y:40},width:100,height:80}
    ];
    source.nodeData.g = {groupCollapsed:true};
    const ctrl = controller();
    const service = createCanvasLocateService({getCanvas:()=>source,getController:()=>ctrl as never});
    expect(service.locateNodes(["member"]).ok).toBe(true);
    expect(ctrl.selected).toEqual(["g"]);
    // 紧凑组 196×112 固定底边中点：视口按 112 高矩形的中心定位。
    expect(ctrl.viewports[0]).toEqual({x:100,y:-44,zoom:1});
    expect(service.locateNodes(["g"]).ok).toBe(true);
    expect(ctrl.viewports[1]).toEqual(ctrl.viewports[0]);
  });
  it("定位存在节点：选择并用当前缩放居中（走 panViewportTo）", () => {
    const ctrl = controller();
    const panned: Array<{ x: number; y: number; zoom: number }> = [];
    const service = createCanvasLocateService({
      getCanvas: canvas,
      getController: () => ctrl as never,
      panViewportTo: (viewport) => panned.push(viewport)
    });
    expect(service.locateNodes(["b"])).toEqual({ ok: true });
    expect(ctrl.selected).toEqual(["b"]);
    expect(panned).toHaveLength(1);
    // 保持当前缩放（controller.viewport().zoom = 1）。
    expect(panned[0]!.zoom).toBe(1);
  });

  it("select:false 只改视口不改选区（定位当前多选）", () => {
    const ctrl = controller();
    const service = createCanvasLocateService({ getCanvas: canvas, getController: () => ctrl as never });
    expect(service.locateSelection(["a", "b"])).toEqual({ ok: true });
    expect(ctrl.selected).toEqual([]);
    expect(ctrl.viewports).toHaveLength(1);
  });

  it("目标不存在返回失败且不移动视口", () => {
    const ctrl = controller();
    const service = createCanvasLocateService({ getCanvas: canvas, getController: () => ctrl as never });
    const result = service.locateNodes(["missing"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("不存在");
    expect(ctrl.viewports).toHaveLength(0);
    expect(ctrl.selected).toHaveLength(0);
  });

  it("画布/控制器未就绪返回失败", () => {
    const service = createCanvasLocateService({ getCanvas: () => null, getController: () => null });
    const result = service.locateNodes(["a"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("尚未就绪");
  });

  it("空选区返回失败", () => {
    const ctrl = controller();
    const service = createCanvasLocateService({ getCanvas: canvas, getController: () => ctrl as never });
    expect(service.locateNodes([]).ok).toBe(false);
  });
});

it('fits actual accepted render bounds inside an explicit safe rectangle', () => {
  const ctrl = controller();
  const service = createCanvasLocateService({
    getCanvas: canvas, getController: () => ctrl as never,
    renderBounds: () => [{id:'a',x:0,y:0,width:2000,height:1000}],
  });
  expect(service.locateNodes(['a'], {select:false,fit:true,safeArea:{left:50,top:100,right:50,bottom:100}})).toEqual({ok:true});
  const view = ctrl.viewports[0]!;
  expect(view.zoom).toBeCloseTo(.45);
  expect(view.x).toBeCloseTo(50);
  expect(view.y).toBeCloseTo(175);
});
