// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, IMAGE_DIRECTOR_SCENE_DEFAULT_PROMPT } from "@woohaa3/contracts";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { ImageDirectorPanel, imageDirectorSceneExtension } from "./plugin.js";
import { rememberAssistantPreference } from "../../services/assistant-execution/selection.js";

it("keeps model-specific effort drafts when the creation dialog closes and reopens", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const scope = "director-effort-drafts";
  rememberAssistantPreference(scope, { sourceId: "adapter", connectionId: "connection", model: "a", reasoningEffort: "high" });
  const service = { getDataScopeId: () => scope, listConnections: async () => ({ ok: true, value: [{ connectionId: "connection", adapterId: "adapter", name: "助手", ready: true, capabilities: { tools: true, targets: ["world"], textDelivery: { imageInput: true, maxImages: 1 } }, models: [{ id: "a", label: "模型 A", reasoningEfforts: ["high"] }, { id: "b", label: "模型 B", reasoningEfforts: ["low"] }] }] }) };
  const ctx = { get: () => service, canvasSession: { isWritable: () => true }, canvasNavigation: { openDialog: vi.fn() } };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const render = (key: string) => root.render(<ImageDirectorPanel key={key} ctx={ctx as never} canvasId={scope} nodeId="image" visible onClose={() => {}} />);
  const choose = async (label: string) => {
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="来源与模型"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.generation-directory__model')].find(b => b.textContent?.includes(label))!.click());
  };
  try {
    await act(async () => render("first"));
    await choose("模型 B"); expect(host.querySelector('button[aria-label="生成参数"]')?.textContent).not.toContain("高");
    await act(async () => render("reopened"));
    await choose("模型 A"); expect(host.querySelector('button[aria-label="生成参数"]')?.textContent).toContain("高");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("uses the original dialog and assistant toolbar, then closes on explicit generation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const canvas = createEmptyWoohaa3ServerCanvas("dialog-test");
  canvas.document.nodes.push({ id: "image", type: "image", position: { x: 0, y: 0 } });
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  rememberAssistantPreference("dialog-test", { sourceId: "adapter", connectionId: "connection", model: "model", reasoningEffort: "" });
  const submitImageDirectorScene = vi.fn(async (_input: { requestId: string }) => ({ ok: true, value: { conversationId: "conversation", turn: { target: { nodeId: "director" } } } }));
  const listConnections = vi.fn(async () => ({ ok: true, value: [{ connectionId: "connection", adapterId: "adapter", name: "助手", ready: true, capabilities: { tools: true, targets: ["world"], textDelivery: { imageInput: true, maxImages: 1 } }, models: [{ id: "model", label: "模型" }] }] }));
  const service = { getDataScopeId: () => "dialog-test", listConnections, submitImageDirectorScene };
  const openDialog = vi.fn(), onClose = vi.fn();
  const ctx = { get: () => service, applicationRemote: { transport: { request: async () => ({ ok: true, data: null }) } }, canvasSession: { isWritable: () => true }, canvasNavigation: { openDialog } };
  const host = document.createElement("div"), root = createRoot(host);
  const intent = { accept: vi.fn(), cancel: vi.fn() };
  const beginSelection = vi.fn(() => intent);
  await act(async () => root.render(<ImageDirectorPanel ctx={ctx as never} canvasId="dialog-test" nodeId="image" visible onClose={onClose} beginSelection={beginSelection} />));
  expect(host.querySelector(".dlg--md .dlg__header .dlg__title")?.textContent).toBe("生成模型与导演区");
  expect(host.querySelector(".assistant-toolbar .assistant-toolbar__selection")?.textContent).toContain("助手");
  const generate = host.querySelector<HTMLButtonElement>(".assistant-toolbar__submit button")!;
  expect(generate.textContent).toBe("生成");
  expect(generate.disabled).toBe(false);
  expect(submitImageDirectorScene).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>("button[title='刷新助手']")!.click());
  expect(listConnections).toHaveBeenCalledTimes(2);
  await act(async () => host.querySelector<HTMLButtonElement>("button[title='管理助手']")!.click());
  expect(openDialog).toHaveBeenCalledWith({ dialogId: "agent-assistant", payload: { canvasId: "dialog-test" } });
  await act(async () => generate.click());
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(beginSelection).toHaveBeenCalledTimes(1);
  expect(intent.accept).toHaveBeenCalledWith("director");
  expect(intent.cancel).not.toHaveBeenCalled();
  expect(submitImageDirectorScene).toHaveBeenCalledTimes(1);
  const firstId = submitImageDirectorScene.mock.calls[0]?.[0]?.requestId;
  await act(async () => root.render(<ImageDirectorPanel key="new-opening" ctx={ctx as never} canvasId="dialog-test" nodeId="image" visible onClose={onClose} />));
  expect(host.querySelector("textarea")!.disabled).toBe(false);
  expect(host.textContent).not.toContain("核对原请求");
  await act(async () => host.querySelector<HTMLButtonElement>(".assistant-toolbar__submit button")!.click());
  expect(submitImageDirectorScene).toHaveBeenCalledTimes(2);
  expect(submitImageDirectorScene.mock.calls[1]?.[0]?.requestId).not.toBe(firstId);
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("opens a fresh creation form without restoring or polling source-image executions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const canvas = createEmptyWoohaa3ServerCanvas("fresh-form");
  canvas.document.nodes.push({ id: "image", type: "image", position: { x: 0, y: 0 } });
  canvas.nodeData.image = { title: "来源图片", outputAssetId: "asset" };
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const request = vi.fn(async () => ({ ok: true, data: { requestId: "old", stage: "generating" } }));
  const service = { getDataScopeId: () => "fresh-form", listConnections: async () => ({ ok: true, value: [] }) };
  const ctx = { get: () => service, applicationRemote: { transport: { request } }, canvasSession: { isWritable: () => true }, canvasNavigation: { openDialog: vi.fn() } };
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<ImageDirectorPanel ctx={ctx as never} canvasId="fresh-form" nodeId="image" visible onClose={() => {}} />));
  expect(host.querySelector("textarea")!.value).toBe(IMAGE_DIRECTOR_SCENE_DEFAULT_PROMPT);
  expect(request).not.toHaveBeenCalled();
  for (const label of ["停止", "执行详情", "核对原请求", "重试保存", "重试放置", "另建一套"]) expect(host.textContent).not.toContain(label);
  expect(workingCanvasOf(woohaa3CanvasStore.getState())?.nodeData.image).toEqual(canvas.nodeData.image);
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("contributes the same image action to toolbar, context menu and focus header", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const canvas = createEmptyWoohaa3ServerCanvas("slots-test");
  canvas.document.nodes.push({ id: "image", type: "image", position: { x: 0, y: 0 }, parentId: "group" });
  canvas.nodeData.image = { outputAssetId: "asset" };
  canvas.assets.push({ id: "asset", mediaKind: "image", status: "ready", source: "uploaded", title: "image", createdAt: "2026-11-03T00:00:00Z" } as never);
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const entries = new Map<string, any>();
  const service = { getDataScopeId: () => "slots", listConnections: async () => ({ ok: true, value: [] }), subscribe: () => () => {}, getSnapshot: () => null };
  const ctx = { slots: { register: (slot: string, value: unknown) => { entries.set(slot, value); return () => {}; } }, effect: () => {}, get: () => service, canvasSession: { isWritable: () => true }, canvasNavigation: { openDialog: vi.fn() }, applicationRemote: { transport: { request: async () => ({ ok: true, data: null }) } } };
  imageDirectorSceneExtension({ canvasId: "slots-test" })(ctx as never);
  expect(entries.get("canvas.node-action").describe({ nodeId: "image", writable: true })).toMatchObject({ label: "转 3D", enabled: true });
  expect(entries.get("canvas.context-menu").items({ nodeId: "image", writable: true })).toMatchObject([{ label: "生成模型与导演区" }]);
  const Focus = entries.get("canvas.focus-header").render;
  const overlay = entries.get("canvas.overlay");
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => { root.render(<><Focus nodeId="image" />{overlay.render({ writable: true })}</>); });
  await act(async () => { host.querySelector<HTMLButtonElement>("button[title='生成模型与导演区']")!.click(); });
  expect(host.textContent).toContain("生成模型与导演区");
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

