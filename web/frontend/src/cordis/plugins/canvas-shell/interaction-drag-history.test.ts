/**
 * 拖拽经页面编辑历史并可结束时复位手势
 * （change: 2026-10-09-improve-canvas-workflow，任务 1.5/1.7 回归）。
 *
 * 回归动机：canvas-runtime 曾访问未注入的 `ctx.canvasEdit`，提交回调抛错会中断
 * pointerup 派发，导致拖拽卡死且无法产生可撤销记录。这里验证：
 * - 移动经 `onEditCommands` 记录，且不再直接提交；
 * - 提交/回调抛错时输入层仍复位手势，后续拖拽可继续；
 * - 记录失败不静默（onInteractionError 收到错误）。
 */
import { describe, expect, it, afterEach } from "vitest";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { installInteractionController } from "./interaction-controller.js";
import {
  canvasWith, getSession, harness, installSharedSession, runtimeCapturing, submitted
} from "./test-support/controller-harness.js";

installSharedSession();
afterEach(() => {
  nodeSelectionStore.reset();
});

describe("拖拽经编辑历史并可结束时重置手势（change: 2026-10-09，任务 1.5/1.7 回归）", () => {
  it("移动通过 onEditCommands 记录，且释放后手势复位可再次拖拽", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const edits: Array<{ label: string; count: number }> = [];
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      onEditCommands: (commands, label) => { edits.push({ label, count: commands.length }); }
    });

    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 300, clientY: 100 });
    dom.fire("pointerup", { clientX: 300, clientY: 100 });
    controller.flush();

    expect(edits).toEqual([{ label: "移动作品", count: 1 }]);
    // 直接提交被编辑历史路径取代（不重复提交）。
    expect(submitted.some((command) => command.type === "node.update")).toBe(false);

    // 手势已复位：从同一节点再次拖拽仍能记录第二次动作（不会卡死）。
    dom.fire("pointerdown", { clientX: 200, clientY: 150 });
    dom.fire("pointermove", { clientX: 400, clientY: 150 });
    dom.fire("pointerup", { clientX: 400, clientY: 150 });
    controller.flush();
    expect(edits).toHaveLength(2);
    controller.dispose();
  });

  it("onEditCommands 抛错时指针释放仍复位手势（避免拖拽卡死）", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n2", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    let calls = 0;
    const errors: unknown[] = [];
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      onEditCommands: () => {
        calls += 1;
        if (calls === 1) throw new Error("canvasEdit unavailable");
      },
      onInteractionError: (error) => errors.push(error)
    });

    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 300, clientY: 100 });
    expect(() => dom.fire("pointerup", { clientX: 300, clientY: 100 })).not.toThrow();
    controller.flush();
    // 记录失败不静默。
    expect(errors).toHaveLength(1);

    // 手势已复位：第二次拖拽可以再次进入提交路径。
    dom.fire("pointerdown", { clientX: 200, clientY: 150 });
    dom.fire("pointermove", { clientX: 400, clientY: 150 });
    dom.fire("pointerup", { clientX: 400, clientY: 150 });
    controller.flush();
    expect(calls).toBe(2);
    controller.dispose();
  });
});
