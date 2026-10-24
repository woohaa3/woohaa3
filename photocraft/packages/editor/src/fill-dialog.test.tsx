/** @vitest-environment jsdom */
import {act,useSyncExternalStore} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import type {EditorDialogInstance,EditorDialogPort,EditorDialogRegistration} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {useFillDialog,readFill} from "./fill-dialog.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("填充确认才记忆，错误保留表单，Alt取消恢复默认，目标过期/只读不填充",()=>{
 localStorage.removeItem("photocraft.fill.v1");const registrations=new Map<string,EditorDialogRegistration>(),listeners=new Set<()=>void>();let top:EditorDialogInstance|null=null,count=0;
 const port:EditorDialogPort={subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},isModalActive:()=>!!top,registerDialog:(id,value)=>{registrations.set(id,value);return()=>{registrations.delete(id);};},open:({dialogId})=>{if(top || !registrations.get(dialogId)?.definition.editingOwner?.())return {ok:false,error:"无归属"};top={dialogId,instanceId:String(++count)};listeners.forEach(fn=>fn());return {ok:true,instance:top};},top:()=>top,close:()=>{top=null;listeners.forEach(fn=>fn());}};
 let owner="a",revision=1,blocked=false;const dispatch=vi.fn((_id:string,_params:unknown)=>({ok:true as const,value:{}})),refresh=vi.fn(),report=vi.fn();
 const patterns=[{id:"tile",name:"Tile",width:1,height:1}];
 const controller={dialogOwner:()=>({canvasId:"c",sessionId:owner}),snapshot:()=>({view:{document:{documentKey:owner,revision}},commands:new Map([["edit.fill",{allowed:true,enabled:true}]])}),dispatch,patternLibrary:()=>({ok:true,value:{presets:[],patternPresets:patterns}})} as unknown as EditorWorkspaceController;
 let actions:ReturnType<typeof useFillDialog>;
 function App(){actions=useFillDialog(port,controller,blocked,{foreground:"#ff0000",background:"#0000ff"},refresh,report);const instance=useSyncExternalStore(port.subscribe,port.top);return instance?registrations.get(instance.dialogId)?.renderer({instance,requestClose:()=>port.close(),setBusy:()=>{},replace:()=>{}}):null;}
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node),render=()=>act(()=>root.render(<App/>));render();
 const cancel=(altKey=false)=>act(()=>[...node.querySelectorAll("button")].find(button=>button.textContent==="取消")!.dispatchEvent(new MouseEvent("click",{bubbles:true,altKey})));
 const submit=()=>act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 const source=(contents:string)=>act(()=>{const select=node.querySelector("select")!;select.value=contents;select.dispatchEvent(new Event("change",{bubbles:true}));});
 try {
  act(()=>actions.open());source("white");cancel();expect(dispatch).not.toHaveBeenCalled();expect(localStorage.getItem("photocraft.fill.v1")).toBeNull();
  act(()=>actions.open());submit();expect(dispatch).toHaveBeenLastCalledWith("edit.fill",{contents:"foreground",color:"#ff0000",mode:"Normal",opacity:100,preserveTransparency:false});expect(top).toBeNull();expect(refresh).toHaveBeenCalledOnce();
  const stored=localStorage.getItem("photocraft.fill.v1");act(()=>actions.open());source("pattern");expect(node.textContent).toContain("Tile");dispatch.mockReturnValueOnce({ok:false,code:"locked",message:"目标已锁定"} as never);submit();expect(top).not.toBeNull();expect(node.textContent).toContain("目标已锁定");expect(localStorage.getItem("photocraft.fill.v1")).toBe(stored);
  cancel(true);expect(top).not.toBeNull();expect(node.querySelector("select")!.value).toBe("foreground");expect(localStorage.getItem("photocraft.fill.v1")).toBe(stored);source("background");submit();expect(dispatch).toHaveBeenLastCalledWith("edit.fill",expect.objectContaining({contents:"background",color:"#0000ff"}));
  act(()=>actions.open());const calls=dispatch.mock.calls.length;revision++;submit();expect(dispatch).toHaveBeenCalledTimes(calls);expect(node.textContent).toContain("目标已更换");cancel();
  act(()=>actions.open());owner="b";submit();expect(dispatch).toHaveBeenCalledTimes(calls);cancel();
  act(()=>actions.open());blocked=true;render();expect(top).toBeNull();act(()=>expect(actions.open()).toBe(false));
  localStorage.setItem("photocraft.fill.v1",JSON.stringify({contents:"bad",color:7,pattern:"deleted",opacity:200,mode:"Pass Through",preserveTransparency:"true"}));expect(readFill("#ff0000",patterns)).toMatchObject({contents:"foreground",color:"#ff0000",pattern:"tile",opacity:100,mode:"Normal",preserveTransparency:false});
 }finally{act(()=>root.unmount());node.remove();localStorage.removeItem("photocraft.fill.v1");}
});
