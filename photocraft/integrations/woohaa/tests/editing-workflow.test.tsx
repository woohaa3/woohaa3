import { PHOTOCRAFT_ENGINE_VERSION } from "@woohaa3/contracts";
/** @vitest-environment jsdom */
// 同一真实界面/控制器的连续事件链。内核、纹理和上传为接口替身，不执行图像合成或文字布局。
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {IMAGE_PROJECT_CONTENT_TYPE,type StoredAsset} from "@woohaa3/contracts";
import {PhotoEditorApp} from "@woohaa3/photocraft-editor";
import {EditorHandle,type EditorInstance} from "@woohaa3/photocraft-editor";
import {EditorWorkspaceController} from "../src/editor-workspace.js";
import {ProjectSession} from "../src/project-session.js";
import type {ProjectSaveDeps,ProjectSaveOutcome} from "../src/project-save.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root|undefined,controller:EditorWorkspaceController|undefined;
afterEach(()=>{act(()=>root?.unmount());controller?.dispose();document.body.replaceChildren();vi.restoreAllMocks();vi.unstubAllGlobals();});

it.each([false,true])("同一工作区连续编辑后成对保存（工程上传首次失败=%s）",async(failFirst)=>{
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(514);
  let frameId=0;const frames=new Map<number,FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame",(callback:FrameRequestCallback)=>{frames.set(++frameId,callback);return frameId;});
  vi.stubGlobal("cancelAnimationFrame",(id:number)=>frames.delete(id));
  const tick=()=>act(()=>{const batch=[...frames];for(const [id,callback] of batch){if(frames.delete(id))callback(0);}});
  let revision=1,activeLayer=1,mask=false,selection=false,target="pixels",draft:string|null=null,step=0;
  const history:string[]=[];const redo:string[]=[];
  const hash=()=>step.toString(16).padStart(16,"0");
  const write=(label:string)=>{history.push(label);redo.length=0;step++;revision++;draft=null;return "null";};
  const commands=["layer.select","view.layerMask","channel.target.composite","channel.target.layerMask","select.rect","select.deselect",
    "layer.layerMask.revealAll","layer.layerMask.revealSelection","layer.newAdjustmentLayer.brightnessContrast"];
  const stateJson=()=>JSON.stringify({document:{width:1600,height:900,revision,activeLayer,selectedLayers:[activeLayer],
    hasSelection:selection,selectionFrame:selection?[100,100,300,300]:null,
    selectionOutline:selection?[[100,100,300,100],[300,100,300,300],[300,300,100,300],[100,300,100,100]]:[],
    transformFrame:[100,100,300,300],editTarget:target,canUndo:history.length>0,canRedo:redo.length>0,history:["打开",...history],redoHistory:redo,
    layers:[{id:3,name:"调色",kind:"adjustment",adjustment:{kind:"brightnessContrast",params:{brightness:0,contrast:0}}},
      {id:2,name:"素材",kind:"raster",hasMask:mask,maskEnabled:true,maskLinked:true},{id:1,name:"原图",kind:"raster"}]
  }});
  const execute=vi.fn((id:string,json:string)=>{
    const params=JSON.parse(json);
    if(id==="layer.select")activeLayer=params.layer;
    else if(id==="channel.target.layerMask")target="mask";
    else if(id==="channel.target.composite")target="pixels";
    else if(id==="select.rect")selection=true;
    else if(id==="select.deselect")selection=false;
    else if(id==="layer.layerMask.revealSelection"){mask=true;target="mask";return write("蒙版");}
    else if(id==="edit.undo"){redo.push(history.pop()!);step--;revision++;}
    else if(id==="edit.redo"){history.push(redo.pop()!);step++;revision++;}
    return "null";
  });
  const stroke=vi.fn((params:string)=>{draft="stroke";expect(JSON.parse(params)).toMatchObject({target:"mask",erase:false});});
  const textInfo=()=>JSON.stringify({layer:4,new:true,text:"连续编辑"});
  const adjustmentInfo=()=>JSON.stringify({layer:3,kind:"brightnessContrast",params:{brightness:0,contrast:0}});
  const exportBundle=vi.fn(()=>({revision,documentContentHash:hash(),canvasWidth:1600,canvasHeight:900,
    project:new Uint8Array([80,step]),output:new Uint8Array([79,step])}));
  const instance={openImage:stateJson,stateJson,contentHash:hash,commandsJson:()=>JSON.stringify(commands.map(id=>({id,label:id,menu:["Layer"],params:"",shortcut:null,disabledReason:null,needsDocument:true,enabled:true,allowed:true}))),execute,
    beginStroke:stroke,appendStroke:()=>{},commitStroke:()=>write("画笔"),cancelStroke:()=>{draft=null;},
    beginTransform:()=>{draft="transform";},previewTransform:()=>{},commitTransform:()=>write("变换"),cancelTransform:()=>{draft=null;},
    beginText:()=>{draft="text";return textInfo();},previewText:textInfo,commitText:()=>write("文字"),cancelText:()=>{draft=null;},
    textGeometry:()=>JSON.stringify({caret:[[136,100],[136,136]],selection:[],hit:null}),
    beginAdjustment:()=>{draft="adjustment";return adjustmentInfo();},previewAdjustment:adjustmentInfo,commitAdjustment:()=>write("调整"),cancelAdjustment:()=>{draft=null;},
    renderPreview:()=>({width:1,height:1,pixels:new Uint8Array([draft?99:step,0,0,255])}),
    exportBundle,assetIdsJson:()=>JSON.stringify({baseAssetId:"asset-base",placed:[]}),closeDocument:()=>"null"
  } as unknown as EditorInstance;
  const session=new ProjectSession({nodeId:"node-1",baseAssetId:"asset-base",baseStorageKey:"base.png",sourceWidth:1600,sourceHeight:900,edit:null});
  const handle=new EditorHandle(instance,{upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1});
  const digest=async(bytes:Uint8Array)=>(bytes[0]===80?"1":"2").repeat(64);
  const object={storageKey:"project.pcraft",checksum:"f".repeat(64),contentType:IMAGE_PROJECT_CONTENT_TYPE,size:2,url:"/media/project.pcraft"};
  const uploadProject=vi.fn<ProjectSaveDeps["uploadProject"]>(async()=>object),uploadOutput=vi.fn(async()=>({...object,storageKey:"out.png",contentType:"image/png"}));
  if(failFirst)uploadProject.mockRejectedValueOnce(new Error("上传失败（HTTP 404）"));
  const complete=vi.fn<ProjectSaveDeps["complete"]>(async()=>({ok:true,receipt:{requestId:"req-1",sessionId:"session-1",canvasId:"default",nodeId:"node-1",kind:"image",status:"completed",contentIdentity:hash(),entryId:"entry-1",revision:1,contentCommitted:true}}));
  controller=new EditorWorkspaceController({session,sessionId:"session-1",baselineDocument:null,load:async()=>({ok:true,value:handle}),digest,
    saveDeps:{uploadProject,uploadOutput,complete,digest,assetIdFor:checksum=>`asset-${checksum}`}});
  await controller.openImage({name:"image",assetId:"asset-base",bytes:new Uint8Array()});session.establishBaseline();
  const baseAsset:StoredAsset={id:"asset-base",title:"原图",mediaKind:"image",source:"uploaded",status:"ready",createdAt:"2026-10-17T00:00:00Z"};
  const saveInput={canvasId:"default",nodeId:"node-1",sessionId:"session-1",requestId:"req-1",baselineContentIdentity:"base.png",
    baseAsset,baseStorageKey:"base.png",baseChecksum:"a".repeat(64),baseContentType:"image/png",baseSize:1024};
  let saved:ProjectSaveOutcome|undefined;
  const onApply=vi.fn(async()=>{saved=await controller!.save(saveInput);});
  const onPreview=vi.fn();const container=document.createElement("div");document.body.append(container);root=createRoot(container);
  act(()=>root!.render(<PhotoEditorApp controller={controller!} onApply={onApply} onPreview={onPreview}
    canvasView={{viewport:{x:0,y:0,zoom:.5},fitZoom:.5,transitioning:false,onChange:vi.fn()}}/>));
  const editor=container.querySelector<HTMLElement>(".photo-editor")!,stage=container.querySelector<HTMLElement>(".photo-editor-canvas")!;
  const key=(key:string,ctrlKey=false,shiftKey=false,node:Element=editor)=>act(()=>node.dispatchEvent(new KeyboardEvent("keydown",{key,ctrlKey,shiftKey,bubbles:true,cancelable:true})));
  const choose=(name:string)=>act(()=>container.querySelector<HTMLButtonElement>(`.photo-editor__toolrail [aria-label="${name}"]`)!.click());
  const capture=(element:HTMLElement)=>{element.setPointerCapture=vi.fn();element.hasPointerCapture=()=>true;element.releasePointerCapture=vi.fn();};capture(stage);
  const pointer=(type:string,x=100,y=100,node:Element=stage)=>{const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true});Object.defineProperty(event,"pointerId",{value:1});act(()=>node.dispatchEvent(event));};
  const input=(node:HTMLInputElement|HTMLTextAreaElement,value:string)=>act(()=>{Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value")!.set!.call(node,value);node.dispatchEvent(new Event("input",{bubbles:true}));});
  act(()=>container.querySelector<HTMLButtonElement>('[data-layer-id="2"] .photo-editor__layer-name')!.click());
  pointer("pointerdown");pointer("pointerup",160,140);
  expect(controller.currentView().document?.activeLayerId).toBe(2);expect(controller.currentView().document?.hasSelection).toBe(true);expect(controller.isDirty()).toBe(false);
  act(()=>container.querySelector<HTMLButtonElement>('[aria-label="添加蒙版"]')!.click());
  expect(execute).toHaveBeenCalledWith("layer.layerMask.revealSelection",JSON.stringify({layer:2}));
  choose("画笔");pointer("pointerdown");pointer("pointermove",140,120);tick();
  expect(stroke).toHaveBeenCalledOnce();expect(onPreview.mock.lastCall?.[0].pixels[0]).toBe(99);
  const rejected=await controller.save(saveInput);expect(rejected.ok).toBe(false);expect(exportBundle).not.toHaveBeenCalled();
  pointer("pointerup",150,130);
  expect(controller.currentView().document?.history).toEqual(["打开","蒙版","画笔"]);
  key("t",true);
  const transform=container.querySelector<HTMLElement>(".photo-editor-transform")!;capture(transform);
  pointer("pointerdown",100,100,transform);pointer("pointermove",120,120,transform);pointer("pointerup",120,120,transform);tick();key("Enter");
  expect(controller.hasTransform()).toBe(false);expect(stage.dataset.tool).toBe("brush");
  choose("文字");pointer("pointerdown");pointer("pointerup");
  const text=container.querySelector<HTMLTextAreaElement>("[data-text-input]")!;input(text,"连续编辑");tick();
  key("s",true,false,text);expect(onApply).not.toHaveBeenCalled();expect(controller.hasText()).toBe(true);
  key("Enter",true,false,text);expect(controller.hasText()).toBe(false);
  act(()=>container.querySelector<HTMLButtonElement>('[data-layer-id="3"] .photo-editor__layer-name')!.click());
  const slider=container.querySelector<HTMLInputElement>("[data-adjustment-control] input")!;
  pointer("pointerdown",0,0,slider);input(slider,"40");tick();pointer("pointerup",0,0,slider);
  expect(controller.hasAdjustment()).toBe(false);
  expect(controller.currentView().document?.history).toEqual(["打开","蒙版","画笔","变换","文字","调整"]);
  key("z",true);expect(controller.currentView().document?.canRedo).toBe(true);
  key("z",true,true);expect(controller.currentView().document?.canRedo).toBe(false);
  await act(async()=>{key("s",true);await Promise.resolve();});
  if(failFirst) {
    expect(saved).toMatchObject({ok:false,code:"project-upload-failed",retriable:true});
    expect(container.textContent).toContain("工程对象上传失败：上传失败（HTTP 404）");
    expect(controller.isDirty()).toBe(true);expect(complete).not.toHaveBeenCalled();expect(uploadOutput).not.toHaveBeenCalled();
    expect(controller.currentView().document?.history).toEqual(["打开","蒙版","画笔","变换","文字","调整"]);
    await act(async()=>{key("s",true);await Promise.resolve();});
    expect(uploadProject.mock.calls[1][0]).toBe(uploadProject.mock.calls[0][0]);
  }
  expect(onApply).toHaveBeenCalledTimes(failFirst?2:1);expect(saved?.ok).toBe(true);expect(exportBundle).toHaveBeenCalledOnce();
  expect(uploadProject).toHaveBeenCalledTimes(failFirst?2:1);expect(uploadOutput).toHaveBeenCalledOnce();expect(complete).toHaveBeenCalledOnce();
  expect(controller.isDirty()).toBe(false);expect(controller.snapshot().state.phase).toBe("saved");
  key("s",true);expect(onApply).toHaveBeenCalledTimes(failFirst?2:1);
  expect(container.querySelector("canvas,img")).toBeNull();
});
