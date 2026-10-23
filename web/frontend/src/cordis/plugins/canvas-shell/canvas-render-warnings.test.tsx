// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filmSetNodeDataFields, buildFilmSetObjectMotions, createFilmSetSnapshot, createFilmSetItemMotion, createModelSnapshot, createMotionSnapshot, defaultInitialShotCamera, type FilmSetItem } from "@woohaa3/contracts";
import type { BevyRuntime } from "../canvas-runtime/bevy-runtime.js";
import { RuntimeIssues } from "../canvas-runtime/runtime-issues.js";
import type { ModelRenderIssue } from "../canvas-runtime/model-resource-failures.js";
import { CanvasRenderWarnings } from "./canvas-render-warnings.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { canvasMotionIssues } from "./canvas-motion-issues.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CanvasRenderWarnings", () => {
  it("媒体错误可见且可重试；致命故障不显示仍可操作或虚假的重试入口", () => {
    const issues = new RuntimeIssues();
    const runtime = { getRuntimeIssues: issues.getSnapshot, subscribeRuntimeIssues: issues.subscribe } as unknown as BevyRuntime;
    const retry = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      issues.report({ key: "texture:n", scope: "texture", operation: "upload", nodeId: "n", message: "媒体预览上传失败，可以重试或更换素材。",
        detail: "Invalid texture", recoverable: true });
      act(() => root.render(<CanvasRenderWarnings runtime={runtime} onRetry={retry} />));
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("媒体预览上传失败");
      const retryButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "重试预览");
      expect(retryButton).toBeDefined();
      act(() => retryButton!.click());
      expect(retry).toHaveBeenCalledOnce();
      act(() => issues.clear("texture:n"));
      expect(container.childElementCount).toBe(0);
      act(() => issues.report({ key: "trap", scope: "runtime", operation: "set_scene", message: "渲染器故障", detail: "unreachable", recoverable: false }));
      expect(container.querySelector("strong")?.textContent).toContain("暂时不可用");
      expect(container.textContent).not.toContain("画布仍可操作");
      expect([...container.querySelectorAll("button")].some((button) => /重试|重建/.test(button.textContent ?? ""))).toBe(false);
    } finally { act(() => root.unmount()); }
  });

  afterEach(() => woohaa3CanvasStore.setState({ canvas: null }));

  it("提示栏可关闭；清除后同一问题再次出现会重新提示", () => {
    const issues = new RuntimeIssues();
    const runtime = { getRuntimeIssues: issues.getSnapshot, subscribeRuntimeIssues: issues.subscribe } as unknown as BevyRuntime;
    const container = document.createElement("div");
    const root = createRoot(container);
    const issue = { key: "texture:n", scope: "texture" as const, operation: "upload" as const, nodeId: "n", message: "图片加载失败", detail: "404", recoverable: true };
    try {
      issues.report(issue);
      act(() => root.render(<CanvasRenderWarnings runtime={runtime} onRetry={() => undefined} />));
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="关闭画布提示"]')!.click());
      expect(container.querySelector('[role="alert"]')).toBeNull();
      act(() => issues.clear("texture:n"));
      act(() => issues.report(issue));
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="关闭画布提示"]')!.click());
      act(() => issues.report({ ...issue, key: "texture:n2", nodeId: "n2" }));
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
    } finally { act(() => root.unmount()); }
  });

  it("非法 child 动作显示具体对象与原因，合法对象继续播放，修正后提示消失", () => {
    const model = createModelSnapshot({ modelScript: 'scene.box({id:"body"});', modelScriptVersion: "woohaa-model-js-v2" });
    const item = (id: string): FilmSetItem => ({ id, name: id === "hero" ? "跑酷人物" : "正常人物", kind: "model", model, localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } });
    const good = "motion.model.tween('root',{property:'position',from:[0,0,0],to:[4,0,0]});";
    const bad = good + "motion.model.move('root',{speed:1,range:[0,1]});";
    const snapshot = (heroScript: string) => {
      const hero = item("hero"), other = item("other");
      const playback = { startTime: 0, duration: 4, timeScale: 1, loop: false };
      const clip = {
        id: "clip-1", name: "默认动画", kind: "dynamic" as const, timeline: { duration: 4, loop: false }, initialCamera: defaultInitialShotCamera(),
        cameraMotion: createMotionSnapshot({ motionScript: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }),
        bindings: [
          { itemId: "hero", motion: createFilmSetItemMotion({ item: hero, motionScript: heroScript }), playback },
          { itemId: "other", motion: createFilmSetItemMotion({ item: other, motionScript: good }), playback }
        ]
      };
      return { kind: "composite-asset" as const, title: "屋顶跑酷", scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, sceneCamera: defaultInitialShotCamera(), camera: defaultInitialShotCamera(), timeline: { duration: 4, loop: false }, filmSetContent: { schemaVersion: 4 as const, items: [hero, other] }, filmSetAnimations: { schemaVersion: 3 as const, defaultClipId: "clip-1", clips: [clip] } };
    };
    const setCanvas = (heroScript: string) => woohaa3CanvasStore.setState({ canvas: { document: { nodes: [{ id: "scene", type: "composite-asset" }] }, nodeData: { scene: filmSetNodeDataFields(snapshot(heroScript)) } } as never });
    const badSnapshot = snapshot(bad);
    const projection = buildFilmSetObjectMotions({ filmSetContent: badSnapshot.filmSetContent, bindings: badSnapshot.filmSetAnimations.clips[0]!.bindings });
    expect(projection.motions.map(entry => entry.itemId)).toEqual(["other"]);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      setCanvas(bad);
      act(() => root.render(<CanvasRenderWarnings runtime={null} onRetry={() => undefined} />));
      expect(container.textContent).toContain("画布仍可操作");
      expect(container.textContent).toContain("屋顶跑酷");
      expect(container.querySelector("pre")?.textContent).toContain("跑酷人物（hero）");
      expect(container.querySelector("pre")?.textContent).toContain("overlapping-model-track");
      expect(container.querySelector("pre")?.textContent).toContain("其他对象仍可播放");
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect([...container.querySelectorAll("button")].filter((button) => button.textContent)).toEqual([]);
      act(() => setCanvas(good));
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally { act(() => root.unmount()); }
  });

  it("对象动作非法和动画结构不可读都给出提示", () => {
    const snapshot = createFilmSetSnapshot({ title: "转身", model: { modelScript: 'scene.box({id:"body"});', modelScriptVersion: "woohaa-model-js-v2" }, modelItemId: "actor", motionScript: "motion.model.rotate('ghost',{speed:1});", timeline: { duration: 4, loop: false } });
    const data = filmSetNodeDataFields(snapshot);
    const canvas = { document: { nodes: [{ id: "scene", type: "composite-asset" }] }, nodeData: { scene: data } };
    expect(canvasMotionIssues(canvas)[0]?.details.join()).toContain("unknown-target");
    expect(canvasMotionIssues({ ...canvas, nodeData: { scene: { extensionId: "film-set", modelScript: "scene.box({id:'x'});" } } })[0]?.details.join()).toContain("动画数据无法读取");
  });

  it("展示对象、失败原因和保留预览说明，允许重试，恢复后撤去提示", () => {
    let issues: readonly ModelRenderIssue[] = [{ nodeId: "n", title: "街道片场", message: "模型数据超过预览容量，请简化模型或减少片场内容。", detail: "Model resource payload too large", retainedPreview: true }];
    const listeners = new Set<() => void>();
    const runtime = {
      getRenderIssues: () => issues,
      subscribeRenderIssues: (listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      }
    } as unknown as BevyRuntime;
    const container = document.createElement("div");
    const root = createRoot(container);
    const retry = vi.fn();
    try {
      act(() => root.render(<CanvasRenderWarnings runtime={runtime} onRetry={retry} />));
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("画布仍可操作");
      expect(alert?.textContent).toContain("街道片场");
      expect(alert?.textContent).toContain("上次成功加载");
      expect(container.querySelector("pre")?.textContent).toBe("Model resource payload too large");
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      const retryButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "重试模型预览");
      expect(retryButton).toBeDefined();
      act(() => retryButton!.click());
      expect(retry).toHaveBeenCalledOnce();
      act(() => { issues = []; for (const listener of listeners) listener(); });
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally { act(() => root.unmount()); }
    expect(listeners.size).toBe(0);
  });

  it("没有渲染运行时或没有失败时不挡住画布", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() => root.render(<CanvasRenderWarnings runtime={null} onRetry={() => undefined} />));
      expect(container.childElementCount).toBe(0);
    } finally { act(() => root.unmount()); }
  });
});
