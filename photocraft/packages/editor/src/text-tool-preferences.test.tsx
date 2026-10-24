/** @vitest-environment jsdom */
import {act} from "react";import {createRoot} from "react-dom/client";import {expect,it,vi} from "vitest";
import {useTextEditing} from "./use-text-editing.js";import type {EditorWorkspaceController} from "./editor-workspace.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("new point/box text selects placeholder, opt-out starts empty, existing text stays intact; memory excludes content",()=>{
 const host=document.createElement("div"),root=createRoot(host);let editing:ReturnType<typeof useTextEditing>,fill=true;
 const begin=vi.fn((placement:{layer?:number})=>({ok:true,value:{layer:placement.layer??null,text:placement.layer?"existing content":""}}));
 const preview=vi.fn((value:unknown)=>({ok:true,value})),controller={beginText:begin,previewText:preview,cancelText:vi.fn(),textGeometry:vi.fn(()=>({ok:true,value:{caret:[],selection:[],hit:null,next:undefined}}))} as unknown as EditorWorkspaceController,refresh=vi.fn(),error=vi.fn();
 vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());function Probe(){editing=useTextEditing(controller,refresh,error,()=>fill);return null;}
 try{act(()=>root.render(<Probe/>));act(()=>editing.begin({x:10,y:20}));expect(editing!.style.text).toBe("Lorem Ipsum");expect(editing!.selection).toMatchObject({start:0,end:11});expect(preview).not.toHaveBeenCalled();
 act(()=>editing!.update({font:"Inter",size:64,text:"private draft"}));const memory=localStorage.getItem("photocraft.tools.v1.text")!;expect(JSON.parse(memory)).toEqual({font:"Inter",size:64});expect(memory).not.toContain("private");act(()=>editing!.finish(false));
 fill=false;act(()=>editing!.begin({x:20,y:30,box:[20,30,100,50]}));expect(editing!.style).toMatchObject({text:"",font:"Inter",size:64});expect(editing!.selection).toMatchObject({start:0,end:0});act(()=>editing!.finish(false));
 fill=true;act(()=>editing!.begin({layer:1}));expect(editing!.style.text).toBe("existing content");expect(editing!.selection).toMatchObject({start:16,end:16});
 }finally{act(()=>root.unmount());vi.unstubAllGlobals();}
});
it("font hover previews through native draft, exit cancels automatic session or restores existing draft; selection survives close",()=>{
 const host=document.createElement("div"),root=createRoot(host),frames:FrameRequestCallback[]=[];let editing:ReturnType<typeof useTextEditing>;
 vi.stubGlobal("requestAnimationFrame",vi.fn((frame:FrameRequestCallback)=>{frames.push(frame);return frames.length;}));vi.stubGlobal("cancelAnimationFrame",vi.fn());
 const preview=vi.fn((value:unknown)=>({ok:true,value:{...(value as object),layer:1}})),cancel=vi.fn();const controller={beginText:vi.fn(()=>({ok:true,value:{layer:1,text:"original"}})),previewText:preview,cancelText:cancel,textGeometry:vi.fn(()=>({ok:true,value:{caret:[],selection:[],hit:null}}))} as unknown as EditorWorkspaceController,refresh=vi.fn(),error=vi.fn();
 function Probe(){editing=useTextEditing(controller,refresh,error);return null;}const flush=()=>act(()=>{frames.splice(0).forEach(frame=>frame(0));});
 try{act(()=>root.render(<Probe/>));act(()=>editing.previewFont("Inter",1));flush();expect(preview.mock.lastCall?.[0]).toMatchObject({font:"Inter",text:"original"});expect(editing!.style.font).toBe("Noto Sans SC");expect(localStorage.getItem("photocraft.tools.v1.text")).toBeNull();act(()=>editing!.previewFont(null));expect(cancel).toHaveBeenCalledOnce();expect(editing!.active).toBe(false);
 act(()=>editing!.begin({layer:1}));act(()=>editing!.update({text:"draft"}));act(()=>editing!.previewFont("Inter"));flush();expect(preview.mock.lastCall?.[0]).toMatchObject({font:"Inter",text:"draft"});act(()=>editing!.previewFont(null));flush();expect(preview.mock.lastCall?.[0]).toMatchObject({font:"Noto Sans SC",text:"draft"});expect(editing!.active).toBe(true);expect(cancel).toHaveBeenCalledOnce();
 act(()=>editing!.previewFont("Inter"));act(()=>editing!.update({font:"Inter"}));act(()=>editing!.previewFont(null));flush();expect(editing!.active).toBe(true);expect(preview.mock.lastCall?.[0]).toMatchObject({font:"Inter",text:"draft"});expect(cancel).toHaveBeenCalledOnce();
 }finally{act(()=>root.unmount());vi.unstubAllGlobals();}
});
it("抗锯齿模式随文字候选与工具记忆传递，取消不提交正式层，坏模式恢复缺省",()=>{
 const host=document.createElement("div"),root=createRoot(host),frames:FrameRequestCallback[]=[];let editing!:ReturnType<typeof useTextEditing>;
 vi.stubGlobal("requestAnimationFrame",vi.fn((frame:FrameRequestCallback)=>{frames.push(frame);return frames.length;}));vi.stubGlobal("cancelAnimationFrame",vi.fn());
 const preview=vi.fn((_params:unknown)=>({ok:true,value:{layer:1}})),cancel=vi.fn(),commit=vi.fn(()=>({ok:true,value:{}}));
 const controller={beginText:vi.fn(()=>({ok:true,value:{layer:1,text:"Aa",antialias:"sharp",character:{font_family:"Inter",size_pt:12},paragraph:{align:"Left"}}})),previewText:preview,cancelText:cancel,commitText:commit,textGeometry:vi.fn(()=>({ok:true,value:{caret:[],selection:[],hit:null}}))} as unknown as EditorWorkspaceController;
 const refresh=vi.fn(),error=vi.fn();function Probe(){editing=useTextEditing(controller,refresh,error);return null;}
 try{act(()=>root.render(<Probe/>));act(()=>editing.begin({layer:1}));expect(editing.style.antialias).toBe("sharp");act(()=>editing.update({antialias:"none"}));act(()=>frames.splice(0).forEach(frame=>frame(0)));expect(preview.mock.lastCall?.[0]).toMatchObject({text:"Aa",antialias:"none"});expect(localStorage.getItem("photocraft.tools.v1.text")).toContain('"antialias":"none"');act(()=>editing.finish(false));expect(cancel).toHaveBeenCalledOnce();expect(commit).not.toHaveBeenCalled();
 }finally{act(()=>root.unmount());vi.unstubAllGlobals();localStorage.removeItem("photocraft.tools.v1.text");}
});
