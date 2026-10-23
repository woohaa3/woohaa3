/**
 * 画布落点请求回归（U73，change `2026-10-22-add-photocraft-view-workspace-workflows`）。
 *
 * 这层的关键不是「能不能放点」，而是**一次性**：消费即清、取消即清，绝不能让下一次普通
 * 画布点击被上一次请求意外捕获。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activePlacement,
  cancelPlacement,
  consumePlacement,
  requestPlacement,
  resetPlacementForTests,
  subscribePlacement,
} from "./placement.js";

describe("一次性落点请求", () => {
  beforeEach(() => resetPlacementForTests());

  it("发起后可读到请求，消费时把源坐标交给回调并立即清空", () => {
    const place = vi.fn();
    requestPlacement({ label: "放置", place });
    expect(activePlacement()?.label).toBe("放置");

    expect(consumePlacement([12.5, 30])).toBe(true);
    expect(place).toHaveBeenCalledWith([12.5, 30]);
    // 一次性：第二次点击不能被同一次请求消费。
    expect(activePlacement()).toBeNull();
    expect(consumePlacement([1, 1])).toBe(false);
    expect(place).toHaveBeenCalledTimes(1);
  });

  it("没有请求时不消费点击（画布按当前工具处理）", () => {
    expect(consumePlacement([1, 2])).toBe(false);
  });

  it("取消后不再消费", () => {
    const place = vi.fn();
    requestPlacement({ label: "放置", place });
    cancelPlacement();
    expect(activePlacement()).toBeNull();
    expect(consumePlacement([3, 4])).toBe(false);
    expect(place).not.toHaveBeenCalled();
  });

  it("后发请求覆盖先发，不会同时挂两个", () => {
    const first = vi.fn();
    const second = vi.fn();
    requestPlacement({ label: "第一次", place: first });
    requestPlacement({ label: "第二次", place: second });
    consumePlacement([5, 6]);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith([5, 6]);
  });

  it("订阅者在发起、取消、消费时都被通知", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePlacement(listener);
    requestPlacement({ label: "放置", place: () => {} });
    cancelPlacement();
    requestPlacement({ label: "再放置", place: () => {} });
    consumePlacement([0, 0]);
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    requestPlacement({ label: "第三次", place: () => {} });
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("回调抛错时请求已经清掉，不留下半消费状态", () => {
    requestPlacement({ label: "放置", place: () => { throw new Error("写入失败"); } });
    expect(() => consumePlacement([0, 0])).toThrow("写入失败");
    expect(activePlacement()).toBeNull();
  });
});
