/** @vitest-environment jsdom */
import {act,useSyncExternalStore} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import type {EditorDialogInstance,EditorDialogPort,EditorDialogRegistration} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {useLayerActionDialogs} from "./layer-action-dialogs.js";
import {useNewLayerDialog} from "./new-layer-dialog.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.replaceChildren();localStorage.clear();});
function dialogPort() {
  const registrations=new Map<string,EditorDialogRegistration>(),listeners=new Set<()=>void>();let top:EditorDialogInstance|null=null,count=0;
  const port:EditorDialogPort={subscribe:listener=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},isModalActive:()=>!!top,
    registerDialog:(id,value)=>{registrations.set(id,value);return ()=>{registrations.delete(id);};},
    open:({dialogId})=>{const definition=registrations.get(dialogId)?.definition;
      if(top || !definition || !definition.editingOwner?.()) return {ok:false,error:"无归属或已有弹窗"};
      top={dialogId,instanceId:String(++count)};listeners.forEach(listener=>listener());return {ok:true,instance:top};},
    top:()=>top,close:()=>{top=null;listeners.forEach(listener=>listener());}};
  function Host() {const instance=useSyncExternalStore(port.subscribe,port.top);return instance ? registrations.get(instance.dialogId)?.renderer({instance,requestClose:()=>port.close(),setBusy:()=>{},replace:()=>{}}):null;}
  return {port,Host};
}
it("页脚默认确认，取消不写；目标变化拒绝，Alt 绕过且跳过偏好只在成功确认后保存；锁定一次提交五项",()=>{
  const {port,Host}=dialogPort();let selected=[1,2],owner={canvasId:"c",documentId:"d",sessionId:"s"};
  const dispatch=vi.fn(()=>({ok:true}));const controller={dialogOwner:()=>owner,snapshot:()=>({view:{document:{layers:selected.map(id=>({id,selected:true,active:id===selected[0],hasMask:true}))}},commands:new Map(["layer.renameLayer","layer.layerStyle.scaleEffects","layer.matting.colorDecontaminate","layer.matting.defringe","layer.delete","layer.lockLayers","layer.layerMask.delete","layer.layerMask.apply"].map(id=>[id,{allowed:true,enabled:true}]))}),dispatch} as unknown as EditorWorkspaceController;
  const error=vi.fn(),refresh=vi.fn();let actions:ReturnType<typeof useLayerActionDialogs>;let blocked=false;
  function Probe() {actions=useLayerActionDialogs(port,controller,blocked,refresh,error);return <Host/>;}
  const node=document.createElement("div");document.body.append(node);root=createRoot(node);const render=()=>act(()=>root.render(<Probe/>));render();
  const submit=()=>act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  const cancel=()=>act(()=>[...node.querySelectorAll("button")].find(button=>button.textContent==="取消")!.click());
  expect(port.open({dialogId:"image-editor.layer-delete"}).ok).toBe(false);
  act(()=>actions!.delete());expect(node.textContent).toContain("2 个图层");cancel();expect(dispatch).not.toHaveBeenCalled();
  act(()=>actions!.delete());selected=[3];submit();expect(node.textContent).toContain("已更换");expect(dispatch).not.toHaveBeenCalled();cancel();
  act(()=>actions!.delete(true));expect(dispatch.mock.calls).toEqual([["layer.delete",null]]);expect(port.top()).toBeNull();dispatch.mockClear();
  act(()=>actions!.delete());act(()=>node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());submit();expect(dispatch.mock.calls).toEqual([["layer.delete",null]]);
  act(()=>actions!.delete());expect(dispatch).toHaveBeenCalledTimes(2);expect(port.top()).toBeNull();
  act(()=>actions!.locks());expect(node.textContent).toContain("锁定图层");submit();expect(dispatch.mock.lastCall).toEqual(["layer.lockLayers",{transparency:false,pixels:false,position:false,artboard:false,all:true}]);
  act(()=>actions!.locks());owner={...owner,sessionId:"new"};submit();expect(node.textContent).toContain("已更换");cancel();
  act(()=>actions!.mask(3));expect(node.textContent).toContain("移除图层蒙版");
  act(()=>[...node.querySelectorAll("button")].find(button=>button.textContent==="应用蒙版")!.click());expect(dispatch.mock.lastCall).toEqual(["layer.layerMask.apply",{layer:3}]);
  act(()=>actions!.mask(3));submit();expect(dispatch.mock.lastCall).toEqual(["layer.layerMask.delete",{layer:3}]);
  act(()=>actions!.defringe());submit();expect(dispatch.mock.lastCall).toEqual(["layer.matting.defringe",{width:1}]);
  act(()=>actions!.decontaminate());submit();expect(dispatch.mock.lastCall).toEqual(["layer.matting.colorDecontaminate",{amount:100,radius:4}]);
  act(()=>actions!.rename());const rename=node.querySelector<HTMLInputElement>('input[maxlength="200"]')!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(rename,"Updated layer");rename.dispatchEvent(new Event("input",{bubbles:true}));});submit();
  expect(dispatch.mock.lastCall).toEqual(["layer.renameLayer",{name:"Updated layer"}]);
  act(()=>actions!.scale());submit();expect(dispatch.mock.lastCall).toEqual(["layer.layerStyle.scaleEffects",{scale:100}]);
  act(()=>actions!.scale());selected=[4];const before=dispatch.mock.calls.length;submit();expect(dispatch).toHaveBeenCalledTimes(before);expect(node.textContent).toContain("已更换");cancel();
  blocked=true;render();act(()=>actions!.delete(true));expect(error.mock.lastCall).toEqual(["请先结束当前操作"]);
});
it("新建图层预填内核名称，模式/不透明度/剪贴和中性色只在确认创建一次；取消不创建",()=>{
  const {port,Host}=dialogPort(),dispatch=vi.fn(()=>({ok:true}));
  const controller={dialogOwner:()=>({canvasId:"c",sessionId:"s"}),snapshot:()=>({view:{document:{nextLayerName:"Layer 8"}},commands:new Map([["layer.new.layer",{allowed:true,enabled:true}]])}),dispatch} as unknown as EditorWorkspaceController;
  let open:()=>string|null;
  function Probe() {open=useNewLayerDialog(port,controller,false).open;return <Host/>;}
  const node=document.createElement("div");document.body.append(node);root=createRoot(node);act(()=>root.render(<Probe/>));act(()=>open());
  expect(node.querySelector<HTMLInputElement>('input[maxlength="200"]')!.value).toBe("Layer 8");
  const select=node.querySelectorAll("select")[1]!;act(()=>{select.value="Multiply";select.dispatchEvent(new Event("change",{bubbles:true}));});
  for(const checkbox of node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) act(()=>checkbox.click());
  act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  expect(dispatch.mock.calls).toEqual([["layer.new.layer",{name:"Layer 8",color:"none",mode:"Multiply",opacity:1,clipToPrevious:true,fillNeutral:true}]]);
  act(()=>open());act(()=>[...node.querySelectorAll("button")].find(button=>button.textContent==="取消")!.click());expect(dispatch).toHaveBeenCalledTimes(1);
});

it("查找图层复用宿主弹窗，无图层选择也可打开，取消和过期 owner 不派发",()=>{
  const {port,Host}=dialogPort(),dispatch=vi.fn(()=>({ok:true}));let sessionId="s";
  const controller={dialogOwner:()=>({canvasId:"c",documentId:"d",sessionId}),snapshot:()=>({view:{document:{layers:[]}},commands:new Map([["select.findLayers",{allowed:true,enabled:true}]])}),dispatch} as unknown as EditorWorkspaceController;
  let actions:ReturnType<typeof useLayerActionDialogs>;function Probe() {actions=useLayerActionDialogs(port,controller,false,vi.fn(),vi.fn());return <Host/>;}
  const node=document.createElement("div");document.body.append(node);root=createRoot(node);act(()=>root.render(<Probe/>));act(()=>actions!.find());
  const input=node.querySelector<HTMLInputElement>('input[maxlength="200"]')!;act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"Photo");input.dispatchEvent(new Event("input",{bubbles:true}));});
  act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));expect(dispatch.mock.calls).toEqual([["select.findLayers",{name:"Photo"}]]);
  act(()=>actions!.find());sessionId="other";act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));expect(node.textContent).toContain("已更换");expect(dispatch).toHaveBeenCalledTimes(1);
});
