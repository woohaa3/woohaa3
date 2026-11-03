/**
 * 拖动辅助对齐线的控制器集成
 * （`alignment-guides` 扩展注入策略；这里验证宿主接线本身）。
 *
 * 走真实 pointer 事件：策略注入后拖动预览吸到对齐位置并暴露参考线，释放后参考线撤下；
 * 不注入策略时行为与未安装扩展一致（无吸附、无参考线）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { installInteractionController } from "./interaction-controller.js";
import type { AlignmentSnapPolicy } from "../../contract/alignment-snap.js";

/**
 * 测试用策略：把拖动框左边缘吸到最近的候选左边缘。
 *
 * 求解规则本身归扩展（`extensions/alignment-guides/src/frontend/solver.test.ts`）；这里只要一个
 * 确定性规则，用来验证宿主是否真的把偏移落到了预览与提交上。
 */
const defaultAlignmentSnapPolicy = (): AlignmentSnapPolicy => ({
  resolve: input => {
    const moving = input.moving[0];
    if (!moving || input.candidates.length === 0) return null;
    let best: number | null = null;
    for (const candidate of input.candidates) {
      const delta = candidate.x - moving.x;
      if (Math.abs(delta) <= input.threshold && (best === null || Math.abs(delta) < Math.abs(best))) best = delta;
    }
    if (best === null) return null;
    return { dx: best, dy: 0, guides: [{ axis: "x", position: moving.x + best, start: 0, end: 400, kind: "start" }] };
  }
});
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing } from "./test-support/controller-harness.js";

installSharedSession();
afterEach(() => {
  nodeSelectionStore.reset();
});

describe("拖动辅助对齐线（内置插件 alignment-guides）", () => {
  it("拖动越过阈值后吸附，并暴露参考线；释放后参考线撤下", () => {
    // b 的左边缘在 8：拖 a 10px 时左边缘落在 10，差 2px → 吸到 8。
    // （拖动必须超过阈值才会启用吸附，因此不能用 3~4px 的微移来验证。）
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 8, y: 300 }
    ]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      alignmentSnap: () => defaultAlignmentSnapPolicy(),
      onEditCommands: () => undefined
    });

    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 110, clientY: 100 });

    const guides = controller.alignmentGuides();
    expect(guides.length).toBeGreaterThan(0);
    expect(guides.some(guide => guide.axis === "x" && Math.abs(guide.position - 8) < 0.01)).toBe(true);
    const version = controller.alignmentGuidesVersion();
    expect(version).toBeGreaterThan(0);

    dom.fire("pointerup", { clientX: 110, clientY: 100 });
    controller.flush();
    // 手势结束：参考线立即失效（覆盖层据此收起）。
    expect(controller.alignmentGuides()).toEqual([]);
    controller.dispose();
  });

  it("没有注入策略时不吸附、不出参考线", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 0, y: 300 }
    ]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      onEditCommands: () => undefined
    });

    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 104, clientY: 100 });
    expect(controller.alignmentGuides()).toEqual([]);
    dom.fire("pointerup", { clientX: 104, clientY: 100 });
    controller.flush();
    controller.dispose();
  });

  it("setAlignmentSnapPolicy 可在挂载后启停策略", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 8, y: 300 }
    ]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const positions: number[] = [];
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      onEditCommands: (commands) => {
        for (const command of commands) {
          if (command.type === "node.update" && command.position) positions.push(command.position.x);
        }
      }
    });

    controller.setAlignmentSnapPolicy(defaultAlignmentSnapPolicy());
    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 110, clientY: 100 });
    expect(controller.alignmentGuides().length).toBeGreaterThan(0);
    dom.fire("pointerup", { clientX: 110, clientY: 100 });
    controller.flush();

    controller.setAlignmentSnapPolicy(null);
    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 110, clientY: 100 });
    expect(controller.alignmentGuides()).toEqual([]);
    dom.fire("pointerup", { clientX: 110, clientY: 100 });
    controller.flush();
    // b 在 x=8：有策略时第二次拖动被吸到 8，没有策略时按实际 10 提交。
    expect(positions).toEqual([8, 10]);
    controller.dispose();
  });

  it("小于阈值的位移不吸附，按实际位移提交（修复\"移一点点就弹回原位\"）", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 0, y: 300 }
    ]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const positions: number[] = [];
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      alignmentSnap: () => defaultAlignmentSnapPolicy(),
      onEditCommands: (commands) => {
        for (const command of commands) {
          if (command.type === "node.update" && command.position) positions.push(command.position.x);
        }
      }
    });

    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 103, clientY: 100 });
    expect(controller.alignmentGuides()).toEqual([]);
    dom.fire("pointerup", { clientX: 103, clientY: 100 });
    controller.flush();
    expect(positions).toEqual([3]);
    controller.dispose();
  });
});
