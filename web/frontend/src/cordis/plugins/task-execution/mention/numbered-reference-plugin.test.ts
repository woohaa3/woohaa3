import { describe, expect, it } from "vitest";
import { serializeWoohaa3CanvasMention } from "@woohaa3/contracts";
import { normalizeNumberedReferences } from "./numbered-reference-plugin.js";
import type { MentionCandidate } from "./mention-types.js";
const candidates: MentionCandidate[] = [
  { slotId: "image-2", type: "input_image", label: "图片 2" },
  { slotId: "video-1", type: "input_video", label: "视频 1" },
  { slotId: "image-1", type: "input_image", label: "图片 1" },
  { slotId: "image-10", type: "input_image", label: "图片 10" }
];
const token = (index: number) => serializeWoohaa3CanvasMention(candidates[index])!;
describe("numbered reference normalization", () => {
  it("resolves pasted Chinese prose by stable labels, preserving spaces and lines", () => {
    expect(normalizeNumberedReferences("参考图片1和图片 2，\n使用视频1，图片10。", candidates))
      .toBe(`参考${token(2)}和${token(0)}，\n使用${token(1)}，${token(3)}。`);
  });
  it("preserves unknown/disabled/ambiguous references and never partially matches a longer index", () => {
    expect(normalizeNumberedReferences("图片11 视频2 图片0", candidates)).toBe("图片11 视频2 图片0");
    expect(normalizeNumberedReferences("图片1", [{ ...candidates[2], disabled: true }])).toBe("图片1");
    expect(normalizeNumberedReferences("图片1", [candidates[2], { ...candidates[2], slotId: "duplicate" }])).toBe("图片1");
  });
  it("does not rebind existing tokens or convert aliases inside their labels", () => {
    const existing = serializeWoohaa3CanvasMention({ type: "input_image", slotId: "old-slot", label: "图片1" })!;
    expect(normalizeNumberedReferences(`${existing} @图片2`, candidates)).toBe(`${existing} ${token(0)}`);
  });
});
