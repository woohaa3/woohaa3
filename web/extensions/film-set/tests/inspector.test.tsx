/**
 * 三栏片场、当前镜头输出与整个片场 AI 的交互回归。
 * 选择、折叠、预览和历史只改变呈现，不复制草稿或写入规范内容。
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
  animationSnapshotHash, readFilmSetAnimationProjection, createFilmSetGroupMarker, staticShotCameraMotion,
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
  schemaVersion: 4,
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
    modelWorkspace: { session, renderCameraPreview: () => <div data-camera-preview />, renderCameraPanel: () => <div data-camera-panel>镜头工具</div>, renderGenerate },
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
    canvasEdit: { record: async (commands: typeof submitted) => { submitted.push(...commands); return { ok: true }; } },
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
  const onLayoutChange = vi.fn();
  document.body.appendChild(element);
  root = createRoot(element);
  act(() => root!.render(
      <FilmSetInspector ctx={ctx} session={session} objectSession={objectSession} captureSession={{} as never} writable onLayoutChange={onLayoutChange} />
  ));
  return { submitted, objectSession, session, playback: ctx.filmSetPlayback, renderGenerate, onLayoutChange };
}

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label || b.getAttribute("aria-label") === label)!;

describe("FilmSetInspector three columns and whole-set generation", () => {
  it("separates lists and properties; selecting a shot activates tools without expanding composition", () => {
    const h = renderOverlay(filmSetCanvas(true), true);
    expect(document.querySelector(".model-inspector-header h2")?.textContent).toBe("对象属性");
    act(() => h.objectSession.select("body"));
    expect(document.querySelector(".film-set-object-fields")).not.toBeNull();
    act(() => document.querySelector<HTMLButtonElement>(".film-set-shot-card")!.click());
    // 构图不再折叠成 details；选中镜头后属性区直接显示镜头分区。
    expect(document.querySelector(".film-set-composition")).toBeNull();
    expect(document.querySelector(".film-set-property-section")).not.toBeNull();
    expect(document.querySelector(".film-set-current-shot select")).toBeNull();
    // 观察方向走共享 SelectInput，不再渲染浏览器原生下拉。
    expect(document.querySelector(".film-set-view-bar select")).toBeNull();
    expect(button("自由观察方式").classList.contains("ui-select-input")).toBe(true);
    expect(button("动画预览")).toBeUndefined();
    expect(h.session.getState().toolMode).toBe("camera");
    expect(h.objectSession.getState().selectedItemId).toBe("body");
    expect(document.querySelector("[data-camera-preview]")).not.toBeNull();
    const list = document.querySelector(".film-set-navigation")!;
    expect(list.querySelector(".film-set-object-list")).not.toBeNull();
    expect(list.querySelectorAll("ul")).toHaveLength(1);
    expect(list.querySelector(".film-set-shot-list")).toBeNull();
    const sharedList = list.querySelector("ul")!;
    expect(sharedList.querySelector('[aria-label^="模型 ·"]')).not.toBeNull();
    const shotRow = list.querySelector<HTMLButtonElement>('[aria-label^="镜头 ·"]')!;
    expect(shotRow).not.toBeNull();
    act(() => shotRow.click());
    expect(shotRow.getAttribute("aria-selected")).toBe("true");
    expect(sharedList.querySelectorAll('[aria-selected="true"]')).toHaveLength(0);
    expect(list.querySelectorAll('.film-set-shot-card[aria-selected="true"]')).toHaveLength(1);
    expect(document.querySelector(".film-set-list-tabs")).toBeNull();
    expect(h.session.getState().toolMode).toBe("camera");
    expect(document.querySelectorAll(".film-set-viewport-tools button")).toHaveLength(6);
    expect(button("移动对象")).toBeUndefined();
    act(() => sharedList.querySelector<HTMLButtonElement>('[aria-label^="模型 ·"]')!.click());
    expect(document.querySelectorAll(".film-set-viewport-tools button")).toHaveLength(5);
    act(() => button("移动对象").click());
    expect(h.session.getState().toolMode).toBe("model");
    expect(h.objectSession.selectedItem()?.id).toBe("body");
    expect(h.submitted).toHaveLength(0);
  });

  it("floating tools cancel object drafts, select the real tool and contain canvas input", () => {
    const h = renderOverlay(filmSetCanvas(true), true);
    act(() => { h.objectSession.select("body"); h.objectSession.beginEdit(); h.objectSession.updatePreview({ offset: { x: 3, y: 0, z: 0 }, yaw: 0, scale: 1 }); });
    expect(h.objectSession.getState().preview?.offset.x).toBe(3);
    const tool = button("Y 旋转");
    expect(tool.textContent).toBe(""); expect(tool.querySelector("svg")).not.toBeNull();
    act(() => tool.click());
    expect(h.objectSession.getState().preview).toBeNull(); expect(h.objectSession.getState().tool).toBe("yaw");
    expect(tool.getAttribute("data-active")).toBe("true");
    const leaked = vi.fn(); document.addEventListener("pointerdown", leaked); document.addEventListener("wheel", leaked);
    act(() => { tool.dispatchEvent(new Event("pointerdown", { bubbles: true })); tool.dispatchEvent(new Event("wheel", { bubbles: true })); });
    document.removeEventListener("pointerdown", leaked); document.removeEventListener("wheel", leaked);
    expect(leaked).not.toHaveBeenCalled();
    act(() => button("网格").click()); expect(button("网格").getAttribute("data-active")).toBe("false");
    act(() => button("选择对象").click()); expect(h.objectSession.selectedItem()).toBeNull();
    expect(button("移动对象").disabled).toBe(true); expect(h.submitted).toHaveLength(0);
  });

  it("uses the host dock outside the sidebar with the whole-set precondition", () => {
    const h = renderOverlay(filmSetCanvas(true), false, { generate: true });
    expect(document.querySelector(".model-inspector-scroll [data-host-generate]")).toBeNull();
    expect(document.querySelector(".film-set-generate-dock [data-host-generate]")).not.toBeNull();
    expect(document.querySelector("[data-raw-generate]")).toBeNull();
    expect(h.renderGenerate).toHaveBeenLastCalledWith(expect.objectContaining({
      nodeId: "film", mode: "film-set", presentation: "dock", writable: true, clipId: null, itemId: null, expectedContentHash: animationSnapshotHash(readFilmSetAnimationProjection(filmSetCanvas(true), "film")!)
    }));
  });

  it("collapse and restore retain the same composer, draft and model selection", () => {
    const h = renderOverlay(filmSetCanvas(true), false, { generate: true });
    const composer = document.querySelector<HTMLTextAreaElement>("[data-host-generate] textarea")!;
    composer.value = "保留这段未提交输入";
    const model = document.querySelector<HTMLSelectElement>("[data-host-generate] select")!;
    model.value = "model-a";
    const overlay = document.querySelector(".film-set-viewport-overlay")!;
    expect(overlay.querySelector(".film-set-generate-dock")).not.toBeNull();
    expect(document.querySelector(".film-set-bottom .film-set-generate-dock")).toBeNull();
    const toggle = overlay.querySelector<HTMLButtonElement>('.film-set-viewport-tools [aria-label="收起场景 AI"]')!;
    expect(toggle.getAttribute("data-active")).toBe("true");
    h.onLayoutChange.mockClear();
    act(() => toggle.click());
    expect(document.querySelector<HTMLElement>(".film-set-generate-dock")!.hidden).toBe(true);
    expect(document.querySelector<HTMLDivElement>(".film-set-generate-dock__expanded")!.hidden).toBe(true);
    expect(toggle.getAttribute("data-active")).toBe("false");
    act(() => toggle.click());
    expect(document.querySelector<HTMLElement>(".film-set-generate-dock")!.hidden).toBe(false);
    expect(h.onLayoutChange).not.toHaveBeenCalled();
    expect(document.querySelector("[data-host-generate] textarea")).toBe(composer);
    expect(composer.value).toBe("保留这段未提交输入");
    expect(model.value).toBe("model-a");
    expect(h.submitted).toHaveLength(0);
  });

  it("shot properties are presentation only and never collapse AI or clear selection", () => {
    const h = renderOverlay(filmSetCanvas(true), true, { generate: true });
    const composer = document.querySelector("[data-host-generate] textarea");
    act(() => h.objectSession.select("body"));
    act(() => document.querySelector<HTMLButtonElement>(".film-set-shot-card")!.click());
    act(() => button("推拉").click());
    // 构图与画幅直接展开为属性分区；切换工具只改变呈现。
    expect(document.querySelector(".film-set-composition")).toBeNull();
    expect(document.querySelector(".film-set-camera-properties")).not.toBeNull();
    expect(document.querySelector(".film-set-property-section")).not.toBeNull();
    expect(h.objectSession.getState().selectedItemId).toBe("body");
    expect(h.session.getState().toolMode).toBe("camera");
    expect(h.session.getState().cameraTool).toBe("distance");
    expect(document.querySelector<HTMLDivElement>(".film-set-generate-dock__expanded")!.hidden).toBe(false);
    expect(document.querySelector("[data-host-generate] textarea")).toBe(composer);
    expect(h.submitted).toHaveLength(0);
  });

  it("object and shot inspection keep the same whole-set target and composer", () => {
    const h = renderOverlay(filmSetCanvas(true), true, { generate: true });
    const composer = document.querySelector("[data-host-generate] textarea");
    act(() => h.objectSession.select("ground"));
    expect(h.renderGenerate).toHaveBeenLastCalledWith(expect.objectContaining({ clipId: null, itemId: null, writable: true }));
    act(() => document.querySelector<HTMLButtonElement>(".film-set-shot-card")!.click());
    act(() => h.objectSession.select("body"));
    expect(h.renderGenerate).toHaveBeenLastCalledWith(expect.objectContaining({ clipId: null, itemId: null, writable: true }));
    expect(document.querySelector('[aria-label="AI 修改目标"]')).toBeNull();
    expect(document.querySelector("[data-host-generate] textarea")).toBe(composer);
    expect(h.submitted).toHaveLength(0);
  });

  it("joining a shot submits one checked binding command and disables the history path", async () => {
    const h = renderOverlay(filmSetCanvas(true), false, { generate: true });
    act(() => h.objectSession.select("ground"));
    await act(async () => { button("为此镜头启用对象动作").click(); });
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
    expect(button("为此镜头启用对象动作").disabled).toBe(true);
    expect(h.renderGenerate).toHaveBeenLastCalledWith(expect.objectContaining({ writable: false }));
    expect(h.submitted).toHaveLength(0);
  });

  it("empty group without shots permits whole-set generation without creating content", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c1");
    canvas.document.nodes.push({ id: "film", type: "group", position: { x: 0, y: 0 } });
    canvas.nodeData.film = { title: "空片场", filmSetGroup: createFilmSetGroupMarker({ clips: [] }) };
    const h = renderOverlay(canvas, false, { generate: true });
    expect(h.renderGenerate).toHaveBeenLastCalledWith(expect.objectContaining({ clipId: null, itemId: null, writable: true }));
    expect(button("镜头预览").disabled).toBe(true);
    expect(h.submitted).toHaveLength(0);
  });

  it("navigation and AI collapse report occupied edges and do not change selection or draft", () => {
    const h = renderOverlay(filmSetCanvas(true), true, { generate: true });
    const composer = document.querySelector<HTMLTextAreaElement>("[data-host-generate] textarea")!;
    composer.value = "保持整体草稿";
    act(() => h.objectSession.select("body"));
    act(() => button("收起导航").click());
    expect(document.querySelector('.film-set-navigation')?.getAttribute('data-collapsed')).toBe("true");
    act(() => button("展开").click());
    expect(h.objectSession.getState().selectedItemId).toBe("body");
    expect(composer.value).toBe("保持整体草稿");
    expect(document.querySelector("[data-host-generate] textarea")).toBe(composer);
    expect(h.submitted).toHaveLength(0);
  });

  it("static preview uses the exact saved camera and cancels pending writes without an animation player", () => {
    const canvas = filmSetCanvas(true);
    const fields = canvas.nodeData.film as unknown as { filmSetAnimations: { clips: Array<{ kind: string; timeline: { duration: number; loop: boolean }; cameraMotion: ReturnType<typeof staticShotCameraMotion>; bindings: unknown[] }> } };
    Object.assign(fields.filmSetAnimations.clips[0]!, { kind: "static", timeline: { duration: 0, loop: false }, cameraMotion: staticShotCameraMotion(), bindings: [] });
    const h = renderOverlay(canvas, true, { generate: true });
    act(() => { h.session.beginPose(); h.session.updatePose({ azimuth: 0.6 }); });
    act(() => button("镜头预览").click());
    expect(h.playback.getSnapshot().preview).toBe(true);
    expect(h.session.getState().posePreview).toBeNull();
    expect(document.querySelector(".film-set-animation-player")).toBeNull();
    expect(document.querySelector<HTMLDivElement>(".film-set-generate-dock")!.hidden).toBe(true);
    act(() => button("场景编辑").click());
    expect(h.playback.getSnapshot().preview).toBe(false);
    expect(h.submitted).toHaveLength(0);
  });

  it("dynamic playback is available in edit mode and cancels uncommitted poses before preview", () => {
    const h = renderOverlay(filmSetCanvas(true), true);
    expect(document.querySelector(".film-set-animation-player")).not.toBeNull();
    act(() => { h.session.beginPose(); h.session.updatePose({ azimuth: 0.5 }); });
    act(() => button("播放").click());
    expect(h.playback.getSnapshot().preview).toBe(true);
    expect(h.session.getState().posePreview).toBeNull();
    expect(document.querySelector<HTMLDivElement>(".film-set-viewport-tools")!.hidden).toBe(true);
    act(() => button("场景编辑").click());
    expect(h.playback.getSnapshot().preview).toBe(false);
    expect(h.submitted).toHaveLength(0);
  });

});
