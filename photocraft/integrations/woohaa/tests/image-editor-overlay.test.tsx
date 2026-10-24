/** @vitest-environment jsdom */
// 只核对 React 状态与订阅，不加载或绘制 Canvas / WASM。
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ImageEditorWorkspace } from "../src/image-editor-overlay.js";
import type { ProjectEditorPort } from "../src/project-editor-pane.js";
import { PANEL_LAYOUT_KEY } from "@woohaa3/photocraft-editor";
import type { EditorDisplayControls } from "@woohaa3/photocraft-editor";
import { FocusWorkspace } from "@woohaa3/frontend/plugin-api";
import type { CanvasRuntimeService } from "@woohaa3/frontend/plugin-api";
import { RuntimeProvider } from "@woohaa3/frontend/plugin-api";
import type { FrontendRuntime } from "@woohaa3/frontend/plugin-api";
import { bindingOf, entryOf, fakeDocumentView, storeWith } from "../src/test-support/document-workspace-harness.js";

const opened = vi.hoisted(() => vi.fn());
vi.mock("@woohaa3/frontend/plugin-api", async (importOriginal) => ({ ...(await importOriginal<object>()), FocusHeader: () => <div data-header="true" /> }));
vi.mock("../src/project-editor-pane.js", () => ({
  ProjectEditorPane: ({ entry, writable, display }: { entry: unknown; writable: boolean; display: EditorDisplayControls }) => {
    useEffect(() => { opened(entry); }, [entry]);
    const [draft, setDraft] = useState("草稿");
    return <><input data-draft="true" value={draft} disabled={!writable} onChange={(event) => setDraft(event.currentTarget.value)} />
      <button data-screen onClick={()=>display.setScreenMode?.(display.state.screenMode==="fullScreen"?"standard":display.state.screenMode==="fullScreenWithMenuBar"?"fullScreen":"fullScreenWithMenuBar")}>屏幕</button>
      <button data-toggle="panels" onClick={() => display.toggle("panels")}>面板</button>
      <button data-toggle="sidebar" onClick={() => display.toggle("sidebar")}>侧栏</button>
      <button data-panel-width onClick={() => display.updatePanels?.({ width: 400 })}>宽度</button>
      <button data-panel-float onClick={() => display.updatePanels?.({ floating: !display.state.panelLayout?.floating })}>浮动</button></>;
  }
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.clearAllMocks(); localStorage.removeItem(PANEL_LAYOUT_KEY); localStorage.removeItem("photocraft.editor-preferences.v1"); });

it("订阅历史切换，显示所选图片并保留草稿组件；取景刷新不重新打开内核", async () => {
  let hasProject = false;
  let override: { url: string } | null = null;
  let ready = false;
  const view = fakeDocumentView({
    projectDocument: () => hasProject ? {} : null,
    isReadOnlyPreview: () => override !== null,
    isPresentationReady: () => ready,
    historyOverrideState: () => override
  });
  const store = storeWith({ active: bindingOf({ view }) });
  const refresh = () => act(() => view.emit());
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<ImageEditorWorkspace store={store} projectPort={{} as ProjectEditorPort} onActivateDocument={() => undefined} onCloseDocument={() => undefined} />));
  const input = container.querySelector<HTMLInputElement>("[data-draft]")!;
  const presentation = container.querySelector<HTMLElement>(".image-edit-presentation")!;
  expect(presentation.style.visibility).toBe("hidden");
  expect(presentation.querySelector("[data-header]")).not.toBeNull();
  expect(input.disabled).toBe(true);
  expect(opened).toHaveBeenCalledTimes(1);
  refresh();
  expect(presentation.style.visibility).toBe("hidden");
  ready = true;
  refresh();
  expect(presentation.style.visibility).toBe("");
  expect(container.querySelector("[data-draft]")).toBe(input);
  expect(input.disabled).toBe(false);
  expect(opened).toHaveBeenCalledTimes(1);
  override = { url: "/mounted/api/history/old.png" };
  refresh();
  expect(container.querySelector(".image-edit-workspace__editor")?.hasAttribute("hidden")).toBe(true);
  expect(container.querySelector(".image-edit-workspace__history-preview")).not.toBeNull();
  expect(container.querySelector("img, canvas")).toBeNull();
  expect(input.disabled).toBe(true);
  override = null;
  refresh();
  expect(container.querySelector(".image-edit-workspace__history-preview")).toBeNull();
  expect(container.querySelector(".image-edit-workspace__editor")?.hasAttribute("hidden")).toBe(false);
  expect(container.querySelector("[data-draft]")).toBe(input);
  expect(input.disabled).toBe(false);
  expect(opened).toHaveBeenCalledTimes(1);
  expect(container.querySelector(".image-edit-workspace [data-header]")).toBeNull();
  expect(container.querySelector("[data-header]")).not.toBeNull();
  // 设为当前只替换编辑内容：同一文档上重新创建工程界面。
  await act(async () => { hasProject = true; view.patch({ projectDocument: () => ({}) }); });
  expect(container.querySelector("[data-draft]")).not.toBe(input);
  expect(opened).toHaveBeenCalledTimes(2);
  expect(opened).toHaveBeenLastCalledWith({ mode: "project" });
  refresh();
  expect(opened).toHaveBeenCalledTimes(2);
});

it("显示状态贯通延迟界面与公共布局，唯一 runtime 端口更新矩形而不重开草稿", async () => {
  const preserve = vi.fn();
  const view = fakeDocumentView({ preserveNextLayoutViewport: preserve });
  const store = storeWith({ active: bindingOf({ view }) });
  const setFocusContentRect = vi.fn();
  const runtime = { setFocusContentRect } as unknown as CanvasRuntimeService;
  const surface = document.createElement("div");
  surface.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1600, height: 1000, top: 0, left: 0, right: 1600, bottom: 1000, toJSON: () => ({}) });
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<FocusWorkspace presentation={{ mode: { type: "node-focus", kind: "image", nodeId: "image", owner: "direct" }, panel: null, menu: null }}
    runtime={runtime} surfaceRef={{ current: surface }}>
    <ImageEditorWorkspace store={store} projectPort={{} as ProjectEditorPort} onActivateDocument={() => undefined} onCloseDocument={() => undefined} />
  </FocusWorkspace>));
  const input = container.querySelector("[data-draft]");
  expect(setFocusContentRect.mock.lastCall?.[0]).toEqual({ x: 52, y: 186, width: 1268, height: 770 });
  act(() => container.querySelector<HTMLButtonElement>('[data-toggle="sidebar"]')!.click());
  expect(setFocusContentRect.mock.lastCall?.[0]).toEqual({ x: 52, y: 186, width: 1548, height: 770 });
  act(() => container.querySelector<HTMLButtonElement>('[data-toggle="panels"]')!.click());
  expect(setFocusContentRect.mock.lastCall?.[0]).toEqual({ x: 0, y: 134, width: 1600, height: 822 });
  act(() => container.querySelector<HTMLButtonElement>('[data-toggle="panels"]')!.click());
  expect(setFocusContentRect.mock.lastCall?.[0]).toEqual({ x: 52, y: 186, width: 1548, height: 770 });
  expect(preserve).toHaveBeenCalledTimes(3);
  expect(container.querySelector("[data-draft]")).toBe(input); expect(opened).toHaveBeenCalledTimes(1);
  act(() => container.querySelector<HTMLButtonElement>('[data-toggle="sidebar"]')!.click());
  act(() => container.querySelector<HTMLButtonElement>('[data-panel-width]')!.click());
  expect(setFocusContentRect.mock.lastCall?.[0]).toEqual({ x: 52, y: 186, width: 1148, height: 770 });
  act(() => container.querySelector<HTMLButtonElement>('[data-panel-float]')!.click());
  expect(setFocusContentRect.mock.lastCall?.[0]).toEqual({ x: 52, y: 186, width: 1548, height: 770 });
  expect(preserve).toHaveBeenCalledTimes(6);
  act(() => container.querySelector<HTMLButtonElement>('[data-toggle="sidebar"]')!.click());
  act(() => container.querySelector<HTMLButtonElement>('[data-toggle="sidebar"]')!.click());
  expect(preserve).toHaveBeenCalledTimes(6);
  act(()=>window.dispatchEvent(new CustomEvent("photocraft:narrow-options-bar",{detail:true})));
  expect(setFocusContentRect.mock.lastCall?.[0]).toEqual({x:52,y:178,width:1548,height:778});expect(preserve).toHaveBeenCalledTimes(7);
  act(()=>window.dispatchEvent(new CustomEvent("photocraft:large-document-tabs",{detail:true})));
  expect(container.querySelector('[data-large-tabs="true"]')).not.toBeNull();
  expect(setFocusContentRect.mock.lastCall?.[0]).toEqual({x:52,y:186,width:1548,height:770});expect(preserve).toHaveBeenCalledTimes(8);
  act(()=>window.dispatchEvent(new CustomEvent("photocraft:large-document-tabs",{detail:false})));
  expect(setFocusContentRect.mock.lastCall?.[0]).toEqual({x:52,y:178,width:1548,height:778});expect(preserve).toHaveBeenCalledTimes(9);
  act(()=>window.dispatchEvent(new CustomEvent("photocraft:narrow-options-bar",{detail:false})));
  expect(setFocusContentRect.mock.lastCall?.[0]).toEqual({x:52,y:186,width:1548,height:770});expect(preserve).toHaveBeenCalledTimes(10);
  expect(container.querySelector("[data-draft]")).toBe(input); expect(opened).toHaveBeenCalledTimes(1);
});

it("节点版本抽屉打开时隐藏编辑器并提示在右侧选择版本", async () => {
  const listeners = new Set<() => void>();
  let snapshot = {
    mode: { type: "node-focus" as const, kind: "image" as const, nodeId: "image", owner: "direct" as const },
    panel: null as null | { type: string; nodeId: string },
    menu: null
  };
  const navigation = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot
  };
  const setPanel = (panel: typeof snapshot.panel) => {
    snapshot = { ...snapshot, panel };
    listeners.forEach((listener) => listener());
  };
  const view = fakeDocumentView({ nodeId: "image" });
  const store = storeWith({ active: bindingOf({ view }) });
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const runtime = { ctx: { canvasNavigation: navigation } } as unknown as FrontendRuntime;
  await act(async () => root.render(
    <RuntimeProvider runtime={runtime}>
      <ImageEditorWorkspace store={store} projectPort={{} as ProjectEditorPort} onActivateDocument={() => undefined} onCloseDocument={() => undefined} />
    </RuntimeProvider>
  ));
  const editor = () => container.querySelector<HTMLElement>(".image-edit-workspace__editor")!;
  expect(editor().hidden).toBe(false);
  await act(async () => setPanel({ type: "node-history", nodeId: "image" }));
  expect(editor().hidden).toBe(true);
  expect(container.textContent).toContain("在右侧选择版本预览");
  await act(async () => setPanel(null));
  expect(editor().hidden).toBe(false);
});

it("tab 条显示顺序与状态，激活点击只切换文档、不重排", async () => {
  const first = entryOf({ id: "doc-1", name: "A.png", source: { kind: "file", fileName: "A.png" }, status: "dirty" });
  const second = entryOf({ id: "doc-2", name: "B.png", source: { kind: "node", canvasId: "c1", nodeId: "n2" }, detail: "n2" });
  const view = fakeDocumentView();
  const store = storeWith({
    entries: [first, second],
    active: bindingOf({ documentId: "doc-2", view, name: "B.png", detail: "n2", nodeDocument: true })
  });
  const onActivate = vi.fn();
  const onClose = vi.fn();
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<ImageEditorWorkspace store={store} projectPort={{} as ProjectEditorPort}
    onActivateDocument={onActivate} onCloseDocument={onClose} onOpenFile={() => undefined} />));
  const tabs = [...container.querySelectorAll<HTMLElement>("[data-document-id]")];
  expect(tabs.map((tab) => tab.dataset.documentId)).toEqual(["doc-1", "doc-2"]);
  expect(tabs[1]!.dataset.active).toBe("true");
  expect(tabs[0]!.textContent).toContain("未保存");
  await act(async () => tabs[0]!.click());
  expect(onActivate).toHaveBeenCalledWith("doc-1");
  // 激活不改变顺序。
  expect([...container.querySelectorAll<HTMLElement>("[data-document-id]")].map((tab) => tab.dataset.documentId))
    .toEqual(["doc-1", "doc-2"]);
  const close = tabs[0]!.querySelector<HTMLButtonElement>(".photo-document-tab__close")!;
  await act(async () => close.click());
  expect(onClose).toHaveBeenCalledWith("doc-1");
});

it("空工作区仅双击背景打开，按钮自行处理，忙碌或存在文档时不重复打开",async()=>{
 const onOpenFile=vi.fn(),store=storeWith({entries:[],active:null}),container=document.createElement("div");document.body.append(container);root=createRoot(container);
 await act(async()=>root.render(<ImageEditorWorkspace store={store} onActivateDocument={()=>{}} onCloseDocument={()=>{}} onOpenFile={onOpenFile}/>));
 const body=container.querySelector(".image-edit-workspace__body")!;
 act(()=>body.dispatchEvent(new MouseEvent("click",{bubbles:true})));expect(onOpenFile).not.toHaveBeenCalled();
 act(()=>body.dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));expect(onOpenFile).toHaveBeenCalledOnce();
 const button=container.querySelector<HTMLButtonElement>(".image-edit-workspace__notice button")!;act(()=>button.dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));expect(onOpenFile).toHaveBeenCalledOnce();act(()=>button.click());expect(onOpenFile).toHaveBeenCalledTimes(2);
 act(()=>store.update({busy:true}));act(()=>body.dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));expect(onOpenFile).toHaveBeenCalledTimes(2);expect(button.disabled).toBe(true);
});

it("活动文档订阅内核上下文与取景供标签展示，缩放/换目标不重开编辑器",async()=>{
 const listeners=new Set<()=>void>();let zoom=.5;
 let snapshot={view:{document:{activeLayerId:1,layers:[{id:1,name:"图层甲"}],editTarget:"pixels",mode:"RGB",depthBits:8}}};
 const controller={subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},snapshot:()=>snapshot,isDirty:()=>false} as unknown as import("../src/editor-workspace.js").EditorWorkspaceController;
 const view=fakeDocumentView();view.focus.viewportState=()=>({x:0,y:0,zoom});
 const store=storeWith({active:bindingOf({view,controller})});const container=document.createElement("div");document.body.append(container);root=createRoot(container);
 await act(async()=>root.render(<ImageEditorWorkspace store={store} projectPort={{} as ProjectEditorPort} onActivateDocument={()=>{}} onCloseDocument={()=>{}}/>));
 const title=()=>container.querySelector('.photo-document-tab__name')?.textContent;
 expect(title()).toBe("图片 @ 50% (图层甲，RGB/8)");
 zoom=2;act(()=>view.emit());expect(title()).toBe("图片 @ 200% (图层甲，RGB/8)");
 snapshot={view:{document:{...snapshot.view.document,editTarget:"mask",layers:[{id:1,name:"图层乙"}]}}};act(()=>listeners.forEach(listener=>listener()));expect(title()).toBe("图片 @ 200% (图层乙，图层蒙版，RGB/8)");expect(opened).toHaveBeenCalledOnce();
 act(()=>store.update({active:null}));expect(listeners.size).toBe(0);
});

it("空工作区读取并订阅本机画布背景，不修改宿主全局主题",async()=>{
 localStorage.setItem("photocraft.editor-preferences.v1",JSON.stringify({pasteboard:{color:"custom",custom:"#123456",border:"none",dots:false}}));
 const store=storeWith({entries:[],active:null}),container=document.createElement("div");document.body.append(container);root=createRoot(container);
 await act(async()=>root.render(<ImageEditorWorkspace store={store} onActivateDocument={()=>{}} onCloseDocument={()=>{}}/>));
 const body=container.querySelector<HTMLElement>(".image-edit-workspace__body")!;expect(body.style.backgroundColor).toBe("rgb(18, 52, 86)");expect(body.style.backgroundImage).toBe("none");
 act(()=>window.dispatchEvent(new CustomEvent("photocraft-pasteboard-change",{detail:{color:"lightGray",custom:"#123456",border:"none",dots:true}})));
 expect(body.style.backgroundColor).toBe("rgb(184, 184, 184)");expect(document.documentElement.style.getPropertyValue("--photo-editor-canvas-color")).toBe("");
 localStorage.removeItem("photocraft.editor-preferences.v1");
});

it("屏幕模式同步标签和唯一runtime内容矩形，全屏Tab不修改面板，草稿不重开",async()=>{
  let full:Element|null=null;
  Object.defineProperty(document,"fullscreenElement",{configurable:true,get:()=>full});
  Object.defineProperty(document.documentElement,"requestFullscreen",{configurable:true,value:async()=>{full=document.documentElement;document.dispatchEvent(new Event("fullscreenchange"));}});
  Object.defineProperty(document,"exitFullscreen",{configurable:true,value:async()=>{full=null;document.dispatchEvent(new Event("fullscreenchange"));}});
  const view=fakeDocumentView(),store=storeWith({active:bindingOf({view})}),setFocusContentRect=vi.fn();
  const surface=document.createElement("div");surface.getBoundingClientRect=()=>({x:0,y:0,width:1600,height:1000,top:0,left:0,right:1600,bottom:1000,toJSON:()=>({})});
  const container=document.createElement("div");document.body.append(container);root=createRoot(container);
  try{
    await act(async()=>root.render(<FocusWorkspace presentation={{mode:{type:"node-focus",kind:"image",nodeId:"image",owner:"direct"},panel:null,menu:null}} runtime={{setFocusContentRect} as unknown as CanvasRuntimeService} surfaceRef={{current:surface}}><ImageEditorWorkspace store={store} projectPort={{} as ProjectEditorPort} onActivateDocument={()=>undefined} onCloseDocument={()=>undefined}/></FocusWorkspace>));
    const draft=container.querySelector("[data-draft]"),tabs=container.querySelector<HTMLElement>("[data-document-tabs-wrap]")!,screen=container.querySelector<HTMLButtonElement>("[data-screen]")!;
    const rect=()=>setFocusContentRect.mock.lastCall?.[0];expect(rect()).toEqual({x:52,y:186,width:1268,height:770});
    await act(async()=>screen.click());expect(tabs.hidden).toBe(true);expect(rect()).toEqual({x:52,y:152,width:1268,height:804});
    act(()=>screen.click());expect(rect()).toEqual({x:0,y:0,width:1600,height:1000});expect(container.querySelector('[data-focus-chrome="hidden"]')).not.toBeNull();
    act(()=>container.querySelector<HTMLButtonElement>('[data-toggle="panels"]')!.click());expect(rect()).toEqual({x:52,y:152,width:1268,height:804});expect(tabs.hidden).toBe(true);
    await act(async()=>screen.click());expect(tabs.hidden).toBe(false);expect(rect()).toEqual({x:52,y:186,width:1268,height:770});
    expect(container.querySelector("[data-draft]")).toBe(draft);expect(opened).toHaveBeenCalledTimes(1);
  }finally{full=null;document.dispatchEvent(new Event("fullscreenchange"));delete (document.documentElement as Partial<HTMLElement>).requestFullscreen;delete (document as Partial<Document>).exitFullscreen;Reflect.deleteProperty(document,"fullscreenElement");}
});
