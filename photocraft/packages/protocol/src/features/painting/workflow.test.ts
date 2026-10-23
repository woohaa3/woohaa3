import { describe, expect, it } from "vitest";
import {
  MAX_CURVE_POINTS,
  MAX_GRADIENT_STOPS,
  MAX_TOOL_PRESET_OPTIONS_BYTES,
  PAINTING_COMMAND_PREFIXES,
  PAINT_BLEND_MODE_IDS,
  SAMPLE_SIZES,
  isPaintableBlendMode,
  isPaintingToolId,
  isSampleLayer,
  isSampleSize,
  isValidPresetName,
  normalizeBlendModeId,
  normalizeCurvePoints,
  normalizeGradientPreset,
  normalizeGradientStops,
  normalizeGradientTransparency,
  ownsPaintingCommand,
  toolPresetOptionsBytes,
  validateSampleColorParams,
  validateSymmetryParams,
  validateToolPreset
} from "./workflow.js";

describe("渐变色标校验", () => {
  it("接受单调色标并保持顺序与数值", () => {
    expect(normalizeGradientStops([[0, "#ff0000"], [0.5, "foreground"], [1, "background"]]))
      .toEqual([[0, "#ff0000"], [0.5, "foreground"], [1, "background"]]);
  });

  it("拒绝少于两个、乱序、越界与非法颜色", () => {
    expect(normalizeGradientStops([[0, "#ff0000"]])).toBeNull();
    expect(normalizeGradientStops([[0.6, "#ff0000"], [0.2, "#00ff00"]])).toBeNull();
    expect(normalizeGradientStops([[0, "#ff0000"], [1.2, "#00ff00"]])).toBeNull();
    expect(normalizeGradientStops([[0, "#f00"], [1, "#00ff00"]])).toBeNull();
    expect(normalizeGradientStops([[0, "#ff0000"], [1, "white"]])).toBeNull();
    expect(normalizeGradientStops([[0, "#ff0000"], [1, "#00ff00"], [Number.NaN, "#000000"]])).toBeNull();
    expect(normalizeGradientStops("nope")).toBeNull();
  });

  it("色标数量在预算内", () => {
    const many = Array.from({ length: MAX_GRADIENT_STOPS + 1 }, (_, index) => [index / (MAX_GRADIENT_STOPS + 1), "#000000"] as [number, string]);
    expect(normalizeGradientStops(many)).toBeNull();
    expect(normalizeGradientStops(many.slice(0, MAX_GRADIENT_STOPS))).not.toBeNull();
  });

  it("透明度缺省为不透明，越界拒绝", () => {
    expect(normalizeGradientTransparency(undefined)).toEqual([]);
    expect(normalizeGradientTransparency([[0, 100], [0.5, 0], [1, 100]])).toEqual([[0, 100], [0.5, 0], [1, 100]]);
    expect(normalizeGradientTransparency([[0, 101]])).toBeNull();
    expect(normalizeGradientTransparency([[0.5, 10], [0.2, 20]])).toBeNull();
  });

  it("整条渐变预设任一处非法就拒绝", () => {
    expect(normalizeGradientPreset({ name: "我的渐变", stops: [[0, "#000000"], [1, "#ffffff"]], transparency: [] }))
      .toEqual({ name: "我的渐变", stops: [[0, "#000000"], [1, "#ffffff"]], transparency: [] });
    expect(normalizeGradientPreset({ name: "", stops: [[0, "#000000"], [1, "#ffffff"]] })).toBeNull();
    expect(normalizeGradientPreset({ name: "x", stops: [[0, "#000000"]] })).toBeNull();
  });
});

describe("吸管参数校验", () => {
  it("默认点采样与全部图层", () => {
    expect(validateSampleColorParams({ x: 2, y: 3 })).toEqual({ x: 2, y: 3, size: 1, sampleLayer: "all" });
  });

  it("只接受内核允许的尺寸与层策略", () => {
    for (const size of SAMPLE_SIZES) expect(isSampleSize(size)).toBe(true);
    expect(isSampleSize("point")).toBe(true);
    expect(isSampleSize(4)).toBe(false);
    expect(isSampleLayer("currentAndBelow")).toBe(true);
    expect(isSampleLayer("visible")).toBe(false);
    expect(validateSampleColorParams({ x: 1, y: 1, size: 4 })).toBeNull();
    expect(validateSampleColorParams({ x: 1, y: 1, sampleLayer: "visible" })).toBeNull();
  });

  it("拒绝非有限坐标（避免被转换成别的有效坐标）", () => {
    expect(validateSampleColorParams({ x: Number.NaN, y: 1 })).toBeNull();
    expect(validateSampleColorParams({ x: Infinity, y: 1 })).toBeNull();
    expect(validateSampleColorParams({ x: "1", y: 1 })).toBeNull();
    expect(validateSampleColorParams(null)).toBeNull();
  });
});

describe("对称参数校验", () => {
  it("缺省中心与旋转合法", () => {
    expect(validateSymmetryParams({ mode: "vertical" })).toEqual({ mode: "vertical", rotation: 0 });
  });

  it("半个坐标与非有限旋转拒绝", () => {
    expect(validateSymmetryParams({ mode: "vertical", center: [1] })).toBeNull();
    expect(validateSymmetryParams({ mode: "vertical", center: [1, Number.NaN] })).toBeNull();
    expect(validateSymmetryParams({ mode: "spiral" })).toBeNull();
    expect(validateSymmetryParams({ mode: "dual", rotation: Infinity })).toBeNull();
    expect(validateSymmetryParams({ mode: "dual", center: [4, 5], rotation: 45 })).toEqual({ mode: "dual", center: [4, 5], rotation: 45 });
  });
});

describe("工具预设预算", () => {
  it("名称与工具 id 有界", () => {
    expect(isValidPresetName("我的画笔")).toBe(true);
    expect(isValidPresetName("  ")).toBe(false);
    expect(isValidPresetName("a".repeat(256))).toBe(false);
    expect(validateToolPreset({ name: "预设", tool: "brush" })).toEqual({ name: "预设", tool: "brush", options: {} });
    expect(validateToolPreset({ name: "预设", tool: "" })).toBeNull();
    expect(validateToolPreset({ name: "预设", tool: "brush", options: 3 })).toBeNull();
  });

  it("超预算的 options 与不可序列化结构都拒绝", () => {
    const big = { blob: "x".repeat(MAX_TOOL_PRESET_OPTIONS_BYTES) };
    expect(toolPresetOptionsBytes(big)).toBeGreaterThan(MAX_TOOL_PRESET_OPTIONS_BYTES);
    expect(validateToolPreset({ name: "预设", tool: "brush", options: big })).toBeNull();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toolPresetOptionsBytes(cyclic)).toBeGreaterThan(MAX_TOOL_PRESET_OPTIONS_BYTES);
    expect(validateToolPreset({ name: "预设", tool: "brush", options: cyclic })).toBeNull();
  });
});

describe("命令归属与工具 id", () => {
  it("本域命令归属与别域隔离", () => {
    for (const id of ["paint.bucket", "swatches.list", "gradient.presets.list", "tool.presets.new", "document.sampleColor", "tool.reset"]) {
      expect(ownsPaintingCommand(id), id).toBe(true);
    }
    for (const id of ["layer.delete", "select.all", "filter.blur.gaussianBlur"]) {
      expect(ownsPaintingCommand(id), id).toBe(false);
    }
    expect(PAINTING_COMMAND_PREFIXES.every((prefix) => prefix.endsWith("."))).toBe(true);
  });

  it("工具 id 白名单不含未交付工具", () => {
    expect(isPaintingToolId("bucket")).toBe(true);
    expect(isPaintingToolId("mixerBrush")).toBe(false);
    expect(isPaintingToolId(null)).toBe(false);
  });
});

describe("U30 混合模式与响应曲线", () => {
  it("混合模式清单与内核标签可互相归一化", () => {
    for (const id of PAINT_BLEND_MODE_IDS) expect(normalizeBlendModeId(id), id).toBe(id);
    expect(normalizeBlendModeId("Color Dodge")).toBe("colorDodge");
    expect(normalizeBlendModeId("Color_Burn")).toBe("colorBurn");
    expect(normalizeBlendModeId("LinearDodge")).toBe("linearDodge");
    // 界面只认自己的 id 集合：带补充说明的 PS 标签（「Linear Dodge (Add)」）不被当成 id，
    // 否则「界面显示的模式」与「真正发给内核的值」会分成两套。
    expect(normalizeBlendModeId("linear dodge (add)")).toBeNull();
    // 组专用的 Pass Through 与 erase 语义的 clear 不是可绘制的笔迹模式。
    expect(normalizeBlendModeId("passThrough")).toBeNull();
    expect(normalizeBlendModeId("clear")).toBeNull();
    expect(isPaintableBlendMode("multiply")).toBe(true);
    expect(isPaintableBlendMode(12)).toBe(false);
  });

  it("响应曲线要求 2–16 个递增的 0–1 点，且不静默排序", () => {
    expect(normalizeCurvePoints([[0, 0], [0.5, 0.2], [1, 1]])).toEqual([[0, 0], [0.5, 0.2], [1, 1]]);
    expect(normalizeCurvePoints([[0, 0]])).toBeNull();
    expect(normalizeCurvePoints([[0.6, 0], [0.2, 1], [1, 1]])).toBeNull();
    expect(normalizeCurvePoints([[0, 0], [0, 0.2], [1, 1]])).toBeNull();
    expect(normalizeCurvePoints([[0, -0.1], [1, 1]])).toBeNull();
    expect(normalizeCurvePoints([[0, 0], [1.5, 1]])).toBeNull();
    expect(normalizeCurvePoints([[0, 0], [1, 1], [2, 2]])).toBeNull();
    expect(normalizeCurvePoints([[0, 0], [Number.NaN, 1]])).toBeNull();
    const many = Array.from({ length: MAX_CURVE_POINTS + 1 }, (_, index) => [index / (MAX_CURVE_POINTS + 1), 0.5]);
    expect(normalizeCurvePoints(many)).toBeNull();
  });
});
