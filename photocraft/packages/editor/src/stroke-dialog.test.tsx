/** @vitest-environment jsdom */
import {act,useSyncExternalStore} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import type {EditorDialogInstance,EditorDialogPort,EditorDialogRegistration} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {useStrokeDialog,readStroke} from "./stroke-dialog.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("描边显式确认才记忆，数值/失败保留输入，取消与过期目标无写",()=>{
 localStorage.removeItem("photocraft.edge-stroke.v1");const registrations=new Map<string,EditorDialogRegistration>(),listeners=new Set<()=>void>();let top:EditorDialogInstance|null=null,count=0;
 const port:EditorDialogPort={subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},isModalActive:()=>!!top,registerDialog:(id,value)=>{registrations.set(id,value);return()=>{registrations.delete(id);};},open:({dialogId})=>{if(top || !registrations.get(dialogId)?.definition.editingOwner?.())return {ok:false,error:"无归属"};top={dialogId,instanceId:String(++count)};listeners.forEach(fn=>fn());return {ok:true,instance:top};},top:()=>top,close:()=>{top=null;listeners.forEach(fn=>fn());}};
 let owner="a",revision=1,blocked=false;const dispatch=vi.fn((_id:string,_params:unknown)=>({ok:true as const,value:{}})),refresh=vi.fn(),report=vi.fn();
 const patterns=[{id:"tile",name:"Tile",width:1,height:1}];
 const controller={dialogOwner:()=>({canvasId:"c",sessionId:owner}),snapshot:()=>({view:{document:{documentKey:owner,revision}},commands:new Map([["edit.stroke",{allowed:true,enabled:true}]])}),dispatch,patternLibrary:()=>({ok:true,value:{presets:[],patternPresets:patterns}})} as unknown as EditorWorkspaceController;
 let actions:ReturnType<typeof useStrokeDialog>;
 function App(){actions=useStrokeDialog(port,controller,blocked,"#ff0000",refresh,report);const instance=useSyncExternalStore(port.subscribe,port.top);return instance?registrations.get(instance.dialogId)?.renderer({instance,requestClose:()=>port.close(),setBusy:()=>{},replace:()=>{}}):null;}
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node),render=()=>act(()=>root.render(<App/>));render();
 const cancel=(altKey=false)=>act(()=>[...node.querySelectorAll("button")].find(button=>button.textContent==="取消")!.dispatchEvent(new MouseEvent("click",{bubbles:true,altKey})));
 const submit=()=>act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 const edit=(index:number,value:string)=>act(()=>{const input=node.querySelectorAll<HTMLInputElement>('input[type="text"]')[index];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});
 try {
  act(()=>actions.open());edit(0,"3");cancel();expect(dispatch).not.toHaveBeenCalled();expect(localStorage.getItem("photocraft.edge-stroke.v1")).toBeNull();
  act(()=>actions.open());expect(node.querySelector<HTMLInputElement>('input[type="color"]')!.value).toBe("#ff0000");for(const bad of ["","0","251","NaN"]){edit(0,bad);submit();expect(dispatch).not.toHaveBeenCalled();}edit(0,"2.5");edit(1,"50");submit();
  expect(dispatch).toHaveBeenLastCalledWith("edit.stroke",{width:2.5,color:"#ff0000",location:"center",mode:"Normal",opacity:50,preserveTransparency:false});expect(top).toBeNull();expect(refresh).toHaveBeenCalledOnce();
  const stored=localStorage.getItem("photocraft.edge-stroke.v1");act(()=>actions.open());expect(node.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("2.5");edit(0,"4");dispatch.mockReturnValueOnce({ok:false,code:"locked",message:"目标已锁定"} as never);submit();expect(top).not.toBeNull();expect(node.textContent).toContain("目标已锁定");expect(localStorage.getItem("photocraft.edge-stroke.v1")).toBe(stored);cancel();
  act(()=>actions.open());const calls=dispatch.mock.calls.length;revision++;submit();expect(dispatch).toHaveBeenCalledTimes(calls);expect(node.textContent).toContain("目标已更换");cancel();
  act(()=>actions.open());owner="b";submit();expect(dispatch).toHaveBeenCalledTimes(calls);cancel();
  act(()=>actions.open());blocked=true;render();expect(top).toBeNull();act(()=>expect(actions.open()).toBe(false));
  localStorage.setItem("photocraft.edge-stroke.v1",JSON.stringify({width:500,color:7,location:"any",opacity:200,mode:"Pass Through",preserveTransparency:"true"}));expect(readStroke("#ff0000")).toEqual({width:1,color:"#ff0000",location:"center",opacity:100,mode:"Normal",preserveTransparency:false});
 }finally{act(()=>root.unmount());node.remove();localStorage.removeItem("photocraft.edge-stroke.v1");}
});
