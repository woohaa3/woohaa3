import { PHOTOCRAFT_ENGINE_VERSION } from "@woohaa3/contracts";
/** @vitest-environment jsdom */
// 真实 React → Controller → EditorHandle → 接口替身；剪贴仅模拟领域字段，不合成图片。
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {PhotoEditorApp} from "@woohaa3/photocraft-editor";
import {EditorHandle,type EditorInstance} from "@woohaa3/photocraft-editor";
import {EditorWorkspaceController} from "../src/editor-workspace.js";
import {ProjectSession} from "../src/project-session.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("剪贴快捷键按当前状态创建或释放，面板、净变化和纹理随正式快照刷新",async()=>{
  let revision=1,clipped=false;
  const ids=["layer.createClippingMask","layer.releaseClippingMask","edit.undo","edit.redo"];
  const stateJson=()=>JSON.stringify({document:{width:800,height:600,revision,activeLayer:2,selectedLayers:[1,2],canUndo:clipped,canRedo:!clipped,
    history:clipped?["打开","创建剪贴蒙版"]:["打开"],layers:[1,2].map(id=>({id,name:`图层${id}`,kind:"raster",visible:true,opacity:1,blend:"Normal",clipped:id===2&&clipped}))}});
  const execute=vi.fn((id:string,_params:string)=>{clipped=id==="layer.createClippingMask"||id==="edit.redo";revision++;return "null";});
  const instance={openImage:stateJson,stateJson,contentHash:()=>(clipped?2:1).toString(16).padStart(16,"0"),execute,
    commandsJson:()=>JSON.stringify(ids.map(id=>({id,label:id,menu:["Layer"],shortcut:null,params:"{}",allowed:true,
      enabled:id==="layer.createClippingMask"?!clipped:id==="layer.releaseClippingMask"?clipped:true,needsDocument:true,disabledReason:null}))),
    renderPreview:()=>({width:1,height:1,pixels:new Uint8Array([clipped?2:1,0,0,255])}),closeDocument:()=>"null"} as unknown as EditorInstance;
  const handle=new EditorHandle(instance,{upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1});
  const session=new ProjectSession({nodeId:"image-1",baseAssetId:"asset-1",baseStorageKey:"image.png",sourceWidth:800,sourceHeight:600,edit:null});
  const controller=new EditorWorkspaceController({session,sessionId:"session-1",baselineDocument:null,load:async()=>({ok:true,value:handle}),
    saveDeps:{uploadProject:async()=>null,uploadOutput:async()=>null,complete:async()=>({ok:false,code:"unused",error:"unused"}),assetIdFor:()=>"unused"}});
  await controller.openImage({name:"image",assetId:"asset-1",bytes:new Uint8Array()});session.establishBaseline();
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);const onPreview=vi.fn();
  const render=(readonly=false)=>act(()=>root.render(<PhotoEditorApp controller={controller} readonly={readonly} canvasView={{viewport:{x:0,y:0,zoom:0.5},fitZoom:0.5,transitioning:false,onChange:vi.fn()}} onPreview={onPreview}/>));
  const chord=(target:Element)=>act(()=>target.dispatchEvent(new KeyboardEvent("keydown",{key:"g",code:"KeyG",ctrlKey:true,altKey:true,bubbles:true,cancelable:true})));
  try {
    render();const editor=container.querySelector(".photo-editor")!;
    chord(editor);expect(execute.mock.lastCall).toEqual(["layer.createClippingMask","null"]);
    expect(controller.isDirty()).toBe(true);expect(container.querySelectorAll(".photo-editor__clipping-indicator")).toHaveLength(1);
    expect(controller.snapshot().view.document?.selectedLayerIds).toEqual([1,2]);expect(onPreview.mock.calls.at(-1)?.[0].pixels[0]).toBe(2);
    chord(editor);expect(execute.mock.lastCall).toEqual(["layer.releaseClippingMask","null"]);expect(controller.isDirty()).toBe(false);
    act(()=>container.querySelector<HTMLButtonElement>(".photo-editor__clipping-action")!.click());expect(controller.isDirty()).toBe(true);
    act(()=>container.querySelector<HTMLButtonElement>('.photo-editor__history-actions [aria-label="撤销"]')!.click());expect(controller.isDirty()).toBe(false);
    act(()=>container.querySelector<HTMLButtonElement>('.photo-editor__history-actions [aria-label="重做"]')!.click());expect(controller.isDirty()).toBe(true);
    chord(container.querySelector("input")!);expect(execute.mock.lastCall).toEqual(["layer.releaseClippingMask","null"]);const calls=execute.mock.calls.length;
    render(true);chord(editor);act(()=>container.querySelector<HTMLButtonElement>(".photo-editor__clipping-action")!.click());expect(execute).toHaveBeenCalledTimes(calls);
  } finally {act(()=>root.unmount());controller.dispose();container.remove();vi.restoreAllMocks();}
});
