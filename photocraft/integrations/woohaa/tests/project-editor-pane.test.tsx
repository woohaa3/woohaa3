/** @vitest-environment jsdom */
// 替换编辑画布，仅验证底层纹理的显示归属，不绘制像素。
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectEditorPane, type ProjectEditorPort } from "../src/project-editor-pane.js";
import type { EditorDocumentView } from "../src/document-view.js";
import { fakeDocumentView } from "../src/test-support/document-workspace-harness.js";
const normalize = vi.hoisted(() => vi.fn(async (_bytes: Uint8Array) => new Uint8Array([2])));
vi.mock("../../../packages/editor/src/normalize-image.js", () => ({ normalizeEditorImage: normalize }));
const preview = { width: 2, height: 1, pixels: new Uint8Array(8) };
vi.mock("../../../packages/editor/src/photo-editor-app.js", () => ({
  PhotoEditorApp: ({ onPreview }: { onPreview: (preview: unknown, size: unknown) => void }) => {
    useEffect(() => onPreview(preview, { width: 800, height: 400 }), [onPreview]);
    return <div data-editor />;
  }
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });
it.each([true, false])("编辑结果更新原节点，打开结果 %s；卸载释放预览", async (ok) => {
  const publish = vi.fn();
  const dispose = vi.fn();
  const openImage = vi.fn(async () => ({ ok, message: "无法打开" }));
  const view = fakeDocumentView({ baseAsset: () => ({ id: "base" }), setEditorPreview: publish });
  const port = {
    createController: () => ({ dispose, openImage }),
    loadBaseImageBytes: async () => new Uint8Array([1])
  } as unknown as ProjectEditorPort;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ProjectEditorPane view={view as unknown as EditorDocumentView} port={port} writable entry={{ mode: "image" }} />));
  expect(publish).toHaveBeenCalledWith(preview, { width: 800, height: 400 });
  expect(normalize).toHaveBeenLastCalledWith(new Uint8Array([1]));
  expect(openImage).toHaveBeenCalledWith({ name: "image", assetId: "base", bytes: new Uint8Array([2]) });
  expect(container.querySelector("[data-editor]") !== null).toBe(ok);
  act(() => root!.unmount());
  root = null;
  expect(publish).toHaveBeenLastCalledWith(null);
  expect(dispose).toHaveBeenCalledOnce();
});

it.each([false, true])("进入动画结束前不打开内核；等待期间退出=%s", async (exitEarly) => {
  let transitioning = true;
  const listeners = new Set<() => void>();
  const openImage = vi.fn(async () => ({ ok: true }));
  const view = fakeDocumentView({
    baseAsset: () => ({ id: "base" }),
    isTransitioning: () => transitioning,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }
  });
  const port = {
    createController: () => ({ dispose: vi.fn(), openImage }),
    loadBaseImageBytes: async () => new Uint8Array([1])
  } as unknown as ProjectEditorPort;
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ProjectEditorPane view={view as unknown as EditorDocumentView} port={port} writable entry={{ mode: "image" }} />));
  expect(openImage).not.toHaveBeenCalled();
  if (exitEarly) {
    await act(async () => root!.unmount()); root = null;
    // 面板取消订阅后等待器不再保留（释放视图不等价于销毁文档）。
    expect(listeners.size).toBe(0);
  }
  await act(async () => { transitioning = false; for (const listener of [...listeners]) listener(); });
  expect(openImage).toHaveBeenCalledTimes(exitEarly ? 0 : 1);
});

it("工作区持有的控制器不随面板卸载释放", async () => {
  const dispose = vi.fn();
  const openImage = vi.fn(async () => ({ ok: true }));
  const controller = {
    dispose,
    openImage,
    hasLayerProperties: () => false,
    hasAdjustment: () => false,
    hasText: () => false,
    hasTransform: () => false,
    isDirty: () => false,
    currentState: () => ({ phase: "editing", message: null, dirty: false, retriable: false }),
    snapshot: () => ({ view: { hasDocument: false, document: null, sessionActiveIndex: null }, commands: new Map(), state: { phase: "editing", message: null, dirty: false, retriable: false } }),
    subscribe: () => () => undefined
  };
  const view = fakeDocumentView({ baseAsset: () => ({ id: "base" }) });
  const port = {
    createController: () => controller,
    loadBaseImageBytes: async () => new Uint8Array([1])
  } as unknown as ProjectEditorPort;
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ProjectEditorPane view={view as unknown as EditorDocumentView} port={port} writable entry={{ mode: "image" }} controller={controller as never} />));
  act(() => root!.unmount());
  root = null;
  expect(dispose).not.toHaveBeenCalled();
});

it("缺失内核后，菜单和取景刷新不再次打开编辑器", async () => {
  const openImage = vi.fn(async () => ({ ok: false, message: "需要图片编辑组件" }));
  const createController = vi.fn(() => ({ dispose: vi.fn(), openImage }));
  const view = fakeDocumentView({ baseAsset: () => ({ id: "base" }) });
  const port = { createController, loadBaseImageBytes: async () => new Uint8Array([1]) } as unknown as ProjectEditorPort;
  const entry = { mode: "image" } as const;
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  const render = () => root!.render(<ProjectEditorPane view={view as unknown as EditorDocumentView} port={{ ...port, documents: { list: [], onActivateDocument: () => undefined } }} writable entry={entry} />);
  await act(async () => render());
  for (let i = 0; i < 5; i++) await act(async () => render());
  expect(openImage).toHaveBeenCalledOnce();
  expect(createController).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("需要图片编辑组件");
});
