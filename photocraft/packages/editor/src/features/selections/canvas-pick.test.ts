import { expect, it, vi } from "vitest";
import { armCanvasPick, canvasPickOf, disarmCanvasPick, takeCanvasPick } from "./canvas-pick.js";

it("布防后消费一次单击，且无论成败都解除（不把下一次无关单击也当成布防动作）", () => {
  const controller = {};
  const onPoint = vi.fn();

  // 没布防：不认领，调用方继续走原本的单击语义（例如点空白处取消选择）。
  expect(canvasPickOf(controller)).toBeNull();
  expect(takeCanvasPick(controller, { x: 10, y: 5 })).toBe(false);
  expect(onPoint).not.toHaveBeenCalled();

  armCanvasPick(controller, { kind: "line", axis: "row" }, onPoint);
  expect(canvasPickOf(controller)).toEqual({ kind: "line", axis: "row" });
  // 点位原样交给域处理器；编译、图外拒绝与文案都在域内。
  expect(takeCanvasPick(controller, { x: 10, y: 5 })).toBe(true);
  expect(onPoint).toHaveBeenCalledWith({ x: 10, y: 5 });
  // 已被认领 → 自动解除，第二次单击回到普通语义。
  expect(canvasPickOf(controller)).toBeNull();
  expect(takeCanvasPick(controller, { x: 10, y: 5 })).toBe(false);
  expect(onPoint).toHaveBeenCalledTimes(1);
});

it("待命状态按控制器实例隔离，不同编辑器互不影响", () => {
  const a = {};
  const b = {};
  const onA = vi.fn();
  armCanvasPick(a, { kind: "sample", operation: "-" }, onA);
  // 多标签宿主里 A 布防不应让 B 的单击也变成取样。
  expect(canvasPickOf(a)).toEqual({ kind: "sample", operation: "-" });
  expect(canvasPickOf(b)).toBeNull();
  expect(takeCanvasPick(b, { x: 3, y: 4 })).toBe(false);
  expect(onA).not.toHaveBeenCalled();
  disarmCanvasPick(a);
  expect(canvasPickOf(a)).toBeNull();
});
