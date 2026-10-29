/**
 * Seedream 卡片投影的契约测试。
 *
 * 钉住的事实：**卡片是唯一事实来源**——版本语义（档位、像素表、网关收窄、透明背景、
 * 参考图上限）全部从 `cards/image/ark/seedream-*.ts` 投影出来，这里不复制任何数据，
 * 只验证投影与查表本身。
 */
import { describe, expect, it } from "vitest";
import {
  SEEDREAM_CARDS,
  SEEDREAM_SIZE_PRESETS,
  seedreamSizePresetFor,
  seedreamSpecOfCard
} from "./seedream-cards.js";
import {
  seedreamGatewayResolutions,
  seedreamPixelSize,
  seedreamSupportsAspectRatio,
  seedreamSupportsTransparentBackground
} from "./seedream-spec.js";

describe("卡片投影", () => {
  it("每张声明了即梦语义的卡片都能被自己的 id 命中", () => {
    expect(SEEDREAM_CARDS.length).toBeGreaterThanOrEqual(5);
    for (const card of SEEDREAM_CARDS) {
      expect(seedreamSpecOfCard(card)?.id).toBe(card.id);
      expect(seedreamSizePresetFor(card.providerModelId)?.id).toBe(card.id);
    }
    // 没声明 seedream 块的卡片不参与投影。
    expect(seedreamSpecOfCard({ ...SEEDREAM_CARDS[0]!, seedream: undefined })).toBeUndefined();
  });

  it("参考图上限取自卡片 limits，不另存一份数字", () => {
    const pro = SEEDREAM_CARDS.find((card) => card.id === "seedream-5.0-pro")!;
    const lite = SEEDREAM_CARDS.find((card) => card.id === "seedream-5.0-lite")!;
    expect(seedreamSpecOfCard(pro)?.maxReferenceImages).toBe(pro.limits?.references?.image?.max);
    expect(seedreamSpecOfCard(lite)?.maxReferenceImages).toBe(14);
  });

  it("档位与默认分辨率与卡片一致", () => {
    for (const card of SEEDREAM_CARDS) {
      const spec = seedreamSpecOfCard(card)!;
      expect(spec.resolutions).toEqual(card.seedream!.resolutions);
      expect(spec.defaultResolution).toBe(card.seedream!.defaultResolution);
      expect(spec.resolutions).toContain(spec.defaultResolution);
    }
  });
});

describe("按 id 匹配版本", () => {
  it("精确 id / 别名 / 前缀都能落回同一张卡片", () => {
    expect(seedreamSizePresetFor("doubao-seedream-5-0-pro-260628")?.id).toBe("seedream-5.0-pro");
    expect(seedreamSizePresetFor("seedream-5-pro")?.id).toBe("seedream-5.0-pro");
    expect(seedreamSizePresetFor("doubao-seedream-5.0-pro")?.id).toBe("seedream-5.0-pro");
    expect(seedreamSizePresetFor("doubao-seedream-4-5-999999")?.id).toBe("seedream-4.5");
    expect(seedreamSizePresetFor("doubao-seedream-5-0-flash-260915")?.id).toBe("seedream-5.0-flash");
  });

  it("最长前缀优先：seedream-4.5 不会被 seedream-4 抢走", () => {
    expect(seedreamSizePresetFor("seedream-4-5-251128")?.id).toBe("seedream-4.5");
    expect(seedreamSizePresetFor("seedream-4-0-250828")?.id).toBe("seedream-4.0");
    expect(seedreamSizePresetFor("seedream-image-4.5")?.id).toBe("seedream-4.5");
  });

  it("只带日期后缀的 5.0 网关 id 落到 Lite", () => {
    expect(seedreamSizePresetFor("doubao-seedream-5-0-260128")?.id).toBe("seedream-5.0-lite");
    expect(seedreamSizePresetFor("doubao-seedream-5-0-260129")?.id).toBe("seedream-5.0-lite");
  });

  it("认得出是即梦但版本未知时只给保守档位，不猜像素表", () => {
    const unknown = seedreamSizePresetFor("seedream-9-9")!;
    expect(unknown.id).toBe("seedream-unknown");
    expect(unknown.resolutions).toEqual(["1K", "2K", "4K"]);
    expect(seedreamSupportsAspectRatio(unknown)).toBe(false);
    expect(seedreamSupportsTransparentBackground(unknown)).toBe(false);
    // 非即梦 id 仍不命中，由各 Provider 回退自己的通用取值域。
    expect(seedreamSizePresetFor("nano-banana-2")).toBeUndefined();
    expect(seedreamSizePresetFor("")).toBeUndefined();
  });
});

describe("官方 size 语义", () => {
  it("网关收窄只发生在 5.0 pro（1K / 2K），其余与官方一致", () => {
    const pro = seedreamSizePresetFor("seedream-5-pro")!;
    expect(seedreamGatewayResolutions(pro)).toEqual(["1K", "2K"]);
    // 官方语义仍保留，供原生 Ark 直连使用。
    expect(pro.resolutions).toEqual(["1K", "1.5K", "2K"]);

    for (const id of ["seedream-5-flash", "seedream-5-lite", "seedream-4.5", "seedream-4.0"]) {
      const preset = seedreamSizePresetFor(id)!;
      expect(seedreamGatewayResolutions(preset)).toEqual(preset.resolutions);
    }
    for (const preset of SEEDREAM_SIZE_PRESETS) {
      expect(seedreamGatewayResolutions(preset)).toContain(preset.defaultResolution);
    }
  });

  it("按档位表把比例 + 档位翻成 WIDTHxHEIGHT", () => {
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

  it("像素表只覆盖卡片声明的档位，比例都对得上横竖方向", () => {
    for (const preset of SEEDREAM_SIZE_PRESETS) {
      for (const [tier, table] of Object.entries(preset.sizes)) {
        expect(preset.resolutions, preset.id).toContain(tier);
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

  it("像素表里的每个值都落在卡片的官方总像素窗口与宽高比范围内", () => {
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

  it("4.0 的卡片没有像素表，因此不暴露比例", () => {
    const four = seedreamSizePresetFor("seedream-4.0")!;
    expect(seedreamSupportsAspectRatio(four)).toBe(false);
    expect(four.aspectRatios).toEqual([]);
    expect(seedreamPixelSize(four, "16:9", "2K")).toBeUndefined();
  });

  it("透明背景只有 5.0 pro / flash 的卡片声明", () => {
    const supported = SEEDREAM_SIZE_PRESETS
      .filter((preset) => seedreamSupportsTransparentBackground(preset))
      .map((preset) => preset.id);
    expect(supported).toEqual(["seedream-5.0-pro", "seedream-5.0-flash"]);
  });

  it("比例或档位不在表里时返回 undefined，由调用方回退到档位", () => {
    const pro = seedreamSizePresetFor("seedream-5-pro")!;
    expect(seedreamPixelSize(pro, "16:9", "4K")).toBeUndefined();
    expect(seedreamPixelSize(pro, "5:4", "2K")).toBeUndefined();
    expect(seedreamPixelSize(pro, "", "2K")).toBeUndefined();
    expect(seedreamPixelSize(pro, "16:9", "")).toBeUndefined();
  });
});
