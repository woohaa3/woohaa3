/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {MenuScroll} from "./menu-scroll.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>vi.unstubAllGlobals());
function setup(){
 const frames=new Map<number,FrameRequestCallback>();let sequence=0,resize=()=>{};
 vi.stubGlobal("requestAnimationFrame",(callback:FrameRequestCallback)=>{frames.set(++sequence,callback);return sequence;});
 vi.stubGlobal("cancelAnimationFrame",(id:number)=>frames.delete(id));
 vi.stubGlobal("ResizeObserver",class {constructor(callback:()=>void){resize=callback;}observe(){}disconnect(){}});
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
 act(()=>root.render(<MenuScroll><button>First</button><button>Last</button></MenuScroll>));
 const viewport=host.querySelector<HTMLDivElement>(".ui-menu-scroll__viewport")!;
 let height=100,content=400;Object.defineProperties(viewport,{clientHeight:{get:()=>height},scrollHeight:{get:()=>content}});
 const measure=()=>act(resize),arrow=(name:string)=>host.querySelector(`[data-menu-scroll="${name}"]`)!;
 const hover=(node:Element)=>act(()=>node.dispatchEvent(new MouseEvent("pointerover",{bubbles:true})));
 const frame=(time:number)=>act(()=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback(time));});
 return {host,viewport,measure,arrow,hover,frame,frames,resize:(next:number)=>{height=next;measure();},content:(next:number)=>{content=next;measure();},dispose:()=>{act(()=>root.unmount());host.remove();}};
}
it("不溢出无箭头，溢出按边界显示；箭头区域滚轮驱动相同视口且不冒泡",()=>{
 const probe=setup();try{
 probe.resize(500);expect(probe.arrow("down")).toBeNull();expect(probe.arrow("up")).toBeNull();
 probe.resize(100);expect(probe.arrow("down")).not.toBeNull();expect(probe.arrow("up")).toBeNull();
 const bubble=vi.fn();probe.host.addEventListener("wheel",bubble);
 const wheel=new WheelEvent("wheel",{bubbles:true,cancelable:true,deltaY:5,deltaMode:1});act(()=>probe.arrow("down").dispatchEvent(wheel));
 expect(wheel.defaultPrevented).toBe(true);expect(bubble).not.toHaveBeenCalled();expect(probe.viewport.scrollTop).toBe(80);expect(probe.arrow("up")).not.toBeNull();
 act(()=>probe.arrow("down").dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,deltaY:1000})));expect(probe.viewport.scrollTop).toBe(300);expect(probe.arrow("down")).toBeNull();
 probe.content(100);probe.viewport.scrollTop=0;probe.measure();expect(probe.arrow("up")).toBeNull();expect(probe.arrow("down")).toBeNull();
 }finally{probe.dispose();}
});
it("悬停持续滚动，帧间距封顶；失焦、离开和卸载隔离迟到帧",()=>{
 const probe=setup();try{
 probe.measure();probe.hover(probe.arrow("down"));probe.frame(0);expect(probe.viewport.scrollTop).toBeCloseTo(3.84);
 probe.frame(1000);expect(probe.viewport.scrollTop).toBeCloseTo(11.52);
 const stale=[...probe.frames.values()][0];act(()=>window.dispatchEvent(new Event("blur")));expect(probe.frames.size).toBe(0);act(()=>stale(1100));expect(probe.viewport.scrollTop).toBeCloseTo(11.52);
 probe.hover(probe.arrow("up"));probe.frame(1200);expect(probe.viewport.scrollTop).toBeCloseTo(7.68);
 act(()=>probe.arrow("up").dispatchEvent(new MouseEvent("pointerout",{bubbles:true,relatedTarget:document.body})));expect(probe.frames.size).toBe(0);
 probe.hover(probe.arrow("down"));const late=[...probe.frames.values()][0];probe.dispose();act(()=>late(1300));expect(probe.frames.size).toBe(0);
 }finally{if(probe.host.isConnected)probe.dispose();}
});
