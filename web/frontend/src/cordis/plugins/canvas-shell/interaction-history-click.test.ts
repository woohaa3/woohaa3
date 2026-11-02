import { afterEach, expect, it, vi } from "vitest";
import { installInteractionController } from "./interaction-controller.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { canvasWith, harness, installSharedSession, getSession, setSession, runtimeCapturing, submitted } from "./test-support/controller-harness.js";
import { bevyNodeHistoryStripDot, type CanvasRenderScene, type NodeGenerationHistoryListItem } from "@woohaa3/contracts";
import { sceneDiagnostics } from "../canvas-runtime/scene-diagnostics.js";
installSharedSession();
let dispose: (()=>void)|undefined;
afterEach(()=>{dispose?.();nodeSelectionStore.reset();});
function setup(node?: {type:string;width:number;height:number}) {
  const saved = canvasWith([{id:"n",x:100,y:100}]);
  if (node) Object.assign(saved.document.nodes[0]!, node);
  woohaa3CanvasStore.getState().applyRemoteCanvas(saved);
  const dom=harness(), changed=vi.fn();
  let scene: CanvasRenderScene | null = null;
  const {runtime}=runtimeCapturing({pointHit:()=>({kind:"history",nodeId:"n"})});
  let versionId = 0;
  const version=(current:boolean)=>({current, entryId: String(versionId++), createdAt: String(versionId), recoverable: true, source: {label:"test"}, preview: {kind:"text",excerpt:"test"}}) as NodeGenerationHistoryListItem;
  const versionsByNode = new Map([
    ["removed",[version(true),version(false)]], ["n",[version(true),version(false),version(false)]]
  ]);
  const controller=installInteractionController({canvas:dom.canvas,target:dom.target as never,getRuntime:()=>runtime,
    getSession:()=>getSession() as never,onNodeHistorySelect:changed,onScene:next=>{scene=next;},
    getRunState:()=>({summaries:[],records:[],versionsByNode})});
  dispose=()=>controller.dispose();controller.flush();
  const point=(x:number)=>controller.worldToClient(
    bevyNodeHistoryStripDot(scene!.nodes.find(candidate=>candidate.id==="n")!, (x-212)/12, 3));
  return {dom,controller,changed,point,runtime,versionsByNode,scene:()=>scene!};
}
it("圆点按下不切换，释放后请求直接切换已完成版本",()=>{
  const {dom,point,changed}=setup();const at=point(224);
  dom.fire("pointerdown",{clientX:at.x,clientY:at.y});
  expect(changed).not.toHaveBeenCalled();
  dom.fire("pointerup",{clientX:at.x+1,clientY:at.y});
  expect(changed.mock.calls[0]?.[0]).toMatchObject({nodeId:"n", entryId:"3", presentationId:"entry:3"});
  expect(submitted).toHaveLength(0);
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual([]);
});
it("当前版本圆点只做只读查看，不重复应用",()=>{
  const {dom,point,changed}=setup();const at=point(212);
  dom.fire("pointerdown",{clientX:at.x,clientY:at.y});
  dom.fire("pointerup",{clientX:at.x,clientY:at.y});
  expect(changed.mock.calls[0]?.[0]).toMatchObject({nodeId:"n", entryId:"2"});
  expect(submitted).toHaveLength(0);
});
it("locks identity across window changes and cancels when the pressed target disappears",()=>{
  const {dom,point,changed,versionsByNode,controller}=setup();const at=point(212);
  dom.fire("pointerdown",{clientX:at.x,clientY:at.y});
  const versions=versionsByNode.get("n")!;
  versionsByNode.set("n",[{...versions[0]!,entryId:"new",current:false,createdAt:"0"},...versions]);
  controller.invalidate("history-update");controller.flush();
  dom.fire("pointerup",{clientX:at.x,clientY:at.y});
  expect(changed.mock.calls[0]?.[0].entryId).toBe("2");
  versionsByNode.set("n",versions);controller.invalidate("history-update");controller.flush();
  dom.fire("pointerdown",{clientX:at.x,clientY:at.y});
  versionsByNode.set("n",versions.filter(version=>version.entryId!=="2"));
  controller.invalidate("history-update");controller.flush();
  dom.fire("pointerup",{clientX:at.x,clientY:at.y});
  expect(changed).toHaveBeenCalledTimes(1);
});
it("readonly failed dots inspect details without requesting a restore",()=>{
  const {dom,point,changed,versionsByNode,controller}=setup();
  const versions=versionsByNode.get("n")!;
  versionsByNode.set("n",versions.map((item,index)=>index===0 ? {...item,outcome:"failed",recoverable:false,preview:{kind:"failure",outcome:"failed",message:"safe failure"}} : item));
  setSession({...getSession(),isWritable:()=>false});
  controller.invalidate("history-update");controller.flush();
  const at=point(212);
  dom.fire("pointerdown",{clientX:at.x,clientY:at.y});
  dom.fire("pointerup",{clientX:at.x,clientY:at.y});
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({entryId:"2"}));
  expect(submitted).toHaveLength(0);
});
it.each([{type:"model3d",width:196,height:64},{type:"image",width:32,height:40}])("launch anchor shares the accepted expanded geometry and follows pan/zoom: %o",node=>{
  const {controller,versionsByNode,scene}=setup(node);
  versionsByNode.set("n",versionsByNode.get("n")!.map((item,index)=>({...item,source:{...item.source,runId:`run-${index}`}})));
  controller.invalidate("history-update");controller.flush();
  for (const viewport of [{x:137,y:-51,zoom:0.67},{x:53,y:13,zoom:1.2}]) {
    controller.restoreViewport(viewport);controller.flush();
    const expected=controller.worldToClient(bevyNodeHistoryStripDot(scene().nodes[0]!,1,3));
    expect(controller.historyDotScreenPoint?.("n","run-1")).toMatchObject(expected);
  }
  expect(controller.historyDotScreenPoint?.("n","missing")).toBeNull();
});
it.each([{dx:24,dy:0},{dx:0,dy:24}])("从圆点开始拖动会平移画布，不切换版本：%o",({dx,dy})=>{
  const {dom,point,changed,controller}=setup();const at=point(212),before=controller.viewport();
  const frames: FrameRequestCallback[] = [];
  dom.target.requestAnimationFrame = (callback: FrameRequestCallback) => frames.push(callback);
  const advance = () => frames.splice(0).forEach(callback => callback(0));
  const builds=sceneDiagnostics.sceneBuilds;
  dom.fire("pointerdown",{clientX:at.x,clientY:at.y});
  dom.fire("pointermove",{clientX:at.x+dx,clientY:at.y+dy});
  advance();
  expect(sceneDiagnostics.sceneBuilds).toBe(builds);
  dom.fire("pointerup",{clientX:at.x+dx,clientY:at.y+dy});
  expect(changed).not.toHaveBeenCalled();
  expect(controller.viewport()).toEqual({...before,x:before.x+dx,y:before.y+dy});
  expect(submitted).toHaveLength(0);
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual([]);
});
it("拖离圆点后返回原处也不切换版本",()=>{
  const {dom,point,changed}=setup();const at=point(212);
  dom.fire("pointerdown",{clientX:at.x,clientY:at.y});
  dom.fire("pointermove",{clientX:at.x+24,clientY:at.y});
  dom.fire("pointermove",{clientX:at.x,clientY:at.y});
  dom.fire("pointerup",{clientX:at.x,clientY:at.y});
  expect(changed).not.toHaveBeenCalled();
});
it("释放位置超过点击容差时不切换，即使没有 move 事件",()=>{
  const {dom,point,changed}=setup();const at=point(212);
  dom.fire("pointerdown",{clientX:at.x,clientY:at.y});
  dom.fire("pointerup",{clientX:at.x+24,clientY:at.y});
  expect(changed).not.toHaveBeenCalled();
});
it.each([{deltaX:50,deltaY:0},{deltaX:0,deltaY:50}])("圆点上的滚轮只导航画布，不切换版本：%o",delta=>{
  const {dom,point,changed,controller}=setup();const at=point(224),before=controller.viewport();
  dom.fire("wheel",{clientX:at.x,clientY:at.y,...delta,deltaMode:0,ctrlKey:false,metaKey:false,timeStamp:100,stopPropagation:vi.fn()});
  expect(changed).not.toHaveBeenCalled();
  expect(controller.viewport()).not.toEqual(before);
});
it.each(["pointercancel","blur","visibilitychange"])("%s 取消待确认点击，后续释放不切版本",type=>{
  const {dom,point,changed}=setup();const at=point(212);
  dom.fire("pointerdown",{clientX:at.x,clientY:at.y});
  dom.fire(type,{});
  dom.fire("pointerup",{clientX:at.x,clientY:at.y});
  expect(changed).not.toHaveBeenCalled();
});
it("按下后变为只读，释放仍可只读预览",()=>{
  const {dom,point,changed}=setup();const at=point(212);
  dom.fire("pointerdown",{clientX:at.x,clientY:at.y});
  setSession({...getSession(),isWritable:()=>false});
  dom.fire("pointerup",{clientX:at.x,clientY:at.y});
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({presentationId:"entry:2"}));
  expect(submitted).toHaveLength(0);
});
it("圆点内外的连续滚动均不查询历史命中",()=>{
  const {dom,controller,runtime,changed,scene}=setup();
  controller.restoreViewport({x:137,y:-51,zoom:0.67}); controller.flush();
  const query=vi.spyOn(runtime,"queryPoint");
  const dot=bevyNodeHistoryStripDot(scene().nodes[0]!,1,3);
  for(const world of [{x:900,y:700},dot]) {
    const at=controller.worldToClient(world);
    for(let i=0;i<20;i++) dom.fire("wheel",{clientX:at.x,clientY:at.y,deltaX:50,deltaY:0,deltaMode:0,
      ctrlKey:false,metaKey:false,timeStamp:100+i,stopPropagation:vi.fn()});
  }
  expect(query).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it.each([
  {type:"model3d",width:196,height:64},
  {type:"model3d",width:300,height:116},
  {type:"image",width:32,height:40},
])("dot centers use rendered geometry for expanded/clamped cards: %o", node => {
  const {dom,controller,changed,scene}=setup(node);
  dom.canvas.getBoundingClientRect=()=>({left:83,top:47,width:1000,height:800}) as DOMRect;
  // Nonzero viewport and DOM origins must not introduce a CSS/world coordinate offset.
  controller.restoreViewport({x:137,y:-51,zoom:0.67});controller.flush();
  const card=scene().nodes.find(candidate=>candidate.id==="n")!;
  expect(card.width).not.toBe(node.width);
  const builds=sceneDiagnostics.sceneBuilds;
  for (let index=0;index<3;index++) {
    const at=controller.worldToClient(bevyNodeHistoryStripDot(card,index,3));
    dom.fire("pointerdown",{clientX:at.x,clientY:at.y});
    dom.fire("pointerup",{clientX:at.x,clientY:at.y});
  }
  expect(changed.mock.calls.map(([request])=>request.entryId)).toEqual(["2","3","4"]);
  // Pointer feedback may submit one scene on press and one on release, never per animation frame.
  expect(sceneDiagnostics.sceneBuilds - builds).toBeLessThanOrEqual(6);
  expect(submitted).toHaveLength(0);
});
