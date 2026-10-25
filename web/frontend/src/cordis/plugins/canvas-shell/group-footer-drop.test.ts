import { afterEach, expect, it, vi } from "vitest";
import { applyCanvasCommands, createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { createDragGestureFamily } from "./drag-gesture.js";
import { createCanvasNodeIndex } from "./canvas-node-index.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";

function canvas(): ServerCanvas {
  const c = createEmptyWoohaa3ServerCanvas("footer-drop");
  c.document.nodes = [
    {id: "g", type: "group", position: {x: 0, y: 0}, width: 300, height: 180},
    {id: "m", type: "image", parentId: "g", position: {x: 40, y: 40}, width: 200, height: 100},
    {id: "free", type: "image", position: {x: 600, y: 0}, width: 180, height: 64}
  ];
  return c;
}
function release(source: ServerCanvas, id: string, from: {x:number;y:number}, at: {x:number;y:number}) {
  woohaa3CanvasStore.getState().applyRemoteCanvas(source);
  const family = createDragGestureFamily({state: {}, submit: vi.fn(), buildScene: () => null,
    schedule: vi.fn(), clearHeldKeys: vi.fn()} as unknown as Parameters<typeof createDragGestureFamily>[0]);
  const commands = family.dragDropCommands(new Map([[id, from]]), new Map([[id, at]]));
  const result = applyCanvasCommands(source, commands);
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error("drop failed");
  return result.canvas;
}
afterEach(() => woohaa3CanvasStore.getState().applyWorkingCanvas(null));
it("old group visible footer accepts a drop through the actual release planner", () => {
  const source = canvas();
  expect(createCanvasNodeIndex(source)!.groupBounds[0]).toMatchObject({height: 220});
  // Center y=200 is below the stored bottom 180, but inside the displayed bottom 220.
  const result = release(source, "free", {x:600,y:0}, {x:50,y:168});
  expect(result.document.nodes.find(n => n.id === "free")?.parentId).toBe("g");
  expect(result.document.nodes.find(n => n.id === "m")?.position).toEqual({x:40,y:40});
});
it("a member may leave the group; its preview cannot expand its own drop target", () => {
  const result = release(canvas(), "m", {x:40,y:40}, {x:900,y:600});
  expect(result.document.nodes.find(n => n.id === "m")).toMatchObject({position: {x:900,y:600}});
  expect(result.document.nodes.find(n => n.id === "m")?.parentId).toBeUndefined();
});
it("nested displayed footer dimensions are cached for release targeting", () => {
  const source = canvas();
  source.document.nodes = [
    {id: "outer", type: "group", position: {x:100,y:200}, width:300,height:220},
    {id: "g", type: "group", parentId: "outer", position: {x:40,y:40}, width:280,height:200},
    ...source.document.nodes.filter(n => n.id !== "g")
  ];
  const bounds = createCanvasNodeIndex(source)!.groupBounds;
  expect(bounds.find(g => g.id === "outer")).toMatchObject({x:100,y:200,width:360,height:340});
  expect(bounds.find(g => g.id === "g")).toMatchObject({x:140,y:240,width:280,height:220});
});
it("collapsed and hidden nested groups cannot receive drops into their expanded bounds", () => {
  const source = canvas();
  source.nodeData.g = {groupCollapsed: true};
  source.document.nodes.push({id:"nested",type:"group",parentId:"g",position:{x:10,y:10},width:280,height:200});
  const result = release(source, "free", {x:600,y:0}, {x:50,y:100});
  expect(result.document.nodes.find(n => n.id === "free")?.parentId).toBeUndefined();
  expect(result.nodeData.g.groupCollapsed).toBe(true);
});
