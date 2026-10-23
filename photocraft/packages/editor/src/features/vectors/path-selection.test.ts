/**
 * 路径目标解析（U11–U15 接线）。
 *
 * 这一层固定的是「面板选的目标 = 画布改的目标」。接线前该规则只存在于面板状态里，
 * 画布永远改工作路径，于是「面板显示已存路径 P、直接选择却改 work」这种错位无人发现。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathChoice, resolvePathTarget, setPathChoice, subscribePathChoice } from "./path-selection.js";

afterEach(() => setPathChoice("work"));

describe("路径目标", () => {
  it("面板选择被订阅出去，空名退回工作路径", () => {
    const listener = vi.fn();
    const off = subscribePathChoice(listener);
    setPathChoice("P");
    expect(pathChoice()).toBe("P");
    expect(listener).toHaveBeenCalledTimes(1);
    // 同值不重复通知：避免画布每次渲染都重读几何。
    setPathChoice("P");
    expect(listener).toHaveBeenCalledTimes(1);
    setPathChoice("   ");
    expect(pathChoice()).toBe("work");
    off();
    setPathChoice("Q");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("显式选图层走图层路径；默认 work 但图层自身有路径时也改图层", () => {
    // 显式 `layer`：即使图层当前没有路径，也把目标交给内核裁定（它会明确拒绝，而不是静默改 work）。
    expect(resolvePathTarget("layer", 7, false)).toEqual({ name: "layer", layer: 7 });
    // 没有活动图层时 `layer` 不成立。
    expect(resolvePathTarget("layer", null, false)).toEqual({ name: "work" });
    // 默认值 + 形状层/矢量蒙版 → 开箱即用地编辑该图层路径。
    expect(resolvePathTarget("work", 7, true)).toEqual({ name: "layer", layer: 7 });
    // 默认值 + 普通像素层 → 工作路径。
    expect(resolvePathTarget("work", 7, false)).toEqual({ name: "work" });
    // 命名路径优先，不被图层覆盖。
    expect(resolvePathTarget("P", 7, true)).toEqual({ name: "P" });
  });
});
