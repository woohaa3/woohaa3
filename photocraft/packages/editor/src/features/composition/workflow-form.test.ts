import { expect, it } from "vitest";
import {
  compileImageSize,
  compileWorkflow,
  defaultValues,
  isWorkflowEnabled,
  puppetPinOf,
  workflowFields,
  WORKFLOW_FIELDS
} from "./workflow-form.js";
import { isParamError } from "./workflows.js";

const errorOf = (value: unknown) => {
  expect(isParamError(value)).toBe(true);
  return (value as { error: string }).error;
};

it("每个入口的字段表都有默认值或明确留空，且 key 不重复", () => {
  for (const [id, fields] of Object.entries(WORKFLOW_FIELDS)) {
    const keys = fields.map((field) => field.key);
    expect(new Set(keys).size, `${id} 有重复字段`).toBe(keys.length);
    for (const field of fields) {
      expect(field.label.length, `${id}.${field.key} 缺少标签`).toBeGreaterThan(0);
      if (field.kind === "select" && field.options) {
        if (field.initial !== undefined) {
          expect(field.options.map((option) => option.value), `${id}.${field.key} 的默认值不在选项里`).toContain(field.initial);
        }
      }
    }
    // 默认值只收声明的字段。
    expect(Object.keys(defaultValues(id)).every((key) => keys.includes(key))).toBe(true);
  }
});

it("没有参数的入口返回空对象，未知入口也不猜测字段", () => {
  expect(workflowFields("transformAgain")).toEqual([]);
  expect(workflowFields("doesNotExist")).toEqual([]);
  expect(compileWorkflow("transformAgain", {})).toEqual({});
  expect(compileWorkflow("doesNotExist", { x: 1 })).toEqual({});
});

it("能力门只认明确的 allowed === true", () => {
  expect(isWorkflowEnabled({ allowed: true })).toBe(true);
  expect(isWorkflowEnabled({ allowed: false })).toBe(false);
  expect(isWorkflowEnabled(undefined)).toBe(false);
});

it("变形：样式、弯曲、扭曲与垂直方向", () => {
  expect(compileWorkflow("warp", defaultValues("warp"))).toMatchObject({ style: "arc", bend: 50, vertical: false });
  expect(compileWorkflow("warp", { style: "flag", bend: -40, hDistort: 10, vDistort: -10, vertical: true }))
    .toEqual({ style: "flag", bend: -40, hDistort: 10, vDistort: -10, vertical: true });
  expect(errorOf(compileWorkflow("warp", { style: "spiral", bend: 50 }))).toContain("变形样式");
  expect(errorOf(compileWorkflow("warp", { style: "arc", bend: 500 }))).toContain("bend");
  // 清空的数字字段不进入参数，而不是变成 0。
  expect(compileWorkflow("warp", { style: "arc", bend: "", hDistort: "" })).toEqual({ style: "arc" });
});

it("网格与分割：default 字符串与成对坐标", () => {
  expect(compileWorkflow("warpGrid", { size: "default" })).toEqual({ size: "default" });
  expect(compileWorkflow("warpGrid", { size: "8" })).toEqual({ size: 8 });
  expect(errorOf(compileWorkflow("warpGrid", { size: "0" }))).toContain("网格分割");
  expect(compileWorkflow("splitWarpCrosswise", {})).toEqual({});
  expect(compileWorkflow("splitWarpCrosswise", { atX: 10, atY: 20 })).toEqual({ at: [10, 20] });
  // 有变形会话时必须整链路带上 warp：只传 size 会让上游去找活动智能对象，普通像素层上必失败。
  const warp = { style: "custom", bounds: [0, 0, 10, 10], mesh: { us: [0, 1], vs: [0, 1], points: [] } };
  expect(compileWorkflow("warpGrid", { size: "4" }, undefined, warp)).toEqual({ size: 4, warp });
  expect(compileWorkflow("warpGrid", { size: "default" }, undefined, warp)).toEqual({ size: "default", warp });
  expect(compileWorkflow("splitWarpHorizontally", { atX: 5, atY: 6 }, undefined, warp)).toEqual({ at: [5, 6], warp });
  expect(compileWorkflow("removeWarpSplit", {}, undefined, warp)).toEqual({ warp });
  expect(errorOf(compileWorkflow("removeWarpSplit", { atX: 10 }))).toContain("分割点");
});

it("填充：内容类型决定必填项，混合模式与不透明度受范围约束", () => {
  expect(compileWorkflow("fill", { contents: "color", color: "#112233" }))
    .toEqual({ contents: "color", color: "#112233" });
  expect(compileWorkflow("fill", { contents: "pattern", pattern: "dots", scale: 200, angle: 30 }))
    .toEqual({ contents: "pattern", pattern: "dots", scale: 200, angle: 30 });
  expect(compileWorkflow("fill", { contents: "foreground", mode: "multiply", opacity: 40, preserveTransparency: true }))
    .toEqual({ contents: "foreground", mode: "multiply", opacity: 40, preserveTransparency: true });
  expect(errorOf(compileWorkflow("fill", { contents: "color" }))).toContain("#rrggbb");
  expect(errorOf(compileWorkflow("fill", { contents: "pattern" }))).toContain("图案");
  expect(errorOf(compileWorkflow("fill", { contents: "foreground", mode: "glow" }))).toContain("混合模式");
  expect(errorOf(compileWorkflow("fill", { contents: "foreground", opacity: 101 }))).toContain("不透明度");
});

it("内容识别填充/缩放：范围与至少一个方向", () => {
  expect(compileWorkflow("contentAwareFill", defaultValues("contentAwareFill")))
    .toEqual({ sampling: "auto", sampleAllLayers: true });
  expect(compileWorkflow("contentAwareFill", { sampling: "custom", margin: 40, output: "new" }))
    .toEqual({ sampling: "custom", margin: 40, output: "new" });
  expect(errorOf(compileWorkflow("contentAwareFill", { margin: -1 }))).toContain("边缘扩展");
  expect(compileWorkflow("contentAwareScale", { scaleX: 120, protectSkinTones: false }))
    .toEqual({ scaleX: 120, protectSkinTones: false });
  expect(errorOf(compileWorkflow("contentAwareScale", {}))).toContain("至少需要一个方向");
  expect(errorOf(compileWorkflow("contentAwareScale", { scaleX: 401 }))).toContain("scaleX");
});

it("描边与渐隐：宽度取整、位置枚举、不透明度", () => {
  expect(compileWorkflow("stroke", { width: 3.4, location: "outside", color: "#ff0000" }))
    .toEqual({ width: 4, location: "outside", color: "#ff0000" });
  expect(errorOf(compileWorkflow("stroke", { width: 0 }))).toContain("描边宽度");
  expect(compileWorkflow("fade", { opacity: 30, mode: "screen" })).toEqual({ opacity: 30, mode: "screen" });
  expect(compileWorkflow("fade", {})).toEqual({ opacity: 50 });
  expect(errorOf(compileWorkflow("fade", { opacity: -1 }))).toContain("渐隐不透明度");
});

it("照片合并：投影/版面、HDR 位深与色调方法", () => {
  expect(compileWorkflow("autoAlign", { projection: "cylindrical", geometricCorrection: true, registration: "features" }))
    .toEqual({ projection: "cylindrical", geometricCorrection: true, registration: "features" });
  expect(errorOf(compileWorkflow("autoAlign", { reference: -1 }))).toContain("参考图层");
  expect(compileWorkflow("autoBlend", { method: "stack", haloControl: 4 })).toEqual({ method: "stack", haloControl: 4 });
  expect(errorOf(compileWorkflow("autoBlend", { haloControl: 9 }))).toContain("光晕控制");
  // Photomerge 永远只读已打开文档。
  expect(compileWorkflow("photomerge", { layout: "collage" })).toEqual({ useOpenDocuments: true, layout: "collage" });
  expect(errorOf(compileWorkflow("photomerge", { focalLength: 3000 }))).toContain("焦距");
  expect(compileWorkflow("mergeToHdr", { mode: "32", method: "exposureGamma", align: true }))
    .toEqual({ useOpenDocuments: true, mode: "32", method: "exposureGamma", align: true });
  expect(errorOf(compileWorkflow("mergeToHdr", { mode: "12" }))).toContain("位深");
});

it("画板：位置尺寸可省略，自定义背景要求颜色，全空时拒绝", () => {
  expect(compileWorkflow("newArtboard", { name: "画板 1", width: 320, height: 240, x: 0, y: 0, background: "custom", color: "#123456" }))
    .toEqual({ x: 0, y: 0, width: 320, height: 240, name: "画板 1", background: "custom", color: "#123456" });
  expect(compileWorkflow("newArtboard", { name: "画板 2" })).toEqual({ name: "画板 2" });
  expect(errorOf(compileWorkflow("newArtboard", { width: 320 }))).toContain("宽和高");
  expect(errorOf(compileWorkflow("newArtboard", {}))).toContain("至少需要一项改动");
  expect(errorOf(compileWorkflow("newArtboard", { background: "custom" }))).toContain("#rrggbb");
  expect(compileWorkflow("artboardFromLayers", { name: "从图层", background: "transparent" }))
    .toEqual({ name: "从图层", background: "transparent" });
});

it("框架与切片：尺寸必填、类型枚举、链接长度", () => {
  expect(compileWorkflow("newFrame", { shape: "ellipse", x: 0, y: 0, width: 200, height: 100, name: "框架" }))
    .toEqual({ x: 0, y: 0, width: 200, height: 100, shape: "ellipse", name: "框架" });
  expect(errorOf(compileWorkflow("newFrame", { width: 200 }))).toContain("宽和高");
  expect(errorOf(compileWorkflow("newFrame", { width: 200, height: 100 }))).toContain("X 和 Y");
  expect(errorOf(compileWorkflow("newFrame", {}))).toContain("位置与尺寸");
  expect(compileWorkflow("newSlice", { x: 0, y: 0, width: 100, height: 100, kind: "table", url: "#top" }))
    .toEqual({ x: 0, y: 0, width: 100, height: 100, kind: "table", url: "#top" });
  expect(errorOf(compileWorkflow("newSlice", { x: 0, y: 0, width: 100, height: 100, url: "x".repeat(1025) }))).toContain("1024");
  expect(compileWorkflow("slicesFromGuides", { name: "切片" })).toEqual({ name: "切片" });
  expect(compileWorkflow("layerSlice", {})).toEqual({});
});

it("图像尺寸：宽高优先，百分比次之，只改 DPI 时两者都不传", () => {
  expect(compileImageSize({ resolution: 72 })).toEqual({ resolution: 72, resample: "bicubic" });
  expect(compileImageSize({ width: 800, height: 600, resolution: 300 }))
    .toEqual({ width: 800, height: 600, resolution: 300, resample: "bicubic" });
  expect(compileImageSize({ percent: 200, resolution: 72 }))
    .toEqual({ percent: 200, resolution: 72, resample: "bicubic" });
  // 默认 100% 不进入参数（否则内核会把它当成显式尺寸）。
  expect(compileImageSize({ percent: 100, resolution: 144 })).toEqual({ resolution: 144, resample: "bicubic" });
  // 宽高与百分比互斥：两者都给会让内核按「显式边优先」静默忽略百分比。
  expect(errorOf(compileImageSize({ width: 800, percent: 200 }))).toContain("不能同时使用");
  // 只给一边时另一边按比例（与内核一致），因此允许。
  expect(compileImageSize({ width: 800, resolution: 72 })).toMatchObject({ width: 800 });
});

it("钉点行 → src/dst，旋转只在给出时携带", () => {
  expect(puppetPinOf({ srcX: 10, srcY: 20, dstX: 30, dstY: 40 })).toEqual({ at: [10, 20], to: [30, 40] });
  expect(puppetPinOf({ srcX: 10, srcY: 20, dstX: 10, dstY: 20, rotate: 15 }))
    .toEqual({ at: [10, 20], to: [10, 20], rotate: 15 });
  // 0° 是界面的默认值 = 自动，不写进参数（否则上游会把钉点锁成固定朝向）。
  expect(puppetPinOf({ srcX: 1, srcY: 2, dstX: 3, dstY: 4, rotate: 0 })).toEqual({ at: [1, 2], to: [3, 4] });
});
