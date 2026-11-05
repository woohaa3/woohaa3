import { describe, expect, it } from "vitest";
import { mergeMarqueeSelection } from "../canvas-runtime/model-world-presentation.js";

describe("世界模型框选合并", () => {
  it("卡片框选结果在前，世界模型去重追加", () => {
    expect(mergeMarqueeSelection(["card"], ["model-a", "model-b"])).toEqual(["card", "model-a", "model-b"]);
    expect(mergeMarqueeSelection(["card", "shared"], ["shared", "model"])).toEqual(["card", "shared", "model"]);
  });

  it("任一侧为空时保留另一侧", () => {
    expect(mergeMarqueeSelection([], ["model"])).toEqual(["model"]);
    expect(mergeMarqueeSelection(["card"], [])).toEqual(["card"]);
  });
});
