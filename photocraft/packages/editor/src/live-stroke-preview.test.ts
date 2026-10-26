import {expect,it,vi} from "vitest";
import {LiveStrokePreview} from "./live-stroke-preview.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
it("tap replacement uses frozen options, cancels only candidate, commits once, and ignores delayed frames",()=>{
 const frames:FrameRequestCallback[]=[];vi.stubGlobal("requestAnimationFrame",vi.fn((frame:FrameRequestCallback)=>{frames.push(frame);return frames.length;}));vi.stubGlobal("cancelAnimationFrame",vi.fn());
 const begin=vi.fn((_params:unknown)=>({ok:true})),append=vi.fn(()=>({ok:true})),commit=vi.fn(()=>({ok:true})),cancel=vi.fn(),refresh=vi.fn(),error=vi.fn();const controller={beginStroke:begin,appendStroke:append,commitStroke:commit,cancelStroke:cancel} as unknown as EditorWorkspaceController;
 try{const live=new LiveStrokePreview(controller,refresh,error),options={points:[[10,20,.1]],size:40,color:"#123456",target:"mask"};expect(live.begin(options)).toBe(true);options.color="#ffffff";const old=frames[0];expect(live.replaceTap({x:10,y:20,pressure:.8})).toBe(true);expect(cancel).toHaveBeenCalledOnce();expect(begin.mock.lastCall?.[0]).toMatchObject({points:[[10,20,.8]],size:40,color:"#123456",target:"mask"});old(0);expect(refresh).not.toHaveBeenCalled();expect(live.finish()).toBe(true);expect(commit).toHaveBeenCalledOnce();expect(append).not.toHaveBeenCalled();frames[1](0);expect(refresh).not.toHaveBeenCalled();
 live.begin({points:[[1,2,.2],[3,4,.3]],color:"#000000"});expect(live.replaceTap({x:3,y:4,pressure:.9})).toBe(false);live.cancel();expect(commit).toHaveBeenCalledOnce();
 }finally{vi.unstubAllGlobals();}
});

it("只在原生笔迹需要时间推进时发送停留点，保留设备字段并在提交/取消后停止",()=>{
 const frames:FrameRequestCallback[]=[];vi.stubGlobal("requestAnimationFrame",vi.fn((callback:FrameRequestCallback)=>{frames.push(callback);return frames.length;}));vi.stubGlobal("cancelAnimationFrame",vi.fn());
 const append=vi.fn(()=>({ok:true})),commit=vi.fn(()=>({ok:true})),cancel=vi.fn(),refresh=vi.fn();let needsTime=true;
 const controller={beginStroke:()=>({ok:true}),appendStroke:append,commitStroke:commit,cancelStroke:cancel,strokeWantsTime:()=>needsTime} as unknown as EditorWorkspaceController;
 try{const live=new LiveStrokePreview(controller,refresh,vi.fn());live.begin({points:[[2.25,3.75,.4,10,-15,45,10]],size:4});frames[0](20);
 expect(append.mock.lastCall).toEqual([[[2.25,3.75,.4,10,-15,45,20]]]);expect(frames).toHaveLength(2);
 live.replaceTap({x:2.25,y:3.75,pressure:.8,time:25});expect(cancel).not.toHaveBeenCalled();needsTime=false;frames[1](30);expect(frames).toHaveLength(2);
 expect(live.finish()).toBe(true);expect(commit).toHaveBeenCalledOnce();live.cancel();expect(cancel).not.toHaveBeenCalled();
 live.begin({points:[[1,2,.5,0,0,0,40]]});needsTime=true;live.cancel();const calls=append.mock.calls.length;frames.at(-1)!(50);expect(append).toHaveBeenCalledTimes(calls);
 }finally{vi.unstubAllGlobals();}
});
