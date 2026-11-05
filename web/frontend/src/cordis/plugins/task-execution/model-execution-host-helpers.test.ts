/**
 * `@` 候选门禁测试。参考必须已就绪且挂槽位才允许进入候选。
 */
import { describe, expect, it } from "vitest";
import { canMentionReference } from "./model-execution-host-helpers.js";

describe("canMentionReference（@ 候选）", () => {
  it("就绪且挂槽位可 @", () => {
    expect(canMentionReference({ slotId: "slot-1", role: "reference_image", status: "ready" })).toBe(true);
  });

  it("其他未就绪参考不进入候选", () => {
    expect(canMentionReference({ slotId: "slot-1", role: "reference_image", status: "pending" })).toBe(false);
    expect(canMentionReference({ slotId: "slot-1", role: "reference_video", status: "failed" })).toBe(false);
  });

  it("没有槽位不能 @", () => {
    expect(canMentionReference({ slotId: "", role: "reference_image", status: "ready" })).toBe(false);
  });
});
