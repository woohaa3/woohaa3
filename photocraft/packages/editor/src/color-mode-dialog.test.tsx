/** @vitest-environment jsdom */
import {act,useSyncExternalStore} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import type {EditorDialogInstance,EditorDialogPort,EditorDialogRegistration} from "./ports.js";
import type{EditorWorkspaceController} from "./editor-workspace.js";
import {useColorModeDialog} from "./color-mode-dialog.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("图像模式按模式再位深各分派一次，取消零写，未变化禁止确认",()=>{
 const registrations=new Map<string,EditorDialogRegistration>(),listeners=new Set<()=>void>();let top:EditorDialogInstance|null=null,count=0;
 const port:EditorDialogPort={subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},isModalActive:()=>!!top,registerDialog:(id,value)=>{registrations.set(id,value);return()=>{registrations.delete(id);};},open:({dialogId})=>{if(top || !registrations.get(dialogId)?.definition.editingOwner?.())return {ok:false,error:"无归属"};top={dialogId,instanceId:String(++count)};listeners.forEach(fn=>fn());return {ok:true,instance:top};},top:()=>top,close:()=>{top=null;listeners.forEach(fn=>fn());}};
 const commands=new Map<string,unknown>([["image.mode.rgb",{allowed:true,enabled:true}],["image.mode.grayscale",{allowed:true,enabled:true}],["image.mode.cmyk",{allowed:true,enabled:true}],["image.mode.bits8",{allowed:true,enabled:true}],["image.mode.bits16",{allowed:true,enabled:true}]]);
 const dispatch=vi.fn<(id:string,params:unknown)=>unknown>(()=>({ok:true,value:{}})),refresh=vi.fn(),report=vi.fn();let blocked=false;
 const controller={dialogOwner:()=>({canvasId:"c",sessionId:"s"}),snapshot:()=>({view:{document:{documentKey:"doc",revision:1,mode:"RGB",depthBits:8}},commands}),dispatch} as unknown as EditorWorkspaceController;
 let actions:ReturnType<typeof useColorModeDialog>;
 function App(){actions=useColorModeDialog(port,controller,blocked,refresh,report);const instance=useSyncExternalStore(port.subscribe,port.top);return instance?registrations.get(instance.dialogId)?.renderer({instance,requestClose:()=>port.close(),setBusy:()=>{},replace:()=>{}}):null;}
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node),render=()=>act(()=>root.render(<App/>));render();
 const submit=()=>act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 const choose=(index:number,value:string)=>act(()=>{const select=node.querySelectorAll<HTMLSelectElement>("select")[index]!;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(select,value);select.dispatchEvent(new Event("change",{bubbles:true}));});
 try{
  act(()=>actions.open());
  expect(node.querySelector('[role="dialog"]')?.textContent).toContain("图像模式与位深");
  expect(node.querySelector<HTMLSelectElement>("select")!.value).toBe("rgb");
  expect([...node.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="转换")!.disabled).toBe(true);
  act(()=>[...node.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="取消")!.click());expect(dispatch).not.toHaveBeenCalled();
  act(()=>actions.open());choose(0,"grayscale");choose(1,"16");submit();
  expect(dispatch.mock.calls).toEqual([["image.mode.grayscale",{}],["image.mode.bits16",{}]]);
  expect(refresh).toHaveBeenCalledOnce();
  // 命令关闭时不得先写一半。
  act(()=>actions.open());choose(0,"cmyk");commands.set("image.mode.cmyk",{allowed:true,enabled:false,disabledReason:"CMYK 暂不可转换"});submit();
  expect(node.textContent).toContain("CMYK 暂不可转换");expect(dispatch).toHaveBeenCalledTimes(2);
  act(()=>[...node.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="取消")!.click());
  act(()=>actions.open());blocked=true;render();expect(top).toBeNull();act(()=>expect(actions.open()).toBe(false));
 }finally{act(()=>root.unmount());node.remove();}
});
