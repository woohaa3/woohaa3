/**
 * U57–U64 面板参数契约的回归（纯函数，不加载 WASM）。
 *
 * 这些断言与 Rust 侧 `layer_fill.rs` / `layer_workflows.rs` / `layer_filter_domain.rs`
 * 使用同一组界限数字；两处漂移时先由本文件在宿主侧暴露，避免用户先碰到内核拒绝。
 */
import { describe, expect, it } from "vitest";
import {
  LAYER_FILL_KINDS,
  LAYER_FILL_LIMITS,
  LAYER_FILTER_COMBINATION_NOTE,
  MAX_LAYER_COMPS,
  blendingParamError,
  isBlendIfList,
  isBlendIfRange,
  isGradientStops,
  layerCompParamError,
  layerFillCommandParams,
  layerFillParamError,
  layerFilterActive,
  layerFilterParamError,
  layerStylePresetParamError,
  mattingParamError,
  STYLE_PRESET_ACTIONS,
} from "./workflows.js";

describe("填充层参数（U57）", () => {
  it("三种填充各自校验自己的必填与界限", () => {
    expect(LAYER_FILL_KINDS).toEqual(["solid", "gradient", "pattern"]);
    expect(layerFillParamError("solid", { color: "#3366ff" })).toBeNull();
    expect(layerFillParamError("solid", { color: "#fff" })).toBeNull();
    expect(layerFillParamError("solid", { color: "蓝色" })).toContain("#rrggbb");
    expect(layerFillParamError("solid", null)).toContain("必须为对象");
    expect(layerFillParamError("gradient", { stops: [[0, "#000"], [1, "#fff"]] })).toBeNull();
    expect(layerFillParamError("gradient", { stops: [[0, "#000"]] })).toContain("2–1024");
    expect(layerFillParamError("gradient", { stops: [[0.6, "#000"], [0.2, "#fff"]] })).toContain("递增");
    expect(layerFillParamError("gradient", { stops: [[0, "#000"], [2, "#fff"]] })).toContain("0–1");
    expect(layerFillParamError("gradient", { scale: 9 })).toContain("10–150");
    expect(layerFillParamError("gradient", { scale: 151 })).toContain("10–150");
    // 透明度端点是百分比 0–100（与上游一致），不是 0–1。
    expect(layerFillParamError("gradient", { transparency: [[0, 100], [1, 0]] })).toBeNull();
    expect(layerFillParamError("gradient", { transparency: [[0, 0], [1, 100]] })).toBeNull();
    expect(layerFillParamError("gradient", { transparency: [[0, 101]] })).toContain("透明度");
    expect(layerFillParamError("gradient", { transparency: [[0, -1]] })).toContain("透明度");
    expect(layerFillParamError("gradient", { transparency: [[1.5, 100]] })).toContain("透明度");
    expect(layerFillParamError("pattern", { pattern: "Checkerboard", scale: 200 })).toBeNull();
    expect(layerFillParamError("pattern", {})).toContain("选择图案");
    expect(layerFillParamError("pattern", { pattern: "Checkerboard", scale: 0 })).toContain("1–1000");
    expect(layerFillParamError("pattern", { pattern: "Checkerboard", angle: 361 })).toContain("±360");
  });

  it("端点点数与上限和内核一致", () => {
    const at = (index: number) => [index / LAYER_FILL_LIMITS.maxGradientStops, "#fff"] as const;
    const many = Array.from({ length: LAYER_FILL_LIMITS.maxGradientStops }, (_, index) => at(index));
    expect(isGradientStops(many)).toBe(true);
    expect(isGradientStops([...many, at(0)])).toBe(false);
    expect(isGradientStops([[0, null]])).toBe(false);
  });

  it("面板路由标记不进入内核参数", () => {
    expect(layerFillCommandParams("solid", { fillKind: "solid", color: "#000" })).toEqual({ color: "#000" });
    expect(layerFillCommandParams("pattern", { color: "#000" })).toEqual({ color: "#000" });
  });
});

describe("高级混合参数（U60）", () => {
  it("Blend If 端点必须 2/4 项、0–255 且单调", () => {
    expect(isBlendIfRange([0, 255])).toBe(true);
    expect(isBlendIfRange([30, 60, 200, 235])).toBe(true);
    expect(isBlendIfRange([60, 30])).toBe(false);
    expect(isBlendIfRange([0, 255, 200, 235])).toBe(false);
    expect(isBlendIfRange([0, 300])).toBe(false);
    expect(isBlendIfRange([0])).toBe(false);
  });

  it("Blend If 列表拒绝未知字段与空通道", () => {
    expect(isBlendIfList(null)).toBe(true);
    expect(isBlendIfList({ channel: "gray", thisLayer: [0, 255] })).toBe(true);
    expect(isBlendIfList([{ channel: "red" }, { channel: 2, underlying: [10, 20] }])).toBe(true);
    expect(isBlendIfList({ channel: "" })).toBe(false);
    expect(isBlendIfList({ channel: "gray", extra: 1 })).toBe(false);
    expect(isBlendIfList([{ thisLayer: [0, 1] }])).toBe(false);
    expect(isBlendIfList(new Array(9).fill({ channel: "gray" }))).toBe(false);
  });

  it("挖空、通道开关与布尔选项逐项校验", () => {
    expect(blendingParamError({})).toBeNull();
    expect(blendingParamError({ knockout: "deep", channels: [true, true, false] })).toBeNull();
    expect(blendingParamError({ knockout: "deepish" })).toContain("none、shallow 或 deep");
    expect(blendingParamError({ channels: [true, "3"] })).toContain("布尔");
    expect(blendingParamError({ blendInteriorEffectsAsGroup: "yes" })).toContain("布尔值");
    expect(blendingParamError({ blendIf: { channel: "gray", thisLayer: [200, 60] } })).toContain("端点");
    expect(blendingParamError(null)).toContain("必须为对象");
  });
});

describe("去边与净化参数（U62）", () => {
  it("宽度、强度与半径有界", () => {
    expect(mattingParamError("layer.matting.defringe", { width: 1 })).toBeNull();
    expect(mattingParamError("layer.matting.defringe", { width: 200 })).toBeNull();
    expect(mattingParamError("layer.matting.defringe", { width: 0 })).toContain("1–200");
    expect(mattingParamError("layer.matting.defringe", { width: 201 })).toContain("1–200");
    expect(mattingParamError("layer.matting.colorDecontaminate", { amount: 0, radius: 100 })).toBeNull();
    expect(mattingParamError("layer.matting.colorDecontaminate", { amount: 101 })).toContain("0–100");
    expect(mattingParamError("layer.matting.colorDecontaminate", { radius: 0 })).toContain("1–100");
    // 无参数命令（去黑/白杂边）不要求字段。
    expect(mattingParamError("layer.matting.removeBlackMatte", null)).toBeNull();
  });
});

describe("图层复合参数（U64）", () => {
  it("名称与选项字段有界", () => {
    expect(MAX_LAYER_COMPS).toBe(64);
    expect(layerCompParamError("layerComp.new", { name: "显示态" })).toBeNull();
    expect(layerCompParamError("layerComp.new", { name: "" })).toContain("1–200");
    expect(layerCompParamError("layerComp.new", { name: "x".repeat(201) })).toContain("1–200");
    expect(layerCompParamError("layerComp.new", { visibility: "yes" })).toContain("布尔值");
    expect(layerCompParamError("layerComp.setOptions", { appearance: true, position: false })).toBeNull();
    expect(layerCompParamError("layerComp.apply", { comp: 1 })).toBeNull();
  });
});

describe("图层过滤参数（U63）", () => {
  it("组合条件与未知值", () => {
    expect(layerFilterParamError({})).toBeNull();
    expect(layerFilterParamError({ by: "mode", mode: "multiply" })).toBeNull();
    expect(layerFilterParamError({ kinds: ["raster", "shape", "group"] })).toBeNull();
    expect(layerFilterParamError({ onlySelected: true })).toBeNull();
    expect(layerFilterParamError({ by: "bogus" })).toContain("kind、name 或 mode");
    expect(layerFilterParamError({ kinds: ["pixel"] })).toContain("种类只接受");
    expect(layerFilterParamError({ kinds: "raster" })).toContain("数组");
    expect(layerFilterParamError({ onlySelected: "yes" })).toContain("布尔值");
    expect(layerFilterParamError({ name: "a".repeat(201) })).toContain("200");
    expect(layerFilterParamError(null)).toContain("必须为对象");
  });

  it("空条件不算过滤，模式主条件总在过滤", () => {
    expect(layerFilterActive({})).toBe(false);
    expect(layerFilterActive({ name: "  " })).toBe(false);
    expect(layerFilterActive({ kinds: [] })).toBe(false);
    expect(layerFilterActive({ by: "mode" })).toBe(true);
    expect(layerFilterActive({ onlySelected: true })).toBe(true);
    expect(LAYER_FILTER_COMBINATION_NOTE).toContain("父组");
  });
});

describe("样式预设管理参数（U61）", () => {
  it("list/reset 只接受各自字段", () => {
    expect(layerStylePresetParamError("style.presets.list", {})).toBeNull();
    expect(layerStylePresetParamError("style.presets.list", { nope: 1 })).toContain("不接受参数");
    expect(layerStylePresetParamError("style.presets.reset", {})).toBeNull();
    expect(layerStylePresetParamError("style.presets.reset", { append: true })).toBeNull();
    expect(layerStylePresetParamError("style.presets.reset", { append: "yes" })).toContain("布尔值");
    expect(layerStylePresetParamError("style.presets.reset", { nope: 1 })).toContain("不接受");
  });

  it("new 要求至少包含效果或混合选项，名称有界", () => {
    expect(layerStylePresetParamError("style.presets.new", { name: "金色" })).toBeNull();
    expect(layerStylePresetParamError("style.presets.new", { name: "x".repeat(201) })).toContain("1–200");
    expect(layerStylePresetParamError("style.presets.new", { name: "  " })).toContain("1–200");
    expect(layerStylePresetParamError("style.presets.new", { name: "金色", effects: "x" })).toContain("[[kind, params]");
    expect(layerStylePresetParamError("style.presets.new", { includeEffects: false, includeBlending: false })).toContain("至少");
    expect(layerStylePresetParamError("style.presets.new", { name: "金色", nope: 1 })).toContain("不接受");
  });

  it("edit 逐动作校验：改名/删除/移动/组操作", () => {
    expect(STYLE_PRESET_ACTIONS).toEqual(["rename", "delete", "move", "newGroup", "renameGroup", "deleteGroup"]);
    expect(layerStylePresetParamError("style.presets.edit", { action: "rename", preset: "旧", name: "新" })).toBeNull();
    expect(layerStylePresetParamError("style.presets.edit", { action: "rename", preset: "旧" })).toContain("新名称");
    expect(layerStylePresetParamError("style.presets.edit", { action: "delete", preset: ["甲", "乙"] })).toBeNull();
    expect(layerStylePresetParamError("style.presets.edit", { action: "delete", preset: [] })).toContain("名称");
    expect(layerStylePresetParamError("style.presets.edit", { action: "move", preset: "甲", to: "组" })).toBeNull();
    expect(layerStylePresetParamError("style.presets.edit", { action: "move", preset: "甲" })).toContain("to");
    expect(layerStylePresetParamError("style.presets.edit", { action: "newGroup", name: "新组" })).toBeNull();
    expect(layerStylePresetParamError("style.presets.edit", { action: "deleteGroup", group: "组" })).toBeNull();
    expect(layerStylePresetParamError("style.presets.edit", { action: "deleteGroup" })).toContain("group");
    expect(layerStylePresetParamError("style.presets.edit", { action: "bogus" })).toContain("action 只接受");
    expect(layerStylePresetParamError("style.presets.edit", { action: "rename", preset: "旧", name: "新", index: -1 })).toContain("index");
    expect(layerStylePresetParamError("style.presets.edit", { action: "rename", preset: "旧", name: "新", nope: 1 })).toContain("不接受");
  });

  it("非预设命令被拒绝", () => {
    expect(layerStylePresetParamError("style.presets.apply", {})).toContain("不是样式预设命令");
    expect(layerStylePresetParamError("layer.linkLayers", {})).toContain("不是样式预设命令");
  });
});

describe("样式默认值参数（U61）", () => {
  it("defaultFor/makeDefault 只接受 kind 与 params", () => {
    expect(layerStylePresetParamError("layer.layerStyle.defaultFor", { kind: "dropShadow" })).toBeNull();
    expect(layerStylePresetParamError("layer.layerStyle.defaultFor", {})).toContain("kind");
    expect(layerStylePresetParamError("layer.layerStyle.defaultFor", { kind: "dropShadow", params: {} })).toContain("不接受");
    expect(layerStylePresetParamError("layer.layerStyle.makeDefault", { kind: "dropShadow", params: { distance: 3 } })).toBeNull();
    expect(layerStylePresetParamError("layer.layerStyle.makeDefault", { kind: "dropShadow" })).toContain("params");
    expect(layerStylePresetParamError("layer.layerStyle.makeDefault", { kind: "dropShadow", params: [] })).toContain("params");
  });
});
