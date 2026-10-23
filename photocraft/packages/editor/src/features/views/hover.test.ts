/**
 * Info 光标读数的发布/订阅（U73）。
 *
 * 只测这一层的语义：读数不是文档数据；`null` 必须清空；相同内容不重复通知（画布移动很密，
 * 面板不该被无变化的读数刷）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activeHover, publishHover, resetHoverForTests, subscribeHover } from "./hover.js";

const reading = {
  unit: "px",
  reading: { source: [10.5, 20.5] as [number, number], pixel: [10, 20] as [number, number], rgb: [255, 255, 255] as [number, number, number], cmyk: [0, 0, 0, 0] as [number, number, number, number] },
};

beforeEach(() => resetHoverForTests());

describe("hover", () => {
  it("发布后订阅者能读到同一份读数", () => {
    const listener = vi.fn();
    subscribeHover(listener);
    publishHover(reading);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(activeHover()).toBe(reading);
  });

  it("画布外发布 null 必须清空读数，而不是保留上一个像素", () => {
    publishHover(reading);
    publishHover(null);
    expect(activeHover()).toBeNull();
  });

  it("相同引用不重复通知（指针停在同一个读数上不刷面板）", () => {
    const listener = vi.fn();
    subscribeHover(listener);
    publishHover(reading);
    publishHover(reading);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("取消订阅后不再收到通知", () => {
    const listener = vi.fn();
    const off = subscribeHover(listener);
    off();
    publishHover(reading);
    expect(listener).not.toHaveBeenCalled();
  });

  it("画布外读数也可以是一个「有 unit 但没 reading」的结果", () => {
    publishHover({ unit: "px", reading: null });
    expect(activeHover()?.reading).toBeNull();
  });
});
