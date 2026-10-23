/**
 * P5–P7 面板与命令编译的回归
 * （change: 2026-10-22-complete-photocraft-webui-editing）。
 *
 * 只锁定界面侧的契约：内核响应解码、参数编译与「失败不提交」。像素与内核语义在 Rust 侧。
 */
import { describe, expect, it } from "vitest";
import { decodeHistogram, FILTER_TOOLS, RETOUCH_TOOLS } from "./editor-tool-panels.js";
import { buildStroke, type BrushSettings } from "./photo-editor-tools.js";

describe("直方图解码（任务 7.2）", () => {
  const bins = () => Array.from({ length: 256 }, (_, index) => index);

  it("接受三通道 256 桶并保留来源与代际", () => {
    const state = decodeHistogram({
      channels: [bins(), bins(), bins()],
      samples: 1024,
      source: "layer",
      channel: "luminance",
      generation: 12
    });
    expect(state).not.toBeNull();
    expect(state!.channels).toHaveLength(3);
    expect(state!.channels[0]).toHaveLength(256);
    expect(state!.source).toBe("layer");
    expect(state!.channel).toBe("luminance");
    expect(state!.generation).toBe(12);
    expect(state!.samples).toBe(1024);
  });

  it("拒绝桶数不足、非数值与缺失通道", () => {
    expect(decodeHistogram(null)).toBeNull();
    expect(decodeHistogram({ channels: [bins(), bins()] })).toBeNull();
    expect(decodeHistogram({ channels: [bins(), bins(), bins().slice(0, 255)] })).toBeNull();
    const negative = bins();
    negative[3] = -1;
    expect(decodeHistogram({ channels: [negative, bins(), bins()] })).toBeNull();
    const nan = bins();
    nan[0] = Number.NaN;
    expect(decodeHistogram({ channels: [bins(), nan, bins()] })).toBeNull();
  });
});

describe("修饰与滤镜工具清单（任务 8.x）", () => {
  it("每个修饰工具都有稳定的内核命令 id", () => {
    expect(RETOUCH_TOOLS.map((tool) => tool.id)).toEqual([
      "paint.cloneStamp",
      "paint.healingBrush",
      "paint.spotHealing",
      "paint.blur",
      "paint.sharpen",
      "paint.smudge",
      "paint.dodge",
      "paint.burn",
      "paint.sponge"
    ]);
  });

  it("滤镜参数范围与内核一致（半径上限 1000）", () => {
    const gaussian = FILTER_TOOLS.find((entry) => entry.id === "filter.blur.gaussianBlur")!;
    expect(gaussian.key).toBe("radius");
    expect(gaussian.max).toBe(1000);
    const usm = FILTER_TOOLS.find((entry) => entry.id === "filter.sharpen.unsharpMask")!;
    expect(usm.key).toBe("amount");
    expect(usm.max).toBe(500);
  });
});

describe("修饰笔迹参数（任务 8.2/8.4）", () => {
  it("修饰笔迹复用同一笔刷补丁，不复制参数模型", () => {
    const brush: BrushSettings = {
      size: 40,
      hardness: 0.5,
      opacity: 1,
      flow: 1,
      smoothing: 0.1,
      color: "#000000",
      target: "pixels",
      dynamics: { shapeDynamics: { enabled: true, size: { control: "penPressure" } } }
    };
    const params = buildStroke([{ x: 4, y: 5, pressure: 0.7 }], brush, { zoom: 2 })!;
    expect(params.zoom).toBe(2);
    expect(params.brush).toEqual({ shapeDynamics: { enabled: true, size: { control: "penPressure" } } });
    expect(params.points).toEqual([[4, 5, 0.7]]);
  });
});
