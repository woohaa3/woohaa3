import { expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { buildCanvasRenderScene } from "./render-scene.js";

it("absolute preview on a nested parent replaces its complete ancestor position", () => {
  const canvas=createEmptyWoohaa3ServerCanvas("nested");
  canvas.document.nodes=[
    {id:"outer",type:"group",position:{x:100,y:200}},
    {id:"inner",type:"group",position:{x:10,y:20},parentId:"outer"},
    {id:"leaf",type:"image",position:{x:5,y:7},parentId:"inner"}
  ];
  const scene=buildCanvasRenderScene({canvas,positionOverrides:new Map([["inner",{x:150,y:250}]])});
  expect(scene.nodes.find(n=>n.id==="leaf")).toMatchObject({x:155,y:257});
  expect(scene.nodes.find(n=>n.id==="outer")).toMatchObject({x:100,y:200});
  expect(canvas.document.nodes[1]!.position).toEqual({x:10,y:20});
});
