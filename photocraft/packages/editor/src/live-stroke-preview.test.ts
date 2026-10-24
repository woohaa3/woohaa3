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
