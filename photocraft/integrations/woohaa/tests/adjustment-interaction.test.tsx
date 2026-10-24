import { PHOTOCRAFT_ENGINE_VERSION } from "@woohaa3/contracts";
/** @vitest-environment jsdom */
// 真实 React → Controller → EditorHandle → WASM 接口替身；只检查事件、领域状态和预览端口。
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {PhotoEditorApp} from "@woohaa3/photocraft-editor";
import {EditorHandle,type EditorInstance} from "@woohaa3/photocraft-editor";
import {EditorWorkspaceController} from "../src/editor-workspace.js";
import {ProjectSession} from "../src/project-session.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,controller:EditorWorkspaceController;
afterEach(()=>{act(()=>root?.unmount());controller?.dispose();document.body.innerHTML="";vi.restoreAllMocks();vi.unstubAllGlobals();});
async function setup(kind="brightnessContrast") {
  const frames=new Map<number,FrameRequestCallback>();let frameId=0;
  vi.stubGlobal("requestAnimationFrame",(callback:FrameRequestCallback)=>{frames.set(++frameId,callback);return frameId;});
  vi.stubGlobal("cancelAnimationFrame",(id:number)=>frames.delete(id));
  let revision=1,layerId=1;
  let formal:Record<string,unknown>=kind==="curves"?{points:[[0,0],[128,128],[255,255]]}:{brightness:30,contrast:20};
  let draft:Record<string,unknown>|null=null;
  const info=()=>JSON.stringify({layer:layerId,kind,params:draft??formal});
  const begin=vi.fn(()=>{draft={...formal};return info();});
  const preview=vi.fn((params:string)=>{draft={...draft,...JSON.parse(params)};return info();});
  const commit=vi.fn(()=>{formal={...draft};draft=null;revision++;return "null";});
  const cancel=vi.fn(()=>{draft=null;});
  const stateJson=()=>JSON.stringify({document:{width:800,height:600,revision,activeLayer:layerId,canUndo:revision>1,history:revision>1?["修改调整层"]:[],
    layers:[{id:layerId,name:"调色",kind:"adjustment",visible:true,opacity:1,blend:"Normal",adjustment:{kind,params:formal}}]}});
  const adjustmentIds=["brightnessContrast","hueSaturation","curves"].map(kind=>`layer.newAdjustmentLayer.${kind}`);
  const execute=vi.fn((id:string,params:string)=>{
    if(adjustmentIds.includes(id)) {kind=id.split(".").at(-1)!;formal=JSON.parse(params);layerId++;revision++;}
    return "null";
  });
  const instance={openImage:stateJson,stateJson,commandsJson:()=>JSON.stringify(adjustmentIds.map(id=>({id,label:id,menu:["Layer"],params:"",shortcut:null,disabledReason:null,needsDocument:true,enabled:true,allowed:true}))),execute,contentHash:()=>revision.toString(16).padStart(16,"0"),
    beginAdjustment:begin,previewAdjustment:preview,commitAdjustment:commit,cancelAdjustment:cancel,
    curveGeometry:()=>JSON.stringify(Array.from({length:256},(_,i)=>i)),
    renderPreview:()=>({width:1,height:1,pixels:new Uint8Array([draft?99:revision,0,0,255])}),closeDocument:()=>"null"} as unknown as EditorInstance;
  const handle=new EditorHandle(instance,{upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1});
  const session=new ProjectSession({nodeId:"image-1",baseAssetId:"asset-1",baseStorageKey:"image.png",sourceWidth:800,sourceHeight:600,edit:null});
  controller=new EditorWorkspaceController({session,sessionId:"session-1",baselineDocument:null,load:async()=>({ok:true,value:handle}),
    saveDeps:{uploadProject:async()=>null,uploadOutput:async()=>null,complete:async()=>({ok:false,code:"unused",error:"unused"}),assetIdFor:()=>"unused"}});
  await controller.openImage({name:"image",assetId:"asset-1",bytes:new Uint8Array()});session.establishBaseline();
  const container=document.createElement("div");document.body.append(container);root=createRoot(container);
  const onPreview=vi.fn();
  const render=(readonly=false)=>act(()=>root.render(<PhotoEditorApp controller={controller} readonly={readonly} canvasView={{viewport:{x:0,y:0,zoom:0.5},fitZoom:0.5,transitioning:false,onChange:vi.fn()}} onPreview={onPreview}/>));
  render();
  const tick=()=>act(()=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback(0));});
  const key=(node:Element,key:string,ctrlKey=false)=>act(()=>node.dispatchEvent(new KeyboardEvent("keydown",{key,ctrlKey,bubbles:true,cancelable:true})));
  const input=(node:HTMLInputElement,value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(node,value);node.dispatchEvent(new Event("input",{bubbles:true}));});
  const pointer=(node:Element,type:string,x=0,y=0)=>{const event=new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y});Object.defineProperty(event,"pointerId",{value:1});act(()=>node.dispatchEvent(event));};
  return {container,begin,preview,commit,cancel,onPreview,tick,key,input,pointer,render,execute};
}
it("滑杆在松手前发出临时预览，取消恢复正式预览，下一次拖动只提交一步",async()=>{
  const {container,preview,commit,cancel,onPreview,tick,key,input,pointer}=await setup();
  const slider=container.querySelector<HTMLInputElement>('[data-adjustment-control] input')!;
  const before=controller.snapshot();pointer(slider,"pointerdown");input(slider,"40");input(slider,"50");tick();
  expect(JSON.parse(preview.mock.calls.at(-1)![0])).toEqual({brightness:50});
  expect(onPreview.mock.calls.at(-1)![0].pixels[0]).toBe(99);
  expect(controller.snapshot()).toBe(before);expect(controller.isDirty()).toBe(false);
  key(slider,"s",true);expect(container.textContent).toContain("请先确认或取消调整参数编辑");
  key(slider,"Escape");expect(cancel).toHaveBeenCalledOnce();expect(slider.value).toBe("30");
  pointer(slider,"pointerup");expect(commit).not.toHaveBeenCalled();expect(onPreview.mock.calls.at(-1)![0].pixels[0]).toBe(1);
  pointer(slider,"pointerdown");input(slider,"60");pointer(slider,"pointerup");
  expect(commit).toHaveBeenCalledOnce();expect(controller.snapshot().view.document?.revision).toBe(2);
  expect(controller.isDirty()).toBe(true);expect(controller.hasAdjustment()).toBe(false);
});
it("曲线直接在属性面板里拖点和数字焦点切换不被误判为离开编辑器，失焦与只读取消活动草稿",async()=>{
  // 回归（A4）：曲线编辑器曾经收在「RGB 曲线」按钮的 Popover 后面，属性面板只显示一行按钮，
  // 选中曲线调整层看不到曲线也拖不动。现在曲线**直接铺在面板里**（inline）。
  const {container,preview,commit,cancel,key,input,pointer,tick,render}=await setup("curves");
  const properties=container.querySelector('.photo-editor__object-properties [aria-label="调整层"]')!;
  const graph=properties.querySelector<SVGSVGElement>("[data-curve-graph]")!;
  expect(graph).not.toBeNull();
  expect(graph).not.toBeNull();graph.getBoundingClientRect=()=>({left:0,top:0,width:255,height:255} as DOMRect);
  pointer(graph,"pointerdown",128,127);pointer(graph,"pointermove",100,75);tick();
  expect(controller.hasAdjustment()).toBe(true);expect(JSON.parse(preview.mock.calls.at(-1)![0]).points[1]).toEqual([100,180]);
  key(graph,"Escape");pointer(graph,"pointermove",90,60);pointer(graph,"pointerup",90,60);
  expect(cancel).toHaveBeenCalledOnce();expect(commit).not.toHaveBeenCalled();
  const inputs=document.querySelectorAll<HTMLInputElement>(".photo-editor-curve input");
  act(()=>inputs[2]!.focus());input(inputs[2]!,"110");tick();
  expect(controller.hasAdjustment()).toBe(true);
  act(()=>inputs[3]!.focus());expect(commit).toHaveBeenCalledOnce();
  input(inputs[3]!,"160");tick();expect(controller.hasAdjustment()).toBe(true);
  act(()=>window.dispatchEvent(new Event("blur")));expect(controller.hasAdjustment()).toBe(false);
  expect(cancel).toHaveBeenCalledTimes(2);
  input(inputs[3]!,"170");tick();expect(controller.hasAdjustment()).toBe(true);
  render(true);expect(controller.hasAdjustment()).toBe(false);expect(cancel).toHaveBeenCalledTimes(3);
});
it("提交失败保留调整输入和草稿，显式重试只推进一次正式修订",async()=>{
  const {container,commit,input,pointer}=await setup();
  const slider=container.querySelector<HTMLInputElement>('[data-adjustment-control] input')!;
  commit.mockImplementationOnce(()=>{throw JSON.stringify({code:"command-failed",message:"提交失败，请重试"});});
  pointer(slider,"pointerdown");input(slider,"70");pointer(slider,"pointerup");
  expect(controller.hasAdjustment()).toBe(true);expect(controller.snapshot().view.document?.revision).toBe(1);
  expect(slider.value).toBe("70");expect(container.textContent).toContain("提交失败，请重试");
  act(()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="确认调整")!.click());
  expect(controller.hasAdjustment()).toBe(false);expect(controller.snapshot().view.document?.revision).toBe(2);
  expect(commit).toHaveBeenCalledTimes(2);
});

it.each([
  ["亮度/对比度","brightnessContrast",{brightness:0,contrast:0},["亮度","对比度"]],
  ["色相/饱和度","hueSaturation",{hue:0,saturation:0,lightness:0},["色相","饱和度","明度"]],
  ["曲线","curves",{points:[[0,0],[255,255]]},[]]
] as const)("从图层面板创建%s，保留工具并显示新图层对应属性",async(label,kind,params,fields)=>{
  const {container,key,execute,render}=await setup();
  const editor=container.querySelector(".photo-editor")!;
  key(editor,"b");
  act(()=>container.querySelector<HTMLButtonElement>('[title="折叠属性"]')!.click());
  const trigger=container.querySelector<HTMLButtonElement>('.photo-editor__layer-actions [aria-label="新建调整层"]')!;
  key(trigger,"Enter");
  const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent===label)!;
  expect(item).toBeDefined();act(()=>item.click());
  expect(execute).toHaveBeenLastCalledWith(`layer.newAdjustmentLayer.${kind}`,JSON.stringify(params));
  expect(controller.currentView().document?.activeLayerId).toBe(2);
  expect(controller.isDirty()).toBe(true);
  expect(container.querySelector<HTMLElement>(".photo-editor-canvas")!.dataset.tool).toBe("brush");
  const properties=container.querySelector('.photo-editor__object-properties [aria-label="调整层"]')!;
  expect(properties.hasAttribute("hidden")).toBe(false);
  expect([...properties.querySelectorAll("[data-adjustment-control]")].map(node=>node.firstChild?.textContent)).toEqual(fields);
  // 曲线调整层必须**直接**带可拖的曲线图，而不是只有一行按钮（A4）。
  expect(properties.querySelector("[data-curve-graph]") !== null).toBe(kind==="curves");
  expect(container.querySelector('.photo-editor__toolrail [aria-label="调整层"]')).toBeNull();
  render(true);expect(trigger.disabled).toBe(true);
});

it("从图层菜单创建调整层，离开文字属性后仍保留文字工具",async()=>{
  const {container,key,execute}=await setup();
  const editor=container.querySelector(".photo-editor")!;
  key(editor,"t");key(editor,"Tab");
  expect(container.querySelector<HTMLElement>(".photo-editor__sidebar")!.hidden).toBe(true);
  const trigger=[...container.querySelectorAll<HTMLButtonElement>(".photo-editor__menubar button")].find(button=>button.textContent==="图层")!;
  key(trigger,"Enter");
  const submenu=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent?.includes("新建调整图层"))!;
  key(submenu,"ArrowRight");
  const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="色相/饱和度")!;
  act(()=>item.click());
  expect(execute).toHaveBeenLastCalledWith("layer.newAdjustmentLayer.hueSaturation",JSON.stringify({hue:0,saturation:0,lightness:0}));
  expect(container.querySelector<HTMLElement>(".photo-editor-canvas")!.dataset.tool).toBe("text");
  expect(container.querySelector<HTMLElement>(".photo-editor__sidebar")!.hidden).toBe(false);
  expect(container.querySelector('.photo-editor__object-properties [aria-label="调整层"]')!.hasAttribute("hidden")).toBe(false);
});
