/** @vitest-environment jsdom */
import {act,useSyncExternalStore} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import type {EditorDialogInstance,EditorDialogPort,EditorDialogRegistration} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {useDefinePatternDialog} from "./define-pattern-dialog.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("图案命名取消无写、确认校验名称/文档/选区归属，失败保留表单；只读关闭",()=>{
 const registrations=new Map<string,EditorDialogRegistration>(),listeners=new Set<()=>void>();let top:EditorDialogInstance|null=null,count=0;
 const port:EditorDialogPort={subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},isModalActive:()=>!!top,registerDialog:(id,value)=>{registrations.set(id,value);return()=>{registrations.delete(id);};},open:({dialogId})=>{if(top || !registrations.get(dialogId)?.definition.editingOwner?.())return {ok:false,error:"无归属"};top={dialogId,instanceId:String(++count)};listeners.forEach(fn=>fn());return {ok:true,instance:top};},top:()=>top,close:()=>{top=null;listeners.forEach(fn=>fn());}};
 let owner="a",revision=1,blocked=false;const create=vi.fn((_name:string):string|null=>null),report=vi.fn();
 const controller={dialogOwner:()=>({canvasId:"c",sessionId:owner}),snapshot:()=>({view:{document:{name:"Example.png",revision,selectionFrame:[0,0,4,3]}},commands:new Map([["edit.definePattern",{allowed:true,enabled:true}]])})} as unknown as EditorWorkspaceController;
 let actions:ReturnType<typeof useDefinePatternDialog>;
 function App(){actions=useDefinePatternDialog(port,controller,blocked,create,report);const instance=useSyncExternalStore(port.subscribe,port.top);return instance?registrations.get(instance.dialogId)?.renderer({instance,requestClose:()=>port.close(),setBusy:()=>{},replace:()=>{}}):null;}
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node),render=()=>act(()=>root.render(<App/>));render();
 const cancel=()=>act(()=>[...node.querySelectorAll("button")].find(button=>button.textContent==="取消")!.click());
 const submit=()=>act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 const edit=(name:string)=>act(()=>{const input=node.querySelector("input")!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,name);input.dispatchEvent(new Event("input",{bubbles:true}));});
 try{
  expect(port.open({dialogId:"image-editor.define-pattern"}).ok).toBe(false);act(()=>actions.open());expect(node.querySelector("input")!.value).toBe("Example");cancel();expect(create).not.toHaveBeenCalled();
  act(()=>actions.open());edit(" ");submit();expect(node.textContent).toContain("有效图案名称");expect(create).not.toHaveBeenCalled();edit("Region");revision++;submit();expect(node.textContent).toContain("文档或选区已更换");expect(create).not.toHaveBeenCalled();cancel();
  act(()=>actions.open());owner="b";submit();expect(create).not.toHaveBeenCalled();cancel();
  act(()=>actions.open());create.mockReturnValueOnce("图案库已满");submit();expect(node.textContent).toContain("图案库已满");expect(top).not.toBeNull();submit();expect(create.mock.lastCall).toEqual(["Example"]);expect(top).toBeNull();
  act(()=>actions.open());blocked=true;render();expect(top).toBeNull();act(()=>expect(actions.open()).toBe(false));
 }finally{act(()=>root.unmount());node.remove();}
});
