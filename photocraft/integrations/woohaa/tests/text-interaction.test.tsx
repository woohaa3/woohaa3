import { PHOTOCRAFT_ENGINE_VERSION } from "@woohaa3/contracts";
/** @vitest-environment jsdom */
// 真实 React → Controller → WASM 接口替身；不排版、绘制或比较图像。
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

it("T 定位、按帧文字和样式、取消与确认均沿原节点预览，确认前不改正式修订",async()=>{
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(514);
  let frame:FrameRequestCallback|null=null;
  vi.stubGlobal("requestAnimationFrame",vi.fn((callback:FrameRequestCallback)=>{frame=callback;return 1;}));
  vi.stubGlobal("cancelAnimationFrame",vi.fn(()=>{frame=null;}));
  let revision=1, draft:Record<string,unknown>|null=null;
  const info=()=>JSON.stringify({layer:draft?.text===undefined?null:2,new:true,text:draft?.text??""});
  const begin=vi.fn((params:string)=>{draft=JSON.parse(params);return info();});
  const preview=vi.fn((params:string)=>{draft={...draft,...JSON.parse(params)};return info();});
  const commit=vi.fn(()=>{revision++;draft=null;return "null";});
  const cancel=vi.fn(()=>{draft=null;});
  const stateJson=()=>JSON.stringify({document:{width:1600,height:900,revision,activeLayer:1,canUndo:revision>1,history:revision>1?["编辑文字"]:[],layers:[{id:1,name:"原图",kind:"raster",visible:true,opacity:1,blend:"Normal"}]}});
  const geometry=vi.fn((params:string)=>{const range=JSON.parse(params);return JSON.stringify({caret:[[136,100],[136,136]],selection:range.start!==range.end?[[[136,100],[156,100],[156,136],[136,136]]]:[],hit:null});});
  const instance={openImage:stateJson,stateJson,commandsJson:()=>"[]",contentHash:()=>revision.toString(16).padStart(16,"0"),
    beginText:begin,previewText:preview,commitText:commit,cancelText:cancel,textGeometry:geometry,
    renderPreview:()=>({width:1,height:1,pixels:new Uint8Array([draft?99:revision,0,0,255])}),closeDocument:()=>"null"} as unknown as EditorInstance;
  const handle=new EditorHandle(instance,{upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1});
  const session=new ProjectSession({nodeId:"image-1",baseAssetId:"asset-1",baseStorageKey:"image.png",sourceWidth:1600,sourceHeight:900,edit:null});
  controller=new EditorWorkspaceController({session,sessionId:"session-1",baselineDocument:null,load:async()=>({ok:true,value:handle}),
    saveDeps:{uploadProject:async()=>null,uploadOutput:async()=>null,complete:async()=>({ok:false,code:"unused",error:"unused"}),assetIdFor:()=>"unused"}});
  expect((await controller.openImage({name:"image",assetId:"asset-1",bytes:new Uint8Array()})).ok).toBe(true);
  session.establishBaseline();
  const container=document.createElement("div");document.body.append(container);root=createRoot(container);
  const onPreview=vi.fn();
  act(()=>root.render(<PhotoEditorApp controller={controller} canvasView={{viewport:{x:0,y:0,zoom:0.5},fitZoom:0.5,transitioning:false,onChange:vi.fn()}} onPreview={onPreview}/>));
  act(()=>container.querySelector<HTMLButtonElement>('.photo-editor__toolrail [data-tool-slot="16"]')!.click());
  const stage=container.querySelector<HTMLElement>(".photo-editor-canvas")!;
  stage.setPointerCapture=vi.fn();stage.hasPointerCapture=()=>true;stage.releasePointerCapture=vi.fn();
  const send=(type:string)=>{const event=new MouseEvent(type,{button:0,clientX:100,clientY:100,bubbles:true});Object.defineProperty(event,"pointerId",{value:1});act(()=>stage.dispatchEvent(event));};
  const tick=()=>act(()=>{const callback=frame;frame=null;callback?.(0);});
  const type=(text:string)=>{const input=container.querySelector<HTMLTextAreaElement>("[data-text-input]")!;act(()=>{
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,text);
    input.setSelectionRange(text.length,text.length);input.dispatchEvent(new Event("input",{bubbles:true}));
  });return input;};
  send("pointerdown");send("pointerup");
  expect(JSON.parse(begin.mock.calls[0][0])).toEqual({x:136,y:136});
  expect(controller.hasText()).toBe(true);
  const before=controller.snapshot();
  tick();type("第一版");type("最后输入");tick();
  expect(JSON.parse(preview.mock.calls.at(-1)![0])).toMatchObject({text:"最后输入",font:"Noto Sans SC",size:48});
  expect(controller.snapshot()).toBe(before);expect(controller.isDirty()).toBe(false);
  expect(onPreview.mock.calls.at(-1)![0].pixels[0]).toBe(99);
  expect(geometry).toHaveBeenCalledWith(JSON.stringify({start:4,end:4}));
  const composingInput=container.querySelector<HTMLTextAreaElement>("[data-text-input]")!;
  act(()=>composingInput.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true})));
  type("最后输入候");tick();
  expect(geometry).toHaveBeenCalledWith(JSON.stringify({start:4,end:5}));
  const preedit=container.querySelector('[data-text-preedit="true"]');expect(preedit).not.toBeNull();
  expect(preedit?.getAttribute("x1")).toBe("100");expect(preedit?.getAttribute("x2")).toBe("110");expect(preedit?.getAttribute("y1")).toBe("100");
  type("最后输入候选");tick();expect(geometry).toHaveBeenCalledWith(JSON.stringify({start:4,end:6}));
  act(()=>composingInput.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"候选"})));tick();
  expect(container.querySelector('[data-text-preedit="true"]')).toBeNull();expect(controller.snapshot()).toBe(before);
  type("取消内容");
  act(()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="取消文字")!.click());
  expect(cancel).toHaveBeenCalledOnce();expect(commit).not.toHaveBeenCalled();
  expect(controller.snapshot()).toBe(before);expect(onPreview.mock.calls.at(-1)![0].pixels[0]).toBe(1);
  send("pointerdown");send("pointerup");const finalInput=type("确认文字");
  act(()=>finalInput.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true,cancelable:true})));
  expect(JSON.parse(preview.mock.calls.at(-1)![0])).toMatchObject({text:"确认文字"});
  expect(commit).toHaveBeenCalledOnce();expect(controller.hasText()).toBe(false);
  expect(controller.snapshot().view.document?.revision).toBe(2);expect(controller.isDirty()).toBe(true);
  expect(onPreview.mock.calls.at(-1)![0].pixels[0]).toBe(2);
});
