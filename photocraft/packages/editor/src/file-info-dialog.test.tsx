/** @vitest-environment jsdom */
import {act,useSyncExternalStore} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import type {EditorDialogInstance,EditorDialogPort,EditorDialogRegistration} from "./ports.js";
import type{EditorWorkspaceController} from "./editor-workspace.js";
import {useFileInfoDialog} from "./file-info-dialog.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("文件信息读取只读相机数据，确认只分派一次写入，取消与过期文档零写",()=>{
 const registrations=new Map<string,EditorDialogRegistration>(),listeners=new Set<()=>void>();let top:EditorDialogInstance|null=null,count=0;
 const port:EditorDialogPort={subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},isModalActive:()=>!!top,registerDialog:(id,value)=>{registrations.set(id,value);return()=>{registrations.delete(id);};},open:({dialogId})=>{if(top || !registrations.get(dialogId)?.definition.editingOwner?.())return {ok:false,error:"无归属"};top={dialogId,instanceId:String(++count)};listeners.forEach(fn=>fn());return {ok:true,instance:top};},top:()=>top,close:()=>{top=null;listeners.forEach(fn=>fn());}};
 const dispatch=vi.fn<(id:string,params:unknown)=>unknown>(()=>({ok:true,value:{}})),refresh=vi.fn(),report=vi.fn();let revision=1,blocked=false;
 const controller={dialogOwner:()=>({canvasId:"c",sessionId:"s"}),snapshot:()=>({view:{document:{documentKey:"doc",revision}},commands:new Map([["file.fileInfo",{allowed:true,enabled:true}]])}),dispatch,
  fileInfo:vi.fn(()=>({ok:true,value:{title:"示例",author:"作者",keywords:["红","绿"],copyrightStatus:"copyrighted",camera:{make:"Canon",iso:200}}}))} as unknown as EditorWorkspaceController;
 let actions:ReturnType<typeof useFileInfoDialog>;
 function App(){actions=useFileInfoDialog(port,controller,blocked,refresh,report);const instance=useSyncExternalStore(port.subscribe,port.top);return instance?registrations.get(instance.dialogId)?.renderer({instance,requestClose:()=>port.close(),setBusy:()=>{},replace:()=>{}}):null;}
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node),render=()=>act(()=>root.render(<App/>));render();
 const cancel=()=>act(()=>[...node.querySelectorAll("button")].find(button=>button.textContent==="取消")!.click());
 const submit=()=>act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 const input=(label:string)=>[...node.querySelectorAll<HTMLLabelElement>("label")].find(item=>item.textContent?.startsWith(label))!.querySelector("input")!;
 const type=(element:HTMLInputElement,value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(element,value);element.dispatchEvent(new Event("input",{bubbles:true}));});
 try{
  act(()=>actions.open());
  expect(node.querySelector('[role="dialog"]')?.textContent).toContain("文件信息");
  expect(input("标题").value).toBe("示例");expect(input("关键词（分号分隔）").value).toBe("红; 绿");
  expect(node.textContent).toContain("Canon");expect(node.textContent).toContain("相机数据（只读）");
  cancel();expect(dispatch).not.toHaveBeenCalled();
  act(()=>actions.open());type(input("标题"),"新标题");submit();
  expect(dispatch).toHaveBeenLastCalledWith("file.fileInfo",expect.objectContaining({title:"新标题",keywords:["红","绿"],copyrightStatus:"copyrighted"}));
  expect(refresh).toHaveBeenCalledOnce();
  act(()=>actions.open());revision++;submit();expect(node.textContent).toContain("文档已更换");expect(dispatch).toHaveBeenCalledTimes(1);cancel();
  act(()=>actions.open());dispatch.mockReturnValueOnce({ok:false,code:"stale",message:"文件信息未能写入"});submit();expect(node.textContent).toContain("文件信息未能写入");expect(top).not.toBeNull();cancel();
  act(()=>actions.open());blocked=true;render();expect(top).toBeNull();act(()=>expect(actions.open()).toBe(false));
 }finally{act(()=>root.unmount());node.remove();}
});
