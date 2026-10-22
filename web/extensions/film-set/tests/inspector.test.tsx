/**
 * 片场检查器任务页签测试
 * （change: 2026-10-10-improve-film-set-editing-and-inspector，任务 6.1–6.5 / design D7）。
 *
 * 覆盖：单一 inspector owner 拆为对象/镜头/动画三页；对象与镜头选择联动切页；
 * 切换页签不写规范内容；真实片场名称进入 header。
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
import type { FilmSetContext as Context } from "../src/frontend/context.js";
import { createTestCanvasState } from "./canvas-state.js";
const woohaa3CanvasStore = createTestCanvasState();
import { FilmSetObjectSession } from "../src/shared.js";
import { ModelEditorSession, CompositeAssetRegistry } from "@woohaa3/frontend/extension-api";
import { FilmSetPlaybackService } from "../src/frontend/playback-service.js";
import { FilmSetInspector } from "../src/frontend/inspector.js";

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

function renderOverlay(canvas: ServerCanvas, initialCamera = false, options: { generate?: boolean } = {}) {
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
  const renderGenerate = vi.fn((_input: unknown) => <div data-host-generate>生成</div>);
  const ctx = {
    canvasState: woohaa3CanvasStore.facade,
    compositeAssets: new CompositeAssetRegistry(), filmSetPlayback: new FilmSetPlaybackService(),
    modelWorkspace: { renderCameraPreview: () => null, renderCameraPanel: () => <div data-camera-panel>镜头工具</div>, renderGenerate },
    canvasNavigation: {
      subscribe: () => () => undefined,
      getSnapshot: () => NAV_SNAPSHOT,
      openDialog: () => undefined
    },
    canvasRuntime: {
      modelFocusMode: () => "edit",
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
  const tabs = () => [...document.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
  return { submitted, objectSession, session, tabs, renderGenerate };
}

describe("FilmSetInspector 片场任务页（任务 6.1–6.5）", () => {
  it("片场聚焦时渲染对象/镜头/动画三页签，默认对象页", () => {
    const h = renderOverlay(filmSetCanvas());
    expect(h.tabs().map(tab => tab.textContent)).toEqual(["对象", "镜头", "动画"]);
    expect(h.tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    // 真实片场名称进入 header，而非固定「片场编辑」。
    expect(document.querySelector(".model-inspector-header h2")?.textContent).toBe("跑酷片场");
  });

  it("初始化自动选中场景镜头仍保持默认对象页", () => {
    const h = renderOverlay(filmSetCanvas(), true);
    expect(h.session.getState().selectedCameraId).toBe("scene");
    expect(h.tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(h.submitted).toHaveLength(0);
  });

  it("点击页签切换视图且不写规范内容（零命令）", () => {
    const h = renderOverlay(filmSetCanvas());
    act(() => h.tabs()[1]!.focus());
    expect(h.tabs()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(h.submitted).toHaveLength(0);
    act(() => h.tabs()[2]!.focus());
    expect(h.tabs()[2]!.getAttribute("aria-selected")).toBe("true");
    expect(h.submitted).toHaveLength(0);
  });

  it("对象选择联动切回对象页且不提交命令", () => {
    const h = renderOverlay(filmSetCanvas());
    act(() => h.tabs()[1]!.focus());
    expect(h.tabs()[1]!.getAttribute("aria-selected")).toBe("true");
    act(() => h.objectSession.select("body"));
    expect(h.objectSession.getState().selectedItemId).toBe("body");
    expect(h.tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(h.submitted).toHaveLength(0);
  });

  it("镜头选择联动切到镜头页且不提交命令", () => {
    const h = renderOverlay(filmSetCanvas());
    act(() => h.tabs()[0]!.focus());
    expect(h.tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    act(() => {
      CAMERAS.push({ id: "cam-x", name: "镜头 1", order: 0, azimuth: 0.3, elevation: Math.PI / 4, distance: 6, aspect: "16:9" });
      h.session.selectCamera("cam-x");
    });
    expect(h.tabs()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(h.submitted).toHaveLength(0);
  });

  it("生成入口经宿主 renderGenerate 注入并带默认目标片段（会话能力可达且片段写授权可放行）", () => {
    const h = renderOverlay(filmSetCanvas(true), false, { generate: true });
    // 扩展不得直接渲染 slot 的 render：否则宿主无法注入 agentConversation，片场节点看不到详情入口。
    expect(document.querySelector("[data-host-generate]")).not.toBeNull();
    expect(document.querySelector("[data-raw-generate]")).toBeNull();
    // 默认对象页也要带目标片段：动作写入缺 clipId 会被工具授权拒绝（tool-not-allowed）。
    expect(h.renderGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "film", mode: "film-set", writable: true, clipId: "clip-1", itemId: null })
    );
  });

  it("片场节点没有动画片段时禁用生成并说明原因", () => {
    const h = renderOverlay(filmSetCanvas(), false, { generate: true });
    expect(h.renderGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "film-set",
        clipId: null,
        writable: false,
        disabledReason: expect.stringContaining("动画片段")
      })
    );
  });

  it("无生成贡献时不调用宿主生成入口", () => {
    const h = renderOverlay(filmSetCanvas());
    expect(h.renderGenerate).not.toHaveBeenCalled();
    expect(document.querySelector("[data-host-generate]")).toBeNull();
  });
});
