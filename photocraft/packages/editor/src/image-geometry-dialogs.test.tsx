/** @vitest-environment jsdom */
import {act,useSyncExternalStore} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import type {EditorDialogInstance,EditorDialogPort,EditorDialogRegistration} from "./ports.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {useImageGeometryDialogs} from "./image-geometry-dialogs.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{localStorage.clear();act(()=>root?.unmount());document.body.replaceChildren();vi.unstubAllGlobals();});
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

function setup() {
 const {port,Host}=dialogPort();let revision=1,blocked=false;
 const dispatch=vi.fn((..._args:unknown[])=>({ok:true} as {ok:boolean;message?:string})),error=vi.fn();
 const controller={dialogOwner:()=>({canvasId:"c",sessionId:"s"}),snapshot:()=>({view:{document:{width:12,height:8,revision}},commands:new Map(["image.canvasSize","image.rotation.arbitrary","image.imageSize","file.automate.fitImage","image.trim"].map(id=>[id,{allowed:true,enabled:true}]))}),dispatch,beginImageRotation:vi.fn(()=>({ok:true,value:{width:12,height:8}})),previewImageRotation:(params:unknown)=>{dispatch("preview-rotation",params);return {ok:true,value:{width:12,height:8}};},commitImageRotation:()=>{dispatch("commit-rotation");return {ok:true};},cancelImageRotation:vi.fn(),render:()=>({ok:false,message:"测试不运行合成"})} as unknown as EditorWorkspaceController;
 let actions:ReturnType<typeof useImageGeometryDialogs>;
 function Probe(){actions=useImageGeometryDialogs(port,controller,blocked,vi.fn(),error,{foreground:"#112233",background:"#ffffff"});return <Host/>;}
 const node=document.createElement("div");document.body.append(node);root=createRoot(node);const render=()=>act(()=>root.render(<Probe/>));render();
 return {node,dispatch,error,port,controller,open:(action:"canvas"|"rotate"|"size"|"fit"|"trim")=>act(()=>actions!.open(action)),changeRevision:()=>{revision++;},block:()=>{blocked=true;render();}};
}
function input(node:HTMLElement,index:number,value:string){const field=node.querySelectorAll<HTMLInputElement>('input[data-numeric-input]')[index]!;act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));});}
function submit(node:HTMLElement){act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));}
it("画布相对尺寸、锚点和宿主颜色在确认一次派发，取消不写",()=>{
 const {node,dispatch,open}=setup();open("canvas");act(()=>node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());input(node,0,"8");input(node,1,"-2");
 const anchor=node.querySelectorAll("select")[0]!;act(()=>{anchor.value="bottomRight";anchor.dispatchEvent(new Event("change",{bubbles:true}));});submit(node);
 expect(dispatch.mock.calls).toEqual([["image.canvasSize",{width:8,height:-2,relative:true,anchor:"bottomRight",extensionColor:"#ffffff"}]]);
 open("canvas");act(()=>[...node.querySelectorAll("button")].find(b=>b.textContent==="取消")!.click());expect(dispatch).toHaveBeenCalledTimes(1);
});
it("非法和超限尺寸不派发，失败保留窗口，文档修订变化拒绝旧请求",()=>{
 const {node,dispatch,open,changeRevision}=setup();open("canvas");
 for(const value of ["","0","8193","1.5"]){input(node,0,value);submit(node);expect(dispatch).not.toHaveBeenCalled();}
 input(node,0,"16");dispatch.mockReturnValueOnce({ok:false,message:"资源预算不足"});submit(node);expect(node.textContent).toContain("资源预算不足");expect(node.querySelector("form")).not.toBeNull();
 changeRevision();submit(node);expect(dispatch).toHaveBeenCalledTimes(1);expect(node.textContent).toContain("文档已变化");
});
it("任意角度旋转参数和忙碌关闭均经过同一模态门禁",()=>{
 const {node,dispatch,open,block}=setup();open("rotate");input(node,0,"22.5");const direction=node.querySelector("select")!;act(()=>{direction.value="ccw";direction.dispatchEvent(new Event("change",{bubbles:true}));});submit(node);
 expect(dispatch.mock.calls).toEqual([["preview-rotation",{angle:22.5,direction:"ccw",interpolation:"bicubic",backgroundColor:"#ffffff"}],["commit-rotation"]]);
 open("rotate");block();expect(node.querySelector("form")).toBeNull();expect(dispatch).toHaveBeenCalledTimes(2);
});

it("图像大小约束比例与仅分辨率保存不误改像素尺寸",()=>{
 const {node,dispatch,open}=setup();open("size");input(node,0,"24");expect(node.querySelectorAll<HTMLInputElement>('input[data-numeric-input]')[1]!.value).toBe("16");submit(node);
 expect(dispatch.mock.lastCall).toEqual(["image.imageSize",{width:24,height:16,resolution:72,resample:"bicubic"}]);
 open("size");const resample=node.querySelectorAll("select")[1]!;act(()=>{resample.value="none";resample.dispatchEvent(new Event("change",{bubbles:true}));});input(node,2,"300.1");submit(node);
 expect(dispatch.mock.lastCall).toEqual(["image.imageSize",{resolution:300.1,resample:"none"}]);
 open("size");const unit=node.querySelectorAll("select")[0]!;act(()=>{unit.value="percent";unit.dispatchEvent(new Event("change",{bubbles:true}));});input(node,0,"50");submit(node);
 expect(dispatch.mock.lastCall).toEqual(["image.imageSize",{percent:50,resolution:72,resample:"bicubic"}]);
});

it("旋转预览按帧只执行最新参数，外部关闭取消候选且迟到帧不再运行",()=>{
 let sequence=0;const frames=new Map<number,FrameRequestCallback>();vi.stubGlobal("requestAnimationFrame",(callback:FrameRequestCallback)=>{frames.set(++sequence,callback);return sequence;});vi.stubGlobal("cancelAnimationFrame",(id:number)=>frames.delete(id));
 const {node,dispatch,open,port,controller}=setup();open("rotate");input(node,0,"12");input(node,0,"45");expect(dispatch).not.toHaveBeenCalled();
 act(()=>{for(const [id,callback] of frames){frames.delete(id);callback(0);}});expect(dispatch.mock.calls).toEqual([["preview-rotation",{angle:45,direction:"cw",interpolation:"bicubic",backgroundColor:"#ffffff"}]]);expect(node.textContent).toContain("测试不运行合成");
 input(node,0,"60");act(()=>port.close());expect(controller.cancelImageRotation).toHaveBeenCalledOnce();expect(frames.size).toBe(0);expect(dispatch).toHaveBeenCalledTimes(1);
});

it("适合图像独立最大宽高、禁止放大与取消/失效保护",()=>{
 const {node,dispatch,open,changeRevision}=setup();open("fit");input(node,0,"30");input(node,1,"12");
 expect(node.textContent).toContain("18 × 12 px");
 act(()=>node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());expect(node.textContent).toContain("12 × 8 px");
 submit(node);expect(dispatch.mock.lastCall).toEqual(["file.automate.fitImage",{width:30,height:12,dontEnlarge:true,resample:"bicubic"}]);
 open("fit");for(const invalid of ["","0","1.5","8193"]){input(node,0,invalid);submit(node);expect(dispatch).toHaveBeenCalledTimes(1);}
 input(node,0,"6");input(node,1,"6");expect(node.textContent).toContain("6 × 4 px");changeRevision();submit(node);expect(dispatch).toHaveBeenCalledTimes(1);expect(node.textContent).toContain("文档已变化");
 act(()=>[...node.querySelectorAll("button")].find(b=>b.textContent==="取消")!.click());expect(dispatch).toHaveBeenCalledTimes(1);
});

it("修整按四边/颜色确认，成功记忆；失败与取消不覆盖记忆",()=>{
 const {node,dispatch,open}=setup();open("trim");const based=node.querySelector("select")!;act(()=>{based.value="topLeft";based.dispatchEvent(new Event("change",{bubbles:true}));});act(()=>node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[2]!.click());submit(node);
 expect(dispatch.mock.lastCall).toEqual(["image.trim",{basedOn:"topLeft",top:true,bottom:true,left:false,right:true}]);
 open("trim");expect(node.querySelector("select")!.value).toBe("topLeft");expect(node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[2]!.checked).toBe(false);
 act(()=>{const select=node.querySelector("select")!;select.value="bottomRight";select.dispatchEvent(new Event("change",{bubbles:true}));});dispatch.mockReturnValueOnce({ok:false,message:"没有可修整内容"});submit(node);expect(node.textContent).toContain("没有可修整内容");act(()=>[...node.querySelectorAll("button")].find(b=>b.textContent==="取消")!.click());
 open("trim");expect(node.querySelector("select")!.value).toBe("topLeft");
});
