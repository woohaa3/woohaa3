/**
 * Typed Slot registry 测试（change: adopt-frontend-cordis-plugin-runtime，design D6）。
 *
 * 覆盖：确定排序、priority/tie-breaker、重复 ID hard failure、availability 过滤、
 * disposer 撤销与订阅通知。
 */
import { describe, expect, it, vi } from "vitest";
import { SlotRegistry } from "./slots.js";

describe("SlotRegistry", () => {
  it("同 slot 按 priority、注册序号、ID 稳定排序", () => {
    const slots = new SlotRegistry();
    slots.register("canvas.toolbar", { id: "b", owner: "o", priority: 10, render: () => null });
    slots.register("canvas.toolbar", { id: "a", owner: "o", priority: 5, render: () => null });
    slots.register("canvas.toolbar", { id: "c", owner: "o", render: () => null });
    expect(slots.list("canvas.toolbar").map((entry) => entry.id)).toEqual(["c", "a", "b"]);
  });

  it("同 priority 时按注册序号稳定", () => {
    const slots = new SlotRegistry();
    slots.register("canvas.toolbar", { id: "z", owner: "o", render: () => null });
    slots.register("canvas.toolbar", { id: "y", owner: "o", render: () => null });
    expect(slots.list("canvas.toolbar").map((entry) => entry.id)).toEqual(["z", "y"]);
  });

  it("重复 ID 抛错并报告两个 owner", () => {
    const slots = new SlotRegistry();
    slots.register("dialog.renderer", { id: "media-preview", owner: "legacy", dialogId: "media-preview", render: () => null });
    expect(() =>
      slots.register("dialog.renderer", { id: "media-preview", owner: "extension", dialogId: "media-preview", render: () => null })
    ).toThrow(/media-preview.*legacy.*extension|legacy.*extension/);
  });

  it("disposer 撤销且只影响自身", () => {
    const slots = new SlotRegistry();
    const remove = slots.register("canvas.overlay", { id: "one", owner: "o", render: () => null });
    slots.register("canvas.overlay", { id: "two", owner: "o", render: () => null });
    remove();
    expect(slots.list("canvas.overlay").map((entry) => entry.id)).toEqual(["two"]);
    remove();
    expect(slots.list("canvas.overlay")).toHaveLength(1);
  });

  it("available() 为 false 的 contribution 不出现", () => {
    const slots = new SlotRegistry();
    let available = false;
    slots.register("canvas.overlay", {
      id: "panel",
      owner: "o",
      available: () => available,
      render: () => null
    });
    expect(slots.list("canvas.overlay")).toHaveLength(0);
    available = true;
    expect(slots.list("canvas.overlay")).toHaveLength(1);
  });

  it("订阅在注册/撤销时触发，且 slot 相互隔离", () => {
    const slots = new SlotRegistry();
    const toolbar = vi.fn();
    const overlay = vi.fn();
    slots.subscribe("canvas.toolbar", toolbar);
    slots.subscribe("canvas.overlay", overlay);
    const remove = slots.register("canvas.toolbar", { id: "t", owner: "o", render: () => null });
    expect(toolbar).toHaveBeenCalledTimes(1);
    expect(overlay).not.toHaveBeenCalled();
    remove();
    expect(toolbar).toHaveBeenCalledTimes(2);
  });
});
