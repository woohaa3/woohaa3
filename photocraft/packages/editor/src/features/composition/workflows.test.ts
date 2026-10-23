import { expect, it } from "vitest";
import {
  CANVAS_ANCHORS,
  COMPOSITION_WORKFLOW_GROUPS,
  CROP_RATIOS,
  artboardParams,
  autoAlignParams,
  autoBlendParams,
  canvasSizeParams,
  cropParams,
  fadeParams,
  fillParams,
  fitCropFrame,
  frameParams,
  guideSliceCount,
  imageSizeParams,
  isParamError,
  isValidPerspectiveQuad,
  isValidTransformRect,
  isValidWarpMesh,
  parseWorkflowManifest,
  perspectiveCropParams,
  perspectiveWarpParams,
  photomergeParams,
  pixelsToPrintSize,
  printSizeToPixels,
  puppetWarpParams,
  quadArea2,
  resolveCropRatio,
  rotateArbitraryParams,
  rotatedCanvasSize,
  sliceParams,
  strokeParams,
  trimParams,
  warpGridParams,
  warpMeshParams,
  warpSplitParams,
  warpStyleParams,
  workflowsByGroup,
  type PerspectiveCorners,
  type WarpMesh
} from "./workflows.js";

const document = { width: 40, height: 30 };

// ---------------------------------------------------------------- 清单解析

const entry = (id: string, overrides: Record<string, unknown> = {}) =>
  ({ id, group: "crop", label: id, command: "image.crop", allowed: true, reason: null, ...overrides });

it("解析内核清单：保留顺序与可选原因，拒绝半截入口", () => {
  expect(parseWorkflowManifest([
    entry("crop"),
    entry("slicesToFiles", { group: "structure", command: null, allowed: false, reason: "尚未接通" })
  ])).toEqual([
    { id: "crop", group: "crop", label: "crop", command: "image.crop", allowed: true, reason: null },
    { id: "slicesToFiles", group: "structure", label: "slicesToFiles", command: null, allowed: false, reason: "尚未接通" }
  ]);
  // 非数组、重复 id、未知分组、缺少禁用原因、类型不对都视为结构非法。
  expect(parseWorkflowManifest(null)).toBeNull();
  expect(parseWorkflowManifest({})).toBeNull();
  expect(parseWorkflowManifest([entry("crop"), entry("crop")])).toBeNull();
  expect(parseWorkflowManifest([entry("crop", { group: "unknown" })])).toBeNull();
  expect(parseWorkflowManifest([entry("crop", { allowed: false })])).toBeNull();
  expect(parseWorkflowManifest([entry("crop", { allowed: "yes" })])).toBeNull();
  expect(parseWorkflowManifest([entry("")])).toBeNull();
  expect(parseWorkflowManifest([entry("crop", { command: "" })])).toBeNull();
  expect(parseWorkflowManifest([entry("crop", { label: "x".repeat(201) })])).toBeNull();
});

it("按分组索引只返回同组入口", () => {
  const workflows = parseWorkflowManifest([entry("crop"), entry("fill", { group: "fill" })])!;
  expect(workflowsByGroup(workflows, "fill").map((workflow) => workflow.id)).toEqual(["fill"]);
  expect(workflowsByGroup(workflows, "photo")).toEqual([]);
  expect(COMPOSITION_WORKFLOW_GROUPS.map((group) => group.id)).toEqual(["crop", "size", "trim", "transform", "fill", "photo", "structure"]);
});

/** 编译结果要么是错误分支，要么是参数对象；测试里统一取参数。 */
function params(value: Record<string, unknown> | { error: string }): Record<string, unknown> {
  if (isParamError(value)) throw new Error(`期望合法参数，实际失败：${value.error}`);
  return value;
}
const errorOf = (value: Record<string, unknown> | { error: string }): string => {
  if (!isParamError(value)) throw new Error("期望参数被拒绝");
  return value.error;
};

// ---------------------------------------------------------------- U50 裁剪

it("裁剪：比例解析与框内合比例，保持中心且不越界", () => {
  expect(resolveCropRatio(null, document)).toBeNull();
  expect(resolveCropRatio("original", document)).toBeCloseTo(4 / 3);
  expect(resolveCropRatio(1, document)).toBe(1);
  expect(resolveCropRatio(0, document)).toBeNull();
  expect(resolveCropRatio(Number.NaN, document)).toBeNull();

  const square = fitCropFrame({ x: 0, y: 0, width: 40, height: 30 }, 1, document);
  expect(square).toEqual({ x: 5, y: 0, width: 30, height: 30 });
  const wide = fitCropFrame({ x: 0, y: 0, width: 40, height: 30 }, 16 / 9, document);
  expect(wide.width).toBe(40); expect(wide.height).toBe(23);
  expect(wide.y).toBeGreaterThanOrEqual(0);
  // 自由比例原样返回（只做取整与最小 1 像素）。
  expect(fitCropFrame({ x: -4, y: 2, width: 0, height: 30 }, null, document))
    .toEqual({ x: -4, y: 2, width: 1, height: 30 });
  expect(CROP_RATIOS.find((entry) => entry.id === "16:9")?.ratio).toBeCloseTo(16 / 9);
});

it("裁剪参数：只带合法字段，角度归一到 ±180 且 0 不传", () => {
  expect(params(cropParams({ frame: { x: 1.4, y: 2.6, width: 20, height: 10 } })))
    .toEqual({ x: 1, y: 3, width: 20, height: 10 });
  expect(params(cropParams({ frame: { x: 0, y: 0, width: 20, height: 10 }, angle: 3.5 })).angle).toBe(3.5);
  expect(params(cropParams({ frame: { x: 0, y: 0, width: 20, height: 10 }, angle: 0 })).angle).toBeUndefined();
  expect(params(cropParams({ frame: { x: 0, y: 0, width: 20, height: 10 }, angle: 270 })).angle).toBe(-90);
  expect(params(cropParams({ frame: { x: 0, y: 0, width: 20, height: 10 }, angle: 720 })).angle).toBeUndefined();
  expect(errorOf(cropParams({ frame: { x: 0, y: 0, width: 20, height: 10 }, angle: Number.NaN }))).toContain("拉直角度");
  expect(errorOf(cropParams({ frame: { x: 0, y: 0, width: 0, height: 10 } }))).toContain("至少为 1 像素");
  expect(errorOf(cropParams({ frame: { x: Number.POSITIVE_INFINITY, y: 0, width: 20, height: 10 } }))).toContain("有限数值");
});

it("裁剪参数：目标尺寸必须成对、需要重采样，分辨率有范围", () => {
  const resized = params(cropParams({
    frame: { x: 0, y: 0, width: 20, height: 10 },
    targetWidth: 400.4, targetHeight: 300.6, resolution: 300, resample: "bicubicSharper"
  }));
  expect(resized).toMatchObject({ targetWidth: 400, targetHeight: 301, resolution: 300, resample: "bicubicSharper" });
  expect(errorOf(cropParams({ frame: { x: 0, y: 0, width: 20, height: 10 }, targetWidth: 40 }))).toContain("必须同时给出");
  expect(errorOf(cropParams({ frame: { x: 0, y: 0, width: 20, height: 10 }, targetWidth: 40, targetHeight: 30, resample: "none" })))
    .toContain("必须重采样");
  expect(errorOf(cropParams({ frame: { x: 0, y: 0, width: 20, height: 10 }, resolution: 0 }))).toContain("分辨率");
  expect(errorOf(cropParams({ frame: { x: 0, y: 0, width: 20, height: 10 }, targetWidth: 40, targetHeight: 30, resample: "magic" as never })))
    .toContain("重采样");
  // 保留画布外像素与内容识别填充随参数透传（裁剪框允许越界扩展画布）。
  const extended = params(cropParams({
    frame: { x: -10, y: -10, width: 60, height: 50 }, deleteCroppedPixels: false, contentAware: true
  }));
  expect(extended).toMatchObject({ x: -10, y: -10, width: 60, height: 50, deleteCroppedPixels: false, contentAware: true });
});

it("透视裁剪：凸四边形判据与四角参数", () => {
  const quad: PerspectiveCorners = [[0, 0], [40, 0], [40, 30], [0, 30]];
  expect(quadArea2(quad)).toBe(2400);
  expect(isValidPerspectiveQuad(quad)).toBe(true);
  expect(isValidPerspectiveQuad([[0, 0], [40, 30], [40, 0], [0, 30]])).toBe(false); // 自交
  expect(isValidPerspectiveQuad([[0, 0], [0, 30], [40, 30], [40, 0]])).toBe(false); // 逆时针
  expect(isValidPerspectiveQuad([[0, 0], [1, 0], [1, 0], [0, 1]])).toBe(false); // 重角
  expect(isValidPerspectiveQuad([[0, 0], [Number.NaN, 0], [40, 30], [0, 30]])).toBe(false);

  const tapered: PerspectiveCorners = [[5, 2], [35, 0], [40, 28], [0, 30]];
  expect(params(perspectiveCropParams(tapered, { width: 300, height: 200, resolution: 300, interpolation: "bilinear" })))
    .toMatchObject({ width: 300, height: 200, resolution: 300, interpolation: "bilinear", corners: tapered });
  expect(errorOf(perspectiveCropParams([[0, 0], [40, 30], [40, 0], [0, 30]]))).toContain("顺时针凸四边形");
  expect(errorOf(perspectiveCropParams(tapered, { width: 0 }))).toContain("至少为 1 像素");
});

// ---------------------------------------------------------------- U51 图像/画布尺寸

it("打印单位与像素互换：英寸/厘米/毫米三条路径一致", () => {
  expect(printSizeToPixels(1, "in", 300)).toBe(300);
  expect(printSizeToPixels(2.54, "cm", 100)).toBeCloseTo(100);
  expect(printSizeToPixels(25.4, "mm", 100)).toBeCloseTo(100);
  expect(printSizeToPixels(1, "px", 300)).toBeNull();
  expect(printSizeToPixels(0, "in", 300)).toBeNull();
  expect(pixelsToPrintSize(600, "in", 300)).toBe(2);
  expect(pixelsToPrintSize(600, "cm", 300)).toBeCloseTo(5.08);
  expect(pixelsToPrintSize(600, "mm", 300)).toBeCloseTo(50.8);
  expect(pixelsToPrintSize(600, "in", 0)).toBeNull();
  // 往返一致。
  expect(pixelsToPrintSize(printSizeToPixels(3, "cm", 144)!, "cm", 144)).toBeCloseTo(3);
});

it("图像尺寸：百分比、DPI 与保持打印尺寸", () => {
  expect(params(imageSizeParams({ percent: 200 }))).toEqual({ percent: 200 });
  expect(params(imageSizeParams({ width: 80.6, height: 60.2, resolution: 144, resample: "bicubic" })))
    .toEqual({ width: 81, height: 60, resolution: 144, resample: "bicubic" });
  // 只改分辨率并保持打印尺寸：像素按新 DPI 放大一倍。
  expect(params(imageSizeParams({ resolution: 144, keepPrintSize: true })))
    .toEqual({ resolution: 144, keepPrintSize: true });
  expect(errorOf(imageSizeParams({ keepPrintSize: true }))).toContain("需要先给出分辨率");
  expect(errorOf(imageSizeParams({ width: 0 }))).toContain("至少为 1 像素");
  expect(errorOf(imageSizeParams({ percent: 0 }))).toContain("百分比");
  expect(errorOf(imageSizeParams({ resolution: 10_001 }))).toContain("分辨率");
  expect(errorOf(imageSizeParams({ resample: "magic" as never }))).toContain("重采样");
});

it("画布尺寸：绝对/相对、锚点与扩展颜色", () => {
  const shrink = params(canvasSizeParams({ width: -10, height: -5, relative: true, anchor: "bottomRight" }));
  expect(shrink).toEqual({ width: -10, height: -5, relative: true, anchor: "bottomRight", extensionColor: "background" });
  expect(params(canvasSizeParams({ width: 60, height: 50 })))
    .toEqual({ width: 60, height: 50, relative: false, anchor: "center", extensionColor: "background" });
  expect(params(canvasSizeParams({ width: 60, height: 50, extensionColor: "#FFEEDD" })).extensionColor).toBe("#FFEEDD");
  expect(CANVAS_ANCHORS).toHaveLength(9);
  expect(errorOf(canvasSizeParams({ width: 0, height: 50 }))).toContain("至少为 1 × 1 像素");
  expect(errorOf(canvasSizeParams({ width: 60, height: 50, anchor: "middle" as never }))).toContain("锚点");
  expect(errorOf(canvasSizeParams({ width: 60, height: 50, extensionColor: "red" as never }))).toContain("扩展颜色");
  expect(errorOf(canvasSizeParams({ width: 60, height: 50, extensionColor: "#fff" as never }))).toContain("扩展颜色");
});

// ---------------------------------------------------------------- U52 裁边与旋转

it("裁边：依据与四边开关默认全选", () => {
  expect(params(trimParams())).toEqual({ basedOn: "transparent", top: true, bottom: true, left: true, right: true });
  expect(params(trimParams({ basedOn: "topLeft", top: false, right: false })))
    .toEqual({ basedOn: "topLeft", top: false, bottom: true, left: true, right: false });
  expect(errorOf(trimParams({ basedOn: "center" as never }))).toContain("裁边依据");
});

it("任意角度旋转：角度与方向，画布尺寸与内核同式", () => {
  expect(params(rotateArbitraryParams(30))).toEqual({ angle: 30, direction: "cw" });
  expect(params(rotateArbitraryParams(-12.5, { direction: "ccw", interpolation: "nearest" })))
    .toEqual({ angle: -12.5, direction: "ccw", interpolation: "nearest" });
  expect(errorOf(rotateArbitraryParams(360))).toContain("±360°");
  expect(rotatedCanvasSize({ width: 40, height: 30 }, 0)).toEqual({ width: 40, height: 30 });
  expect(rotatedCanvasSize({ width: 40, height: 30 }, 90)).toEqual({ width: 30, height: 40 });
  expect(rotatedCanvasSize({ width: 40, height: 30 }, 180)).toEqual({ width: 40, height: 30 });
  const diagonal = rotatedCanvasSize({ width: 40, height: 30 }, 45);
  expect(diagonal.width).toBe(50); expect(diagonal.height).toBe(50);
  // 45° 的浮点抖动不能多算一像素。
  expect(rotatedCanvasSize({ width: 10, height: 10 }, 90)).toEqual({ width: 10, height: 10 });
});

// ---------------------------------------------------------------- U53 变换与变形

it("变形样式：弯曲/扭曲范围与布尔字段", () => {
  expect(params(warpStyleParams({ style: "arc", bend: 30, vertical: true })))
    .toEqual({ style: "arc", bend: 30, vertical: true });
  expect(errorOf(warpStyleParams({ style: "spiral" as never }))).toContain("变形样式");
  expect(errorOf(warpStyleParams({ style: "arc", bend: 101 }))).toContain("bend");
  expect(warpGridParams("default")).toEqual({ size: "default" });
  expect(warpGridParams(8)).toEqual({ size: 8 });
  expect(errorOf(warpGridParams(0))).toContain("网格分割");
  expect(errorOf(warpGridParams(1.5))).toContain("网格分割");
});

it("自定义变形网格：块边界 0–1 与控制点 (3c+1)×(3r+1)", () => {
  // `us`/`vs` 是块边界（1 块 = 2 个边界），控制点是 4×4 = 16 个。
  const points = Array.from({ length: 16 }, (_, index) => [(index % 4) / 3, Math.floor(index / 4) / 3] as [number, number]);
  const mesh: WarpMesh = { us: [0, 1], vs: [0, 1], points };
  expect(isValidWarpMesh(mesh)).toBe(true);
  expect(params(warpMeshParams(mesh, { rect: [0, 0, 100, 100], interpolation: "bicubic" })))
    .toMatchObject({ mesh, rect: [0, 0, 100, 100], interpolation: "bicubic" });
  expect(isValidWarpMesh({ ...mesh, us: [1, 0.5, 0.2, 0] })).toBe(false); // 非递增、不以 0 起
  expect(isValidWarpMesh({ ...mesh, vs: [0, 1.2] })).toBe(false); // 超出 0–1
  expect(isValidWarpMesh({ ...mesh, points: mesh.points.slice(0, 3) })).toBe(false); // 点数不配套
  expect(isValidWarpMesh({ ...mesh, points: [...mesh.points.slice(0, 15), [Number.NaN, 0]] })).toBe(false);
  expect(errorOf(warpMeshParams({ ...mesh, us: [1, 1, 1, 1] }))).toContain("变形网格");
  // 2×2 块：每轴 3 个边界，控制点 7×7 = 49。
  const blocks = Array.from({ length: 49 }, () => [0, 0] as [number, number]);
  expect(isValidWarpMesh({ us: [0, 0.5, 1], vs: [0, 0.5, 1], points: blocks })).toBe(true);
  // 块数上限 64。
  const tooMany = Array.from({ length: 65 }, (_, index) => index / 65);
  expect(isValidWarpMesh({ us: [...tooMany, 1], vs: [0, 1], points: [] })).toBe(false);
});

it("操控变形：钉点编译成内核的 src/dst，并按需带上旋转/深度/网格选项", () => {
  // 界面用 at/to，内核用 src/dst；不写 to 时钉住不动（src == dst）。
  expect(params(puppetWarpParams([{ at: [10, 10] }, { at: [20, 20], to: [24, 26] }], { mode: "rigid" }))).toEqual({
    pins: [{ src: [10, 10], dst: [10, 10] }, { src: [20, 20], dst: [24, 26] }],
    mode: "rigid"
  });
  expect(params(puppetWarpParams([{ at: [1, 2], rotate: 15, depth: -1 }], { density: "more", expansion: -40 }))).toEqual({
    pins: [{ src: [1, 2], dst: [1, 2], rotate: 15, depth: -1 }],
    density: "more",
    expansion: -40
  });
  expect(errorOf(puppetWarpParams([]))).toContain("至少需要一个钉点");
  expect(errorOf(puppetWarpParams([{ at: [Number.POSITIVE_INFINITY, 0] }]))).toContain("有限数值");
  expect(errorOf(puppetWarpParams([{ at: [0, 0], to: [Number.NaN, 0] }]))).toContain("有限数值");
  expect(errorOf(puppetWarpParams(Array.from({ length: 513 }, () => ({ at: [0, 0] as [number, number] }))))).toContain("512");
  expect(errorOf(puppetWarpParams([{ at: [0, 0], rotate: 400 }]))).toContain("旋转");
  expect(errorOf(puppetWarpParams([{ at: [0, 0], depth: 1.5 }]))).toContain("深度");
  expect(errorOf(puppetWarpParams([{ at: [0, 0] }], { mode: "melt" as never }))).toContain("模式");
  expect(errorOf(puppetWarpParams([{ at: [0, 0] }], { density: "some" as never }))).toContain("密度");
  expect(errorOf(puppetWarpParams([{ at: [0, 0] }], { expansion: 300 }))).toContain("扩张");
});

it("透视变形：四角凸性校验 + 源框编译成文档角点", () => {
  const quad: PerspectiveCorners = [[0, 0], [10, 0], [10, 10], [0, 10]];
  expect(params(perspectiveWarpParams(quad))).toEqual({ quad });
  // 源框是角点 `[x0,y0,x1,y1]`（与上游 `rect` 同义），不是宽高。
  expect(params(perspectiveWarpParams(quad, { rect: [5, 5, 25, 25], straighten: "auto", layer: 3 })))
    .toEqual({ quad, rect: [5, 5, 25, 25], straighten: "auto", layer: 3 });
  expect(errorOf(perspectiveWarpParams([[0, 0], [10, 10], [10, 0], [0, 10]] as PerspectiveCorners))).toContain("凸四边形");
  expect(errorOf(perspectiveWarpParams(quad, { straighten: "sideways" as never }))).toContain("透视拉直");
  expect(errorOf(perspectiveWarpParams(quad, { rect: [10, 10, 10, 20] }))).toContain("源框");
  expect(errorOf(perspectiveWarpParams(quad, { layer: -1 }))).toContain("图层 id");
});

it("变形框是角点 [x0,y0,x1,y1]，与裁剪的 [x,y,w,h] 分开校验", () => {
  expect(isValidTransformRect([10, 20, 110, 100])).toBe(true);
  expect(isValidTransformRect([110, 20, 10, 100])).toBe(false); // x1<x0
  expect(isValidTransformRect([10, 20, 110, 20])).toBe(false); // 零高
  expect(isValidTransformRect([10, 20, Number.NaN, 100])).toBe(false);
  // 网格的 rect 直接透传角点，不做「宽高 → 角点」换算。
  const mesh = { us: [0, 1], vs: [0, 1], points: Array.from({ length: 16 }, () => [0, 0] as [number, number]) };
  expect(params(warpMeshParams(mesh, { rect: [10, 20, 110, 100] }))).toMatchObject({ rect: [10, 20, 110, 100] });
  expect(errorOf(warpMeshParams(mesh, { rect: [110, 20, 10, 100] }))).toContain("变形框");
});

it("网格分割：分割点可选，非法坐标就地拒绝", () => {
  expect(warpSplitParams()).toEqual({});
  expect(warpSplitParams([12, 34])).toEqual({ at: [12, 34] });
  expect(errorOf(warpSplitParams([1] as never))).toContain("分割点");
  expect(errorOf(warpSplitParams([Number.NaN, 0]))).toContain("分割点");
});

// ---------------------------------------------------------------- U54 填充/描边/渐隐

it("填充：内容类型、颜色、混合模式与不透明度", () => {
  expect(params(fillParams({ contents: "color", color: "#3366cc" }))).toEqual({ contents: "color", color: "#3366cc" });
  expect(params(fillParams({ contents: "foreground", mode: "multiply", opacity: 60 })))
    .toEqual({ contents: "foreground", mode: "multiply", opacity: 60 });
  expect(params(fillParams({ contents: "contentAware", colorAdaptation: true })))
    .toEqual({ contents: "contentAware", colorAdaptation: true });
  expect(params(fillParams({ contents: "pattern", pattern: "dots", scale: 150, angle: 45 })))
    .toEqual({ contents: "pattern", pattern: "dots", scale: 150, angle: 45 });
  expect(errorOf(fillParams({ contents: "color" }))).toContain("#rrggbb");
  expect(errorOf(fillParams({ contents: "pattern" }))).toContain("图案");
  expect(errorOf(fillParams({ contents: "color", color: "#fff" }))).toContain("#rrggbb");
  expect(errorOf(fillParams({ contents: "color", color: "#112233", mode: "glow" }))).toContain("混合模式");
  expect(errorOf(fillParams({ contents: "foreground", opacity: 101 }))).toContain("不透明度");
  expect(errorOf(fillParams({ contents: "foreground", scale: 0 }))).toContain("图案缩放");
});

it("描边：宽度取整、位置与颜色", () => {
  expect(params(strokeParams({ width: 2.2, location: "outside", color: "#00ff00" })))
    .toEqual({ width: 3, location: "outside", color: "#00ff00" });
  expect(params(strokeParams())).toEqual({ width: 1, location: "center" });
  expect(errorOf(strokeParams({ width: 0 }))).toContain("1–250");
  expect(errorOf(strokeParams({ width: 251 }))).toContain("1–250");
  expect(errorOf(strokeParams({ location: "middle" as never }))).toContain("描边位置");
  expect(errorOf(strokeParams({ color: "green" }))).toContain("#rrggbb");
});

it("渐隐：不透明度范围与可选混合模式", () => {
  expect(params(fadeParams(50))).toEqual({ opacity: 50 });
  expect(params(fadeParams(0, "screen"))).toEqual({ opacity: 0, mode: "screen" });
  expect(errorOf(fadeParams(-1))).toContain("0–100");
  expect(errorOf(fadeParams(100, "glow" as never))).toContain("混合模式");
});

// ---------------------------------------------------------------- U55 照片合并

it("自动对齐/混合：投影、参考层与光晕范围", () => {
  expect(params(autoAlignParams({ projection: "cylindrical", reference: 2, geometricCorrection: true })))
    .toEqual({ projection: "cylindrical", reference: 2, geometricCorrection: true });
  expect(params(autoAlignParams())).toEqual({ projection: "auto" });
  expect(errorOf(autoAlignParams({ projection: "fisheye" as never }))).toContain("投影");
  expect(errorOf(autoAlignParams({ reference: -1 }))).toContain("参考图层");
  expect(params(autoBlendParams({ method: "stack", seamlessTones: true, haloControl: 3, depthMap: true })))
    .toEqual({ method: "stack", seamlessTones: true, haloControl: 3, depthMap: true });
  expect(errorOf(autoBlendParams({ method: "average" as never }))).toContain("自动混合");
  expect(errorOf(autoBlendParams({ haloControl: 9 }))).toContain("光晕控制");
});

it("Photomerge：只用已打开文档，版面与焦距有范围", () => {
  const merge = params(photomergeParams({ layout: "perspective", blend: true }));
  expect(merge).toMatchObject({ useOpenDocuments: true, layout: "perspective", blend: true });
  // 浏览器不能读取任意文件夹，因此永远不传文件夹参数。
  expect(merge).not.toHaveProperty("folder");
  expect(merge).not.toHaveProperty("sourceFiles");
  expect(errorOf(photomergeParams({ layout: "auto", focalLength: 3000 }))).toContain("焦距");
  expect(errorOf(photomergeParams({ layout: "spiral" as never }))).toContain("版面");
});

// ---------------------------------------------------------------- U56 画板/框架/切片

it("画板：尺寸、命名与背景色", () => {
  expect(params(artboardParams({ frame: { x: 0, y: 0, width: 320.4, height: 240.6 }, name: "画板 1" })))
    .toEqual({ x: 0, y: 0, width: 320, height: 241, name: "画板 1", background: "white" });
  expect(params(artboardParams({ preset: "A4", background: "custom", color: "#101010", moveContents: false })))
    .toEqual({ preset: "A4", background: "custom", color: "#101010", moveContents: false });
  expect(errorOf(artboardParams({ frame: { x: 0, y: 0, width: 0, height: 10 } }))).toContain("至少为 1 × 1 像素");
  expect(errorOf(artboardParams({ name: "   " }))).toContain("画板名称");
  expect(errorOf(artboardParams({ name: "x".repeat(201) }))).toContain("画板名称");
  expect(errorOf(artboardParams({ background: "custom" }))).toContain("#rrggbb");
  expect(errorOf(artboardParams({ background: "red" as never }))).toContain("画板背景");
});

it("框架：形状与命名", () => {
  expect(params(frameParams({ x: 1, y: 2, width: 320, height: 240 })))
    .toEqual({ x: 1, y: 2, width: 320, height: 240, shape: "rectangle" });
  expect(params(frameParams({ x: 0, y: 0, width: 10, height: 10, shape: "ellipse", name: "圆形" })))
    .toEqual({ x: 0, y: 0, width: 10, height: 10, shape: "ellipse", name: "圆形" });
  expect(errorOf(frameParams({ x: 0, y: 0, width: 10, height: 0 }))).toContain("框架尺寸");
  expect(errorOf(frameParams({ x: 0, y: 0, width: 10, height: 10, shape: "star" as never }))).toContain("框架形状");
  expect(errorOf(frameParams({ x: 0, y: 0, width: 10, height: 10, name: "" }))).toContain("框架名称");
});

it("切片：类型、链接、替代文本与背景", () => {
  expect(params(sliceParams({ frame: { x: 0, y: 0, width: 100, height: 50 }, name: "切片 1", kind: "image", url: "https://example.com", alt: "封面" })))
    .toMatchObject({ x: 0, y: 0, width: 100, height: 50, name: "切片 1", kind: "image", url: "https://example.com", alt: "封面" });
  expect(params(sliceParams({ frame: { x: 0, y: 0, width: 10, height: 10 }, kind: "noImage", background: "#ffffff" })).background).toBe("#ffffff");
  expect(errorOf(sliceParams({ frame: { x: 0, y: 0, width: 0, height: 10 } }))).toContain("切片尺寸");
  expect(errorOf(sliceParams({ frame: { x: 0, y: 0, width: 10, height: 10 }, kind: "video" as never }))).toContain("切片类型");
  expect(errorOf(sliceParams({ frame: { x: 0, y: 0, width: 10, height: 10 }, url: `https://x/${"a".repeat(1020)}` }))).toContain("链接");
  expect(errorOf(sliceParams({ frame: { x: 0, y: 0, width: 10, height: 10 }, alt: "a".repeat(1025) }))).toContain("替代文本");
  expect(errorOf(sliceParams({ frame: { x: 0, y: 0, width: 10, height: 10 }, background: "#fff" as never }))).toContain("切片背景");
  // 参考线网格预算：(竖线 + 1) × (横线 + 1)。
  expect(guideSliceCount([100, 200], [50])).toBe(6);
  expect(guideSliceCount([], [])).toBe(1);
});
