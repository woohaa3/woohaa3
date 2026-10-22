import { describe, expect, it } from "vitest";
import {
  ADAPTIVE_PARAMETER_LABEL,
  ADAPTIVE_PARAMETER_VALUE,
  PPTASK_PARAMETER_ADAPTIVE,
  PPTASK_PARAMETER_CONTROL,
  aspectRatioField,
  findAdaptiveOption,
  inferParameterControl,
  isAdaptiveParameterValue,
  isAspectRatioValue,
  isPptaskParameterControl,
  qualityField,
  resolutionField,
  resolvePixelSize,
} from "./parameter-schema.js";

describe("生成参数语义 schema builder", () => {
  it("比例字段带语义标记与自适应选项", () => {
    const field = aspectRatioField({ ratios: ["1:1", "3:4"], fallback: "1:1", adaptive: true });

    expect(field[PPTASK_PARAMETER_CONTROL]).toBe("aspect-ratio");
    expect(field.default).toBe("1:1");
    expect(field.enum).toEqual([
      { value: ADAPTIVE_PARAMETER_VALUE, label: ADAPTIVE_PARAMETER_LABEL, [PPTASK_PARAMETER_ADAPTIVE]: true },
      { value: "1:1", label: "1:1" },
      { value: "3:4", label: "3:4" },
    ]);
    expect(findAdaptiveOption(field.enum)).toEqual({ value: "auto", label: "自适应" });
  });

  it("自适应取值/标签可覆盖，也可显式关闭", () => {
    const custom = aspectRatioField({
      ratios: ["16:9"],
      adaptive: { value: "adaptive", label: "跟随参考" },
      fallback: "adaptive",
    });
    expect(findAdaptiveOption(custom.enum)).toEqual({ value: "adaptive", label: "跟随参考" });

    const off = aspectRatioField({ ratios: ["16:9"], adaptive: false });
    expect(findAdaptiveOption(off.enum)).toBeUndefined();
    expect(off.default).toBeUndefined();
  });

  it("分辨率/质量字段使用各自语义并保留 hiddenWhen", () => {
    const resolution = resolutionField({
      tiers: ["1K", "2K", "4K"],
      fallback: "1K",
      title: "图片分辨率",
      hiddenWhen: [{ field: "aspectRatio", equals: "auto" }],
    });
    expect(resolution).toMatchObject({
      type: "string",
      title: "图片分辨率",
      default: "1K",
      [PPTASK_PARAMETER_CONTROL]: "resolution",
      "x-hidden-when": [{ field: "aspectRatio", equals: "auto" }],
    });
    expect(resolution.enum).toEqual([
      { value: "1K", label: "1K" },
      { value: "2K", label: "2K" },
      { value: "4K", label: "4K" },
    ]);

    const quality = qualityField({
      levels: [{ value: "high", label: "高" }, "auto"],
      fallback: "high",
    });
    expect(quality[PPTASK_PARAMETER_CONTROL]).toBe("quality");
    expect(quality.enum).toEqual([
      { value: "high", label: "高" },
      { value: "auto", label: "auto" },
    ]);
  });

  it("对照表解析像素尺寸，缺项回退", () => {
    const table = {
      "1:1": { "1K": "1024x1024" },
      "16:9": { "1K": "1536x864", "2K": "2048x1152" },
    };
    expect(resolvePixelSize({ table, aspectRatio: "16:9", resolution: "2K", fallback: "x" })).toBe("2048x1152");
    expect(resolvePixelSize({ table, aspectRatio: "16:9", resolution: "4K", fallback: "x" })).toBe("x");
    expect(resolvePixelSize({ table, aspectRatio: "missing", resolution: "1K", fallback: "x" })).toBe("x");
    expect(resolvePixelSize({ table, fallback: "x" })).toBe("x");
  });

  it("语义标记只接受已知控件", () => {
    expect(isPptaskParameterControl("aspect-ratio")).toBe(true);
    expect(isPptaskParameterControl("resolution")).toBe(true);
    expect(isPptaskParameterControl("quality")).toBe(true);
    expect(isPptaskParameterControl("slider")).toBe(false);
    expect(isPptaskParameterControl(undefined)).toBe(false);
  });

  it("按上游参数名与取值推断语义（动态 Provider）", () => {
    expect(inferParameterControl("aspect_ratio", ["auto", "16:9", "9:16", "1:1"])).toBe("aspect-ratio");
    expect(inferParameterControl("aspectRatio", ["1:1", "16:9"])).toBe("aspect-ratio");
    expect(inferParameterControl("ratio", ["16:9", "9:16"])).toBe("aspect-ratio");
    expect(inferParameterControl("aspect_ratio", ["portrait", "landscape"])).toBeUndefined();
    expect(inferParameterControl("image_size", ["square_hd", "landscape_4_3"])).toBeUndefined();
    expect(inferParameterControl("resolution", ["512P", "768P"])).toBe("resolution");
    expect(inferParameterControl("image_size", ["1K", "2K", "4K"])).toBe("resolution");
    expect(inferParameterControl("quality", ["low", "medium", "high"])).toBe("quality");
    expect(inferParameterControl("quality", ["fast", "slow"])).toBeUndefined();
    expect(inferParameterControl("seed", ["1", "2"])).toBeUndefined();
    expect(inferParameterControl("aspect_ratio", ["16:9"])).toBeUndefined();
    expect(isAspectRatioValue("21:9")).toBe(true);
    expect(isAspectRatioValue("auto")).toBe(false);
    expect(isAdaptiveParameterValue("adaptive")).toBe(true);
  });
});
