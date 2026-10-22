import { describe, expect, it } from "vitest";
import {
  SEEDREAM_SIZE_PRESETS,
  seedreamPixelSize,
  seedreamSizePresetFor,
  seedreamSupportsAspectRatio,
} from "./seedream-presets.js";

describe("即梦（Seedream）官方 size 语义", () => {
  it("按模型 id 命中版本，Lite 不会被 5.0 通用前缀吞掉", () => {
    expect(seedreamSizePresetFor("doubao-seedream-5-0-260128")?.id).toBe("seedream-5-lite");
    expect(seedreamSizePresetFor("doubao-seedream-5-0-lite-260128")?.id).toBe("seedream-5-lite");
    expect(seedreamSizePresetFor("doubao-seedream-5-0-pro-260628")?.id).toBe("seedream-5");
    expect(seedreamSizePresetFor("doubao-seedream-5-0-flash-260915")?.id).toBe("seedream-5");
    expect(seedreamSizePresetFor("seedream-5-pro")?.id).toBe("seedream-5");
    expect(seedreamSizePresetFor("doubao-seedream-4-5-251128")?.id).toBe("seedream-4.5");
    expect(seedreamSizePresetFor("doubao-seedream-4-0-250828")?.id).toBe("seedream-4.0");
    expect(seedreamSizePresetFor("qwen-image-2512")).toBeUndefined();
    expect(seedreamSizePresetFor("")).toBeUndefined();
  });

  it("档位与默认分辨率按版本区分", () => {
    expect(seedreamSizePresetFor("seedream-5-pro")?.resolutions).toEqual(["1K", "1.5K", "2K"]);
    expect(seedreamSizePresetFor("seedream-5-lite")?.resolutions).toEqual(["2K", "3K", "4K"]);
    expect(seedreamSizePresetFor("seedream-4.5")?.resolutions).toEqual(["2K", "4K"]);
    expect(seedreamSizePresetFor("seedream-4.0")?.resolutions).toEqual(["1K", "2K", "4K"]);
    for (const preset of SEEDREAM_SIZE_PRESETS) {
      expect(preset.resolutions).toContain(preset.defaultResolution);
    }
  });

  it("按官方像素表把比例 + 档位翻成 WIDTHxHEIGHT", () => {
    const pro = seedreamSizePresetFor("seedream-5-pro")!;
    expect(seedreamPixelSize(pro, "1:1", "2K")).toBe("2048x2048");
    expect(seedreamPixelSize(pro, "16:9", "1K")).toBe("1424x800");
    expect(seedreamPixelSize(pro, "21:9", "1.5K")).toBe("2352x1008");
    expect(seedreamPixelSize(pro, "3:4", "2K")).toBe("1728x2304");

    const lite = seedreamSizePresetFor("seedream-5-lite")!;
    expect(seedreamPixelSize(lite, "16:9", "3K")).toBe("4096x2304");
    expect(seedreamPixelSize(lite, "21:9", "4K")).toBe("6240x2656");

    const fourFive = seedreamSizePresetFor("seedream-4.5")!;
    expect(seedreamPixelSize(fourFive, "3:2", "4K")).toBe("4992x3328");
  });

  it("每个比例都给出横竖方向正确、档位内唯一的像素值", () => {
    for (const preset of SEEDREAM_SIZE_PRESETS) {
      if (!seedreamSupportsAspectRatio(preset)) continue;
      for (const table of Object.values(preset.sizes)) {
        const sizes = new Set<string>();
        for (const [ratio, size] of Object.entries(table)) {
          const [width, height] = size.split("x").map(Number) as [number, number];
          expect(Number.isInteger(width) && Number.isInteger(height)).toBe(true);
          const [left, right] = ratio.split(":").map(Number) as [number, number];
          // 像素值实际表达的宽高比要与标注一致（官方 4K 表有两行标签互换，这里按像素归位）。
          // 官方像素值本身是近似值（如 4K 16:9 = 5504x3040 ≈ 1.81），所以留 5% 容差。
          expect(Math.abs(width / height - left / right)).toBeLessThan(0.05);
          expect(sizes.has(size)).toBe(false);
          sizes.add(size);
        }
        expect(Object.keys(table).sort()).toEqual([...preset.aspectRatios].sort());
        expect(sizes.size).toBe(preset.aspectRatios.length);
      }
    }
  });

  it("像素表里的每个值都落在官方的总像素窗口与宽高比范围内", () => {
    for (const preset of SEEDREAM_SIZE_PRESETS) {
      const { minTotalPixels, maxTotalPixels, minAspectRatio, maxAspectRatio } = preset.pixelWindow;
      for (const table of Object.values(preset.sizes)) {
        for (const size of Object.values(table)) {
          const [width, height] = size.split("x").map(Number) as [number, number];
          const total = width * height;
          expect(total).toBeGreaterThanOrEqual(minTotalPixels);
          expect(total).toBeLessThanOrEqual(maxTotalPixels);
          expect(width / height).toBeGreaterThanOrEqual(minAspectRatio);
          expect(width / height).toBeLessThanOrEqual(maxAspectRatio);
        }
      }
    }
  });

  it("只认得出是即梦但不知道版本时，保留档位、不给比例", () => {
    for (const id of ["seedream", "doubao-seedream-unknown"]) {
      const generic = seedreamSizePresetFor(id);
      expect(generic?.id).toBe("seedream");
      expect(generic?.resolutions).toEqual(["1K", "2K", "4K"]);
      expect(seedreamSupportsAspectRatio(generic!)).toBe(false);
    }
    // 非即梦 id 仍不命中，由各 Provider 回退自己的通用取值域。
    expect(seedreamSizePresetFor("nano-banana-2")).toBeUndefined();
  });

  it("没有官方比例表的版本不暴露比例", () => {
    const four = seedreamSizePresetFor("seedream-4.0")!;
    expect(seedreamSupportsAspectRatio(four)).toBe(false);
    expect(four.aspectRatios).toEqual([]);
    expect(seedreamPixelSize(four, "16:9", "2K")).toBeUndefined();
  });

  it("比例或档位不在表里时返回 undefined，由调用方回退到档位", () => {
    const pro = seedreamSizePresetFor("seedream-5-pro")!;
    expect(seedreamPixelSize(pro, "16:9", "4K")).toBeUndefined();
    expect(seedreamPixelSize(pro, "5:4", "2K")).toBeUndefined();
    expect(seedreamPixelSize(pro, "", "2K")).toBeUndefined();
    expect(seedreamPixelSize(pro, "16:9", "")).toBeUndefined();
  });
});
