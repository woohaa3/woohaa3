import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeDockExpand, peekDockExpand, requestDockExpand, resetDockExpandRequests, subscribeDockExpand } from "./dock-expand-request.js";

afterEach(resetDockExpandRequests);

describe("dock-expand-request", () => {
  it("请求先到：peek 不消费，consume 取走一次", () => {
    requestDockExpand("n1", 1000);
    expect(peekDockExpand("n1", 1001)).toBe(true);
    expect(peekDockExpand("n1", 1002)).toBe(true);
    expect(consumeDockExpand("n1", 1003)).toBe(true);
    expect(consumeDockExpand("n1", 1004)).toBe(false);
  });

  it("过期的请求不再生效", () => {
    requestDockExpand("n1", 1000);
    expect(peekDockExpand("n1", 1000 + 5001)).toBe(false);
  });

  it("面板已挂载时订阅者立即收到，且只收到自己的请求", () => {
    const listener = vi.fn();
    const off = subscribeDockExpand(listener);
    requestDockExpand("n2");
    expect(listener).toHaveBeenCalledWith("n2");
    off();
    requestDockExpand("n3");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
