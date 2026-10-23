/**
 * 绘画/颜色工作流的域内回归
 * （change: 2026-10-22-add-photocraft-painting-color-workflows，U27–U36）。
 *
 * 这里锁定三件容易悄悄退化的事：
 *
 * 1. **参数编译**：每个工具只发内核 `CommandSpec` 认识的字段，非法输入返回 `null` 而不是被
 *    悄悄改成别的值（否则界面显示与实际落笔不一致）；
 * 2. **逐工具冻结**：切换工具不互相污染设置，冻结快照在笔迹期间不随后续编辑变化；
 * 3. **命令通道**：像素命令必须过草稿门并同步视图，偏好命令不得冒充像素命令。
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BACKGROUND_ERASER,
  DEFAULT_BUCKET,
  DEFAULT_COLOR_REPLACEMENT,
  DEFAULT_GRADIENT,
  DEFAULT_MAGIC_ERASER,
  DEFAULT_PENCIL,
  GRADIENT_METHODS,
  buildBackgroundEraser,
  buildBucket,
  buildColorReplacement,
  buildGradient,
  buildMagicEraser,
  buildPatternBucket,
  buildPencil,
  buildSampleColor,
  buildSymmetry,
  buildSymmetryDisable,
  buildSymmetryFromPath,
  decodeSampledColor,
  decodeSymmetryState
} from "./tool-modes.js";
import {
  defaultPaintingToolSettings,
  freezeStroke,
  hasDedicatedSettings,
  normalizeSymmetry,
  settingsForTool,
  TOOL_PRESET_TOOLS
} from "./tool-settings-state.js";
import {
  buildToolPreset,
  buildToolPresetEdit,
  decodeGradientLibrary,
  decodeSwatchLibrary,
  decodeToolPresets,
  filterToolPresets,
  gradientPresetStops
} from "./preset-state.js";
import {
  PAINT_CONTENT_COMMANDS,
  isPaintContentCommand,
  paintCommand,
  preferenceCommand
} from "./workspace.js";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import { PAINTING_TOOL_WIRING } from "./tool-manifest.js";
import { PAINTING_PANEL_TOOLS } from "./panels.js";

describe("U27 铅笔与颜色替换参数", () => {
  it("铅笔是硬边笔尖，模式可选但不接受未知模式", () => {
    const params = buildPencil([{ x: 2, y: 3, pressure: 0.5 }], { ...DEFAULT_PENCIL, size: 6 })!;
    expect(params).toMatchObject({ points: [[2, 3, 0.5]], size: 6, mode: "normal", autoErase: false, target: "pixels" });
    expect(params.brush).toMatchObject({ hardness: 1, flow: 1, opacity: 1 });
    expect(buildPencil([{ x: 1, y: 1 }], DEFAULT_PENCIL, { mode: "multiply" })!.mode).toBe("multiply");
    // `dissolve` 是合法笔迹模式（内核按每个 dab 的概率取像素）；`passThrough` 只对组有意义。
    expect(buildPencil([{ x: 1, y: 1 }], DEFAULT_PENCIL, { mode: "dissolve" })!.mode).toBe("dissolve");
    expect(buildPencil([{ x: 1, y: 1 }], DEFAULT_PENCIL, { mode: "passThrough" as never })).toBeNull();
    expect(buildPencil([], DEFAULT_PENCIL)).toBeNull();
    expect(buildPencil([{ x: 1, y: 1 }], { ...DEFAULT_PENCIL, color: "red" })).toBeNull();
  });

  it("铅笔尺寸仍受共享笔刷上限钳制（不做第二套预算）", () => {
    const params = buildPencil([{ x: 1, y: 1 }], { ...DEFAULT_PENCIL, size: 100_000 })!;
    expect(params.size).toBe(512);
    expect(buildPencil([{ x: 1, y: 1 }], { ...DEFAULT_PENCIL, size: 0 })!.size).toBe(1);
  });

  it("颜色替换拒绝未知模式/取样/边界，容差按 0–100 钳制", () => {
    const paint = { size: 8, color: "#112233" };
    const params = buildColorReplacement([{ x: 1, y: 2 }], { mode: "hue", tolerance: 55, sampling: "once", limits: "findEdges", antiAlias: false }, paint)!;
    expect(params).toMatchObject({ mode: "hue", tolerance: 55, sampling: "once", limits: "findEdges", antiAlias: false, target: "pixels" });
    expect(buildColorReplacement([{ x: 1, y: 1 }], { mode: "nope" as never, tolerance: 10, sampling: "once", limits: "contiguous", antiAlias: true }, paint)).toBeNull();
    expect(buildColorReplacement([{ x: 1, y: 1 }], { mode: "color", tolerance: 10, sampling: "never" as never, limits: "contiguous", antiAlias: true }, paint)).toBeNull();
    const clamped = buildColorReplacement([{ x: 1, y: 1 }], { mode: "color", tolerance: 900, sampling: "continuous", limits: "contiguous", antiAlias: true }, paint)!;
    expect(clamped.tolerance).toBe(100);
  });
});

describe("U28 渐变与油漆桶参数", () => {
  it("渐变端点用源坐标，色标必须单调且颜色合法", () => {
    const params = buildGradient({ x: 0, y: 5 }, { x: 30, y: 5 }, {
      ...DEFAULT_GRADIENT,
      stops: [{ location: 0, color: "foreground" }, { location: 0.5, color: "#ff0000" }, { location: 1, color: "background" }],
      transparency: [{ location: 1, opacity: 20 }]
    })!;
    expect(params.from).toEqual([0, 5]);
    expect(params.to).toEqual([30, 5]);
    expect(params.stops).toEqual([[0, "foreground"], [0.5, "#ff0000"], [1, "background"]]);
    expect(params.transparency).toEqual([[1, 20]]);
    expect(params.mode).toBe("normal");
    // 端点重合、色标乱序、色标越界与非有限坐标全部拒绝。
    expect(buildGradient({ x: 1, y: 1 }, { x: 1, y: 1 }, DEFAULT_GRADIENT)).toBeNull();
    expect(buildGradient({ x: 0, y: 0 }, { x: 5, y: 0 }, { ...DEFAULT_GRADIENT, stops: [{ location: 1, color: "foreground" }, { location: 0, color: "background" }] })).toBeNull();
    expect(buildGradient({ x: 0, y: 0 }, { x: 5, y: 0 }, { ...DEFAULT_GRADIENT, stops: [{ location: -1, color: "foreground" }, { location: 1, color: "background" }] })).toBeNull();
    expect(buildGradient({ x: 0, y: 0 }, { x: 5, y: 0 }, { ...DEFAULT_GRADIENT, stops: [{ location: 0, color: "foreground" }] })).toBeNull();
    expect(buildGradient({ x: 0, y: 0 }, { x: 5, y: 0 }, { ...DEFAULT_GRADIENT, style: "swirl" as never })).toBeNull();
  });

  it("渐变插值方式与平滑度进入命令，未知方式整笔拒绝", () => {
    // 不给 method 时不发这两个键：内核按直线色标处理。
    const plain = buildGradient({ x: 0, y: 0 }, { x: 9, y: 0 }, DEFAULT_GRADIENT)!;
    expect(plain.method).toBeUndefined();
    expect(plain.smoothness).toBeUndefined();

    const classic = buildGradient({ x: 0, y: 0 }, { x: 9, y: 0 }, { ...DEFAULT_GRADIENT, method: "classic", smoothness: 40 })!;
    expect(classic).toMatchObject({ method: "classic", smoothness: 40 });

    // smoothness 只在给了 method 时才发：没有插值方式时它不起作用。
    expect(buildGradient({ x: 0, y: 0 }, { x: 9, y: 0 }, { ...DEFAULT_GRADIENT, smoothness: 40 })!.smoothness).toBeUndefined();

    // 未知方式整笔拒绝，而不是静默退回直线色标（内核会静默接受，所以拒绝只能由这里负责）。
    expect(buildGradient({ x: 0, y: 0 }, { x: 9, y: 0 }, { ...DEFAULT_GRADIENT, method: "bogus" as never })).toBeNull();
    // 平滑度与其它连续参数一致：越界钳制到 0–100，非有限值拒绝（不静默当 100）。
    expect(buildGradient({ x: 0, y: 0 }, { x: 9, y: 0 }, { ...DEFAULT_GRADIENT, method: "linear", smoothness: 101 })!.smoothness).toBe(100);
    expect(buildGradient({ x: 0, y: 0 }, { x: 9, y: 0 }, { ...DEFAULT_GRADIENT, method: "linear", smoothness: -5 })!.smoothness).toBe(0);
    expect(buildGradient({ x: 0, y: 0 }, { x: 9, y: 0 }, { ...DEFAULT_GRADIENT, method: "linear", smoothness: Number.NaN })).toBeNull();
    // 四个合法方式都能通过。
    for (const method of GRADIENT_METHODS) {
      expect(buildGradient({ x: 0, y: 0 }, { x: 9, y: 0 }, { ...DEFAULT_GRADIENT, method })!.method).toBe(method);
    }
  });

  it("颜色替换用自己的笔头尺寸，不再改写背景橡皮的状态", () => {
    // 早前面板把「笔头尺寸」绑在 `backgroundEraser.size` 上：在颜色替换里改尺寸，
    // 背景橡皮的笔头会跟着变，违反「逐工具冻结笔迹设置」。现在各自独立。
    const own = buildColorReplacement([{ x: 0, y: 0 }], { ...DEFAULT_COLOR_REPLACEMENT, size: 7 }, { size: 99, color: "#ff0000" })!;
    expect(own.size).toBe(7);
    // 旧调用方省略 `size` 时仍回落到传入尺寸（保持既有形状，不破坏其它调用方）。
    const legacy = buildColorReplacement([{ x: 0, y: 0 }], DEFAULT_COLOR_REPLACEMENT, { size: 99, color: "#ff0000" })!;
    expect(legacy.size).toBe(99);
  });

  it("铅笔颜色跟随当前前景色，不写死默认黑", () => {
    // 铅笔是面板里唯一把颜色编进命令的拖动类工具；用默认 `#000000` 会让「改了前景色仍然画黑」。
    const params = buildPencil([{ x: 1, y: 1 }], { ...DEFAULT_PENCIL, color: "#00ff00" })!;
    expect(params.color).toBe("#00ff00");
    // 硬边笔尖仍是铅笔的定义（硬度 1、无软边与流量）。
    expect(params.brush).toMatchObject({ hardness: 1, flow: 1, opacity: 1 });
  });

  it("油漆桶容差是 0–255（不是百分比），图案填充只透传来源", () => {    const params = buildBucket({ x: 4, y: 6 }, "#00ff00", { ...DEFAULT_BUCKET, tolerance: 300, opacity: 0 })!;
    expect(params).toMatchObject({ x: 4, y: 6, color: "#00ff00", tolerance: 255, opacity: 1, contiguous: true, sampleAllLayers: false });
    expect(buildBucket({ x: 4, y: 6 }, "green", DEFAULT_BUCKET)).toBeNull();
    const pattern = buildPatternBucket({ x: 1, y: 1 }, "斜纹", DEFAULT_BUCKET)!;
    expect(pattern.contents).toBe("pattern");
    expect(pattern.pattern).toBe("斜纹");
    expect(buildPatternBucket({ x: 1, y: 1 }, "  ", DEFAULT_BUCKET)).toBeNull();
  });
});

describe("U29 背景橡皮与魔术橡皮参数", () => {
  it("背景橡皮保留取样/边界/保护颜色，非法采样被拒绝", () => {
    const params = buildBackgroundEraser([{ x: 3, y: 3 }], { ...DEFAULT_BACKGROUND_ERASER, protectForegroundColor: true, tolerance: 80 })!;
    expect(params).toMatchObject({ sampling: "continuous", limits: "contiguous", tolerance: 80, protectForegroundColor: true, target: "pixels" });
    expect(buildBackgroundEraser([{ x: 1, y: 1 }], { ...DEFAULT_BACKGROUND_ERASER, sampling: "sometimes" as never })).toBeNull();
    expect(buildBackgroundEraser([{ x: 1, y: 1 }], { ...DEFAULT_BACKGROUND_ERASER, limits: "wobbly" as never })).toBeNull();
    expect(buildBackgroundEraser([], DEFAULT_BACKGROUND_ERASER)).toBeNull();
  });

  it("魔术橡皮按 0–255 容差与连通性工作", () => {
    expect(buildMagicEraser({ x: 2, y: 2 }, { ...DEFAULT_MAGIC_ERASER, contiguous: false, tolerance: 200 }))
      .toMatchObject({ x: 2, y: 2, tolerance: 200, contiguous: false, antiAlias: true, opacity: 100 });
    expect(buildMagicEraser({ x: Number.NaN, y: 2 }, DEFAULT_MAGIC_ERASER)).toBeNull();
  });
});

describe("U33 对称与 U34 吸管参数", () => {
  it("对称参数校验模式与中心，路径对称只传来源名", () => {
    expect(buildSymmetry({ mode: "diagonal", center: [12, 9], rotation: 45 })).toEqual({ mode: "diagonal", center: [12, 9], rotation: 45 });
    expect(buildSymmetry({ mode: "spiral" as never, center: [0, 0], rotation: 0 })).toBeNull();
    expect(buildSymmetry({ mode: "vertical", center: [Number.POSITIVE_INFINITY, 0], rotation: 0 })).toBeNull();
    expect(buildSymmetryFromPath("work")).toEqual({ name: "work" });
    expect(buildSymmetryFromPath("  ")).toBeNull();
    expect(buildSymmetryDisable()).toEqual({});
    // 状态解码：未启用、预设、路径三种形状。
    expect(decodeSymmetryState({ enabled: false })).toEqual({ enabled: false });
    expect(decodeSymmetryState({ enabled: true, mode: "vertical", center: [5, 5], rotation: 0 })).toMatchObject({ enabled: true, mode: "vertical" });
    expect(decodeSymmetryState({ enabled: true, source: "work", segments: 3 })).toMatchObject({ enabled: true, mode: "path", source: "work", segments: 3 });
    expect(decodeSymmetryState({ enabled: true })).toBeNull();
    expect(decodeSymmetryState("on")).toBeNull();
  });

  it("吸管只接受内核允许的采样尺寸/层，结果解码区分空与非法", () => {
    expect(buildSampleColor({ x: 3, y: 4 }, { size: 5, sampleLayer: "currentAndBelow", target: "foreground" }))
      .toEqual({ x: 3, y: 4, size: 5, sampleLayer: "currentAndBelow" });
    expect(buildSampleColor({ x: 3, y: 4 }, { size: "point", sampleLayer: "all", target: "background" })).toMatchObject({ size: "point" });
    expect(buildSampleColor({ x: 3, y: 4 }, { size: 4 as never, sampleLayer: "all", target: "foreground" })).toBeNull();
    expect(buildSampleColor({ x: 3, y: 4 }, { size: 1, sampleLayer: "everything" as never, target: "foreground" })).toBeNull();
    const sampled = decodeSampledColor({ hex: "#1a2b3c", alpha: 0.5, rgba: [0.1, 0.2, 0.3, 0.5] });
    expect(sampled).toMatchObject({ hex: "#1a2b3c", alpha: 0.5 });
    // `null` 是内核明确的「没有颜色」，非法结构是 `undefined`：两者不能混为一谈。
    expect(decodeSampledColor(null)).toBeNull();
    expect(decodeSampledColor({ hex: "not-a-color", alpha: 1, rgba: [0, 0, 0, 1] })).toBeUndefined();
    expect(decodeSampledColor({ hex: "#000000", alpha: 2, rgba: [0, 0, 0, 1] })).toBeUndefined();
  });
});

describe("D1 逐工具冻结设置", () => {
  it("每个工具记住自己的设置，切换不互相污染", () => {
    const settings = defaultPaintingToolSettings([10, 20]);
    settings.pencil.size = 9;
    const pencil = settingsForTool(settings, "pencil") as { size: number };
    expect(pencil.size).toBe(9);
    // 取到的是副本：面板改草稿不会改到已冻结的上一笔。
    pencil.size = 3;
    expect((settingsForTool(settings, "pencil") as { size: number }).size).toBe(9);
    expect(settingsForTool(settings, "bucket")).toMatchObject(DEFAULT_BUCKET);
    expect(settingsForTool(settings, "brush")).toBeNull();
    expect(hasDedicatedSettings("pencil")).toBe(true);
    expect(hasDedicatedSettings("brush")).toBe(false);
    expect(settings.symmetry.center).toEqual([10, 20]);
  });

  it("冻结快照在后续编辑后保持不变", () => {
    const settings = defaultPaintingToolSettings();
    const frozen = freezeStroke("pencil", settings.pencil, "multiply");
    settings.pencil.size = 99;
    expect(frozen.settings.size).toBe(DEFAULT_PENCIL.size);
    expect(frozen.blendMode).toBe("multiply");
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it("对称中心钳制到文档内，旋转归一化到 0–360", () => {
    expect(normalizeSymmetry({ mode: "vertical", center: [-5, 900], rotation: -90 }, 100, 50))
      .toEqual({ mode: "vertical", center: [0, 50], rotation: 270 });
    expect(normalizeSymmetry({ mode: "vertical", center: [Number.NaN, 10], rotation: Number.NaN }, 100, 50))
      .toEqual({ mode: "vertical", center: [50, 10], rotation: 0 });
  });

  it("工具预设白名单与内核一致，未开放工具名不在其中", () => {
    expect(TOOL_PRESET_TOOLS).toContain("gradient");
    expect(TOOL_PRESET_TOOLS).toContain("eyedropper");
    expect(TOOL_PRESET_TOOLS).not.toContain("liquify");
  });
});

describe("U35/U36 预设解码与编译", () => {
  it("色板库拒绝越界模型、长度与非法 hex", () => {
    const library = decodeSwatchLibrary({
      groups: [{
        name: "默认",
        swatches: [
          { name: "红", model: "rgb", values: [255, 0, 0], hex: "#ff0000", kind: "global" },
          { name: "灰", model: "gray", values: [50], hex: "#808080" }
        ]
      }]
    })!;
    expect(library.count).toBe(2);
    expect(library.groups[0]!.swatches[0]!.kind).toBe("global");
    expect(library.groups[0]!.swatches[1]!.kind).toBe("process");
    expect(decodeSwatchLibrary({ groups: [{ name: "x", swatches: [{ name: "红", model: "rgb", values: [255, 0], hex: "#ff0000" }] }] })).toBeNull();
    expect(decodeSwatchLibrary({ groups: [{ name: "x", swatches: [{ name: "红", model: "rgb", values: [999, 0, 0], hex: "#ff0000" }] }] })).toBeNull();
    expect(decodeSwatchLibrary({ groups: [{ name: "x", swatches: [{ name: "红", model: "rgb", values: [255, 0, 0], hex: "#GG0000" }] }] })).toBeNull();
  });

  it("渐变预设解码与色标编译，非法色标整组拒绝", () => {
    const library = decodeGradientLibrary({
      groups: [{ name: "基础", presets: [{ name: "黑白", stops: [[0, "#000000"], [1, "#ffffff"]], transparency: [[1, 0]] }] }],
      current: { name: "黑白", stops: [[0, "#000000"], [1, "#ffffff"]] }
    })!;
    expect(library.current?.name).toBe("黑白");
    expect(gradientPresetStops(library.current!)).toEqual({ stops: [[0, "#000000"], [1, "#ffffff"]], transparency: [] });
    expect(decodeGradientLibrary({ groups: [{ name: "基础", presets: [{ name: "坏", stops: [[1, "#000000"], [0, "#ffffff"]] }] }] })).toBeNull();
    expect(decodeGradientLibrary({ groups: [{ name: "基础", presets: [{ name: "单色标", stops: [[0, "#000000"]] }] }] })).toBeNull();
  });

  it("工具预设解码按工具过滤，重名与超预算参数被拒绝", () => {
    const list = decodeToolPresets({
      presets: [
        { name: "大画笔", tool: "brush", options: { brush: { size: 200 }, foreground: [1, 0, 0, 1] } },
        { name: "细铅笔", tool: "Pencil Tool", options: {} }
      ]
    })!;
    expect(list.presets[0]!.foreground).toBe("#ff0000");
    expect(filterToolPresets(list, "pencil").map((preset) => preset.name)).toEqual(["细铅笔"]);
    expect(filterToolPresets(list, "brush").map((preset) => preset.name)).toEqual(["大画笔"]);
    expect(decodeToolPresets({ presets: [{ name: "A", tool: "brush" }, { name: "a", tool: "brush" }] })).toBeNull();
    expect(decodeToolPresets({ presets: [{ name: "", tool: "brush" }] })).toBeNull();
    expect(decodeToolPresets({ presets: [{ name: "A", tool: "brush", options: "nope" }] })).toBeNull();

    const params = buildToolPreset({ name: " 新预设 ", tool: "brush", includeColor: true })!;
    expect(params).toMatchObject({ name: "新预设", tool: "brush", includeColor: true });
    // 没有 options 时不发送空对象（否则会覆盖内核的「当前笔刷」默认）。
    expect("options" in params).toBe(false);
    expect(buildToolPreset({ name: "  ", tool: "brush" })).toBeNull();
    expect(buildToolPresetEdit("rename", "旧", "新")).toEqual({ action: "rename", preset: "旧", name: "新" });
    expect(buildToolPresetEdit("rename", "旧", "  ")).toBeNull();
    expect(buildToolPresetEdit("delete", "旧")).toEqual({ action: "delete", preset: "旧" });
  });
});

describe("绘画工具接线表", () => {
  it("清单与工具轨、面板、像素命令通道逐条一致", async () => {
    const { feature } = await import("./index.js");
    const published = feature.tools.map((tool) => ({ id: tool.id as string, gesture: tool.gesture as string, order: tool.order }));
    for (const entry of PAINTING_TOOL_WIRING) {
      // 每个已接线工具都必须同时有：工具轨条目、参数面板入口、像素命令通道。
      expect(PAINTING_PANEL_TOOLS).toContain(entry.id);
      if (entry.command !== "document.sampleColor") expect(isPaintContentCommand(entry.command)).toBe(true);
      else expect(entry.gesture).toBe("sample");
      // 已发布：清单里的每个条目都在工具轨上，且手势/顺序与清单一致。
      expect(published).toContainEqual({ id: entry.id, gesture: entry.gesture, order: entry.order });
      expect(entry.wiring.length).toBeGreaterThan(10);
    }
    // 反向：工具轨上除画笔/橡皮外的每一项都必须来自接线表（不会出现没登记的入口）。
    const listed = new Set(PAINTING_TOOL_WIRING.map((entry) => entry.id));
    for (const tool of published) {
      if (tool.id === "brush" || tool.id === "eraser") continue;
      expect(listed).toContain(tool.id);
    }
    // 吸管走只读采样，不是像素命令。
    expect(isPaintContentCommand("document.sampleColor")).toBe(false);
  });
});

describe("命令通道：像素与偏好不混用", () => {
  const contentCommandIds = [...PAINT_CONTENT_COMMANDS];
  const preferenceIds = ["swatches.list", "gradient.presets.list", "tool.presets.list", "paint.setSymmetry", "tool.reset", "tool.resetAll"];

  function context(overrides: Record<string, unknown> = {}) {
    const paintingCommand = vi.fn(() => ({ ok: true as const, value: { done: true } }));
    const afterWrite = vi.fn(() => ({ ok: true as const, value: { hasDocument: true, document: null, sessionActiveIndex: null } }));
    const blockingDraft = vi.fn(() => null as null | { ok: false; code: string; message: string });
    const frozen = vi.fn(() => null as null | { ok: false; code: string; message: string });
    const session = {
      handle: { features: { painting: { paintingCommand } } },
      blockingDraft,
      frozen,
      documentGeneration: () => 0,
      afterWrite,
      unavailable: () => ({ ok: false as const, code: "no-document", message: "编辑器尚未就绪" }),
      fail: (failure: { code: string; message: string }) => ({ ok: false as const, ...failure }),
      ...overrides
    } as unknown as WorkspaceFeatureContext;
    return { session, paintingCommand, afterWrite, blockingDraft, frozen };
  }

  it("只有列出的绘画命令走像素通道", () => {
    for (const id of contentCommandIds) expect(isPaintContentCommand(id)).toBe(true);
    for (const id of preferenceIds) expect(isPaintContentCommand(id)).toBe(false);
    // 未开放的绘画命令不在通道里，不能被前缀放开。
    expect(isPaintContentCommand("paint.mixerBrush")).toBe(false);
    expect(isPaintContentCommand("paint.wetEdges")).toBe(false);
  });

  it("像素命令过草稿门并同步视图；偏好命令两者都不做", () => {
    const { session, paintingCommand, afterWrite, blockingDraft } = context();
    expect(paintCommand.call(session, "paint.gradient", { from: [0, 0], to: [1, 1], stops: [[0, "#000000"], [1, "#ffffff"]] })).toMatchObject({ ok: true });
    expect(paintingCommand).toHaveBeenCalledTimes(1);
    expect(afterWrite).toHaveBeenCalledTimes(1);

    expect(preferenceCommand.call(session, "swatches.list", {})).toMatchObject({ ok: true });
    expect(paintingCommand).toHaveBeenCalledTimes(2);
    expect(afterWrite).toHaveBeenCalledTimes(1);
    expect(blockingDraft).toHaveBeenCalledTimes(1);
  });

  it("通道互不接受对方的命令；草稿未结算时像素命令不执行", () => {
    const { session, paintingCommand } = context();
    expect(paintCommand.call(session, "swatches.list", {})).toMatchObject({ ok: false, code: "unsupported-command" });
    expect(preferenceCommand.call(session, "paint.gradient", {})).toMatchObject({ ok: false, code: "unsupported-command" });
    expect(paintingCommand).not.toHaveBeenCalled();

    const blocked = context({ blockingDraft: () => ({ ok: false, code: "stroke-active", message: "请先结算当前草稿" }) });
    expect(paintCommand.call(blocked.session, "paint.bucket", { x: 1, y: 1, color: "#000000" })).toMatchObject({ ok: false, code: "stroke-active" });
    expect(blocked.paintingCommand).not.toHaveBeenCalled();
    expect(blocked.afterWrite).not.toHaveBeenCalled();
  });

  it("没有文档时像素命令返回统一的 unavailable", () => {
    const { session } = context({ handle: null });
    expect(paintCommand.call(session, "paint.gradient", {})).toMatchObject({ ok: false, code: "no-document" });
    expect(preferenceCommand.call(session, "swatches.list", {})).toMatchObject({ ok: false, code: "no-document" });
  });

  it("冻结门与草稿门并列：导出期间像素命令被拒，偏好命令不受影响", () => {
    // 保存/导出期间：`dispatch()` 拒写，域里直连内核的像素命令必须同样被拒。
    const frozenContext = context({ frozen: () => ({ ok: false, code: "frozen", message: "导出期间不接受内容修改" }) });
    expect(paintCommand.call(frozenContext.session, "paint.bucket", { x: 1, y: 1 }))
      .toMatchObject({ ok: false, code: "frozen" });
    expect(frozenContext.paintingCommand).not.toHaveBeenCalled();
    expect(frozenContext.afterWrite).not.toHaveBeenCalled();

    // 偏好命令不写内容，不该被导出冻结尾挡住（否则保存期间连工具选项都改不了）。
    expect(preferenceCommand.call(frozenContext.session, "tool.select", { tool: "brush" })).toMatchObject({ ok: true });
    expect(frozenContext.paintingCommand).toHaveBeenCalledTimes(1);
  });
});
