/**
 * 交互控制器测试：缩放区间与帧循环错误隔离
 * （由 interaction-controller.test.ts 机械拆分，断言不变）。
 */
import { describe, expect, it } from "vitest";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing } from "./test-support/controller-harness.js";
import type { BevyRuntime } from "../canvas-runtime/bevy-runtime.js";
import type { ModelRenderIssue } from "../canvas-runtime/model-resource-failures.js";

installSharedSession();

describe("缩放区间与帧循环错误隔离（change: fix-viewport-zoom-range）", () => {
  it("相同场景下失败资源可重试，恢复后继续去重", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing();
    let issues: readonly ModelRenderIssue[] = [{ nodeId: "n1", title: "模型", message: "加载失败", detail: "too large", retainedPreview: false }];
    runtime.getRenderIssues = () => issues;
    const controller = installInteractionController({ canvas: dom.canvas, getRuntime: () => runtime, getSession: () => getSession() as never, target: dom.target as never });
    controller.flush();
    const attempts = scenes.length;
    controller.flush();
    expect(scenes).toHaveLength(attempts + 1);
    issues = [];
    controller.flush();
    expect(scenes).toHaveLength(attempts + 1);
    controller.dispose();
  });

  it("zoomTo / zoomBy 使用 contracts 的 0.1–12 区间", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    // 上限 12（此前 controller 私有 clamp 只有 3）。
    controller.zoomTo(50);
    expect(controller.viewport().zoom).toBe(12);
    // 下限 0.1。
    controller.zoomTo(0.001);
    expect(controller.viewport().zoom).toBe(0.1);
    controller.dispose();
  });

  it("捏合可越过 2 倍上限（不再被 Rust 校验拒绝）", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    let zoom = 1;
    // 模拟连续捏合（ctrl+wheel）：多帧放大到超过 2.0。
    for (let i = 0; i < 60; i += 1) {
      dom.fire("wheel", { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 200, clientY: 200, timeStamp: 1000 + i * 10 });
      controller.flush();
    }
    zoom = controller.viewport().zoom;
    expect(zoom).toBeGreaterThan(2);
  });

  it("setScene 抛错不终止 flush，也不影响后续帧", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const scenes: Array<Record<string, unknown>> = [];
    let fail = true;
    const runtime = {
      isReady: () => true,
      renderedRevision: () => 1,
      setTexture: () => undefined,
      setScene: (scene: unknown) => {
        if (fail) throw new Error("Invalid viewport zoom");
        scenes.push(scene as Record<string, unknown>);
      }
    } as unknown as BevyRuntime;
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    // 第一帧抛错：flush 不应向外抛，并记录诊断。
    expect(() => controller.flush()).not.toThrow();
    expect(controller.renderError()).toContain("Invalid viewport zoom");
    // 后续帧恢复正常：仍能提交快照。
    fail = false;
    dom.fire("pointermove", { clientX: 400, clientY: 220 });
    controller.flush();
    expect(scenes.length).toBeGreaterThan(0);
    controller.dispose();
  });
});

/** 触发 DOM 事件（事件对象带默认字段）。 */
