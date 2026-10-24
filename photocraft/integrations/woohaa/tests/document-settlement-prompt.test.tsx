/** @vitest-environment jsdom */
import {act,useSyncExternalStore} from "react";import {createRoot} from "react-dom/client";import {expect,it,vi} from "vitest";
import {DialogService} from "@woohaa3/frontend/plugin-api";import {createDocumentSettlementPrompt} from "@woohaa3/photocraft-editor";
import {settleDocument} from "../src/document-settlement.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
function setup(){const dialogs=new DialogService(),error=vi.fn(),prompt=createDocumentSettlementPrompt(dialogs,error),host=document.createElement("div");document.body.append(host);const root=createRoot(host);
 function Probe(){useSyncExternalStore(dialogs.subscribe,dialogs.getSnapshot,dialogs.getSnapshot);const instance=dialogs.top(),Renderer=instance?dialogs.resolveRenderer(instance.dialogId):null;return instance&&Renderer?<Renderer instance={instance} requestClose={()=>dialogs.requestClose(instance.instanceId)} setBusy={busy=>dialogs.setBusy(instance.instanceId,busy)} replace={()=>{}}/>:null;}
 act(()=>root.render(<Probe/>));const click=async(label:string)=>act(async()=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===label)!.click());
 return {dialogs,prompt,error,host,click,dispose:()=>{act(()=>{prompt.dispose();root.unmount();});host.remove();}};
}
const base={documentId:"d",name:"未命名.pcraft",dirty:true,pendingDraft:null,phase:"editing",message:null,nodeDocument:false,receiptUnknown:false};
it("真实宿主弹窗提供保存/不保存/取消；放弃不调用保存，取消保留文档",async()=>{
 const t=setup();try{
  for(const [label,expected] of [["不保存",{ok:true,action:"abandoned"}],["取消",{ok:false,reason:"已取消"}],["保存",{ok:true,action:"closed"}]] as const){
   const save=vi.fn(async()=>({ok:true}));let result!:ReturnType<typeof settleDocument>;
   act(()=>{result=settleDocument({...base,ui:{choose:reason=>t.prompt.ask({name:base.name,reason}),abandon:async()=>true},save});});
   expect(t.host.textContent).toContain(base.name);expect(t.host.textContent).toContain("不保存将丢弃");expect(t.host.querySelector("[data-editor-theme]")).not.toBeNull();
   await t.click(label);expect(await result).toEqual(expected);expect(save).toHaveBeenCalledTimes(label==="保存"?1:0);expect(t.dialogs.top()).toBeNull();
  }
 }finally{t.dispose();}
});
it("下载后第二次确认只有已保存/取消，拒绝确认停止关闭",async()=>{
 const t=setup();try{const save=vi.fn(async()=>({ok:true,downloadOnly:true}));let result!:ReturnType<typeof settleDocument>;
  act(()=>{result=settleDocument({...base,ui:{choose:reason=>t.prompt.ask({name:base.name,reason}),abandon:async reason=>(await t.prompt.ask({name:base.name,reason,acknowledge:true}))==="save"},save});});
  await t.click("保存");expect(save).toHaveBeenCalledOnce();expect(t.host.textContent).toContain("无法确认文件是否已保存");expect([...t.host.querySelectorAll("button")].some(button=>button.textContent==="不保存")).toBe(false);
  await t.click("取消");expect(await result).toEqual({ok:false,reason:"已取消"});
 }finally{t.dispose();}
});
it("宿主Escape/外部关闭、dispose与打开拒绝都按取消完成，注销后不能重放",async()=>{
 const t=setup();try{let first!:ReturnType<typeof t.prompt.ask>;act(()=>{first=t.prompt.ask({name:"a",reason:"dirty"});});act(()=>{t.dialogs.requestClose();});expect(await first).toBe("cancel");expect(t.dialogs.resolveRenderer("image-editor.document-settlement")).toBeNull();
  let second!:ReturnType<typeof t.prompt.ask>;act(()=>{second=t.prompt.ask({name:"b",reason:"dirty"});});act(()=>t.prompt.dispose());expect(await second).toBe("cancel");expect(await t.prompt.ask({name:"c",reason:"dirty"})).toBe("cancel");
 }finally{t.dispose();}
 const dialogs=new DialogService();const stop=dialogs.registerOpenParticipant(()=>false),error=vi.fn(),prompt=createDocumentSettlementPrompt(dialogs,error);expect(await prompt.ask({name:"a",reason:"dirty"})).toBe("cancel");expect(error).toHaveBeenCalledOnce();expect(dialogs.resolveRenderer("image-editor.document-settlement")).toBeNull();stop();prompt.dispose();
});
it("选择期间资源代际变化不保存/不关闭，半笔和未知回执在询问前拒绝",async()=>{
 const choose=vi.fn(async()=>"discard" as const),save=vi.fn(async()=>({ok:true}));let valid=true;
 expect(await settleDocument({...base,isCurrent:()=>valid,ui:{choose:async()=>{valid=false;return "save";},abandon:async()=>true},save})).toMatchObject({ok:false,reason:"文档已变化，请重新关闭"});expect(save).not.toHaveBeenCalled();
 for(const patch of [{pendingDraft:"请结束笔迹"},{receiptUnknown:true}])expect(await settleDocument({...base,...patch,ui:{choose,abandon:async()=>true},save})).toMatchObject({ok:false});expect(choose).not.toHaveBeenCalled();
});
