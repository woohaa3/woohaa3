import { PHOTOCRAFT_ENGINE_VERSION } from "@woohaa3/contracts";
/** @vitest-environment jsdom */
// 真实 React 指针/键盘 → Controller → WASM 接口替身；无渲染和像素合成。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PhotoEditorApp } from "@woohaa3/photocraft-editor";
import { EditorHandle, type EditorInstance } from "@woohaa3/photocraft-editor";
import { EditorWorkspaceController } from "../src/editor-workspace.js";
import { ProjectSession } from "../src/project-session.js";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, controller: EditorWorkspaceController | undefined;
afterEach(() => { act(() => root?.unmount()); controller?.dispose(); document.body.innerHTML = ""; vi.restoreAllMocks(); });
it("加选后约束、中心绘制和空格移位保持同一命令；失焦取消且下一次无状态残留", async () => {
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(514);
  let revision = 1;
  const stateJson = () => JSON.stringify({document:{width:1600,height:900,revision,activeLayer:1,layers:[{id:1,name:"来源",kind:"raster"}]}});
  const execute = vi.fn((_id: string,_params: string) => { revision++; return "null"; });
  const handle = new EditorHandle({openImage:stateJson,stateJson,commandsJson:() => "[]",contentHash:() => "0123456789abcdef",execute,
    renderPreview:() => ({width:1,height:1,pixels:new Uint8Array(4)})} as unknown as EditorInstance,
    {upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1});
  const project = new ProjectSession({nodeId:"image-1",baseAssetId:"asset-1",baseStorageKey:"image.png",sourceWidth:1600,sourceHeight:900,edit:null});
  controller = new EditorWorkspaceController({session:project,sessionId:"selection-test",baselineDocument:null,load:async () => ({ok:true,value:handle}),
    saveDeps:{uploadProject:async () => null,uploadOutput:async () => null,complete:async () => ({ok:false,code:"unused",error:"unused"}),assetIdFor:() => "unused"}});
  await controller.openImage({name:"image",assetId:"asset-1",bytes:new Uint8Array()}); project.establishBaseline();
  const changed = vi.fn(), container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  act(() => root!.render(<PhotoEditorApp controller={controller!} canvasView={{viewport:{x:0,y:0,zoom:.5},fitZoom:.5,transitioning:false,onChange:changed}} onPreview={vi.fn()} />));
  const editor = container.querySelector<HTMLElement>(".photo-editor")!, stage = container.querySelector<HTMLElement>(".photo-editor-canvas")!;
  const captured = new Set<number>();
  stage.setPointerCapture = (id) => { captured.add(id); }; stage.hasPointerCapture = (id) => captured.has(id); stage.releasePointerCapture = (id) => { captured.delete(id); };
  const pointer = (type: string,x: number,y: number,modifiers: MouseEventInit = {}) => {
    const event = new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true,...modifiers});
    Object.defineProperty(event,"pointerId",{value:1}); act(() => stage.dispatchEvent(event));
  };
  const key = (type: string,key: string) => act(() => editor.dispatchEvent(new KeyboardEvent(type,{key,bubbles:true,cancelable:true})));
  pointer("pointerdown",100,100,{shiftKey:true}); pointer("pointermove",160,120,{shiftKey:true});
  key("keyup","Shift"); key("keydown","Shift"); key("keydown","Alt"); key("keydown"," ");
  pointer("pointermove",170,130,{shiftKey:true,altKey:true}); key("keyup"," ");
  expect(stage.dataset.tool).toBe("marquee");
  expect(container.querySelector<HTMLElement>('[data-testid="marquee"]')!.style.width).toBe("120px");
  pointer("pointerup",170,130,{shiftKey:true,altKey:true});
  expect(execute).toHaveBeenCalledOnce(); expect(execute.mock.calls[0][0]).toBe("select.rect");
  expect(JSON.parse(execute.mock.calls[0][1])).toMatchObject({x:36,y:36,width:240,height:240,mode:"add"});
  expect(changed).not.toHaveBeenCalled(); expect(controller.isDirty()).toBe(false);
  pointer("pointerdown",100,100,{altKey:true}); pointer("pointermove",160,120,{altKey:true}); key("keydown"," ");
  act(() => window.dispatchEvent(new Event("blur"))); pointer("pointerup",160,120);
  expect(execute).toHaveBeenCalledOnce(); expect(container.querySelector('[data-testid="marquee"]')).toBeNull();
  pointer("pointerdown",100,100); pointer("pointerup",120,110);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(JSON.parse(execute.mock.calls[1][1])).toMatchObject({x:136,y:136,width:40,height:20,mode:"replace"});
});

it("已有选区拖动沿真实 App → 控制器选择边界或像素草稿，确认与取消不混淆", async () => {
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(514);
  const outline=[[100,100,300,100],[300,100,300,300],[300,300,100,300],[100,300,100,100]];
  const stateJson=() => JSON.stringify({document:{width:1600,height:900,activeLayer:1,revision:1,hasSelection:true,
    selectionFrame:[100,100,300,300],selectionOutline:outline,transformFrame:[120,120,200,200],layers:[{id:1,name:"来源",kind:"raster"}]}});
  const beginBoundary=vi.fn(),beginPixels=vi.fn(),commit=vi.fn(() => "null"),cancel=vi.fn(),preview=vi.fn();
  const handle=new EditorHandle({openImage:stateJson,stateJson,commandsJson:() => "[]",contentHash:() => "0123456789abcdef",
    beginSelectionTransform:beginBoundary,beginTransform:beginPixels,previewTransform:preview,commitTransform:commit,cancelTransform:cancel,
    renderPreview:() => ({width:1,height:1,pixels:new Uint8Array(4)})} as unknown as EditorInstance,
    {upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1});
  const project=new ProjectSession({nodeId:"image-1",baseAssetId:"asset-1",baseStorageKey:"image.png",sourceWidth:1600,sourceHeight:900,edit:null});
  controller=new EditorWorkspaceController({session:project,sessionId:"boundary-test",baselineDocument:null,load:async () => ({ok:true,value:handle}),
    saveDeps:{uploadProject:async () => null,uploadOutput:async () => null,complete:async () => ({ok:false,code:"unused",error:"unused"}),assetIdFor:() => "unused"}});
  await controller.openImage({name:"image",assetId:"asset-1",bytes:new Uint8Array()}); project.establishBaseline();
  const container=document.createElement("div"); document.body.append(container); root=createRoot(container);
  act(() => root!.render(<PhotoEditorApp controller={controller!} canvasView={{viewport:{x:0,y:0,zoom:.5},fitZoom:.5,transitioning:false,onChange:vi.fn()}} onPreview={vi.fn()} />));
  const stage=container.querySelector<HTMLElement>(".photo-editor-canvas")!;
  const captured=new Set<number>(); stage.setPointerCapture=(id)=>{captured.add(id);};
  stage.hasPointerCapture=(id)=>captured.has(id); stage.releasePointerCapture=(id)=>{captured.delete(id);};
  const send=(type:string,x:number,y:number,metaKey=false) => {
    const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,metaKey,bubbles:true}); Object.defineProperty(event,"pointerId",{value:1});
    act(() => stage.dispatchEvent(event));
  };
  send("pointerdown",100,100); send("pointermove",120,110);
  expect(beginBoundary).toHaveBeenCalledOnce(); expect(beginPixels).not.toHaveBeenCalled(); expect(controller.hasTransform()).toBe(true);
  send("pointerup",125,115);
  expect(preview).toHaveBeenLastCalledWith("[1,0,0,1,50,30]"); expect(commit).toHaveBeenCalledOnce(); expect(controller.hasTransform()).toBe(false);
  send("pointerdown",100,100,true); send("pointermove",120,110,true);
  expect(beginPixels).toHaveBeenCalledOnce(); send("pointercancel",120,110); send("pointerup",120,110,true);
  expect(cancel).toHaveBeenCalledOnce(); expect(commit).toHaveBeenCalledOnce(); expect(controller.hasTransform()).toBe(false);
  expect(controller.isDirty()).toBe(false);
});
