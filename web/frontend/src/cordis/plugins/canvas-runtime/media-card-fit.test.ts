import { describe, expect, it } from "vitest";
import type { ServerCanvas } from "@woohaa3/contracts";
import { CARD_FIT_MAX_EDGE, fitImageCardSize, planImageCardFit } from "./media-card-fit.js";

/** 卡片内容区比例（与 Bevy 布局一致：四边各 6 的窄边）。 */
const contentRatio = (size: { width: number; height: number }) => (size.width - 12) / (size.height - 12);

function canvasWith(node: { id: string; type: string; width?: number; height?: number }): ServerCanvas {
  return {
    id: "canvas",
    document: { nodes: [{ ...node, position: { x: 0, y: 0 } }], edges: [] },
    nodeData: {},
    assets: [],
    jobs: []
  } as unknown as ServerCanvas;
}

describe("fitImageCardSize", () => {
  it("matches the image aspect ratio for landscape, portrait and square images", () => {
    for (const media of [{ width: 1600, height: 900 }, { width: 1000, height: 1000 }, { width: 900, height: 1200 }]) {
      const size = fitImageCardSize(media)!;
      expect(Math.abs(contentRatio(size) - media.width / media.height)).toBeLessThan(0.02);
    }
  });

  it("keeps landscape cards wider than portrait cards", () => {
    const wide = fitImageCardSize({ width: 1600, height: 900 })!;
    const tall = fitImageCardSize({ width: 900, height: 1600 })!;
    expect(wide.width).toBeGreaterThan(wide.height);
    expect(tall.height).toBeGreaterThan(tall.width);
    expect(wide.width).toBeGreaterThanOrEqual(196);
    expect(tall.width).toBeGreaterThanOrEqual(196);
  });

  it("uses the image pixel size, capped at CARD_FIT_MAX_EDGE, and never upscales", () => {
    // 4K 横图：长边封顶到 640，卡片明显大于旧的 360 上限。
    const uhd = fitImageCardSize({ width: 3840, height: 2160 })!;
    expect(uhd.width).toBe(CARD_FIT_MAX_EDGE + 12);
    expect(uhd.height).toBeLessThan(400);
    // 小图不放大：300×200 的卡片就是 300×200 加窄边。
    const small = fitImageCardSize({ width: 300, height: 200 })!;
    expect(small).toEqual({ width: 312, height: 212 });
  });

  it("caps extreme ratios and rejects invalid sizes", () => {
    const panorama = fitImageCardSize({ width: 8000, height: 500 })!;
    expect(panorama.width).toBe(CARD_FIT_MAX_EDGE + 12);
    const strip = fitImageCardSize({ width: 300, height: 6000 })!;
    expect(strip.width).toBeGreaterThanOrEqual(196);
    expect(fitImageCardSize({ width: 0, height: 100 })).toBeNull();
  });
});

describe("planImageCardFit", () => {
  it("resizes an image card that still has the default size", () => {
    const command = planImageCardFit(canvasWith({ id: "a", type: "image", width: 248, height: 232 }), "a", { width: 1600, height: 900 });
    expect(command).toMatchObject({ type: "node.update", nodeId: "a" });
  });

  it("leaves manually resized cards and non-image nodes alone", () => {
    expect(planImageCardFit(canvasWith({ id: "a", type: "image", width: 300, height: 200 }), "a", { width: 1600, height: 900 })).toBeNull();
    expect(planImageCardFit(canvasWith({ id: "a", type: "video", width: 248, height: 232 }), "a", { width: 1600, height: 900 })).toBeNull();
    expect(planImageCardFit(canvasWith({ id: "a", type: "image", width: 248, height: 232 }), "missing", { width: 1600, height: 900 })).toBeNull();
  });
});
