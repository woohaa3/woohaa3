import { describe, expect, it } from "vitest";
import { validateRangeInput } from "./video-edit-intents.js";

describe("视频区间时间校验", () => {
  it("接受合法边界与最小跨度", () => {
    expect(validateRangeInput("0", "0.05", 10)).toBeNull();
    expect(validateRangeInput("9.95", "10", 10)).toBeNull();
  });
  it("拒绝空值、越界和过短区间", () => {
    for (const [start, end] of [["", "1"], ["0", ""], ["-1", "1"], ["1", "11"], ["1", "1.04"], ["abc", "2"]]) {
      expect(validateRangeInput(start!, end!, 10)).not.toBeNull();
    }
  });
});
