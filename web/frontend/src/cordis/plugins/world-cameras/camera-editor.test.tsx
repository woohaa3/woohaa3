// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDefaultWorldCameraData, createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { WorldCameraOverlay } from "./plugin.js";
import { worldCameraEditorStore } from "../../services/world-camera-editor-store.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";

let root: Root;
let host: HTMLDivElement;
let canvas: ServerCanvas;
const camera = createDefaultWorldCameraData("camera-1", "v1", { u: 0, v: 0 });
const changed = { ...camera, position: { ...camera.position, u: 2 } };
let lock: Element | null = null;
const ctx = {
  canvasRuntime: { cancelTransientGesture: vi.fn() },
  canvasSession: { isWritable: () => true },
  canvasRemote: { saveWorldCamera: vi.fn() },
  canvasEdit: { recordExternal: vi.fn(() => ({ ok: true })) }
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  lock = null;
  Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => lock });
  document.documentElement.requestPointerLock = vi.fn(() => { lock = document.documentElement; document.dispatchEvent(new Event("pointerlockchange")); return Promise.resolve(); });
  document.exitPointerLock = vi.fn(() => { lock = null; document.dispatchEvent(new Event("pointerlockchange")); });
  const base = createEmptyWoohaa3ServerCanvas("canvas-1");
  canvas = { ...base, revision: 1, document: { ...base.document, nodes: [{ id: "node", type: "world-camera", position: { x: 0, y: 0 } }] },
    nodeData: { node: { worldCamera: camera } } } as unknown as ServerCanvas;
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  worldCameraEditorStore.close(); host.remove();
  vi.unstubAllGlobals();
});

async function renderEditor(edit = true) {
  await act(async () => {
    if (edit) worldCameraEditorStore.begin(canvas.id, "node", camera);
    root.render(<WorldCameraOverlay ctx={ctx as never} canvasId={canvas.id} writable />);
  });
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(button => (button.textContent === label || button.getAttribute("aria-label") === label) && !button.disabled);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}
async function exit() {
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true })));
}

it("does not open a panel on selection; an unchanged edit exits without a dialog", async () => {
  await renderEditor(false);
  expect(host.textContent).toBe("");
  await act(async () => { worldCameraEditorStore.begin(canvas.id, "node", camera); });
  expect(host.textContent).toContain("调整中");
  const guide = host.querySelector(".world-camera-editor__guide");
  expect(guide?.textContent).toContain("拖拽转向");
  expect(guide?.textContent).not.toContain("W / S");
  expect(document.documentElement.requestPointerLock).not.toHaveBeenCalled();
  await exit();
  expect(worldCameraEditorStore.getSnapshot()).toBeNull();
  expect(document.body.textContent).not.toContain("保存镜头调整？");
});

it("can continue a draft and discard it without writing the camera", async () => {
  await renderEditor();
  await act(async () => worldCameraEditorStore.update(changed));
  await exit();
  expect(document.body.textContent).toContain("保存镜头调整？");
  await click("继续调整");
  expect(worldCameraEditorStore.getSnapshot()?.draft.position.u).toBe(2);
  expect(worldCameraEditorStore.getSnapshot()?.phase).toBe("editing");
  await exit();
  await click("放弃修改");
  expect(worldCameraEditorStore.getSnapshot()).toBeNull();
  expect(ctx.canvasRemote.saveWorldCamera).not.toHaveBeenCalled();
  expect(woohaa3CanvasStore.getState().canvas?.nodeData.node.worldCamera).toEqual(camera);
});

it("saves once with the original version, records one undo and waits for the canonical projection", async () => {
  ctx.canvasRemote.saveWorldCamera.mockResolvedValue({ ok: true, canvasId: canvas.id, cameraId: camera.cameraId,
    settingsVersion: "v2", revision: 2, duplicate: false, camera: { ...changed, settingsVersion: "v2" } });
  await renderEditor();
  await act(async () => worldCameraEditorStore.update(changed));
  await click("保存并退出");
  expect(ctx.canvasRemote.saveWorldCamera).toHaveBeenCalledTimes(1);
  expect(ctx.canvasRemote.saveWorldCamera.mock.calls[0]?.[0]).toMatchObject({ expectedSettingsVersion: "v1", settings: { position: changed.position } });
  expect(ctx.canvasEdit.recordExternal).toHaveBeenCalledTimes(1);
  expect(worldCameraEditorStore.getSnapshot()?.phase).toBe("saving");
  expect(document.body.textContent).toContain("等待画布同步");
  await act(async () => woohaa3CanvasStore.getState().applyRemoteCanvas({ ...canvas, revision: 2,
    nodeData: { node: { worldCamera: { ...changed, settingsVersion: "v2" } } } } as unknown as ServerCanvas));
  expect(worldCameraEditorStore.getSnapshot()).toBeNull();
});

it("preserves the draft on a save conflict", async () => {
  ctx.canvasRemote.saveWorldCamera.mockResolvedValue({ ok: false, code: "version-conflict", message: "镜头已更新" });
  await renderEditor();
  await act(async () => worldCameraEditorStore.update(changed));
  await exit(); await click("保存并退出");
  expect(worldCameraEditorStore.getSnapshot()).toMatchObject({ phase: "confirm", draft: changed });
  expect(ctx.canvasEdit.recordExternal).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("镜头");
});

it("keeps invalid precision input editable and blocks saving, including after hiding the popover", async () => {
  await renderEditor();
  await click("机位精调");
  const field = host.querySelectorAll<HTMLInputElement>('[data-camera-popover] input')[2]!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setValue.call(field, ""); field.dispatchEvent(new Event("input", { bubbles: true })); });
  const save = host.querySelector<HTMLButtonElement>('button[aria-label="保存并退出"]')!;
  expect(save.disabled).toBe(true);
  expect(worldCameraEditorStore.getSnapshot()?.draft.position.h).toBe(camera.position.h);
  expect(host.textContent).toContain("机位数值无效");
  await click("机位精调");
  expect(save.disabled).toBe(true);
  await click("机位精调");
  expect(field.value).toBe("");
  await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(field.value).toBe(String(Math.round(camera.position.h * 100) / 100));
  expect(save.disabled).toBe(false);
  expect(ctx.canvasRemote.saveWorldCamera).not.toHaveBeenCalled();
});

it("does not overwrite a camera changed externally while editing", async () => {
  await renderEditor();
  await act(async () => {
    worldCameraEditorStore.update(changed);
    woohaa3CanvasStore.getState().applyRemoteCanvas({ ...canvas, revision: 2,
      nodeData: { node: { worldCamera: { ...camera, settingsVersion: "external" } } } } as unknown as ServerCanvas);
  });
  const save = [...document.querySelectorAll("button")].find(button => (button.textContent === "保存并退出" || button.getAttribute("aria-label") === "保存并退出"));
  expect(save?.disabled).toBe(true);
  expect(worldCameraEditorStore.getSnapshot()?.draft).toEqual(changed);
  expect(document.body.textContent).toContain("其他操作修改");
});


it("returns from explicit free movement to composition, preserving the draft before exit confirmation", async () => {
  await renderEditor();
  await click("自由移动");
  expect(lock).toBe(document.documentElement);
  expect(host.querySelector("[data-mode=fly]")).toBeTruthy();
  expect(host.textContent).toContain("W / S 前进 / 后退");
  await act(async () => worldCameraEditorStore.update(changed));
  await exit();
  expect(lock).toBeNull();
  expect(host.querySelector("[data-mode=compose]")).toBeTruthy();
  expect(worldCameraEditorStore.getSnapshot()?.phase).toBe("editing");
  expect(worldCameraEditorStore.getSnapshot()?.draft).toEqual(changed);
  expect(document.body.textContent).not.toContain("保存镜头调整？");
  await click("关闭");
  await click("继续调整");
  expect(lock).toBeNull();
  expect(document.documentElement.requestPointerLock).toHaveBeenCalledTimes(1);
});

it("keeps helpers and orbit tools local, and closes More before requesting editor exit", async () => {
  await renderEditor();
  await click("查看输出");
  await click("环绕");
  await click("选择环绕中心");
  expect(worldCameraEditorStore.changed()).toBe(false);
  expect(worldCameraEditorStore.getSnapshot()?.showHelpers).toBe(false);
  await click("机位精调");
  expect(host.querySelector("[data-camera-popover]")).toBeTruthy();
  await exit();
  expect(host.querySelector("[data-camera-popover]")).toBeNull();
  expect(worldCameraEditorStore.getSnapshot()?.phase).toBe("editing");
});

it("keeps parameter editing available when pointer lock is denied", async () => {
  document.documentElement.requestPointerLock = vi.fn(() => Promise.reject(new Error("denied")));
  await renderEditor();
  await click("自由移动");
  expect(host.querySelector("[data-mode=compose]")).toBeTruthy();
  expect(host.textContent).toContain("未能启用自由移动");
  expect(host.querySelector('input[type="range"]')?.hasAttribute("disabled")).toBe(false);
});
