import { expect, it } from "vitest";
import { CANVAS_RENDER_SCENE_VERSION, defaultAppTheme, type CanvasRenderScene } from "@woohaa3/contracts";
import { PositionSceneMirror } from "./position-scene-mirror.js";

it("mirrors accepted node positions without speculative writes", () => {
  const node = { id:"n1", type:"model" as const, x:10,y:20,width:100,height:100,
    title:"",typeLabel:"",body:"",progress:0,busy:false,texture:false,resizable:false };
  const original: CanvasRenderScene = { version:CANVAS_RENDER_SCENE_VERSION,canvasId:"canvas-mirror",revision:1,
    nodes:[node],edges:[],selection:{nodes:[],edge:null},viewport:{x:0,y:0,zoom:1},
    draft:null,surface:null,theme:defaultAppTheme() };
  const mirror = new PositionSceneMirror();
  let scene = mirror.reset(original);
  for (let i=0;i<200;i++) {
    scene = mirror.apply(scene,{baseSceneGeneration:1,positions:[{id:"n1",x:10+i*0.13,y:20-i*0.17}]});
    expect(scene.nodes[0]!.x).toBe(10+i*0.13);
    expect(scene.nodes[0]!.y).toBe(20-i*0.17);
  }
  scene = mirror.apply(scene,{baseSceneGeneration:1,positions:[{id:"n1",x:10,y:20}]});
  expect(scene.nodes[0]!.x).toBe(10);
  expect(scene.nodes[0]!.y).toBe(20);
  expect(original.nodes[0]).toBe(node);
  // 未接受的节点不写入镜像。
  const unknown = mirror.apply(scene,{baseSceneGeneration:2,positions:[{id:"missing",x:1,y:2}]});
  expect(unknown.nodes).toHaveLength(1);
});
