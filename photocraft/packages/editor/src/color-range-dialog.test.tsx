/** @vitest-environment jsdom */
import {act,useSyncExternalStore} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import type {EditorDialogInstance,EditorDialogPort,EditorDialogRegistration} from "./ports.js";
import type{EditorWorkspaceController} from "./editor-workspace.js";
import {useColorRangeDialog} from "./color-range-dialog.js";
import {DEFAULT_COLOR_RANGE} from "./photo-editor-tools.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("颜色范围确认只分派原生参数，取消零写，过期文档/只读关闭且保留表单",()=>{
 const registrations=new Map<string,EditorDialogRegistration>(),listeners=new Set<()=>void>();let top:EditorDialogInstance|null=null,count=0;
 const port:EditorDialogPort={subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},isModalActive:()=>!!top,registerDialog:(id,value)=>{registrations.set(id,value);return()=>{registrations.delete(id);};},open:({dialogId})=>{if(top || !registrations.get(dialogId)?.definition.editingOwner?.())return {ok:false,error:"无归属"};top={dialogId,instanceId:String(++count)};listeners.forEach(fn=>fn());return {ok:true,instance:top};},top:()=>top,close:()=>{top=null;listeners.forEach(fn=>fn());}};
 const dispatch=vi.fn<(id:string,params:unknown)=>unknown>(()=>({ok:true,value:{}})),refresh=vi.fn(),report=vi.fn(),applied=vi.fn();let revision=1,blocked=false;
 const controller={dialogOwner:()=>({canvasId:"c",sessionId:"s"}),snapshot:()=>({view:{document:{documentKey:"doc",revision}},commands:new Map([["select.colorRange",{allowed:true,enabled:true}]])}),dispatch} as unknown as EditorWorkspaceController;
 let actions:ReturnType<typeof useColorRangeDialog>;
 function App(){actions=useColorRangeDialog(port,controller,blocked,refresh,report,applied);const instance=useSyncExternalStore(port.subscribe,port.top);return instance?registrations.get(instance.dialogId)?.renderer({instance,requestClose:()=>port.close(),setBusy:()=>{},replace:()=>{}}):null;}
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node),render=()=>act(()=>root.render(<App/>));render();
 const cancel=()=>act(()=>[...node.querySelectorAll("button")].find(button=>button.textContent==="取消")!.click());
 const submit=()=>act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 const input=(label:string)=>[...node.querySelectorAll<HTMLLabelElement>("label")].find(item=>item.textContent?.startsWith(label))!.querySelector("input")!;
 const type=(element:HTMLInputElement,value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(element,value);element.dispatchEvent(new Event("input",{bubbles:true}));});
 try{
  act(()=>actions.open(DEFAULT_COLOR_RANGE));expect(node.querySelector('[role="dialog"]')?.textContent).toContain("颜色范围");cancel();expect(dispatch).not.toHaveBeenCalled();
  act(()=>actions.open(DEFAULT_COLOR_RANGE));submit();expect(dispatch).toHaveBeenLastCalledWith("select.colorRange",expect.objectContaining({select:"sampledColors",color:"#ff0000",fuzziness:40,mode:"replace"}));expect(applied).toHaveBeenCalledOnce();expect(top).toBeNull();
  // 未选中色调时没有取样颜色字段，容差上限改为 100。
  act(()=>actions.open({...DEFAULT_COLOR_RANGE,select:"highlights"}));
  expect(node.querySelector<HTMLSelectElement>("select")!.value).toBe("highlights");
  expect([...node.querySelectorAll("label")].some(label=>label.textContent?.startsWith("取样颜色"))).toBe(false);
  type(input("容差"),"130");submit();expect(node.textContent).toContain("容差须为0–100");expect(dispatch).toHaveBeenCalledTimes(1);
  type(input("容差"),"80");submit();expect(dispatch).toHaveBeenLastCalledWith("select.colorRange",expect.objectContaining({select:"highlights",fuzziness:80}));
  act(()=>actions.open(DEFAULT_COLOR_RANGE));revision++;submit();expect(node.textContent).toContain("文档已更换");expect(dispatch).toHaveBeenCalledTimes(2);cancel();
  act(()=>actions.open(DEFAULT_COLOR_RANGE));dispatch.mockReturnValueOnce({ok:false,code:"no-selection",message:"当前没有可取样像素"});submit();expect(node.textContent).toContain("当前没有可取样像素");expect(top).not.toBeNull();cancel();
  act(()=>actions.open(DEFAULT_COLOR_RANGE));blocked=true;render();expect(top).toBeNull();act(()=>expect(actions.open(DEFAULT_COLOR_RANGE)).toBe(false));
 }finally{act(()=>root.unmount());node.remove();}
});
