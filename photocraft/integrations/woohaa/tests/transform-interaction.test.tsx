import { PHOTOCRAFT_ENGINE_VERSION } from "@woohaa3/contracts";
/** @vitest-environment jsdom */
// 真实 React 指针 → 控制器 → WASM 接口替身 → 原节点纹理；不执行绘制或截图。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PhotoEditorApp } from "@woohaa3/photocraft-editor";
import { EditorHandle, type EditorInstance, type EditorPreview } from "@woohaa3/photocraft-editor";
import { EditorWorkspaceController } from "../src/editor-workspace.js";
import { ProjectSession } from "../src/project-session.js";
import { ImageFocusStore } from "@woohaa3/frontend/plugin-api";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, controller: EditorWorkspaceController | undefined;
afterEach(() => {
  act(() => root?.unmount()); controller?.dispose();
  document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const entries = ["shortcut", "edit-menu", "context-menu", "move-button"] as const;
it.each([1,2].flatMap(count => entries.map(entry => [count,entry] as const)))("%i 个所选图层从 %s 进入变换，统一提交或取消", async (selectedCount, entry) => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(514);
  let callback: FrameRequestCallback | null = null;
  vi.stubGlobal("requestAnimationFrame", vi.fn((next: FrameRequestCallback) => { callback = next; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn(() => { callback = null; }));
  const frame = () => act(() => { const fn = callback; callback = null; fn?.(0); });
  let revision = 1, active = false;
  let draft: number[] | null = null;
  const committed: number[][] = [];
  const stateJson = () => JSON.stringify({ document: { width: 1600, height: 900, revision,
    activeLayer: 1, canUndo: revision > 1, canRedo: false, history: revision > 1 ? ["打开", "自由变换"] : ["打开"],
    transformFrame: [100,100,300,200], selectedLayers:Array.from({length:selectedCount},(_,i)=>i+1),
    layers:Array.from({length:selectedCount},(_,i)=>({id:i+1,name:`图层${i+1}`,kind:"raster",visible:true,opacity:1,blend:"Normal"})) } });
  class BoundPreview implements EditorPreview {
    get width() { return 1; } get height() { return 1; }
    get pixels() { return new Uint8Array([active && draft ? 99 : revision,0,0,255]); }
    free() {}
  }
  const beginMove = vi.fn((_json: string) => { active = true; draft = null; return true; });
  const instance = {
    beginMove,
    openImage: stateJson, stateJson,
    commandsJson: () => JSON.stringify([{id:"edit.transform",label:"自由变换",menu:["Edit"],shortcut:"Mod+T",
      params:"",allowed:true,enabled:true,disabledReason:null,needsDocument:true}]),
    contentHash: () => revision.toString(16).padStart(16,"0"),
    beginTransform: () => { active = true; draft = null; },
    previewTransform: (json: string) => { draft = JSON.parse(json); },
    commitTransform: () => { if (draft) { committed.push(draft); revision++; } active = false; draft = null; return "null"; },
    cancelTransform: () => { active = false; draft = null; },
    closeDocument: () => "null", renderPreview: () => new BoundPreview()
  } as unknown as EditorInstance;
  const handle = new EditorHandle(instance, { upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1 });
  const project = new ProjectSession({ nodeId: "image-1", baseAssetId: "asset-1", baseStorageKey: "image.png", sourceWidth: 1600, sourceHeight: 900, edit: null });
  controller = new EditorWorkspaceController({ session: project, sessionId: "session-1", baselineDocument: null,
    load: async () => ({ ok: true, value: handle }),
    saveDeps: { uploadProject: async () => null, uploadOutput: async () => null, complete: async () => ({ ok: false, code: "unused", error: "unused" }), assetIdFor: () => "unused" } });
  await controller.openImage({ name: "image", assetId: "asset-1", bytes: new Uint8Array() });
  project.establishBaseline();
  const textures = new ImageFocusStore();
  const onPreview = vi.fn((preview: EditorPreview) => textures.setTexture({ nodeId: "image-1", ...preview }));
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  act(() => root!.render(<PhotoEditorApp controller={controller!} onPreview={onPreview}
    canvasView={{ viewport: { x: 0, y: 0, zoom: 0.5 }, fitZoom: 0.5, transitioning: false, onChange: vi.fn() }} />));
  const editor = container.querySelector<HTMLElement>(".photo-editor")!;
  const press = (key: string, ctrlKey = false) => act(() => editor.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true })));
  const openTransform = async () => {
    if (entry === "shortcut") { press("t",true); return; }
    if (entry === "move-button") {
      press("v");
      act(() => [...container.querySelectorAll(".photo-editor__contextbar button")].find(button => button.textContent === "自由变换")!.dispatchEvent(new MouseEvent("click",{bubbles:true})));
      return;
    }
    await act(async () => {
      if (entry === "edit-menu") {
        [...container.querySelectorAll(".photo-editor__menubar button")].find(button => button.textContent === "编辑")!
          .dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true}));
      } else {
        const event = new MouseEvent("contextmenu",{button:2,clientX:120,clientY:100,bubbles:true,cancelable:true});
        container.querySelector(".photo-editor-canvas")!.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
    });
    const item = [...document.querySelectorAll<HTMLElement>(".ui-menu__item")].find(item => item.textContent?.startsWith("自由变换"))!;
    expect(item.hasAttribute("data-disabled")).toBe(false);
    await act(async () => item.click());
  };
  await openTransform();
  const overlay = container.querySelector<HTMLElement>(".photo-editor-transform")!;
  const captured = new Set<number>();
  overlay.setPointerCapture = (id) => { captured.add(id); };
  overlay.hasPointerCapture = (id) => captured.has(id);
  overlay.releasePointerCapture = (id) => { captured.delete(id); };
  const send = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true });
    Object.defineProperty(event, "pointerId", { value: 1 });
    act(() => overlay.dispatchEvent(event));
  };
  const marker = () => onPreview.mock.calls.at(-1)![0].pixels[0];
  send("pointerdown", 100,100); send("pointermove", 120,100); frame();
  expect(marker()).toBe(99); expect(controller.currentView().document?.revision).toBe(1);
  expect(controller.isDirty()).toBe(false); expect(committed).toHaveLength(0);
  send("pointerup", 130,110); frame();
  send("pointerdown", 130,110); send("pointermove", 140,110); send("pointerup", 140,110); frame();
  expect(committed).toHaveLength(0);
  if (entry === "context-menu") {
    await act(async () => overlay.dispatchEvent(new MouseEvent("contextmenu",{button:2,bubbles:true,cancelable:true})));
    await act(async () => [...document.querySelectorAll<HTMLElement>(".ui-menu__item")].find(item => item.textContent === "确认变换")!.click());
  } else press("Enter");
  expect(committed).toEqual([[1,0,0,1,80,20]]);
  expect(controller.currentView().document?.revision).toBe(2);
  expect(controller.currentView().document?.history).toEqual(["打开","自由变换"]);
  expect(controller.isDirty()).toBe(true); expect(marker()).toBe(2);
  await openTransform();
  const again = container.querySelector<HTMLElement>(".photo-editor-transform")!;
  again.setPointerCapture = overlay.setPointerCapture; again.hasPointerCapture = overlay.hasPointerCapture; again.releasePointerCapture = overlay.releasePointerCapture;
  const down = new MouseEvent("pointerdown", { button: 0, clientX: 100, clientY: 100, bubbles: true });
  Object.defineProperty(down,"pointerId",{ value: 1 }); act(() => again.dispatchEvent(down));
  const move = new MouseEvent("pointermove", { clientX: 160, clientY: 100, bubbles: true });
  Object.defineProperty(move,"pointerId",{ value: 1 }); act(() => again.dispatchEvent(move)); frame();
  expect(marker()).toBe(99);
  if (entry === "context-menu") {
    // 右键不结束草稿；菜单内 Esc 只收起菜单，再次右键可取消整个会话。
    const up = new MouseEvent("pointerup",{button:0,clientX:160,clientY:100,bubbles:true});
    Object.defineProperty(up,"pointerId",{value:1}); act(() => again.dispatchEvent(up)); frame();
    await act(async () => again.dispatchEvent(new MouseEvent("contextmenu",{button:2,bubbles:true,cancelable:true})));
    const menu = document.querySelector<HTMLElement>("[data-cursor-menu]")!;
    await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
    await act(async () => { await new Promise(resolve => setTimeout(resolve,0)); });
    expect(controller.hasTransform()).toBe(true); expect(marker()).toBe(99);
    await act(async () => again.dispatchEvent(new MouseEvent("contextmenu",{button:2,bubbles:true,cancelable:true})));
    await act(async () => [...document.querySelectorAll<HTMLElement>(".ui-menu__item")].find(item => item.textContent === "取消变换")!.click());
  } else press("Escape");
  expect(marker()).toBe(2); expect(committed).toHaveLength(1);
  expect(controller.currentView().document?.revision).toBe(2);
  expect(controller.hasTransform()).toBe(false);
  press("v");
  const stage = container.querySelector<HTMLElement>(".photo-editor-canvas")!;
  stage.setPointerCapture = overlay.setPointerCapture; stage.hasPointerCapture = overlay.hasPointerCapture; stage.releasePointerCapture = overlay.releasePointerCapture;
  const movePointer = (type: string,x: number,y: number,altKey = false) => {
    const event = new MouseEvent(type,{button:0,clientX:x,clientY:y,altKey,bubbles:true});
    Object.defineProperty(event,"pointerId",{value:1}); act(() => stage.dispatchEvent(event));
  };
  movePointer("pointerdown",100,100,true);
  expect(JSON.parse(beginMove.mock.calls.at(-1)![0])).toEqual({x:136,y:136,autoSelect:true,duplicate:true});
  movePointer("pointermove",120,110,true); frame();
  expect(marker()).toBe(99); expect(controller.isDirty()).toBe(true); expect(committed).toHaveLength(1);
  movePointer("pointerup",130,120,true);
  expect(committed.at(-1)).toEqual([1,0,0,1,60,40]); expect(committed).toHaveLength(2); expect(marker()).toBe(3);
  movePointer("pointerdown",100,100,true); movePointer("pointermove",150,130,true); frame();
  expect(marker()).toBe(99); movePointer("pointercancel",150,130); frame();
  expect(marker()).toBe(3); expect(committed).toHaveLength(2); expect(controller.hasTransform()).toBe(false);
  movePointer("pointerup",150,130,true); expect(committed).toHaveLength(2);
  expect(container.querySelector("canvas, img")).toBeNull();
});
