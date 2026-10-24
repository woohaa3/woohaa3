/** @vitest-environment jsdom */
import {act,type ReactNode} from "react";
import {createRoot,type Root} from "react-dom/client";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const roots:Root[]=[];
function render(node:ReactNode){const container=document.createElement("div"),root=createRoot(container);roots.push(root);document.body.append(container);act(()=>root.render(node));return {container,rerender:(node:ReactNode)=>act(()=>root.render(node)),unmount:()=>act(()=>root.unmount())};}
import {afterEach,expect,it,vi} from "vitest";
import {PixelGridOverlay} from "./pixel-grid-overlay.js";
import {decodePixelGrid,validatePixelGridRegion,visiblePixelGridRegion,type PixelGridSegment} from "./pixel-grid-data.js";
afterEach(()=>{roots.splice(0).forEach(root=>act(()=>root.unmount()));document.body.innerHTML="";vi.unstubAllGlobals();});
it("limits the actual visible source region and rejects unbounded or malformed ports",()=>{
  expect(visiblePixelGridRegion({x:-12,y:6},{width:24,height:18},6,{width:20,height:20})).toEqual({x:2,y:0,width:4,height:2});
  expect(visiblePixelGridRegion({x:0,y:0},{width:100000,height:100000},6,{width:20000,height:20000})).toBeNull();
  for(const region of [{x:NaN,y:0,width:1,height:1},{x:0,y:0,width:1025,height:1024},{x:2147483647,y:0,width:1,height:1}])expect(()=>validatePixelGridRegion(region)).toThrow();
  const region={x:0,y:0,width:2,height:2};
  for(const value of [null,[[0,0,1,1,0,0,0,64]],[[0,0,3,0,0,0,0,64]],[[0,0,0,1,256,0,0,64]]])expect(()=>decodePixelGrid(value,region)).toThrow();
});
it("gates by physical 500% zoom, groups paths, hides stale candidates and cancels queued frames",()=>{
  const frames:FrameRequestCallback[]=[];vi.stubGlobal("requestAnimationFrame",vi.fn(fn=>{frames.push(fn);return frames.length;}));vi.stubGlobal("cancelAnimationFrame",vi.fn());vi.stubGlobal("devicePixelRatio",2);
  const lines:PixelGridSegment[]=[[0,0,0,1,255,255,255,64],[0,0,1,0,255,255,255,64]];
  const read=vi.fn(()=>({ok:true as const,value:lines}));
  const props={port:{contextKey:"a",read},origin:{x:0,y:0},size:{width:24,height:24},document:{width:8,height:8},zoom:2.5};
  const ui=render(<PixelGridOverlay {...props}/>);expect(frames).toHaveLength(0);
  ui.rerender(<PixelGridOverlay {...props} zoom={3}/>);act(()=>frames[0]!(0));expect(read).toHaveBeenLastCalledWith({x:0,y:0,width:8,height:8});expect(ui.container.querySelectorAll("path")).toHaveLength(1);expect(ui.container.querySelector("path")?.getAttribute("stroke-width")).toBe("0.5");
  ui.rerender(<PixelGridOverlay {...props} zoom={3} port={{contextKey:"b",read}}/>);expect(ui.container.querySelector("svg")).toBeNull();
  ui.rerender(<PixelGridOverlay {...props} zoom={3} port={{contextKey:"c",read}}/>);act(()=>frames[1]!(0));expect(read).toHaveBeenCalledTimes(1);
  act(()=>frames[2]!(0));expect(read).toHaveBeenCalledTimes(2);
  ui.rerender(<PixelGridOverlay {...props} zoom={3} transitioning/>);expect(ui.container.querySelector("svg")).toBeNull();
  ui.unmount();act(()=>frames[2]!(0));expect(read).toHaveBeenCalledTimes(2);
});
it("failed reads replace the prior grid with an explicit error",()=>{
  const frames:FrameRequestCallback[]=[];vi.stubGlobal("requestAnimationFrame",vi.fn(fn=>{frames.push(fn);return frames.length;}));vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const ui=render(<PixelGridOverlay port={{contextKey:"a",read:()=>({ok:false,code:"unavailable",message:"请更新内核"})}} origin={{x:0,y:0}} size={{width:20,height:20}} document={{width:8,height:8}} zoom={6}/>);act(()=>frames[0]!(0));expect(ui.container.textContent).toContain("请更新内核");expect(ui.container.querySelector("svg")).toBeNull();
});
