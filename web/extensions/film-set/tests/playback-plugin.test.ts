/**
 * 动画播放 Plugin 拍摄预览卡片 hover 驱动测试
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 6.1–6.4）。
 *
 * 宿主只从**预览卡片内容区**发布 typed 拍摄播放目标；本 Plugin 只消费该目标：
 * 短单调延迟（`HOVER_PLAYBACK_DELAY_MS`）后从 T=0 强制循环播放明确 clipId，并路由到目标卡片。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  filmSetNodeDataFields,
  createFilmSetSnapshot,
  filmSetAnimationsOf,
  shotPreviewNodeId,
  type BevyAnimationPlayback,
  type CanvasNodeData,
  type FilmSetNodeData
} from "@woohaa3/contracts";
import { animationPlaybackExtension } from "../src/frontend/playback-plugin.js";
import { HOVER_PLAYBACK_DELAY_MS } from "../src/frontend/hover-delay.js";
import { CompositeAssetRegistry } from "@woohaa3/frontend/extension-api";
import { FilmSetPlaybackService } from "../src/frontend/playback-service.js";
import { AnimationPlaybackController } from "../src/shared.js";
import { createTestHoverState } from "./canvas-state.js";
const hoverNodeStore = createTestHoverState();
import { createTestCanvasState } from "./canvas-state.js";
const woohaa3CanvasStore = createTestCanvasState();

const FILM_SET = "film-1";
const MODEL = `scene.group({ id: "body" });
scene.box({ id: "torso", parent: "body", size: [1, 2, 0.5] });`;

function filmSetData(motionScript: string, loop = false): FilmSetNodeData {
  return createFilmSetSnapshot({
    title: "挥手",
    model: { modelScript: MODEL, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript,
    timeline: { duration: 4, loop }
  });
}

/** 追加第二个动态镜头（默认镜头仍是 clip-1）。 */
function withSecondClip(source: FilmSetNodeData): FilmSetNodeData {
  const collection = filmSetAnimationsOf(source);
  const first = collection.clips[0]!;
  return {
    ...source,
    filmSetAnimations: {
      schemaVersion: 3,
      defaultClipId: first.id,
      clips: [
        first,
        { ...structuredClone(first), id: "clip-2", name: "第二镜头", timeline: { duration: 2, loop: false } }
      ]
    }
  };
}

/** 把默认镜头替换为合法静态镜头（零时长、无动作、无绑定）。 */
function withStaticClip(source: FilmSetNodeData): FilmSetNodeData {
  const collection = filmSetAnimationsOf(source);
  const first = collection.clips[0]!;
  return {
    ...source,
    filmSetAnimations: {
      schemaVersion: 3,
      defaultClipId: "static-1",
      clips: [{ ...structuredClone(first), id: "static-1", kind: "static", timeline: { duration: 0, loop: false }, bindings: [] }]
    }
  };
}

function previewNode(filmSetNodeId: string, clipId: string) {
  return {
    id: shotPreviewNodeId(filmSetNodeId, clipId),
    type: "film-set-shot-preview",
    data: { shotPreview: { schemaVersion: 1, filmSetNodeId, clipId } } as CanvasNodeData
  };
}

/** 把内存画布写入 woohaa3CanvasStore（仅提供 plugin 读取所需字段）。 */
function setCanvas(nodes: Array<{ id: string; type: string; data: CanvasNodeData }>): void {
  const state = woohaa3CanvasStore.getState();
  woohaa3CanvasStore.setState({
    ...state,
    canvas: {
      document: { nodes: nodes.map((node) => ({ id: node.id, type: node.type })) },
      nodeData: Object.fromEntries(nodes.map((node) => [node.id, node.data]))
    } as never
  });
}

function canvasWith(animation: FilmSetNodeData, clipIds: string[]): void {
  setCanvas([
    { id: FILM_SET, type: "composite-asset", data: filmSetNodeDataFields(animation) as CanvasNodeData },
    ...clipIds.map(clipId => previewNode(FILM_SET, clipId))
  ]);
}

describe("animationPlaybackExtension（拍摄预览卡片 hover 驱动）", () => {
  const published: Array<BevyAnimationPlayback | null> = [];
  let focused = false;
  let focusListeners: Array<() => void> = [];
  let rendererFocused = true;
  let playbackService: FilmSetPlaybackService;
  let disposers: Array<() => void> = [];
  let rendererGeneration = 1;

  function makeRuntime() {
    const controller = new AnimationPlaybackController({
      readAnimation: () => null, // plugin 使用自己的 readAnimation; 这里仅占位
      publish: () => undefined
    });
    const ctx = new Context();
    ctx.provide("canvasState" as never, woohaa3CanvasStore.facade as never);
    ctx.provide("hoverState" as never, { ...hoverNodeStore } as never);
    const registry = new CompositeAssetRegistry();
    ctx.provide("compositeAssets" as never, registry as never);
    playbackService = new FilmSetPlaybackService();
    // 与生产相同：播放发布会同步触发资产投影重新协调。
    playbackService.subscribe(registry.invalidate);
    ctx.provide("filmSetPlayback" as never, playbackService as never);
    ctx.provide("canvasNavigation" as never, {
      getSnapshot: () => ({ mode: focused ? { type: "node-focus", kind: "model", nodeId: FILM_SET, owner: "direct" } : { type: "overview" }, panel: null, menu: null }),
      subscribe: () => () => undefined
    } as never);
    ctx.provide("canvasRuntime" as never, {
      runtime: () => ({ generation: () => rendererGeneration }),
      subscribe: () => () => undefined,
      setAnimationPlayback: (playback: BevyAnimationPlayback | null) => published.push(playback),
      isFocused: () => focused && rendererFocused,
      controller: () => null,
      modelFocusProjection: () => focused && rendererFocused ? { nodeId: FILM_SET } : null,
      subscribeModelFocus: (listener: () => void) => {
        focusListeners.push(listener);
        return () => {
          focusListeners = focusListeners.filter((entry) => entry !== listener);
        };
      }
    } as never);
    void controller;
    // 直接 apply 插件（不经过完整 kernel）。
    const dispose = (animationPlaybackExtension() as unknown as (ctx: Context) => () => void)(ctx);
    disposers.push(dispose);
    return {
      ctx,
      dispose,
      replaceRenderer: () => { rendererGeneration++; for (const listener of focusListeners) listener(); },
      setFocused: (value: boolean) => {
        focused = value;
        for (const listener of focusListeners) listener();
      }
    };
  }

  /** 发布合法拍摄播放目标（内容区命中）。 */
  function hoverCard(clipId: string): void {
    hoverNodeStore.setPlaybackTarget({
      kind: "shot-preview",
      previewNodeId: shotPreviewNodeId(FILM_SET, clipId),
      filmSetNodeId: FILM_SET,
      clipId
    });
  }

  function latest(): BevyAnimationPlayback | null {
    return published.at(-1) ?? null;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    rendererGeneration = 1;
    published.length = 0;
    focused = false;
    rendererFocused = true;
    focusListeners = [];
    hoverNodeStore.reset();
  });

  afterEach(() => {
    hoverNodeStore.reset();
    disposers.forEach(dispose => dispose());
    disposers = [];
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("hover 动态镜头卡片短延迟后从第 0 秒强制循环并路由到该卡片", () => {
    canvasWith(filmSetData(`motion.model.rotate("torso", { speed: 1 });`), ["clip-1"]);
    makeRuntime();

    expect(latest()).toBeNull();
    hoverCard("clip-1");
    vi.advanceTimersByTime(HOVER_PLAYBACK_DELAY_MS - 1);
    expect(latest()).toBeNull();
    vi.advanceTimersByTime(1);
    const active = latest();
    expect(active?.nodeId).toBe(FILM_SET);
    expect(active?.clipId).toBe("clip-1");
    expect(active?.viewMode).toBe("shot-node-preview");
    expect(active?.targetPreviewNodeId).toBe(shotPreviewNodeId(FILM_SET, "clip-1"));
    expect(active?.time).toBe(0);
    expect(active?.objects?.length ?? 0).toBeGreaterThan(0);

    hoverNodeStore.reset();
    expect(latest()).toBeNull();
  });

  it("强制循环在 duration 处回绕且不写保存的 loop", () => {
    canvasWith(filmSetData(`motion.model.rotate("torso", { speed: 1 });`, false), ["clip-1"]);
    makeRuntime();
    hoverCard("clip-1");
    vi.advanceTimersByTime(HOVER_PLAYBACK_DELAY_MS);
    expect(latest()?.looped).toBe(true);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(3500);
    // 首次 tick 只记录起点；随后 3.5 秒按 duration=4 不结束（强制循环）。
    expect(latest()?.playing).toBe(true);
    expect(latest()!.time).toBeGreaterThan(0);
    // canonical 未被改写：保存的镜头时间线仍是非循环。
    const canvas = woohaa3CanvasStore.facade.getCanvas()!;
    const clips = (canvas.nodeData[FILM_SET] as never as { filmSetAnimations: { clips: Array<{ timeline: { loop: boolean } }> } }).filmSetAnimations;
    expect(clips.clips[0]!.timeline.loop).toBe(false);
  });

  it("非默认镜头按目标显式 clipId 播放", () => {
    canvasWith(withSecondClip(filmSetData(`motion.model.rotate("torso", { speed: 1 });`)), ["clip-1", "clip-2"]);
    makeRuntime();
    hoverCard("clip-2");
    vi.advanceTimersByTime(HOVER_PLAYBACK_DELAY_MS);
    expect(latest()?.clipId).toBe("clip-2");
    expect(latest()?.targetPreviewNodeId).toBe(shotPreviewNodeId(FILM_SET, "clip-2"));
  });

  it("镜头参考录制会话优先于 hover/聚焦，并锁到该卡片", () => {
    // 镜头参考录制在片场**非聚焦**时进行：会话期间忽略 hover/聚焦，把投影锁到该镜头的卡片，
    // 由录制方 seek 按 T 驱动（renderer 据此离屏出画面，任务 8.4）。
    canvasWith(filmSetData(`motion.model.rotate("torso", { speed: 1 });`), ["clip-1"]);
    const runtime = makeRuntime();
    hoverCard("clip-1");
    vi.advanceTimersByTime(HOVER_PLAYBACK_DELAY_MS);
    expect(latest()?.playing).toBe(true);

    playbackService.beginCaptureSession({
      filmSetNodeId: FILM_SET,
      clipId: "clip-1",
      previewNodeId: shotPreviewNodeId(FILM_SET, "clip-1")
    });
    const session = latest();
    expect(session?.nodeId).toBe(FILM_SET);
    expect(session?.clipId).toBe("clip-1");
    expect(session?.viewMode).toBe("shot-node-preview");
    expect(session?.targetPreviewNodeId).toBe(shotPreviewNodeId(FILM_SET, "clip-1"));
    // 暂停会话：录制方逐帧 seek，不自行推进播放头。
    expect(session?.playing).toBe(false);

    // 聚焦不夺走录制会话。
    runtime.setFocused(true);
    expect(latest()?.viewMode).toBe("shot-node-preview");
    expect(latest()?.playing).toBe(false);

    // 结束会话后交还投影：没有 hover 目标时投影被清空（不再留在录制会话）。
    hoverNodeStore.reset();
    playbackService.endCaptureSession();
    expect(latest()).toBeNull();
  });

  it("静态镜头卡片不建立播放状态机", () => {
    canvasWith(withStaticClip(filmSetData(`motion.model.rotate("torso", { speed: 1 });`)), ["static-1"]);
    makeRuntime();
    hoverCard("static-1");
    vi.advanceTimersByTime(2000);
    expect(latest()).toBeNull();
  });

  it("归属非法（源片场缺失）时不建立候选", () => {
    // 只有预览节点，没有源片场。
    setCanvas([previewNode(FILM_SET, "clip-1")]);
    makeRuntime();
    hoverCard("clip-1");
    vi.advanceTimersByTime(2000);
    expect(latest()).toBeNull();
  });

  it("同目标重复通知不重置截止点，等待期间没有编译", () => {
    canvasWith(filmSetData(`motion.model.rotate("torso", { speed: 1 });`), ["clip-1"]);
    makeRuntime();
    hoverCard("clip-1");
    vi.advanceTimersByTime(Math.floor(HOVER_PLAYBACK_DELAY_MS / 2));
    hoverCard("clip-1");
    const mirror = (globalThis as any).__animationPlayback;
    expect(mirror.compilations()).toBe(0);
    vi.advanceTimersByTime(HOVER_PLAYBACK_DELAY_MS - Math.floor(HOVER_PLAYBACK_DELAY_MS / 2) - 1);
    expect(mirror.compilations()).toBe(0);
    vi.advanceTimersByTime(1); expect(mirror.compilations()).toBe(1);
    expect(latest()?.time).toBe(0);
  });

  it("快速 A→B 不继承等待，播放中换目标先清理旧会话", () => {
    canvasWith(withSecondClip(filmSetData(`motion.model.rotate("torso", { speed: 1 });`)), ["clip-1", "clip-2"]);
    makeRuntime();
    hoverCard("clip-1"); vi.advanceTimersByTime(HOVER_PLAYBACK_DELAY_MS - 40);
    hoverCard("clip-2"); vi.advanceTimersByTime(HOVER_PLAYBACK_DELAY_MS - 1);
    expect(latest()).toBeNull(); vi.advanceTimersByTime(1);
    expect(latest()?.clipId).toBe("clip-2");
    hoverCard("clip-1"); expect(latest()).toBeNull();
    vi.advanceTimersByTime(HOVER_PLAYBACK_DELAY_MS); expect(latest()?.clipId).toBe("clip-1");
  });

  it("blocked 目标不具备播放资格，恢复必须重新等满", () => {
    canvasWith(filmSetData(`motion.model.rotate("torso", { speed: 1 });`), ["clip-1"]);
    makeRuntime();
    const target = {
      kind: "shot-preview" as const,
      previewNodeId: shotPreviewNodeId(FILM_SET, "clip-1"),
      filmSetNodeId: FILM_SET,
      clipId: "clip-1"
    };
    hoverNodeStore.setPlaybackTarget(target, true);
    vi.advanceTimersByTime(1000);
    expect(latest()).toBeNull();
    hoverNodeStore.setPlaybackTarget(target, false);
    vi.advanceTimersByTime(HOVER_PLAYBACK_DELAY_MS - 1);
    expect(latest()).toBeNull(); vi.advanceTimersByTime(1);
    expect(latest()?.clipId).toBe("clip-1");
  });

  it("父窗口 blur 后文档仍有焦点时，hover 不被失焦标记锁死", () => {
    canvasWith(filmSetData(`motion.model.rotate("torso", { speed: 1 });`), ["clip-1"]);
    makeRuntime();
    window.dispatchEvent(new Event("blur"));
    hoverCard("clip-1");
    vi.advanceTimersByTime(HOVER_PLAYBACK_DELAY_MS);
    expect(latest()?.playing).toBe(true);
  });

  it("文档失焦仍允许 hover 开播，blur/focus 不重置等待或会话", () => {
    canvasWith(filmSetData(`motion.model.rotate("torso", { speed: 1 });`), ["clip-1"]);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    makeRuntime();
    hoverCard("clip-1");
    vi.advanceTimersByTime(HOVER_PLAYBACK_DELAY_MS - 1);
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(1);
    expect(latest()?.playing).toBe(true);
    const generation = latest()?.generation;
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(50);
    expect(latest()?.playing).toBe(true);
    expect(latest()?.generation).toBe(generation);
  });

  it("内容更换、renderer 重建、页面隐藏与 dispose 使旧等待失效", () => {
    canvasWith(filmSetData(`motion.model.rotate("torso", { speed: 1 });`), ["clip-1"]);
    const runtime = makeRuntime();
    const half = Math.floor(HOVER_PLAYBACK_DELAY_MS / 2);
    hoverCard("clip-1"); vi.advanceTimersByTime(half);
    canvasWith(filmSetData(`motion.model.rotate("torso", { speed: 2 });`), ["clip-1"]);
    vi.advanceTimersByTime(half); runtime.replaceRenderer(); vi.advanceTimersByTime(half);
    expect(latest()).toBeNull();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange")); vi.advanceTimersByTime(1000);
    expect(latest()).toBeNull();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange")); vi.advanceTimersByTime(HOVER_PLAYBACK_DELAY_MS - 1);
    expect(latest()).toBeNull(); vi.advanceTimersByTime(1);
    expect(latest()?.clipId).toBe("clip-1");
    hoverNodeStore.reset();
    runtime.dispose(); const count = published.length; vi.advanceTimersByTime(1000);
    expect(published).toHaveLength(count);
  });

  it("聚焦覆盖 hover：进入显式预览暂停；退出聚焦后恢复 hover 预览", () => {
    canvasWith(filmSetData(`motion.model.rotate("torso", { speed: 1 });`), ["clip-1"]);
    const runtime = makeRuntime();
    hoverCard("clip-1");
    vi.advanceTimersByTime(HOVER_PLAYBACK_DELAY_MS);
    expect(latest()?.viewMode).toBe("shot-node-preview");

    runtime.setFocused(true);
    expect(latest()).toBeNull();
    playbackService.select(FILM_SET, "clip-1");
    playbackService.preview();
    expect(latest()?.viewMode).toBe("focus-preview");
    expect(latest()?.playing).toBe(false);

    runtime.setFocused(false);
    vi.advanceTimersByTime(HOVER_PLAYBACK_DELAY_MS);
    expect(latest()?.viewMode).toBe("shot-node-preview");
    expect(latest()?.playing).toBe(true);
  });

  it("动作错误时导航仍持有聚焦，显式预览保留诊断", () => {
    canvasWith(filmSetData(`motion.model.rotate("missing", { speed: 1 });`), ["clip-1"]);
    const runtime = makeRuntime();
    rendererFocused = false;
    runtime.setFocused(true);
    playbackService.select(FILM_SET, "clip-1");
    playbackService.preview();
    expect(playbackService.getSnapshot()).toMatchObject({ preview: true, playing: false });
    expect(playbackService.getSnapshot().error).toContain("无法播放");
    canvasWith(filmSetData(`motion.model.rotate("torso", { speed: 1 });`), ["clip-1"]);
    expect(playbackService.getSnapshot().error).toBeNull();
    expect(latest()?.nodeId).toBe(FILM_SET);
    runtime.setFocused(false);
    expect(playbackService.getSnapshot().preview).toBe(false);
  });

  it("双击进入事件按显式 clipId 选择镜头并停在零点预览", () => {
    canvasWith(withSecondClip(filmSetData(`motion.model.rotate("torso", { speed: 1 });`)), ["clip-1", "clip-2"]);
    const runtime = makeRuntime();
    // 宿主只在进入片场聚焦**成功**后发布事件（design D8）。
    runtime.setFocused(true);
    runtime.ctx.emit("ui.shot-preview.enter-requested", {
      previewNodeId: shotPreviewNodeId(FILM_SET, "clip-2"),
      filmSetNodeId: FILM_SET,
      clipId: "clip-2"
    } as never);
    const snapshot = playbackService.getSnapshot();
    expect(snapshot.preview).toBe(true);
    expect(snapshot.playing).toBe(false);
    expect(snapshot.time).toBe(0);
    expect(snapshot.clipId).toBe("clip-2");
  });

  it("普通节点 hover 不建立会话", () => {
    setCanvas([{ id: "text-1", type: "text", data: {} as CanvasNodeData }]);
    makeRuntime();
    hoverNodeStore.setNodeId("text-1");
    vi.advanceTimersByTime(1000);
    expect(latest()).toBeNull();
  });
});
