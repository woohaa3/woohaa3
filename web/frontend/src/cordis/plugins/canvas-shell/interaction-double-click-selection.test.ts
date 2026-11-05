/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { domFire, installSharedSession } from "./test-support/controller-harness.js";
import { focusHarness, modelCenter } from "./test-support/model-focus-harness.js";

installSharedSession();

describe("双击选入模型", () => {
  it("只在选入时选中，不进入聚焦；已选中后的下一次双击仍可聚焦", () => {
    const h = focusHarness();
    // 卡片中心同时是 pointerdown 的卡片命中与 dblclick 的卡片回退聚焦入口。
    const point = { x: 298, y: 132 };
    const press = () => {
      domFire(h.dom, "pointerdown", { button: 0, clientX: point.x, clientY: point.y });
      domFire(h.dom, "pointerup", { button: 0, clientX: point.x, clientY: point.y });
    };

    press();
    press();
    domFire(h.dom, "dblclick", { button: 0, clientX: point.x, clientY: point.y });

    expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["m1"]);
    expect(h.controller.isModelFocused()).toBe(false);

    press();
    press();
    domFire(h.dom, "dblclick", { button: 0, clientX: point.x, clientY: point.y });

    expect(h.controller.isModelFocused()).toBe(true);
    h.controller.dispose();
  });

  it("也能处理只在模型网格上双击、卡片外没有 pointerdown 命中的情况", () => {
    const h = focusHarness();
    const point = modelCenter(h.target);
    const press = () => {
      domFire(h.dom, "pointerdown", { button: 0, clientX: point.x, clientY: point.y });
      domFire(h.dom, "pointerup", { button: 0, clientX: point.x, clientY: point.y });
    };

    press();
    press();
    domFire(h.dom, "dblclick", { button: 0, clientX: point.x, clientY: point.y });

    expect(h.controller.isModelFocused()).toBe(false);
    h.controller.dispose();
  });
});
