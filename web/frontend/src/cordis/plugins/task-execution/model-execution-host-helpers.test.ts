/**
 * `@` 候选门禁测试（change: 2026-10-15-add-film-set-shooting-shot-previews）。
 *
 * 镜头参考的类型由 role 唯一确定；录制中只是资产未就绪，应允许先 `@`，提交时由既有
 * 「等待镜头参考录制完成」门禁拦截。其他参考仍必须已就绪。
 */
import { describe, expect, it } from "vitest";
import { canMentionReference } from "./model-execution-host-helpers.js";

describe("canMentionReference（@ 候选）", () => {
  it("就绪且挂槽位可 @", () => {
    expect(canMentionReference({ slotId: "slot-1", role: "reference_image", status: "ready" })).toBe(true);
  });

  it("录制中的镜头参考可先 @（类型确定，提交前有等待门禁）", () => {
    expect(canMentionReference({ slotId: "slot-1", role: "shot_reference", status: "pending" })).toBe(true);
  });

  it("其他未就绪参考不进入候选", () => {
    expect(canMentionReference({ slotId: "slot-1", role: "reference_image", status: "pending" })).toBe(false);
    expect(canMentionReference({ slotId: "slot-1", role: "shot_reference", status: "failed" })).toBe(false);
  });

  it("没有槽位不能 @", () => {
    expect(canMentionReference({ slotId: "", role: "shot_reference", status: "ready" })).toBe(false);
  });
});
