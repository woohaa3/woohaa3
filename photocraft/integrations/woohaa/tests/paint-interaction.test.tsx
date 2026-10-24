import { PHOTOCRAFT_ENGINE_VERSION } from "@woohaa3/contracts";
/** @vitest-environment jsdom */
// 真实 React 工具与指针链路；内核使用原型 getter 替身，不绘制或比对图像。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PhotoEditorApp } from "@woohaa3/photocraft-editor";
import { EditorHandle, type EditorInstance, type EditorPreview } from "@woohaa3/photocraft-editor";
import { EditorWorkspaceController } from "../src/editor-workspace.js";
import { ProjectSession } from "../src/project-session.js";
import { ImageFocusStore } from "@woohaa3/frontend/plugin-api";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let controller: EditorWorkspaceController;
afterEach(() => {
  act(() => root?.unmount());
  controller?.dispose();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([["画笔", false,false,false], ["橡皮", true,false,false],["画笔",false,true,false],["橡皮",true,true,false],["画笔",false,false,true],["橡皮",true,true,true]] as const)("%s 从指针提交到修订更新，再把完整预览送到原节点（蒙版=%s）", async (label, erase,mask,detail) => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(514);
  let frameId=0;const jobs=new Map<number,FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame",vi.fn((callback:FrameRequestCallback)=>{jobs.set(++frameId,callback);return frameId;}));
  vi.stubGlobal("cancelAnimationFrame",vi.fn((id:number)=>{jobs.delete(id);}));
  const frame=()=>act(()=>{const batch=[...jobs.entries()];for(const [id,callback] of batch){if(jobs.delete(id))callback(0);}});
  const drain=()=>{for(let i=0;jobs.size&&i<20;i++)frame();};
  let lastDetails:import("@woohaa3/photocraft-editor").DetailFrame|null=null;
  const onDetails=(value:typeof lastDetails)=>{lastDetails=value;};
  const currentDetails=():import("@woohaa3/photocraft-editor").DetailFrame|null=>lastDetails;
  let revision = 1;
  let live: Record<string, unknown> | null = null;
  const released = vi.fn();
  // 与生成的 WasmPreview 相同：只有原型 getter，没有可展开的内容字段。
  class BoundPreview implements EditorPreview {
    get width() { return 2; }
    get height() { return 1; }
    get pixels() { return new Uint8Array([live ? 99 : revision, 0, 0, 255, 0, 0, 0, 255]); }
    free() { released(); }
  }
  const stateJson = () => JSON.stringify({ document: {
    width: detail?4096:1600, height: detail?3000:900, revision, activeLayer: 1, canUndo: revision > 1, canRedo: false,
    editTarget:mask ? "mask" : "pixels",
    history: revision > 1 ? [erase ? "Eraser" : "Brush Tool"] : [],
    layers: [{ id: 1, name: "原图", kind: "raster", hasMask:mask,visible: true, opacity: 1, blend: "Normal" }]
  } });
  const execute = vi.fn((_id: string, _params: string) => { revision++; return "null"; });
  const sampleColor = vi.fn((x:number,y:number) => x>=0 && y>=0 ? "#336699" : undefined);
  const instance = {
    openImage: stateJson, stateJson, commandsJson: () => "[]", contentHash: () => revision.toString(16).padStart(16, "0"),
    beginStroke: (params: string) => { live = JSON.parse(params); },
    appendStroke: (params: string) => { (live!.points as number[][]).push(...JSON.parse(params).points); },
    commitStroke: () => { const result = execute("paint.stroke", JSON.stringify(live)); live = null; return result; },
    cancelStroke: () => { live = null; },
    takeStrokeDamage:()=>JSON.stringify([{x:1700,y:1300,width:300,height:300}]),
    renderRegion:(params:string)=>{const r=JSON.parse(params);const pixels=new Uint8Array(r.width*r.height*4);pixels[0]=live?99:revision;return {width:r.width,height:r.height,pixels};},
    execute, sampleColor, renderPreview: () => new BoundPreview(), closeDocument: () => "null"
  } as unknown as EditorInstance;
  const handle = new EditorHandle(instance, { upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1 });
  const session = new ProjectSession({ nodeId: "image-1", baseAssetId: "asset-1", baseStorageKey: "image.png", sourceWidth: 1600, sourceHeight: 900, edit: null });
  controller = new EditorWorkspaceController({
    session, sessionId: "session-1", baselineDocument: null, load: async () => ({ ok: true, value: handle }),
    saveDeps: { uploadProject: async () => null, uploadOutput: async () => null, complete: async () => ({ ok: false, code: "unused", error: "unused" }), assetIdFor: () => "unused" }
  });
  expect((await controller.openImage({ name: "image", assetId: "asset-1", bytes: new Uint8Array() })).ok).toBe(true);
  session.establishBaseline();
  const textures = new ImageFocusStore();
  const onPreview = vi.fn((preview: EditorPreview) => textures.setTexture({ nodeId: "image-1", ...preview }));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render=(zoom=detail?1:0.5)=>act(() => root.render(<PhotoEditorApp controller={controller}
    canvasView={{contentSize:{width:864,height:514}, viewport: { x: 0, y: 0, zoom }, fitZoom: 0.5, transitioning: false, onChange: vi.fn() }} onPreview={onPreview} onDetailPreview={detail?onDetails:undefined} />));
  render();
  if(detail)drain();
  act(() => container.querySelector<HTMLButtonElement>(`.photo-editor__toolrail [aria-label="${label}"]`)!.click());
  const stage = container.querySelector<HTMLDivElement>(".photo-editor-canvas")!;
  const captured = new Set<number>();
  stage.setPointerCapture = (id) => { captured.add(id); };
  stage.hasPointerCapture = (id) => captured.has(id);
  stage.releasePointerCapture = (id) => { captured.delete(id); };
  const pointer = (type: string, x: number, y: number, modifiers: MouseEventInit = {}) => {
    const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, ...modifiers });
    Object.defineProperty(event, "pointerId", { value: 1 });
    act(() => stage.dispatchEvent(event));
  };
  pointer("pointerdown", 100, 100);
  pointer("pointermove", 150, 120);
  frame();
  expect(execute).not.toHaveBeenCalled();
  expect(controller.currentView().document?.revision).toBe(1);
  expect(controller.isDirty()).toBe(false);
  if(detail) {expect(currentDetails()?.tiles.some(tile=>tile.preview.pixels[0]===99)).toBe(true);expect(onPreview).toHaveBeenCalledTimes(1);}
  else expect(textures.getTexture()?.pixels[0]).toBe(99);
  // 同帧剩余尾点在松手时立即补齐，不等待下一帧。
  pointer("pointerup", 200, 150);
  expect(execute).toHaveBeenCalledOnce();
  const [id, json] = execute.mock.calls[0] as unknown as [string, string];
  expect(id).toBe("paint.stroke");
  expect(JSON.parse(json)).toMatchObject({ erase, target: mask ? "mask" : "pixels", points: detail?[[1716,1343],[1766,1363],[1816,1393]]:[[136, 136], [236, 176], [336, 236]] });
  expect(controller.currentView().document?.revision).toBe(2);
  expect(controller.isDirty()).toBe(true);
  expect(onPreview).toHaveBeenCalledTimes(detail?2:3);
  expect(textures.getTexture()).toEqual({ nodeId: "image-1", width: 2, height: 1, pixels: new Uint8Array([2, 0, 0, 255, 0, 0, 0, 255]) });
  expect(released).toHaveBeenCalledTimes(detail?2:3);
  if(detail)drain();
  pointer("pointerdown", 110, 110);
  pointer("pointermove", 140, 140);
  frame();
  if(detail) {expect(currentDetails()?.tiles.some(tile=>tile.preview.pixels[0]===99)).toBe(true);expect(onPreview).toHaveBeenCalledTimes(2);}
  else expect(textures.getTexture()?.pixels[0]).toBe(99);
  if(detail) {
    const count=onPreview.mock.calls.length;
    act(()=>currentDetails()?.onUploadFailure?.());
    expect(onPreview).toHaveBeenCalledTimes(count+1);
    expect(textures.getTexture()?.pixels[0]).toBe(99);
    drain();
    pointer("pointermove",160,160);frame();
    const beforeZoom=onPreview.mock.calls.length;
    render(.5);
    expect(onPreview).toHaveBeenCalledTimes(beforeZoom+1);
    expect(currentDetails()).toBeNull();expect(textures.getTexture()?.pixels[0]).toBe(99);
  }
  act(() => window.dispatchEvent(new Event("blur")));
  expect(textures.getTexture()?.pixels[0]).toBe(2);
  pointer("pointerup", 200, 200);
  frame();
  expect(execute).toHaveBeenCalledOnce();
  expect(controller.currentView().document?.revision).toBe(2);
  if(detail) {expect(currentDetails()?.tiles.every(tile=>tile.preview.pixels[0]!==99)??true).toBe(true);return;}
  // 取消的半笔不替换上一笔锚点；Shift 点击从最后成功位置连接直线。
  pointer("pointerdown",250,200,{shiftKey:true}); pointer("pointerup",250,200,{shiftKey:true});
  expect(execute).toHaveBeenCalledTimes(2);
  expect(JSON.parse(execute.mock.calls[1][1])).toMatchObject({points:[[336,236],[436,336]],smoothing:0,erase});
  const editor=container.querySelector(".photo-editor")!;
  act(() => editor.dispatchEvent(new KeyboardEvent("keydown",{key:"Alt",altKey:true,bubbles:true})));
  if(erase) {
    pointer("pointerdown",100,100,{altKey:true});pointer("pointerup",100,100,{altKey:true});
    expect(sampleColor).not.toHaveBeenCalled();expect(JSON.parse(execute.mock.calls[2][1])).toMatchObject({erase:true});return;
  }
  expect(stage.style.cursor).toBe("crosshair");
  pointer("pointerdown",100,100,{altKey:true}); pointer("pointermove",120,110,{altKey:true}); pointer("pointerup",120,110);
  expect(sampleColor).toHaveBeenLastCalledWith(176,156);
  expect(execute).toHaveBeenCalledTimes(2); expect(controller.currentView().document?.revision).toBe(3);
  expect(container.querySelector<HTMLInputElement>('.photo-editor__swatch input')!.value).toBe("#336699");
  act(() => editor.dispatchEvent(new KeyboardEvent("keyup",{key:"Alt",bubbles:true})));
  pointer("pointerdown",100,100); pointer("pointerup",100,100);
  expect(JSON.parse(execute.mock.calls[2][1])).toMatchObject({color:"#336699",points:[[136,136]],erase});
});
