import { PHOTOCRAFT_ENGINE_VERSION } from "@woohaa3/contracts";
/** @vitest-environment jsdom */
// 真实 React → Controller → EditorHandle → 接口替身，不移动或绘制有效图片。
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {PhotoEditorApp} from "@woohaa3/photocraft-editor";
import {EditorHandle,type EditorInstance} from "@woohaa3/photocraft-editor";
import {EditorWorkspaceController} from "../src/editor-workspace.js";
import {ProjectSession} from "../src/project-session.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("面板对齐沿正式命令链刷新原节点和历史，失败保留状态，只读拒绝",async()=>{
  let revision=1,fail=false;
  const commandIds=["layer.align.leftEdges","layer.distribute.horizontally","edit.undo","edit.redo"];
  const stateJson=()=>JSON.stringify({document:{width:800,height:600,revision,activeLayer:3,selectedLayers:[1,2,3],canUndo:revision>1,canRedo:revision===1,
    history:revision>1?["打开","对齐"]:["打开"],hasSelection:true,
    layers:[1,2,3].map(id=>({id,name:`图层${id}`,kind:"raster",visible:true,opacity:1,blend:"Normal"}))}});
  const execute=vi.fn((id:string,_params:string)=>{
    if(fail) throw JSON.stringify({code:"command-failed",message:"对齐失败，请重试"});
    revision=id==="edit.undo"?1:2;return "null";
  });
  const instance={openImage:stateJson,stateJson,contentHash:()=>revision.toString(16).padStart(16,"0"),execute,
    commandsJson:()=>JSON.stringify(commandIds.map(id=>({id,label:id,menu:["Layer"],shortcut:null,params:"{}",enabled:true,allowed:true,needsDocument:true,disabledReason:null}))),
    renderPreview:()=>({width:1,height:1,pixels:new Uint8Array([revision,0,0,255])}),closeDocument:()=>"null"} as unknown as EditorInstance;
  const handle=new EditorHandle(instance,{upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1});
  const session=new ProjectSession({nodeId:"image-1",baseAssetId:"asset-1",baseStorageKey:"image.png",sourceWidth:800,sourceHeight:600,edit:null});
  const controller=new EditorWorkspaceController({session,sessionId:"session-1",baselineDocument:null,load:async()=>({ok:true,value:handle}),
    saveDeps:{uploadProject:async()=>null,uploadOutput:async()=>null,complete:async()=>({ok:false,code:"unused",error:"unused"}),assetIdFor:()=>"unused"}});
  await controller.openImage({name:"image",assetId:"asset-1",bytes:new Uint8Array()});session.establishBaseline();
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);const onPreview=vi.fn();
  const render=(readonly=false)=>act(()=>root.render(<PhotoEditorApp controller={controller} readonly={readonly} canvasView={{viewport:{x:0,y:0,zoom:0.5},fitZoom:0.5,transitioning:false,onChange:vi.fn()}} onPreview={onPreview}/>));
  try {
    render();
    const align=()=>container.querySelector<HTMLButtonElement>('[aria-label="左对齐"]')!;
    act(()=>{const select=container.querySelector<HTMLSelectElement>('[title="对齐参照"]')!;select.value="canvas";select.dispatchEvent(new Event("change",{bubbles:true}));});
    act(()=>align().click());
    expect(execute.mock.lastCall).toEqual(["layer.align.leftEdges",JSON.stringify({to:"canvas"})]);
    expect(controller.snapshot().view.document?.selectedLayerIds).toEqual([1,2,3]);
    expect(controller.snapshot().view.document?.revision).toBe(2);expect(controller.isDirty()).toBe(true);
    expect(onPreview.mock.calls.at(-1)?.[0].pixels[0]).toBe(2);
    act(()=>container.querySelector<HTMLButtonElement>('.photo-editor__history-actions [aria-label="撤销"]')!.click());
    expect(controller.isDirty()).toBe(false);
    act(()=>container.querySelector<HTMLButtonElement>('.photo-editor__history-actions [aria-label="重做"]')!.click());
    expect(controller.isDirty()).toBe(true);
    const before=controller.snapshot();fail=true;act(()=>align().click());
    expect(container.textContent).toContain("对齐失败，请重试");expect(controller.snapshot().view).toBe(before.view);
    expect(controller.snapshot().state.phase).toBe("failed");
    expect(container.querySelector<HTMLSelectElement>('[title="对齐参照"]')!.value).toBe("canvas");
    fail=false;act(()=>align().click());expect(controller.snapshot().state.phase).toBe("editing");
    const distribute=[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="分布")!;
    act(()=>distribute.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})));
    const spacing=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="水平等间距")!;
    act(()=>spacing.click());expect(execute.mock.lastCall).toEqual(["layer.distribute.horizontally","null"]);
    render(true);const calls=execute.mock.calls.length;act(()=>align().click());expect(execute).toHaveBeenCalledTimes(calls);
  } finally {act(()=>root.unmount());controller.dispose();container.remove();vi.restoreAllMocks();}
});
