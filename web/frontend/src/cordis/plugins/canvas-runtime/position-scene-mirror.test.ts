import { expect, it } from "vitest";
import { CANVAS_RENDER_SCENE_VERSION, defaultAppTheme, type CanvasRenderScene } from "@woohaa3/contracts";
import { PositionSceneMirror } from "./position-scene-mirror.js";

it("retains composite scope offsets across 200 moves, return and full replacement", () => {
  const node = { id:"film", type:"model" as const, x:10,y:20,width:100,height:100,
    title:"",typeLabel:"",body:"",progress:0,busy:false,texture:false,resizable:false,
    compositeAsset:{x:12.5,y:25.25,width:80,height:80,scopeGround:{cx:60,cy:90,hx:40,hz:40}} };
  const original: CanvasRenderScene = { version:CANVAS_RENDER_SCENE_VERSION,revision:1,
    nodes:[node],edges:[],selection:{nodes:[],edge:null},viewport:{x:0,y:0,zoom:1},
    draft:null,surface:null,theme:defaultAppTheme() };
  const mirror = new PositionSceneMirror();
  let scene = mirror.reset(original);
  for (let i=0;i<200;i++) {
    scene = mirror.apply(scene,{baseSceneGeneration:1,positions:[{id:"film",x:10+i*0.13,y:20-i*0.17}]});
    expect(scene.nodes[0]!.compositeAsset!.x).toBe(scene.nodes[0]!.x+2.5);
    expect(scene.nodes[0]!.compositeAsset!.y).toBe(scene.nodes[0]!.y+5.25);
    expect(scene.nodes[0]!.compositeAsset!.scopeGround!.cx).toBeCloseTo(scene.nodes[0]!.x+50,9);
    expect(scene.nodes[0]!.compositeAsset!.scopeGround!.cy).toBeCloseTo(scene.nodes[0]!.y+70,9);
  }
  scene = mirror.apply(scene,{baseSceneGeneration:1,positions:[{id:"film",x:10,y:20}]});
  expect(scene.nodes[0]!.compositeAsset!.scopeGround!.cx).toBeCloseTo(60,9);
  expect(scene.nodes[0]!.compositeAsset!.scopeGround!.cy).toBeCloseTo(90,9);
  expect(original.nodes[0]).toBe(node);
  scene = mirror.reset({...original,nodes:[{...node,compositeAsset:{...node.compositeAsset,x:30,y:60}}]});
  scene = mirror.apply(scene,{baseSceneGeneration:2,positions:[{id:"film",x:50,y:80}]});
  expect(scene.nodes[0]!.compositeAsset).toMatchObject({x:70,y:120});
});
