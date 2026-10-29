import { describe, expect, it } from "vitest";
import { IMAGE_MODEL_PRESETS, imageModelPresetFor } from "./model-presets.js";

describe("生成模型参数预设", () => {
  it("Hy-Image-3.5-preview 支持自适应与 1K/1.5K/2K", () => {
    for (const id of ["hy-image-v3.5-preview", "hy-image-v35-preview", "hy3.5-preview"]) {
      const preset = imageModelPresetFor(id);
      expect(preset?.id).toBe("hy-image-v3.5-preview");
      expect(preset?.adaptiveAspectRatio).toBe(true);
      expect(preset?.resolutions).toEqual(["1K", "1.5K", "2K"]);
      expect(preset?.defaultResolution).toBe("1.5K");
    }
  });

  it("Hy-Image-3.0 只有 1K 且不支持自适应", () => {
    const preset = imageModelPresetFor("hy-image-v3");
    expect(preset?.resolutions).toEqual(["1K"]);
    expect(preset?.adaptiveAspectRatio).toBe(false);
  });

  it("Seedream 版本按优先级匹配，Lite 不会被 5.0 通用前缀吞掉", () => {
    expect(imageModelPresetFor("doubao-seedream-5-0-260128")?.id).toBe("seedream-5.0-lite");
    expect(imageModelPresetFor("doubao-seedream-5-0-pro-260628")?.id).toBe("seedream-5.0-pro");
    expect(imageModelPresetFor("seedream-5-pro")?.resolutions).toEqual(["1K", "1.5K", "2K"]);
    expect(imageModelPresetFor("doubao-seedream-5-0-flash-260915")?.id).toBe("seedream-5.0-flash");
    expect(imageModelPresetFor("doubao-seedream-4-5-251128")?.resolutions).toEqual(["2K", "4K"]);
    expect(imageModelPresetFor("doubao-seedream-4-0-250828")?.resolutions).toEqual(["1K", "2K", "4K"]);
  });

  it("Gemini / Nano Banana / GPT Image 使用各自画幅与分辨率", () => {
    expect(imageModelPresetFor("gemini-3-pro-image")?.aspectRatios).toHaveLength(10);
    expect(imageModelPresetFor("gemini-3.1-flash-image")?.aspectRatios).toHaveLength(14);
    expect(imageModelPresetFor("gemini-3.1-flash-image")?.resolutions).toContain("512");
    expect(imageModelPresetFor("gemini-3.1-flash-lite-image")?.resolutions).toEqual(["1K"]);
    expect(imageModelPresetFor("gemini-nano-banana-2.1")?.resolutions).toEqual(["1K", "2K", "4K"]);
    expect(imageModelPresetFor("gpt-image-2.5-flare")?.adaptiveAspectRatio).toBe(true);
  });

  it("注册表 id 唯一且未知模型返回 undefined", () => {
    const ids = IMAGE_MODEL_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(imageModelPresetFor("qwen-image-2512")).toBeUndefined();
    expect(imageModelPresetFor("")).toBeUndefined();
  });
});
