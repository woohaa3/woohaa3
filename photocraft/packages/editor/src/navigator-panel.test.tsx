/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {NavigatorPanel} from "./navigator-panel.js";
import {navigatorViewport,navigatorVisibleRect,type NavigatorFrame} from "./navigator-geometry.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const frame:NavigatorFrame={viewport:{x:0,y:0,zoom:2},size:{width:400,height:300},document:{width:800,height:600}};
const roots:Root[]=[];
afterEach(()=>{roots.splice(0).forEach(root=>act(()=>root.unmount()));document.body.innerHTML="";vi.unstubAllGlobals();});
function setup(){
  const frames:FrameRequestCallback[]=[];vi.stubGlobal("requestAnimationFrame",(fn:FrameRequestCallback)=>{frames.push(fn);return frames.length;});vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const read=vi.fn(()=>({ok:false as const,code:"unavailable",message:"预览不可用"})),navigate=vi.fn(),zoomTo=vi.fn(),node=document.createElement("div"),root=createRoot(node);roots.push(root);document.body.append(node);
  const render=(blocked=false,contextKey="a",pinch=true)=>act(()=>root.render(<NavigatorPanel contextKey={contextKey} frame={frame} read={read} navigate={navigate} zoomTo={zoomTo} blocked={blocked} pinch={pinch}/>));render();
  const area=node.querySelector<HTMLElement>(".photo-editor__navigator-image")!;
  area.getBoundingClientRect=()=>({left:10,top:20,width:200,height:150,right:210,bottom:170,x:10,y:20,toJSON:()=>({})});area.setPointerCapture=vi.fn();area.hasPointerCapture=()=>false;
  const pointer=(type:string,x:number,y:number,modifiers:Record<string,unknown>={})=>act(()=>{const event=new MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y,...modifiers});Object.defineProperty(event,"pointerId",{value:1});area.dispatchEvent(event);});
  return {frames,read,navigate,zoomTo,node,root,render,area,pointer};
}
it("projects the actual main canvas visible rect and centers/zooms without changing document geometry",()=>{
  expect(navigatorVisibleRect(frame)).toEqual({x:300,y:225,width:200,height:150});
  expect(navigatorViewport(frame,{type:"center",x:200,y:100})).toEqual({x:400,y:400,zoom:2});
  expect(navigatorViewport(frame,{type:"rectangle",x:100,y:100,width:200,height:100})).toEqual({x:400,y:300,zoom:2});
  expect(navigatorViewport(frame,{type:"rectangle",x:0,y:0,width:0,height:3})).toBeNull();expect(navigatorViewport(frame,{type:"center",x:NaN,y:0})).toBeNull();
});
it("point dragging flushes release coordinates; command rectangle is deferred and cancel/context/blocked isolate it",()=>{
  const s=setup();s.pointer("pointerdown",60,70);expect(s.navigate).toHaveBeenLastCalledWith({type:"center",x:200,y:200});s.pointer("pointermove",80,80);s.pointer("pointerup",110,120);expect(s.navigate).toHaveBeenLastCalledWith({type:"center",x:400,y:400});
  s.navigate.mockClear();s.pointer("pointerdown",60,70,{ctrlKey:true});s.pointer("pointermove",100,100);expect(s.navigate).not.toHaveBeenCalled();s.pointer("pointerup",110,120);expect(s.navigate).toHaveBeenLastCalledWith({type:"rectangle",x:200,y:200,width:200,height:200});
  s.navigate.mockClear();s.pointer("pointerdown",60,70,{metaKey:true});s.pointer("pointercancel",110,120);s.pointer("pointerup",110,120);expect(s.navigate).not.toHaveBeenCalled();
  s.pointer("pointerdown",60,70,{ctrlKey:true});s.render(false,"b");s.pointer("pointerup",110,120);expect(s.navigate).not.toHaveBeenCalled();s.render(true);s.pointer("pointerdown",60,70);expect(s.navigate).not.toHaveBeenCalled();
});
it("hover wheel zooms even when canvas preference pans; pinch preference and port generations gate work",()=>{
  const s=setup();const wheel=(deltaY:number,ctrlKey=false)=>{const event=new WheelEvent("wheel",{bubbles:true,cancelable:true,deltaY,ctrlKey});act(()=>s.area.dispatchEvent(event));return event;};
  expect(wheel(-100).defaultPrevented).toBe(true);expect(s.zoomTo.mock.calls[0]![0]).toBeGreaterThan(2);
  s.zoomTo.mockClear();s.render(false,"a",false);wheel(-1.5,true);expect(s.zoomTo).not.toHaveBeenCalled();s.render(false,"a",true);wheel(-1.5,true);expect(s.zoomTo.mock.calls[0]![0]).toBeGreaterThan(2);
  s.render(false,"b");act(()=>s.frames[0]!(0));expect(s.read).not.toHaveBeenCalled();act(()=>s.frames[1]!(0));expect(s.read).toHaveBeenCalledTimes(1);expect(s.node.textContent).toContain("预览不可用");s.render(true,"c");act(()=>s.root.unmount());act(()=>s.frames[2]!(0));expect(s.read).toHaveBeenCalledTimes(1);
});
