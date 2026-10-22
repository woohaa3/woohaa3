import { describe, expect, it } from "vitest";
import { findAdaptiveOption } from "@woohaa3/contracts";
import { describeTokenHubModel } from "../src/provider.js";

function propertiesOf(modelType: "image" | "video", modelId: string): Record<string, Record<string, unknown>> {
  return describeTokenHubModel(modelId, modelType)
    .inputSchema?.properties as Record<string, Record<string, unknown>>;
}

describe("TokenHub 参数 schema", () => {
  it("未命中预设的图片模型保留通用语义与取值域", () => {
    const properties = propertiesOf("image", "unknown-image-model");
    expect(properties.aspectRatio).toMatchObject({
      title: "比例",
      default: "1:1",
      "x-pptask-control": "aspect-ratio",
      "x-component": "Select"
    });
    expect(properties.aspectRatio?.enum).toHaveLength(8);
    expect(findAdaptiveOption(properties.aspectRatio?.enum)).toBeUndefined();
    expect(properties.resolution).toMatchObject({
      title: "图片分辨率",
      default: "1K",
      "x-pptask-control": "resolution",
      "x-component": "Select"
    });
    expect(properties.resolution?.enum).toEqual([
      { value: "1K", label: "1K" },
      { value: "2K", label: "2K" },
      { value: "4K", label: "4K" }
    ]);
  });

  it("Hy-Image-3.5-preview 使用模型预设：自适应 + 1K/1.5K/2K", () => {
    const properties = propertiesOf("image", "hy-image-v3.5-preview");
    expect(properties.aspectRatio).toMatchObject({ default: "auto" });
    expect(findAdaptiveOption(properties.aspectRatio?.enum)).toEqual({ value: "auto", label: "自适应" });
    expect(properties.resolution).toMatchObject({ default: "1.5K" });
    expect(properties.resolution?.enum).toEqual([
      { value: "1K", label: "1K" },
      { value: "1.5K", label: "1.5K" },
      { value: "2K", label: "2K" }
    ]);
  });

  it("Hy-Image-3.0 与 Seedream 使用各自模型预设", () => {
    const hy3 = propertiesOf("image", "hy-image-v3");
    expect(hy3.aspectRatio?.default).toBe("1:1");
    expect(findAdaptiveOption(hy3.aspectRatio?.enum)).toBeUndefined();
    expect(hy3.resolution?.enum).toEqual([{ value: "1K", label: "1K" }]);

    const seedream = propertiesOf("image", "seedream-image-5-pro");
    expect(seedream.resolution).toMatchObject({ default: "2K" });
    expect(seedream.resolution?.enum).toEqual([
      { value: "1K", label: "1K" },
      { value: "1.5K", label: "1.5K" },
      { value: "2K", label: "2K" }
    ]);

    const lite = propertiesOf("image", "seedream-image-5-lite");
    expect(lite.resolution?.enum).toEqual([
      { value: "2K", label: "2K" },
      { value: "3K", label: "3K" },
      { value: "4K", label: "4K" }
    ]);

    // 即梦没有 aspect_ratio，比例靠 size 像素值兑现：有官方比例表的版本给比例控件。
    expect(seedream.aspectRatio).toMatchObject({
      title: "比例",
      default: "auto",
      "x-pptask-control": "aspect-ratio"
    });
    // 即梦「方式 1」= 只给档位、宽高比交给模型，所以面板要有自适应。
    expect(findAdaptiveOption(seedream.aspectRatio?.enum)).toEqual({ value: "auto", label: "自适应" });
    const seedreamRatios = (seedream.aspectRatio?.enum ?? []) as Array<{ value: string }>;
    expect(seedreamRatios.map((item) => item.value)).toEqual([
      "auto", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"
    ]);
    expect(seedream.quality).toBeUndefined();
    expect(seedream.n).toBeUndefined();

    // 4.0 的官方文档只给一组像素值，没有「比例 × 档位」，不提供无法兑现的控件。
    const four = propertiesOf("image", "seedream-image-4.0");
    expect(four.aspectRatio).toBeUndefined();
    expect(four.resolution?.enum).toEqual([
      { value: "1K", label: "1K" },
      { value: "2K", label: "2K" },
      { value: "4K", label: "4K" }
    ]);
  });

  it("视频比例与分辨率带公共语义，视频仍叫分辨率", () => {
    const properties = propertiesOf("video", "kling-video-v3");
    expect(properties.aspectRatio).toMatchObject({
      title: "比例",
      default: "16:9",
      "x-pptask-control": "aspect-ratio",
      "x-component": "Select"
    });
    expect(properties.aspectRatio?.enum).toHaveLength(8);
    expect(findAdaptiveOption(properties.aspectRatio?.enum)).toBeUndefined();
    expect(properties.resolution).toMatchObject({
      title: "分辨率",
      default: "720p",
      "x-pptask-control": "resolution",
      "x-component": "Select"
    });
    expect(properties.resolution?.enum).toEqual([
      { value: "720p", label: "720p" },
      { value: "1080p", label: "1080p" },
      { value: "4K", label: "4K" }
    ]);
  });
});
