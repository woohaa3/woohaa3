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
const portSeen = vi.hoisted(() => vi.fn());
vi.mock("@woohaa3/frontend/plugin-api", async (importOriginal) => ({ ...(await importOriginal<object>()), FocusHeader: () => <div data-header="true" /> }));
vi.mock("../src/project-editor-pane.js", () => ({
  ProjectEditorPane: ({ entry, writable, display, port }: { entry: unknown; writable: boolean; display: EditorDisplayControls; port: ProjectEditorPort }) => {
    // Menu/status wrappers may change; only content-loading inputs are allowed to reopen the document.
    useEffect(() => { opened(entry); }, [entry, port.fileDestination, port.loadBaseImageBytes, port.loadProjectBytes]);
    // 最近文件端口属于工作区（不随文档变化），这里只记录它是否贯通到面板。
    portSeen({ recentFiles: port.recentFiles, reopen: port.onReopenRecent, remove: port.onRemoveRecent, hasBytes: port.hasRecentBytes });
    const [draft, setDraft] = useState("草稿");
    return <><input data-draft="true" value={draft} disabled={!writable} onChange={(event) => setDraft(event.currentTarget.value)} />
      <button data-toggle="panels" onClick={() => display.toggle("panels")}>面板</button>
      <button data-toggle="sidebar" onClick={() => display.toggle("sidebar")}>侧栏</button>
      <button data-panel-width onClick={() => display.updatePanels?.({ width: 400 })}>宽度</button>
      <button data-panel-float onClick={() => display.updatePanels?.({ floating: !display.state.panelLayout?.floating })}>浮动</button></>;
  }
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.clearAllMocks(); localStorage.removeItem(PANEL_LAYOUT_KEY); });

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

it("工作区内联提示是浮层，不参与内容矩形的纵向分配（A1 回归）", async () => {
  // 回归：提示曾经和编辑器是同级的 `flex: 1 1 auto` 兄弟节点，于是「导出 PSD」回执或
  // 「正在加载编辑内核…」一出现就把编辑器压掉一半高度，状态栏跑到屏幕中部、画布下半截
  // 画到界面下方（2026-10-24 审片 A1）。提示只能是叠在内容上的 toast。
  const view = fakeDocumentView();
  const store = storeWith({ active: bindingOf({ view }) });
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<ImageEditorWorkspace store={store} projectPort={{} as ProjectEditorPort}
    onActivateDocument={() => undefined} onCloseDocument={() => undefined} />));
  expect(container.querySelector(".image-edit-workspace__toast")).toBeNull();
  await act(async () => store.setNotice({ message: "已导出可编辑 PSD；原工程未保存状态不变", tone: "info" }));
  const toast = container.querySelector<HTMLElement>(".image-edit-workspace__toast")!;
  expect(toast).not.toBeNull();
  expect(toast.textContent).toContain("已导出可编辑 PSD");
  // 提示不得使用会挤占空间的空态类名，也不得成为 body 的直接 flex 子项。
  expect(container.querySelector(".image-edit-workspace__notice")).toBeNull();
  expect(toast.closest(".image-edit-workspace__body")?.querySelector(":scope > .image-edit-workspace__toast")).toBe(toast);
  // 编辑器仍在（提示不替换内容，也不隐藏它）。
  expect(container.querySelector<HTMLElement>(".image-edit-workspace__editor")?.hidden).toBe(false);
  await act(async () => store.setNotice(null));
  expect(container.querySelector(".image-edit-workspace__toast")).toBeNull();
});

it("最近文件端口从工作区贯通到编辑器面板（索引属于工作区，不是某个文档）", async () => {
  // 回归：索引与字节都在宿主；工作区只转交快照与动作。若链路断在这里，
  // 面板会显示「宿主未提供端口」，而宿主明明持有记录——用户看不到最近文件。
  const view = fakeDocumentView({ nodeId: "image" });
  const store = storeWith({ active: bindingOf({ view }) });
  const recentFiles = { version: 1 as const, entries: [{ id: "doc-1", name: "海报.pcraft", width: 100, height: 80, byteLength: 2048, savedAt: 1 }] };
  const onReopenRecent = vi.fn(async () => ({ ok: true as const }));
  const onRemoveRecent = vi.fn();
  const hasRecentBytes = vi.fn(() => true);
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<ImageEditorWorkspace store={store} projectPort={{} as ProjectEditorPort}
    onActivateDocument={() => undefined} onCloseDocument={() => undefined}
    recentFiles={recentFiles} onReopenRecent={onReopenRecent} onRemoveRecent={onRemoveRecent} hasRecentBytes={hasRecentBytes} />));
  const seen = portSeen.mock.lastCall?.[0];
  expect(seen.recentFiles).toBe(recentFiles);
  expect(seen.reopen).toBe(onReopenRecent);
  expect(seen.remove).toBe(onRemoveRecent);
  expect(seen.hasBytes).toBe(hasRecentBytes);
});

it("宿主不提供最近文件端口时不伪造空索引（面板据此显示不可用）", async () => {
  const view = fakeDocumentView({ nodeId: "image" });
  const store = storeWith({ active: bindingOf({ view }) });
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<ImageEditorWorkspace store={store} projectPort={{} as ProjectEditorPort}
    onActivateDocument={() => undefined} onCloseDocument={() => undefined} />));
  expect(portSeen.mock.lastCall?.[0].recentFiles).toBeUndefined();
});
