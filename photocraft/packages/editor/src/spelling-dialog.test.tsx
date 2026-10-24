/** @vitest-environment jsdom */
import {act,useSyncExternalStore} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import type {EditorDialogInstance,EditorDialogPort,EditorDialogRegistration} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {readSpellingDictionary,useSpellingDialog} from "./spelling-dialog.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("拼写范围、忽略、更改与用户词典使用明确动作；失效文档和能力拒绝且保留输入",()=>{
 const registrations=new Map<string,EditorDialogRegistration>(),listeners=new Set<()=>void>();let top:EditorDialogInstance|null=null,count=0;
 const port:EditorDialogPort={subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},isModalActive:()=>!!top,registerDialog:(id,value)=>{registrations.set(id,value);return()=>{registrations.delete(id);};},open:({dialogId})=>{if(top || !registrations.get(dialogId)?.definition.editingOwner?.())return {ok:false,error:"无归属"};top={dialogId,instanceId:String(++count)};listeners.forEach(fn=>fn());return {ok:true,instance:top};},top:()=>top,close:()=>{top=null;listeners.forEach(fn=>fn());}};
 let key="a",blocked=false,enabled=true;const hit={layer:7,start:2,end:6,word:"helo"},refresh=vi.fn();
 const checkSpelling=vi.fn((params:Record<string,unknown>)=>({ok:true as const,value:params.action==="list"?{misspellings:params.ignore && (params.ignore as string[]).includes("helo") || (params.dictionary as string[]).includes("helo")?[]:[hit,{...hit,start:8,end:12}]}:params.action==="suggest"?{suggestions:["hello","help"]}:params.action==="add"?{userDictionary:["helo"]}:{changed:1}}));
 const controller={dialogOwner:()=>({canvasId:"c",sessionId:"s"}),snapshot:()=>({view:{document:{documentKey:key}},commands:new Map([["edit.checkSpelling",{allowed:true,enabled}]])}),checkSpelling} as unknown as EditorWorkspaceController;
 let actions!:ReturnType<typeof useSpellingDialog>;
 function App(){actions=useSpellingDialog(port,controller,blocked,refresh,vi.fn());const instance=useSyncExternalStore(port.subscribe,port.top);return instance?registrations.get(instance.dialogId)?.renderer({instance,requestClose:()=>port.close(),setBusy:()=>{},replace:()=>{}}):null;}
 localStorage.clear();const node=document.createElement("div");document.body.append(node);const root=createRoot(node),render=()=>act(()=>root.render(<App/>));render();
 const button=(label:string)=>[...node.querySelectorAll("button")].find(button=>button.textContent===label)!;
 const click=(label:string)=>act(()=>button(label).click());
 try {
  act(()=>actions.open());expect(checkSpelling).not.toHaveBeenCalled();expect(button("更改").disabled).toBe(true);click("开始检查");expect(node.textContent).toContain("helo");expect(node.querySelectorAll("option")).toHaveLength(2);expect(localStorage.length).toBe(0);
  click("忽略");act(()=>{const select=node.querySelector("select")!;select.value="hello";select.dispatchEvent(new Event("change",{bubbles:true}));});click("更改");expect(checkSpelling).toHaveBeenCalledWith({action:"change",allLayers:true,...hit,start:8,end:12,replace:"hello",dictionary:[]});
  click("全部更改");expect(checkSpelling).toHaveBeenCalledWith({action:"changeAll",allLayers:true,word:"helo",replace:"helo",dictionary:[]});
  act(()=>node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());expect(button("更改").disabled).toBe(true);click("开始检查");expect(checkSpelling).toHaveBeenCalledWith({action:"list",allLayers:false,dictionary:[],ignore:[]});
  click("全部忽略");expect(node.textContent).toContain("拼写检查完成");click("完成");expect(localStorage.length).toBe(0);
  act(()=>actions.open());click("开始检查");checkSpelling.mockReturnValueOnce({ok:false,code:"locked",message:"文字层已锁定"} as never);click("更改");expect(node.textContent).toContain("文字层已锁定");expect(node.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!.value).toBe("helo");
  click("添加到词典");expect(readSpellingDictionary()).toEqual(["helo"]);expect(node.textContent).toContain("拼写检查完成");click("完成");localStorage.clear();
  act(()=>actions.open());click("开始检查");key="b";const count=checkSpelling.mock.calls.length;click("更改");expect(checkSpelling).toHaveBeenCalledTimes(count);expect(node.textContent).toContain("文档已更换");click("完成");
  act(()=>actions.open());click("开始检查");enabled=false;const calls=checkSpelling.mock.calls.length;click("更改");expect(checkSpelling).toHaveBeenCalledTimes(calls);enabled=true;
  blocked=true;render();expect(top).toBeNull();act(()=>expect(actions.open()).toBe(false));
 }finally {act(()=>root.unmount());node.remove();localStorage.clear();}
});
it("用户词典损坏、非数组、超限及多词条目恢复空词典",()=>{
 for(const value of ["{","null",JSON.stringify(["two words"]),JSON.stringify([42]),JSON.stringify(["x".repeat(129)]),JSON.stringify(Array(2001).fill("x"))]){localStorage.setItem("photocraft.spelling-dictionary.v1",value);expect(readSpellingDictionary()).toEqual([]);}localStorage.clear();
});
