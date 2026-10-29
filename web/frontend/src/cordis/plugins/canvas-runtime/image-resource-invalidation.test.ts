import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageResourceInvalidation } from "./image-resource-invalidation.js";

afterEach(() => vi.useRealTimers());

describe("image resource presentation invalidation", () => {
  it("coalesces image completions without postponing the first scheduled update", () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const invalidation = createImageResourceInvalidation(notify);
    invalidation.request();
    for (let frame = 0; frame < 4; frame++) {
      vi.advanceTimersByTime(16);
      invalidation.request();
    }
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("keeps publishing during a continuous gesture and reads the latest state", () => {
    vi.useFakeTimers();
    let loading = true;
    const states: boolean[] = [];
    const invalidation = createImageResourceInvalidation(() => states.push(loading));
    for (let frame = 0; frame < 15; frame++) {
      invalidation.request();
      if (frame === 6) loading = false;
      vi.advanceTimersByTime(16);
    }
    expect(states).toEqual([true, false, false]);
  });

  it("cancels queued work on disposal, including subsequent requests", () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const invalidation = createImageResourceInvalidation(notify);
    invalidation.request();
    invalidation.dispose();
    invalidation.request();
    vi.runAllTimers();
    expect(notify).not.toHaveBeenCalled();
  });
});
