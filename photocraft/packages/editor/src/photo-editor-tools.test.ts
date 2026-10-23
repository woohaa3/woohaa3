/**
 * 编辑器工具参数与坐标映射回归
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 3.4/3.5/3.6）。
 *
 * 只测纯函数：不加载 wasm、不需要浏览器/GPU。
 */
import { describe, expect, it } from "vitest";
import { IMAGE_PROJECT_LIMITS } from "@woohaa3/photocraft-protocol";
import {
  DEFAULT_BRUSH,
  buildBrightnessContrast,
  buildFeather,
  buildHueSaturation,
  buildLasso,
  buildRectSelection,
  buildStroke,
  buildTextCreate,
  clampBrushSize,
  clampFeather,
  isHexColor,
  normalizeMarquee,
  screenToDocument,
  toHexColor,
  type CanvasViewport
} from "./photo-editor-tools.js";
import { mergeBrushPatch } from "./paint-tool-state.js";

describe("范围钳制", () => {
  it("笔头尺寸钳到首期公开范围", () => {
    expect(clampBrushSize(0)).toBe(IMAGE_PROJECT_LIMITS.minBrushSizeSourcePixels);
    expect(clampBrushSize(9_999)).toBe(IMAGE_PROJECT_LIMITS.maxBrushSizeSourcePixels);
    expect(clampBrushSize(64)).toBe(64);
    expect(clampBrushSize(Number.NaN)).toBe(IMAGE_PROJECT_LIMITS.minBrushSizeSourcePixels);
  });

  it("羽化半径钳到 0–100 源像素", () => {
    expect(clampFeather(-5)).toBe(0);
    expect(clampFeather(999)).toBe(IMAGE_PROJECT_LIMITS.maxFeatherSourcePixels);
  });
});

describe("拖拽框归一化", () => {
  it("任意方向都得到左上原点与正尺寸", () => {
    expect(normalizeMarquee({ x: 10, y: 20 }, { x: 30, y: 50 })).toEqual({ x: 10, y: 20, width: 20, height: 30 });
    expect(normalizeMarquee({ x: 30, y: 50 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 20, height: 30 });
  });

  it("单点拖拽得到零尺寸而不是负数", () => {
    expect(normalizeMarquee({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5, width: 0, height: 0 });
  });
});

describe("屏幕坐标 → 文档坐标", () => {
  // 客户矩形 400×300、文档 800×600、比例 2（与 CSS 缩放/平移无关）。
  const viewport: CanvasViewport = {
    left: 100,
    top: 200,
    width: 400,
    height: 300,
    documentWidth: 800,
    documentHeight: 600
  };

  it("按客户矩形比例换算到文档像素", () => {
    expect(screenToDocument(100, 200, viewport)).toEqual({ x: 0, y: 0 });
    expect(screenToDocument(300, 350, viewport)).toEqual({ x: 400, y: 300 });
    expect(screenToDocument(500, 500, viewport)).toEqual({ x: 800, y: 600 });
  });

  it("越界钳制在画布内", () => {
    expect(screenToDocument(10_000, 10_000, viewport)).toEqual({ x: 800, y: 600 });
    expect(screenToDocument(-10_000, -10_000, viewport)).toEqual({ x: 0, y: 0 });
  });

  it("非法视图返回 null（不静默给 0）", () => {
    expect(screenToDocument(0, 0, { ...viewport, width: 0 })).toBeNull();
    expect(screenToDocument(0, 0, { ...viewport, height: 0 })).toBeNull();
    expect(screenToDocument(0, 0, { ...viewport, documentHeight: 0 })).toBeNull();
  });
});

describe("选区与绘画参数", () => {
  it("select.rect 带出首期默认值并钳制羽化", () => {
    const params = buildRectSelection({ x: 4, y: 6, width: 20, height: 10 }, { mode: "add", ellipse: true, feather: 999 });
    expect(params).toMatchObject({
      x: 4,
      y: 6,
      width: 20,
      height: 10,
      mode: "add",
      ellipse: true,
      antiAlias: true
    });
    expect(params.feather).toBe(IMAGE_PROJECT_LIMITS.maxFeatherSourcePixels);
  });

  it("select.modify.feather 只传半径", () => {
    expect(buildFeather(3)).toEqual({ radius: 3 });
  });

  it("套索少于 3 点不提交", () => {
    expect(buildLasso([{ x: 1, y: 1 }, { x: 2, y: 2 }])).toBeNull();
    expect(buildLasso([{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 5, y: 7 }])).toEqual({
      points: [[1, 1], [9, 1], [5, 7]],
      mode: "replace",
      feather: 0
    });
  });

  it("空笔迹不提交；橡皮带上 erase", () => {
    expect(buildStroke([], DEFAULT_BRUSH)).toBeNull();
    const params = buildStroke([{ x: 3, y: 4 }], { ...DEFAULT_BRUSH, size: 9_999, target: "mask" }, { erase: true, zoom: 2 });
    expect(params).toMatchObject({ points: [[3, 4]], erase: true, zoom: 2, target: "mask", mode: "normal" });
    expect(params?.size).toBe(IMAGE_PROJECT_LIMITS.maxBrushSizeSourcePixels);
  });

  it("text.create 与调整层参数", () => {
    expect(buildTextCreate({ x: 10.4, y: 20.6, text: "标题", size: 48, color: "#ff0000", align: "center" })).toEqual({
      x: 10,
      y: 21,
      text: "标题",
      size: 48,
      color: "#ff0000",
      align: "center",
      font: "Noto Sans SC",
      fauxBold: false
    });
    expect(buildBrightnessContrast(999, -999)).toEqual({ brightness: 150, contrast: -50 });
    expect(buildHueSaturation(999, -999, 999)).toEqual({ hue: 180, saturation: -100, lightness: 100 });
  });

  it("颜色工具", () => {
    expect(toHexColor([1, 0.5, 0])).toBe("#ff8000");
    expect(isHexColor("#ff8000")).toBe(true);
    expect(isHexColor("#GGGGGG")).toBe(false);
  });
});


it("选区命中支持孔洞、多块选区和边界，图片外不命中", async () => {
  const { pointInSelection } = await import("./photo-editor-tools.js");
  const rect = (x: number, y: number, w: number, h: number): [number, number, number, number][] => [[x,y,x+w,y],[x+w,y,x+w,y+h],[x+w,y+h,x,y+h],[x,y+h,x,y]];
  const segments = [...rect(10, 10, 100, 100), ...rect(30, 30, 20, 20), ...rect(200, 200, 10, 10)];
  expect(pointInSelection({ x: 20, y: 20 }, segments)).toBe(true);
  expect(pointInSelection({ x: 40, y: 40 }, segments)).toBe(false);
  expect(pointInSelection({ x: 205, y: 205 }, segments)).toBe(true);
  expect(pointInSelection({ x: 10, y: 40 }, segments)).toBe(true);
  expect(pointInSelection({ x: -5, y: 20 }, segments)).toBe(false);
});


it("笔输入保留压感，鼠标不伪造压力，文字粗体使用内核支持的参数", () => {
  expect(buildStroke([{ x: 1, y: 2, pressure: .3 }, { x: 3, y: 4 }], DEFAULT_BRUSH)?.points).toEqual([[1, 2, .3], [3, 4]]);
  expect(buildTextCreate({ x: 1, y: 1, text: "字", color: "#000000", size: 24, align: "left", bold: true })).toMatchObject({ fauxBold: true });
});

it("绘画坐标保留图外点；非法数值不进入内核", () => {
  const viewport = { left: 100, top: 200, width: 400, height: 300, documentWidth: 800, documentHeight: 600 };
  expect(screenToDocument(90, 180, viewport, false)).toEqual({ x: -20, y: -40 });
  expect(screenToDocument(550, 550, viewport, false)).toEqual({ x: 900, y: 700 });
  expect(screenToDocument(NaN, 0, viewport, false)).toBeNull();
  expect(screenToDocument(0, 0, { ...viewport, width: Infinity })).toBeNull();
});

describe("笔刷动态补丁（P1a/P1b）", () => {
  it("dynamics 作为 paint.stroke 的 brush 参数透传；空 dynamics 不发送", () => {
    const plain = buildStroke([{ x: 1, y: 1 }], { ...DEFAULT_BRUSH })!;
    expect("brush" in plain).toBe(false);
    const withDynamics = buildStroke([{ x: 1, y: 1 }], {
      ...DEFAULT_BRUSH,
      dynamics: { spacing: 0.3, roundness: 0.7, scattering: { enabled: true, count: 3 } }
    })!;
    expect(withDynamics.brush).toEqual({ spacing: 0.3, roundness: 0.7, scattering: { enabled: true, count: 3 } });
  });

  it("标量与动态分别合并，互不覆盖", () => {
    const current = { ...DEFAULT_BRUSH, dynamics: { angle: 30 } };
    const next = mergeBrushPatch(current, { size: 88, angle: 45 });
    expect(next.size).toBe(88);
    expect(next.dynamics).toEqual({ angle: 45 });
  });
});
