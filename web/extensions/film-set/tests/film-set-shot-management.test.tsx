/**
 * 拍摄镜头管理工作区测试
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 6.5）。
 *
 * 覆盖：空集合状态、静态/动态各自操作、显式类型转换与影响提示、选择为本地状态。
 * 断言命令形状与 canonical 不变式，不依赖渲染器。
 *
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalFilmSetFields,
  createFilmSetSnapshot,
  createEmptyWoohaa3ServerCanvas,
  createMotionSnapshot,
  filmSetAnimationsOf,
  type FilmSetAnimationClip,
  type FilmSetAnimations,
  type ServerCanvas
} from "@woohaa3/contracts";
import type { FilmSetContext as Context } from "../src/integration/browser/context.js";
import { createTestCanvasState } from "./canvas-state.js";
const store = createTestCanvasState();
import { FilmSetAnimationControls } from "../src/authoring/browser/film-set-animation-controls.js";
import { FilmSetPlaybackService } from "../src/preview/browser/playback-service.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  store.getState().applyRemoteCanvas(null as never);
});

const MODEL = `scene.box({ id: "body" });`;

function staticClip(id: string, name: string): FilmSetAnimationClip {
  return {
    id,
    name,
    kind: "static",
    timeline: { duration: 0, loop: false },
    initialCamera: { azimuth: 0, elevation: Math.PI / 4, distance: 6, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } },
    cameraMotion: createMotionSnapshot({ motionScript: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }),
    bindings: []
  };
}

function dynamicClip(id: string, name: string, motionScript: string): FilmSetAnimationClip {
  return {
    ...staticClip(id, name),
    kind: "dynamic",
    timeline: { duration: 4, loop: true },
    cameraMotion: createMotionSnapshot({ motionScript, basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }),
    bindings: []
  };
}

function canvasWith(animations: FilmSetAnimations): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  const animation = createFilmSetSnapshot({ title: "片场", model: { modelScript: MODEL, modelScriptVersion: "woohaa-model-js-v2" }, timeline: { duration: 4, loop: false } });
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [{ id: "film", type: "composite-asset", position: { x: 0, y: 0 }, width: 400, height: 300 }] },
    nodeData: { film: canonicalFilmSetFields({ ...animation, filmSetAnimations: animations }) }
  } as unknown as ServerCanvas;
}

function render(animations: FilmSetAnimations, options: { writable?: boolean } = {}) {
  const canvas = canvasWith(animations);
  store.getState().applyRemoteCanvas(canvas as never);
  const submitted: Array<{ type: string; clipId: string; op: { kind: string; clip?: unknown; confirmClearContent?: boolean; duration?: number } }> = [];
  const playback = new FilmSetPlaybackService();
  const ctx = {
    canvasState: store.facade,
    compositeAssets: {
      subscribe: () => () => undefined,
      getRevision: () => 0,
      projectCanvas: (value: ServerCanvas | null) => value
    },
    filmSetPlayback: playback,
    modelWorkspace: { session: { cameras: () => [] } },
    canvasSession: {
      submitCommands: (commands: typeof submitted) => { submitted.push(...commands); return { ok: true, handle: { settled: Promise.resolve({ state: "committed", error: null }) } }; }
    }
  } as unknown as Context;
  const element = document.createElement("div");
  document.body.appendChild(element);
  root = createRoot(element);
  const writable = options.writable ?? true;
  act(() => root!.render(<FilmSetAnimationControls ctx={ctx} nodeId="film" writable={writable} cameraId={null} />));
  const button = (name: string) => [...document.querySelectorAll("button")].find(entry => entry.textContent === name || entry.getAttribute("aria-label") === name);
  return { submitted, playback, button, writable };
}

describe("拍摄镜头管理工作区（任务 6.5）", () => {
  it("空集合显示创建入口、禁用预览，且不自动创建镜头", () => {
    const h = render({ schemaVersion: 3, defaultClipId: null, clips: [] });
    expect(document.querySelector(".film-set-animation-controls")?.textContent).toContain("还没有拍摄镜头");
    expect(h.button("动画预览")?.disabled).toBe(true);
    act(() => h.button("新建拍摄镜头")!.click());
    expect(h.button("新建静态镜头")?.disabled).toBe(false);
    expect(h.button("新建动态镜头")?.disabled).toBe(false);
    expect(h.submitted).toHaveLength(0);
  });

  it("静态镜头隐藏时长/循环，显示转换入口，新建保持零时长", () => {
    const h = render({ schemaVersion: 3, defaultClipId: "s1", clips: [staticClip("s1", "定妆照")] });
    const text = document.querySelector(".film-set-animation-controls")!.textContent!;
    expect(text).toContain("静态镜头保持零时长");
    act(() => h.button("拍摄镜头操作")!.click());
    expect(h.button("转为动态镜头")).toBeTruthy();
    expect(document.querySelector(".film-set-animation-controls input[type=checkbox]")).toBeNull();
    expect(h.submitted).toHaveLength(0);
  });

  it("动态→静态先呈现清除影响，确认后才提交 set-kind", async () => {
    const h = render({ schemaVersion: 3, defaultClipId: "d1", clips: [dynamicClip("d1", "运镜", `motion.camera.orbit({ speed: 1 });`)] });
    expect(document.querySelector(".film-set-animation-controls")!.textContent).toContain("动态镜头");
    act(() => h.button("拍摄镜头操作")!.click());
    act(() => h.button("转为静态镜头")!.click());
    expect(document.querySelector(".film-set-animation-controls")!.textContent).toContain("镜头运动");
    expect(h.submitted).toHaveLength(0);
    await act(async () => { h.button("确认转换")!.click(); });
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.op).toMatchObject({ kind: "set-kind", toKind: "static", confirmClearContent: true });
  });

  it("静态→动态要求显式正时长后提交", async () => {
    const h = render({ schemaVersion: 3, defaultClipId: "s1", clips: [staticClip("s1", "定妆照")] });
    act(() => h.button("拍摄镜头操作")!.click());
    act(() => h.button("转为动态镜头")!.click());
    const duration = document.querySelector(".film-set-animation-controls input[type=number]") as HTMLInputElement;
    expect(duration).not.toBeNull();
    await act(async () => { h.button("确认转换")!.click(); });
    expect(h.submitted[0]!.op).toMatchObject({ kind: "set-kind", toKind: "dynamic" });
    expect((h.submitted[0]!.op.duration ?? 0) > 0).toBe(true);
  });

  it("新建动态镜头携带 kind 与正时长，选择只改本地播放状态", async () => {
    const h = render({ schemaVersion: 3, defaultClipId: null, clips: [] });
    act(() => h.button("新建拍摄镜头")!.click());
    await act(async () => { h.button("新建动态镜头")!.click(); });
    expect(h.submitted).toHaveLength(1);
    const op = h.submitted[0]!.op as { kind: string; clip: { kind: string; timeline: { duration: number } } };
    expect(op.kind).toBe("create");
    expect(op.clip.kind).toBe("dynamic");
    expect(op.clip.timeline.duration).toBeGreaterThan(0);
    // 选择是本地状态：不写 defaultClipId（本画布 canonical 未变）。
    expect(h.playback.getSnapshot().nodeId).toBe("film");
    const saved = store.facade.getCanvas()!;
    const collection = filmSetAnimationsOf(saved.nodeData["film"] as never);
    expect(collection.defaultClipId).toBeNull();
  });

  it("只读时写入口禁用但查看与选择仍可用", () => {
    const h = render({ schemaVersion: 3, defaultClipId: "s1", clips: [staticClip("s1", "定妆照")] }, { writable: false });
    expect(h.button("新建拍摄镜头")?.disabled).toBe(true);
    act(() => h.button("拍摄镜头操作")!.click());
    for (const name of ["复制", "删除", "设为默认", "转为动态镜头"]) {
      expect(h.button(name)?.disabled).toBe(true);
    }
    expect(h.button("动画预览")?.disabled).toBe(false);
    expect(h.submitted).toHaveLength(0);
  });
});


it.each(["短名", "audit-fixes-20261019-这是一个合法的长镜头名称", "无空格镜头名称".repeat(8)])("long shot label %s preserves full submitted name and duration", async name => {
  const h=render({schemaVersion:3,defaultClipId:"long",clips:[dynamicClip("long",name,"")]});
  const label=[...document.querySelectorAll("label")].find(label=>label.textContent?.startsWith("名称"))!;
  const input=label.querySelector("input")!;
  expect(input.value).toBe(name);
  const next=name+"新";
  input.value=next;
  await act(async()=>input.dispatchEvent(new FocusEvent("focusout",{bubbles:true})));
  expect(h.submitted).toContainEqual(expect.objectContaining({op:expect.objectContaining({kind:"rename",name:next})}));
  const duration=document.querySelector<HTMLInputElement>('.film-set-animation-controls input[type="number"]')!;
  duration.value="3";
  await act(async()=>duration.dispatchEvent(new FocusEvent("focusout",{bubbles:true})));
  expect(h.submitted).toContainEqual(expect.objectContaining({op:expect.objectContaining({kind:"timeline",timeline:expect.objectContaining({duration:3})})}));
});
