import { afterEach, expect, it } from "vitest";
import type { ServerCanvas } from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { resetSceneDiagnostics, sceneDiagnostics } from "../canvas-runtime/scene-diagnostics.js";
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing, submitted } from "./test-support/controller-harness.js";

installSharedSession();
afterEach(() => { nodeSelectionStore.reset(); resetSceneDiagnostics(); });

function setup(canvas: ServerCanvas = canvasWith([{id:"n1",x:20,y:20},{id:"n2",x:600,y:500}])) {
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const dom=harness();
  const callbacks:Array<(t:number)=>void>=[];
  dom.target.requestAnimationFrame=(cb:(t:number)=>void) => {callbacks.push(cb);return callbacks.length;};
  dom.target.cancelAnimationFrame=()=>undefined;
  const advance=()=>{for(const cb of callbacks.splice(0)) cb(0);};
  const captured=runtimeCapturing();
  let active=captured.runtime;
  const controller=installInteractionController({canvas:dom.canvas,getRuntime:()=>active,getSession:()=>getSession() as never,target:dom.target as never});
  controller.flush();
  return {...captured,dom,advance,controller,swapRuntime:(next:typeof active)=>{active=next;}};
}

function start(s:ReturnType<typeof setup>) {
  s.dom.fire("pointerdown",{clientX:50,clientY:70});
  s.dom.fire("pointermove",{clientX:70,clientY:90});
  s.advance(); // selection and initial attach operation bar require one full scene.
  resetSceneDiagnostics();
}

it("200 ordinary drag frames submit only positions without contact/full scene construction", () => {
  const s=setup();start(s);
  const revision=woohaa3CanvasStore.getState().canvas!.revision;
  for(let i=1;i<=200;i++) {s.dom.fire("pointermove",{clientX:70+i,clientY:90+i});s.advance();}
  expect(s.positions).toHaveLength(200);
  expect(sceneDiagnostics.sceneBuilds).toBe(0);
  expect(sceneDiagnostics.sceneSubmits).toBe(0);
  expect(sceneDiagnostics.fingerprintBuilds).toBe(0);
  expect(s.viewports).toHaveLength(0);
  expect(s.positions.at(-1)!.positions).toEqual([{id:"n1",x:240,y:240}]);
  expect(woohaa3CanvasStore.getState().canvas!.revision).toBe(revision);
  s.controller.dispose();
});

it("coalesces many moves into one final position submission and dedupes return/no-change", () => {
  const s=setup();start(s);
  for(let i=1;i<=20;i++) s.dom.fire("pointermove",{clientX:70+i,clientY:90+i});
  expect(s.positions).toHaveLength(0);
  s.advance();
  expect(s.positions).toHaveLength(1);
  expect(s.positions[0]!.positions).toEqual([{id:"n1",x:60,y:60}]);
  s.dom.fire("pointermove",{clientX:90,clientY:110});s.advance();
  expect(s.positions).toHaveLength(1);
  s.dom.fire("pointermove",{clientX:50,clientY:70});s.advance();
  expect(s.positions.at(-1)!.positions).toEqual([{id:"n1",x:20,y:20}]);
  s.controller.dispose();
});

it("rejects an increment and restores a full scene on the next frame even after cancel", () => {
  const s=setup();start(s);
  s.failNextSetPositions("stale-base");
  s.dom.fire("pointermove",{clientX:100,clientY:120});s.advance();
  expect(s.controller.renderError()).toBe("stale-base");
  expect(sceneDiagnostics.sceneSubmits).toBe(0);
  s.dom.fire("pointercancel",{});s.advance();
  expect(sceneDiagnostics.sceneSubmits).toBe(1);
  expect(s.scenes.at(-1)!.nodes).toEqual(expect.arrayContaining([expect.objectContaining({id:"n1",x:20,y:20})]));
  expect(s.controller.renderError()).toBeNull();
  s.controller.dispose();
});

it("mixed structural invalidation uses a single full scene and no position request", () => {
  const s=setup();start(s);
  s.dom.fire("pointermove",{clientX:100,clientY:120});
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{id:"n1",x:20,y:20},{id:"added",x:700,y:500}]));
  s.controller.invalidate("canvas-store");s.advance();
  expect(s.positions).toHaveLength(0);
  expect(sceneDiagnostics.sceneSubmits).toBe(1);
  expect(s.scenes.at(-1)!.nodes).toEqual(expect.arrayContaining([expect.objectContaining({id:"added"})]));
  s.controller.dispose();
});

it("combines viewport and position changes into one final ABI call", () => {
  const s=setup();start(s);
  s.dom.fire("pointermove",{clientX:100,clientY:120});
  s.dom.fire("wheel",{deltaX:0,deltaY:-100,deltaMode:0,ctrlKey:true,clientX:200,clientY:200,timeStamp:1});
  s.advance();
  expect(s.positions).toHaveLength(1);
  expect(s.positions[0]!.viewport?.zoom).toBeGreaterThan(1);
  expect(s.viewports).toHaveLength(0);
  expect(sceneDiagnostics.sceneBuilds).toBe(0);
  s.controller.dispose();
});

it("WASM runtime replacement replays a full scene instead of using an old fingerprint/base", () => {
  const s=setup();start(s);
  const fresh=runtimeCapturing();s.swapRuntime(fresh.runtime);
  s.dom.fire("pointermove",{clientX:70,clientY:90});s.advance();
  expect(fresh.scenes).toHaveLength(1);
  expect(fresh.positions).toHaveLength(0);
  s.controller.dispose();
});

it("remote owner deletion cancels the gesture and never sends unknown position rows", () => {
  const s=setup();start(s);
  const commands=submitted.length;
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{id:"n2",x:600,y:500}]));
  s.controller.invalidate("canvas-store");s.advance();
  expect(s.positions).toHaveLength(0);
  s.dom.fire("pointermove",{clientX:200,clientY:220});s.dom.fire("pointerup",{});s.advance();
  expect(s.positions).toHaveLength(0);
  expect(submitted).toHaveLength(commands);
  expect(s.scenes.at(-1)!.nodes).toEqual([expect.objectContaining({id:"n2"})]);
  s.controller.dispose();
});

it("remote reparent resets the baseline, then positions continue in absolute coordinates", () => {
  const s=setup();start(s);
  const changed=canvasWith([]);
  changed.document.nodes=[
    {id:"g",type:"group",position:{x:300,y:100},width:400,height:400},
    {id:"n1",type:"image",position:{x:20,y:20},parentId:"g"}
  ];
  woohaa3CanvasStore.getState().applyRemoteCanvas(changed);
  s.dom.fire("pointermove",{clientX:100,clientY:120});s.advance();
  expect(s.positions).toHaveLength(0);
  expect(sceneDiagnostics.sceneSubmits).toBe(1);
  s.dom.fire("pointermove",{clientX:110,clientY:130});s.advance();
  expect(s.positions.at(-1)!.positions).toEqual([{id:"n1",x:80,y:80}]);
  s.controller.dispose();
});

it("surface changes force full even when the only pending reason is position preview", () => {
  const s=setup();start(s);
  s.dom.canvas.getBoundingClientRect=()=>({left:0,top:0,width:1280,height:800,right:1280,bottom:800,x:0,y:0,toJSON:()=>({})});
  s.dom.fire("pointermove",{clientX:100,clientY:120});s.advance();
  expect(s.positions).toHaveLength(0);
  expect(sceneDiagnostics.sceneSubmits).toBe(1);
  expect(s.scenes.at(-1)!.surface).toMatchObject({width:1280,height:800});
  s.controller.dispose();
});

it("moving a group expands nested descendants once; blur restores every original position", () => {
  const canvas=canvasWith([]);
  canvas.document.nodes=[
    {id:"g",type:"group",position:{x:20,y:20},width:300,height:240},
    {id:"inner",type:"group",position:{x:30,y:40},parentId:"g",width:180,height:160},
    {id:"leaf",type:"image",position:{x:10,y:20},parentId:"inner",width:100,height:80}
  ];
  const s=setup(canvas);
  s.dom.fire("pointerdown",{clientX:50,clientY:35});
  s.dom.fire("pointermove",{clientX:60,clientY:45});s.advance();resetSceneDiagnostics();
  s.dom.fire("pointermove",{clientX:80,clientY:75});s.advance();
  expect(s.positions.at(-1)!.positions).toEqual([
    {id:"g",x:50,y:60},{id:"inner",x:80,y:100},{id:"leaf",x:90,y:120}
  ]);
  const commands=submitted.length;
  s.dom.fire("blur",{});s.advance();
  expect(s.positions.at(-1)!.positions).toEqual([
    {id:"g",x:20,y:20},{id:"inner",x:50,y:60},{id:"leaf",x:60,y:80}
  ]);
  expect(submitted).toHaveLength(commands);
  expect(sceneDiagnostics.sceneBuilds).toBe(0);
  s.controller.dispose();
});

it("Q/E activation and new contact use full, stable contacts reuse position frames", () => {
  const s=setup();start(s);
  s.dom.fireKey("keydown",{key:"e",code:"KeyE"});s.advance();
  expect(sceneDiagnostics.sceneSubmits).toBe(1);
  resetSceneDiagnostics();
  s.dom.fire("pointermove",{clientX:80,clientY:100});s.advance();
  expect(sceneDiagnostics.sceneBuilds).toBe(0);
  expect(s.positions).toHaveLength(1);
  s.dom.fireKey("keyup",{key:"e",code:"KeyE"});s.advance();
  expect(sceneDiagnostics.sceneSubmits).toBe(1);
  s.controller.dispose();
});
