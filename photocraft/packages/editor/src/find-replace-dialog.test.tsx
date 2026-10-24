/** @vitest-environment jsdom */
import {act,useSyncExternalStore} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import type {EditorDialogInstance,EditorDialogPort,EditorDialogRegistration} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {useFindReplaceDialog} from "./find-replace-dialog.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("查找替换保留表单、明确确认动作，选项变化需重新查找，拒绝过期文档及只读回调",()=>{
 const registrations=new Map<string,EditorDialogRegistration>(),listeners=new Set<()=>void>();let top:EditorDialogInstance|null=null,count=0;
 const port:EditorDialogPort={subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},isModalActive:()=>!!top,registerDialog:(id,value)=>{registrations.set(id,value);return()=>{registrations.delete(id);};},open:({dialogId})=>{if(top || !registrations.get(dialogId)?.definition.editingOwner?.())return {ok:false,error:"无归属"};top={dialogId,instanceId:String(++count)};listeners.forEach(fn=>fn());return {ok:true,instance:top};},top:()=>top,close:()=>{top=null;listeners.forEach(fn=>fn());}};
 let owner="a",key="doc-a",blocked=false,enabled=true;const findReplaceText=vi.fn((_params:unknown)=>({ok:true as const,value:{found:{layer:7,text:"猫😀"}} as Record<string,unknown>})),refresh=vi.fn(),report=vi.fn();
 const controller={dialogOwner:()=>({canvasId:"c",sessionId:owner}),snapshot:()=>({view:{document:{documentKey:key}},commands:new Map([["edit.findAndReplaceText",{allowed:true,enabled}]])}),findReplaceText} as unknown as EditorWorkspaceController;
 let actions:ReturnType<typeof useFindReplaceDialog>;
 function App(){actions=useFindReplaceDialog(port,controller,blocked,refresh,report);const instance=useSyncExternalStore(port.subscribe,port.top);return instance?registrations.get(instance.dialogId)?.renderer({instance,requestClose:()=>port.close(),setBusy:()=>{},replace:()=>{}}):null;}
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node),render=()=>act(()=>root.render(<App/>));render();
 const button=(label:string)=>[...node.querySelectorAll("button")].find(button=>button.textContent===label)!;
 const click=(label:string)=>act(()=>button(label).click());
 const edit=(index:number,value:string)=>act(()=>{const input=node.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')[index];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});
 try {
  act(()=>actions.open());expect(button("查找下一个").disabled).toBe(true);expect(button("替换").disabled).toBe(true);edit(0,"猫😀");edit(1,"dog");click("查找下一个");
  expect(findReplaceText).toHaveBeenLastCalledWith({find:"猫😀",replace:"dog",caseSensitive:false,wholeWord:false,forward:true,allLayers:true,action:"find"});expect(node.textContent).toContain("找到“猫😀”");expect(top).not.toBeNull();expect(refresh).toHaveBeenCalledOnce();
  click("替换并查找");expect(findReplaceText.mock.lastCall?.[0]).toMatchObject({action:"changeFind"});
  act(()=>node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click());expect(button("替换").disabled).toBe(true);click("全部替换");expect(findReplaceText.mock.lastCall?.[0]).toMatchObject({action:"changeAll",caseSensitive:true});
  findReplaceText.mockReturnValueOnce({ok:false,code:"locked",message:"文字层已锁定"} as never);click("全部替换");expect(node.textContent).toContain("文字层已锁定");expect(node.querySelector<HTMLInputElement>("input")!.value).toBe("猫😀");
  const calls=findReplaceText.mock.calls.length;key="doc-b";click("全部替换");expect(node.textContent).toContain("文档已更换");expect(findReplaceText).toHaveBeenCalledTimes(calls);click("完成");
  act(()=>actions.open());edit(0,"x");owner="b";click("全部替换");expect(findReplaceText).toHaveBeenCalledTimes(calls);click("完成");
  act(()=>actions.open());edit(0,"x");enabled=false;click("全部替换");expect(findReplaceText).toHaveBeenCalledTimes(calls);enabled=true;
  blocked=true;render();expect(top).toBeNull();act(()=>expect(actions.open()).toBe(false));
 }finally {act(()=>root.unmount());node.remove();}
});
