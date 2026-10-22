/**
 * 片场单栏检查器与独立生成面板的交互回归。
 * （change: 2026-10-10-improve-film-set-editing-and-inspector，任务 6.1–6.5 / design D7）。
 *
 * 覆盖：镜头与对象同栏、构图按需展开、独立 AI 面板保留草稿；
 * 本地选择和收起操作不写规范内容，真实片场名称进入 header。
 *
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalFilmSetFields,
  createFilmSetSnapshot,
  createEmptyWoohaa3ServerCanvas,
  createModelSnapshot,
  type FilmSetContent,
  type ServerCanvas
} from "@woohaa3/contracts";
import type { FilmSetContext as Context } from "../src/integration/browser/context.js";
import { createTestCanvasState } from "./canvas-state.js";
const woohaa3CanvasStore = createTestCanvasState();
import { FilmSetObjectSession } from "../src/authoring/browser/object-session.js";
import { ModelEditorSession, CompositeAssetRegistry } from "@woohaa3/frontend/extension-api";
import { FilmSetPlaybackService } from "../src/preview/browser/playback-service.js";
import { FilmSetInspector } from "../src/authoring/browser/inspector.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  woohaa3CanvasStore.getState().applyRemoteCanvas(null as never);
});

const CONTENT: FilmSetContent = {
  schemaVersion: 3,
  items: [
    { id: "body", kind: "model", name: "角色", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, model: createModelSnapshot({ modelScript: `scene.box({id:"body"});`, modelScriptVersion: "woohaa-model-js-v2" }) },
    { id: "ground", kind: "ground", name: "地面", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 32, depth: 32 } }
  ]
};

/** 片场画布：一个动画3d 节点，含一个模型对象与一块地面；`withClip` 时含默认动画片段。 */
function filmSetCanvas(withClip = false): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  const animation = createFilmSetSnapshot({
    title: "跑酷片场",
    model: { modelScript: `scene.box({id:"body"});`, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: withClip ? `motion.root({ itemId: "model" });` : "",
    timeline: { duration: 5, loop: false },
    filmSetContent: CONTENT
  });
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "film", type: "composite-asset", position: { x: 0, y: 0 }, width: 196, height: 64 }] },
    nodeData: { film: canonicalFilmSetFields(animation) }
  } as unknown as ServerCanvas;
}

/** 稳定引用：useSyncExternalStore 的 getSnapshot 必须返回同一对象，避免无限重渲染。 */
const NAV_SNAPSHOT = { mode: { type: "overview" }, panel: null, menu: null } as const;
const READY_RUNTIME = { isReady: () => true } as const;
const CONTROLLER = { viewport: () => ({ x: 0, y: 0, zoom: 1 }), surface: () => ({ width: 1000, height: 800 }), focusProjection: () => null } as const;
const CAMERAS: Array<{ id: string; name: string; order: number; azimuth: number; elevation: number; distance: number; aspect: "16:9" }> = [];

function renderOverlay(canvas: ServerCanvas, initialCamera = false, options: { generate?: boolean; readOnly?: boolean } = {}) {
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
  const submitted: unknown[] = [];
  CAMERAS.length = 0;
  if (initialCamera) CAMERAS.push({ id: "scene", name: "场景镜头", order: 0, azimuth: 0, elevation: Math.PI / 4, distance: 6, aspect: "16:9" });
  const objectSession = new FilmSetObjectSession({
    readContent: () => CONTENT,
    isWritable: () => true,
    submitItemOp: ({ op }) => { submitted.push(op); return true; }
  });
  objectSession.enter("film");
  const session = new ModelEditorSession({
    readCameras: () => CAMERAS,
    isWritable: () => true,
    submitCameras: () => true
  });
  session.enter("film");
  const renderGenerate = vi.fn((_input: unknown) => <div data-host-generate><textarea defaultValue="修改构思" /><select defaultValue="model-b"><option value="model-a">A</option><option value="model-b">B</option></select></div>);
  const ctx = {
    canvasState: woohaa3CanvasStore.facade,
    compositeAssets: new CompositeAssetRegistry(), filmSetPlayback: new FilmSetPlaybackService(),
    modelWorkspace: { renderCameraPreview: () => <div data-camera-preview />, renderCameraPanel: () => <div data-camera-panel>镜头工具</div>, renderGenerate },
    canvasNavigation: {
      subscribe: () => () => undefined,
      getSnapshot: () => NAV_SNAPSHOT,
      openDialog: () => undefined
    },
    canvasRuntime: {
      modelFocusMode: () => options.readOnly ? "history" : "edit",
      runtime: () => READY_RUNTIME,
      controller: () => CONTROLLER,
      exitModelFocus: () => undefined,
      animationPlaybackState: () => null
    },
    canvasSession: {
      isWritable: () => true,
      submitCommands: (commands: unknown[]) => { submitted.push(...commands); return { ok: true, handle: { settled: Promise.resolve({ state: "committed", error: null }) } }; }
    },
    slots: {
      subscribe: () => () => undefined,
      version: () => 0,
      list: () => (options.generate ? [{ id: "demo-generate", owner: "chatgpt", render: () => <span data-raw-generate /> }] : [])
    }
  } as unknown as Context;
  const element = document.createElement("div");
  document.body.appendChild(element);
  root = createRoot(element);
  act(() => root!.render(
      <FilmSetInspector ctx={ctx} session={session} objectSession={objectSession} captureSession={{} as never} writable />
  ));
  return { submitted, objectSession, session, playback: ctx.filmSetPlayback, renderGenerate };
}

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label || b.getAttribute("aria-label") === label)!;
const target = () => document.querySelector<HTMLSelectElement>('[aria-label="AI 修改目标"]')!;

describe("FilmSetInspector single column and generation dock", () => {
  it("shows shots and objects together; expanding composition and selecting an object submit no commands", () => {
    const h = renderOverlay(filmSetCanvas(true), true);
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect(document.querySelector(".model-inspector-header h2")?.textContent).toBe("跑酷片场");
    expect(document.querySelector(".film-set-animation-controls")).not.toBeNull();
    expect(document.querySelector(".film-set-object-list")).not.toBeNull();
    const composition = document.querySelector<HTMLDetailsElement>(".film-set-composition")!;
    expect(composition.open).toBe(false);
    act(() => { composition.querySelector("summary")!.click(); h.objectSession.select("body"); });
    expect(composition.open).toBe(true);
    expect(document.querySelector(".film-set-object-fields")).not.toBeNull();
    expect(h.submitted).toHaveLength(0);
  });

  it("uses the host dock outside the sidebar with the current shot precondition", () => {
    const h = renderOverlay(filmSetCanvas(true), false, { generate: true });
    expect(document.querySelector(".model-inspector-scroll [data-host-generate]")).toBeNull();
    expect(document.querySelector(".film-set-generate-dock [data-host-generate]")).not.toBeNull();
    expect(document.querySelector("[data-raw-generate]")).toBeNull();
    expect(h.renderGenerate).toHaveBeenLastCalledWith(expect.objectContaining({
      nodeId: "film", mode: "film-set", presentation: "dock", writable: true, clipId: "clip-1", itemId: null, expectedContentHash: expect.any(String)
    }));
  });

  it("collapse and restore retain the same composer, draft and model selection", () => {
    const h = renderOverlay(filmSetCanvas(true), false, { generate: true });
    const composer = document.querySelector<HTMLTextAreaElement>("[data-host-generate] textarea")!;
    composer.value = "保留这段未提交输入";
    const model = document.querySelector<HTMLSelectElement>("[data-host-generate] select")!;
    model.value = "model-a";
    act(() => button("收起 AI 修改").click());
    expect(document.querySelector<HTMLDivElement>(".film-set-generate-dock__expanded")!.hidden).toBe(true);
    act(() => button("AI 修改").click());
    expect(document.querySelector("[data-host-generate] textarea")).toBe(composer);
    expect(composer.value).toBe("保留这段未提交输入");
    expect(model.value).toBe("model-a");
    expect(h.submitted).toHaveLength(0);
  });

  it("composition temporarily collapses AI; restoring AI closes the camera preview and keeps the composer", () => {
    const h = renderOverlay(filmSetCanvas(true), true, { generate: true });
    const composer = document.querySelector("[data-host-generate] textarea");
    const composition = document.querySelector<HTMLDetailsElement>(".film-set-composition")!;
    act(() => h.objectSession.select("body"));
    expect(document.querySelector("[data-camera-preview]")).toBeNull();
    act(() => composition.querySelector("summary")!.click());
    expect(h.objectSession.getState().selectedItemId).toBeNull();
    expect(h.session.getState().toolMode).toBe("camera");
    expect(document.querySelector("[data-camera-preview]")).not.toBeNull();
    expect(document.querySelector<HTMLDivElement>(".film-set-generate-dock__expanded")!.hidden).toBe(true);
    act(() => button("AI 修改").click());
    expect(composition.open).toBe(false);
    expect(h.session.getState().toolMode).toBe("model");
    expect(document.querySelector("[data-camera-preview]")).toBeNull();
    expect(document.querySelector("[data-host-generate] textarea")).toBe(composer);
    expect(h.submitted).toHaveLength(0);
  });

  it("selection targets an object; whole shot override preserves scene selection and stays read only locally", () => {
    const h = renderOverlay(filmSetCanvas(true), false, { generate: true });
    act(() => h.objectSession.select("ground"));
    expect(h.renderGenerate).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: "ground", writable: false }));
    act(() => { target().value = ""; target().dispatchEvent(new Event("change", { bubbles: true })); });
    expect(h.objectSession.getState().selectedItemId).toBe("ground");
    expect(h.renderGenerate).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: null, writable: true }));
    act(() => h.objectSession.select("body"));
    expect(target().value).toBe("body");
    expect(h.submitted).toHaveLength(0);
  });

  it("joining a shot submits one checked binding command and disables the history path", async () => {
    const h = renderOverlay(filmSetCanvas(true), false, { generate: true });
    act(() => h.objectSession.select("ground"));
    await act(async () => { button("加入当前拍摄镜头").click(); });
    expect(h.submitted).toEqual([expect.objectContaining({ type: "filmSet.clipPatch", clipId: "clip-1", expectedHash: expect.any(String),
      op: expect.objectContaining({ kind: "binding", itemId: "ground", expectedAdapterHash: expect.any(String) }) })]);
  });

  it("preview hides the composer without unmounting it; returning to edit restores it", () => {
    const h = renderOverlay(filmSetCanvas(true), false, { generate: true });
    const composer = document.querySelector("[data-host-generate] textarea");
    act(() => h.playback.preview());
    expect(document.querySelector<HTMLDivElement>(".film-set-generate-dock")!.hidden).toBe(true);
    act(() => h.playback.edit());
    expect(document.querySelector<HTMLDivElement>(".film-set-generate-dock")!.hidden).toBe(false);
    expect(document.querySelector("[data-host-generate] textarea")).toBe(composer);
  });

  it("history hides AI and prevents object binding", () => {
    const h = renderOverlay(filmSetCanvas(true), false, { generate: true, readOnly: true });
    act(() => h.objectSession.select("ground"));
    expect(document.querySelector<HTMLDivElement>(".film-set-generate-dock")!.hidden).toBe(true);
    expect(button("加入当前拍摄镜头").disabled).toBe(true);
    expect(h.renderGenerate).toHaveBeenLastCalledWith(expect.objectContaining({ writable: false }));
    expect(h.submitted).toHaveLength(0);
  });

  it("no shots blocks generation; no contribution does not mount a floating dock", () => {
    const h = renderOverlay(filmSetCanvas(), false, { generate: true });
    expect(h.renderGenerate).toHaveBeenLastCalledWith(expect.objectContaining({ clipId: null, writable: false, disabledReason: expect.stringContaining("拍摄镜头") }));
  });
});
