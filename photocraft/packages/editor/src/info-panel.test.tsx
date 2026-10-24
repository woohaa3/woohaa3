/** @vitest-environment jsdom */
// Only scheduling, state and DOM; no rendering context or screenshot.
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {InfoPanel} from "./info-panel.js";
import {decodeInfoReadout,type InfoReadout,type InfoRequest} from "./info-readout.js";
import type {EditorResult} from "./editor-wasm.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const sample:InfoReadout={rgb:[255,0,0],cmyk:[0,100,100,0],position:[5,6],selectionSize:[4,5],documentSize:[16,12]};
it("原生读数严格形状和范围，设备CMYK不冒充浏览器颜色",()=>{
  expect(decodeInfoReadout(sample)).toEqual(sample);
  for(const patch of [{rgb:[256,0,0]},{rgb:[1.5,0,0]},{cmyk:[0,0,0,101]},{position:[NaN,3]},{selectionSize:[0,2]},{documentSize:[0,12]},{documentSize:null}])expect(()=>decodeInfoReadout({...sample,...patch})).toThrow();
});
it("一帧读最终指针，代际变化拒绝旧帧；失败/离开无陈旧颜色，卸载不再读取",()=>{
  let id=0;const callbacks=new Map<number,FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame",(callback:FrameRequestCallback)=>{callbacks.set(++id,callback);return id;});vi.stubGlobal("cancelAnimationFrame",(id:number)=>callbacks.delete(id));
  const read=vi.fn((_request:InfoRequest):EditorResult<InfoReadout>=>({ok:true,value:sample})),node=document.createElement("div");document.body.append(node);const root=createRoot(node);
  const render=(contextKey="doc:1",point:{x:number;y:number}|null={x:5,y:6})=>act(()=>root.render(<InfoPanel contextKey={contextKey} point={point} size={3} read={read}/>));
  const flush=()=>act(()=>{for(const [id,callback] of [...callbacks]){callbacks.delete(id);callback(0);}});
  try{
    render();const old=[...callbacks.values()][0];render("doc:1",{x:9,y:10});act(()=>old(0));expect(read).not.toHaveBeenCalled();flush();expect(read.mock.calls).toEqual([[{x:9,y:10,size:3}]]);expect(node.textContent).toContain("255");expect(node.textContent).toContain("16 × 12 px");
    read.mockReturnValueOnce({ok:false,code:"unavailable",message:"样本失败"});render("doc:2");expect(node.textContent).not.toContain("255");flush();expect(node.textContent).toContain("样本失败");expect(node.textContent).not.toContain("255");
    read.mockReturnValue({ok:true,value:{...sample,rgb:null,cmyk:null,position:null}});render("doc:2",null);flush();expect(read).toHaveBeenLastCalledWith({x:null,y:null,size:3});expect(node.textContent).not.toContain("255");
    render("doc:3");const late=[...callbacks.values()][0],count=read.mock.calls.length;act(()=>root.unmount());act(()=>late(0));expect(read).toHaveBeenCalledTimes(count);expect(callbacks.size).toBe(0);
  }finally{act(()=>root.unmount());node.remove();vi.unstubAllGlobals();}
});

it("测量读数使用文档dpi和各轴范围，改变单位不重复读取像素",()=>{
  let frame:FrameRequestCallback=()=>{};vi.stubGlobal("requestAnimationFrame",(fn:FrameRequestCallback)=>{frame=fn;return 1;});vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const node=document.createElement("div"),root=createRoot(node),read=vi.fn(()=>({ok:true as const,value:sample}));
  try{act(()=>root.render(<InfoPanel contextKey="a" point={{x:5,y:6}} size={1} read={read} unit="inches" resolutionDpi={2}/>));act(()=>frame(0));expect(node.textContent).toContain("2.5 in");expect(node.textContent).toContain("3 in");
    act(()=>root.render(<InfoPanel contextKey="a" point={{x:5,y:6}} size={1} read={read} unit="percent"/>));expect(node.textContent).toContain("31.3 %");expect(node.textContent).toContain("50 %");expect(read).toHaveBeenCalledTimes(1);
  }finally{act(()=>root.unmount());vi.unstubAllGlobals();}
});
