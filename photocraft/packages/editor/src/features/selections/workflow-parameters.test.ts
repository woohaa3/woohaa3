/**
 * U17–U24 选中/蒙版工作流的界面侧回归。
 *
 * 这里只锁定**参数编译与解码**：命令是否真的产生像素、边界与历史在 Rust 内核测试
 * （`features/selections/tests_workflows.rs`）里验证。两边都通过才算接上，任一侧缺失不能勾选。
 */
import { describe, expect, it } from "vitest";
import {
  LassoAnchors,
  NAMED_SELECTION_MAX_LENGTH,
  REFINE_OUTPUTS,
  SamplePoints,
  clampMaskDensity,
  clampMaskFeather,
  colorGrowParams,
  colorRangeParams,
  decodeDraftState,
  decodeMaskProperties,
  draftBelongsTo,
  isQuickMaskCommand,
  isStaleResult,
  layerMaskEditParams,
  magneticLassoParams,
  maskViewParams,
  normalizeSelectionName,
  QUICK_MASK_COMMAND,
  quickMaskStrokeParams,
  refineEdgeParams,
  refineEffectiveOutput,
  refineOutputOpensDocument,
  refineOutputUpgraded,
  selectLineParams,
  smartSelectParams
} from "./draft-state.js";

const CANVAS = { width: 100, height: 80 };

describe("U17 单行/单列参数", () => {
  it("单击点决定行/列，越界直接拒绝而不是先往返内核", () => {
    expect(selectLineParams({ x: 12.7, y: 5.2 }, { line: "row", mode: "add", canvas: CANVAS }))
      .toEqual({ x: 12, y: 5, line: "row", mode: "add" });
    expect(selectLineParams({ x: 3, y: 4 }, { line: "column", canvas: CANVAS }))
      .toMatchObject({ line: "column", mode: "replace" });
    expect(selectLineParams({ x: 100, y: 4 }, { canvas: CANVAS })).toBeNull();
    expect(selectLineParams({ x: 4, y: -1 }, { canvas: CANVAS })).toBeNull();
    expect(selectLineParams({ x: Number.NaN, y: 4 }, { canvas: CANVAS })).toBeNull();
    expect(selectLineParams({ x: 4, y: 4 }, { canvas: { width: 0, height: 0 } })).toBeNull();
  });
});

describe("U18 多边形/磁性套索", () => {
  it("少于三个锚点不提交，锚点与参数夹紧到内核范围", () => {
    expect(magneticLassoParams([{ x: 0, y: 0 }, { x: 4, y: 0 }], { canvas: CANVAS })).toBeNull();
    const params = magneticLassoParams(
      [{ x: -5, y: 0 }, { x: 140, y: 10 }, { x: 20, y: 200 }],
      { mode: "subtract", width: 999, contrast: 0, canvas: CANVAS }
    );
    expect(params).toMatchObject({ width: 256, contrast: 1, mode: "subtract", antiAlias: true, feather: 0 });
    // 追踪始终由内核完成：界面不自己猜边界。
    expect(params!.points).toEqual([[0, 0], [100, 10], [20, 80]]);
    expect(params).not.toHaveProperty("trace", false);
    // 闭合方式原样交给内核：默认沿边缘，直线闭合是显式选择。
    expect(params).toMatchObject({ close: "magnetic" });
    expect(magneticLassoParams([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }], { close: "straight", canvas: CANVAS }))
      .toMatchObject({ close: "straight" });
  });

  it("多边形套索关闭内核追踪，只提交锚点边界", () => {
    const params = magneticLassoParams(
      [{ x: 2, y: 2 }, { x: 40, y: 2 }, { x: 40, y: 30 }],
      { trace: false, canvas: CANVAS }
    );
    expect(params).toMatchObject({ trace: false, points: [[2, 2], [40, 2], [40, 30]] });
    // 追踪关闭时 width/contrast 不参与，交给内核的只有几何与组合方式。
    expect(params).not.toHaveProperty("width");
    expect(params).not.toHaveProperty("contrast");
  });

  it("锚点序列支持回退、闭合判定与快照隔离", () => {
    const anchors = new LassoAnchors();
    expect(anchors.canClose()).toBe(false);
    anchors.append({ x: 1, y: 1 });
    anchors.append({ x: Number.NaN, y: 2 });
    anchors.append({ x: 5, y: 1 });
    expect(anchors.length).toBe(2);
    expect(anchors.canClose()).toBe(false);
    anchors.append({ x: 5, y: 5 });
    expect(anchors.canClose()).toBe(true);
    expect(anchors.retreat()).toBe(true);
    expect(anchors.length).toBe(2);
    expect(anchors.retreat()).toBe(true);
    expect(anchors.retreat()).toBe(true);
    expect(anchors.retreat()).toBe(false);
    anchors.append({ x: 2, y: 3 });
    const snapshot = anchors.snapshot();
    snapshot[0]!.x = 99;
    expect(anchors.snapshot()[0]).toEqual({ x: 2, y: 3 });
    anchors.clear();
    expect(anchors.length).toBe(0);
  });
});

describe("U19 命名选区与按颜色扩大", () => {
  it("名称去空白、拒绝空值与超长", () => {
    expect(normalizeSelectionName("  天空  ")).toBe("天空");
    expect(normalizeSelectionName("   ")).toBeNull();
    expect(normalizeSelectionName("a".repeat(NAMED_SELECTION_MAX_LENGTH))).toBe("a".repeat(200));
    expect(normalizeSelectionName("a".repeat(201))).toBeNull();
  });

  it("Grow/Similar 参数与几何 Expand 不是同一条命令", () => {
    expect(colorGrowParams(31.6, true)).toEqual({ tolerance: 32, sampleAllLayers: true });
    expect(colorGrowParams(-4)).toEqual({ tolerance: 0, sampleAllLayers: false });
    expect(colorGrowParams(999)).toEqual({ tolerance: 255, sampleAllLayers: false });
  });
});

describe("U20 快速蒙版笔迹", () => {
  it("目标固定为临时选择通道，参数夹紧到内核范围", () => {
    const params = quickMaskStrokeParams([{ x: 1, y: 2 }], { size: 9999, hardness: -1, color: "#ff0000" });
    expect(params).toMatchObject({ target: "quickMask", size: 5000, hardness: 0, opacity: 1, flow: 1, color: "#ff0000" });
    expect(params!.points).toEqual([[1, 2]]);
    expect(quickMaskStrokeParams([], { size: 10 })).toBeNull();
    expect(quickMaskStrokeParams([{ x: Number.POSITIVE_INFINITY, y: 0 }], { size: 10 })).toBeNull();
  });

  it("缺省笔迹是白色（加入选区），黑白两档对应内核的真实语义", () => {
    // 白 = 覆盖覆盖度 1，转回选区时并入；黑 = 覆盖度 0，转回选区时遮出。
    expect(quickMaskStrokeParams([{ x: 0, y: 0 }], { size: 10 })).toMatchObject({ color: "#ffffff" });
    expect(quickMaskStrokeParams([{ x: 0, y: 0 }], { size: 10, color: "#000000" })).toMatchObject({ color: "#000000" });
  });
});

describe("U21 传统分割参数", () => {
  it("只发上游命令接受的字段，并按种类区分", () => {
    expect(smartSelectParams("object", { mode: "add", point: { x: 3.4, y: 5.6 } }))
      .toEqual({ mode: "add", sampleAllLayers: true, point: [3, 6] });
    // 空矩形不提交（宽高为 0 的取样区域没有意义）。
    expect(smartSelectParams("object", { rect: [0, 0, 0, 5] })).not.toHaveProperty("rect");
    expect(smartSelectParams("sky", { threshold: 200, softness: -1 })).toMatchObject({ threshold: 100, softness: 0 });
    expect(smartSelectParams("focusArea", { range: 4, noise: -2 })).toMatchObject({ range: 1, noise: 0 });
    expect(smartSelectParams("removeBackground")).toEqual({ sampleAllLayers: false, refine: true });
  });

  it("输出目标只在要求蒙版时出现，移除背景不重复声明", () => {
    // 缺省输出是选区：不上交 `output`，避免把本域意图漏给上游分割命令。
    expect(smartSelectParams("object", { point: { x: 1, y: 1 } })).not.toHaveProperty("output");
    expect(smartSelectParams("object", { point: { x: 1, y: 1 }, output: "selection" })).not.toHaveProperty("output");
    expect(smartSelectParams("object", { point: { x: 1, y: 1 }, output: "mask" })).toMatchObject({ output: "mask" });
    expect(smartSelectParams("sky", { output: "mask" })).toMatchObject({ output: "mask" });
    // 移除背景本身就是写蒙版，不接受额外的输出目标。
    expect(smartSelectParams("removeBackground", { output: "mask" })).not.toHaveProperty("output");
    // 主体只接受采样层与组合模式：上游命令没有阈值参数，不能凭空塞。
    expect(smartSelectParams("subject")).toEqual({ mode: "replace", sampleAllLayers: true });
    expect(smartSelectParams("subject", { mode: "add", sampleAllLayers: false })).toEqual({ mode: "add", sampleAllLayers: false });
  });
});

describe("U22 色彩范围取样", () => {
  it("取样序列保持点击顺序，供内核 order 复现", () => {
    const samples = new SamplePoints();
    expect(samples.add({ x: 1, y: 2 })).toBe(true);
    expect(samples.add({ x: Number.NaN, y: 2 })).toBe(false);
    samples.add({ x: 3, y: 4 }, "-");
    expect(samples.snapshot()).toEqual([
      { point: { x: 1, y: 2 }, operation: "+" },
      { point: { x: 3, y: 4 }, operation: "-" }
    ]);
    expect(samples.undo()).toBe(true);
    expect(samples.length).toBe(1);
    expect(samples.undo()).toBe(true);
    expect(samples.undo()).toBe(false);
  });

  it("加减取样分开上交并保留顺序；无取样时拒绝", () => {
    const params = colorRangeParams({
      samples: [{ point: { x: 1.4, y: 2.6 }, operation: "+" }, { point: { x: 7, y: 8 }, operation: "-" }],
      fuzziness: 500,
      inverted: true,
      invert: true,
      localized: true,
      range: 50
    } as never);
    expect(params).toMatchObject({ points: [[1, 3]], subtractPoints: [[7, 8]], order: ["+", "-"], fuzziness: 200, invert: true, localized: true, range: 50, select: "sampledColors" });
    expect(colorRangeParams({})).toBeNull();
    // 局部颜色群组必须真的有一个取样点。
    expect(colorRangeParams({ localized: true })).toBeNull();
    // 上游未实现的 detectFaces 不交给用户。
    expect(colorRangeParams({ detectFaces: true, samples: [{ point: { x: 0, y: 0 }, operation: "+" }] })).toBeNull();
  });

  it("预设范围不需要取样点；已有颜色/反相选项保留", () => {
    expect(colorRangeParams({ preset: "reds" })).toMatchObject({ select: "reds" });
    expect(colorRangeParams({ preset: "shadows", invert: true, color: "#00ff00" })).toMatchObject({ select: "shadows", invert: true, color: "#00ff00" });
  });
});

describe("U23 选择并遮住参数", () => {
  it("数值夹紧到内核范围，缺省输出为选区", () => {
    expect(refineEdgeParams({ radius: 999, smooth: -5, feather: 5000, contrast: 400, shiftEdge: -400 }))
      .toMatchObject({ radius: 250, smooth: 0, feather: 1000, contrast: 100, shiftEdge: -100, output: "selection" });
    expect(refineEdgeParams({ smartRadius: true, sampleAllLayers: true }))
      .toMatchObject({ smartRadius: true, sampleAllLayers: true });
  });

  it("修边笔迹把前景/背景换算成 add/subtract，并丢弃空笔迹", () => {
    const params = refineEdgeParams({
      strokes: [
        { points: [{ x: 1.2, y: 3.7 }], mode: "foreground", size: 900 },
        { points: [], mode: "background" },
        { points: [{ x: 9, y: 9 }], mode: "background", size: 0 }
      ]
    });
    expect(params.refineStrokes).toEqual([
      { points: [[1, 4]], mode: "add", size: 500 },
      { points: [[9, 9]], mode: "subtract", size: 1 }
    ]);
  });

  it("净化颜色只在开启时出现，并带 0–100 的量", () => {
    expect(refineEdgeParams({})).not.toHaveProperty("decontaminate");
    expect(refineEdgeParams({ decontaminate: true, amount: 500 })).toMatchObject({ decontaminate: true, amount: 100 });
  });

  it("只有新文档类输出占用文档名额", () => {
    expect(REFINE_OUTPUTS.map((entry) => entry.id)).toEqual(["selection", "layerMask", "newLayer", "newLayerWithMask", "newDocument", "newDocumentWithMask"]);
    expect(REFINE_OUTPUTS.filter((entry) => refineOutputOpensDocument(entry.id)).map((entry) => entry.id))
      .toEqual(["newDocument", "newDocumentWithMask"]);
  });

  it("净化颜色会把选区/像素蒙版输出升级成新图层（含蒙版），面板据此如实提示", () => {
    // 上游 `refine_edge`：净化要新像素，所以 selection / layerMask 被改成 newLayerWithMask。
    expect(refineEffectiveOutput("selection", true)).toBe("newLayerWithMask");
    expect(refineEffectiveOutput("layerMask", true)).toBe("newLayerWithMask");
    // 已经是新图层/新文档输出时不变（不会再多升一级，也不会降级）。
    for (const output of ["newLayer", "newLayerWithMask", "newDocument", "newDocumentWithMask"] as const) {
      expect(refineEffectiveOutput(output, true)).toBe(output);
    }
    // 不开净化就完全按用户所选。
    for (const output of REFINE_OUTPUTS.map((entry) => entry.id)) {
      expect(refineEffectiveOutput(output, false)).toBe(output);
      expect(refineEffectiveOutput(output, undefined)).toBe(output);
    }
    // 只有真被升级的两项需要提示，避免对其它输出刷无意义的警告。
    expect(REFINE_OUTPUTS.filter((entry) => refineOutputUpgraded(entry.id, true)).map((entry) => entry.id))
      .toEqual(["selection", "layerMask"]);
  });
});

describe("U24 像素蒙版属性", () => {
  it("密度属于内容、查看属于会话：两组参数互不混用", () => {
    expect(layerMaskEditParams({ density: 55.5, feather: 12 })).toEqual({ density: 55.5, feather: 12 });
    expect(layerMaskEditParams({ layer: 3 })).toBeNull();
    expect(layerMaskEditParams({ density: 400 })).toEqual({ density: 100 });
    expect(maskViewParams("gray", 7)).toEqual({ mode: "gray", layer: 7 });
    expect(maskViewParams("off")).toEqual({ mode: "off" });
    expect(maskViewParams("toggleOverlay")).toEqual({ mode: "toggleOverlay" });
    // 查看参数里不能出现内容字段（否则会写历史）。
    expect(Object.keys(maskViewParams("gray"))).toEqual(["mode"]);
  });

  it("密度/羽化范围与界面输入一致", () => {
    expect(clampMaskDensity(-1)).toBe(0);
    expect(clampMaskDensity(101)).toBe(100);
    expect(clampMaskFeather(9999)).toBeLessThanOrEqual(1000);
    expect(clampMaskFeather(-1)).toBe(0);
  });

  it("解码蒙版属性时拒绝非法结构，非法查看模式归一为无查看", () => {
    const decoded = decodeMaskProperties({
 layer: 4, mask: { density: 30, feather: 8, enabled: false, linked: false }, view: "gray", editTarget: "mask" });
    expect(decoded).toEqual({
 layer: 4, mask: { enabled: false, linked: false, density: 30, feather: 8 }, view: "gray", editTarget: "mask" });
    expect(decodeMaskProperties({ layer: 4, mask: { density: "30", feather: 8 } })).toBeNull();
    expect(decodeMaskProperties({ layer: 4, mask: null, view: "purple" }))
      .toEqual({
 layer: 4, mask: null, view: null, editTarget: "pixels" });
    expect(decodeMaskProperties("mask")).toBeNull();
  });
});

describe("草稿归属与过期候选", () => {
  it("解码草稿视图：未知种类与非法结构不猜测", () => {
    expect(decodeDraftState({ active: false })).toEqual({ active: false });
    expect(decodeDraftState({ active: true, kind: "magnetic", document: 3, revision: 9, bounds: [1, 2, 3, 4], maskBounds: null, invalid: false }))
      .toEqual({ active: true, kind: "magnetic", document: 3, revision: 9, stale: false, bounds: [1, 2, 3, 4], maskBounds: null, invalid: false });
    expect(decodeDraftState({ active: true, kind: "magnetic", document: 3, revision: 9, stale: true, bounds: null, maskBounds: null, invalid: false }))
      .toMatchObject({ stale: true });
    expect(decodeDraftState({ active: true, kind: "nope", document: 3, revision: 9 })).toBeNull();
    expect(decodeDraftState({ active: true, kind: "refine", document: 3 })).toBeNull();
    expect(decodeDraftState(null)).toBeNull();
    // 边界必须是 4 个数；坏结构降级为 null 而不是半截矩形。
    expect(decodeDraftState({ active: true, kind: "grow", document: 1, revision: 1, bounds: [1, 2, 3] }))
      .toMatchObject({ bounds: null });
  });

  it("草稿只在同一文档且同一修订时被认领", () => {
    const state = decodeDraftState({ active: true, kind: "refine", document: 2, revision: 5, bounds: [0, 0, 4, 4], maskBounds: null, invalid: false });
    expect(draftBelongsTo(state, { document: 2, revision: 5 })).toBe(true);
    expect(draftBelongsTo(state, { document: 2, revision: 6 })).toBe(false);
    expect(draftBelongsTo(state, { document: 3, revision: 5 })).toBe(false);
    expect(draftBelongsTo(decodeDraftState({ active: false }), { document: 2, revision: 5 })).toBe(false);
    expect(draftBelongsTo(null, { document: 2, revision: 5 })).toBe(false);
    expect(isStaleResult(1, 2)).toBe(true);
    expect(isStaleResult(2, 2)).toBe(false);
  });

  it("内核标记为过期归属的草稿即使文档号相同也不被认领", () => {
    // 切标签/父子回写后草稿保留了旧文档号，只有 `stale` 能说明它不属于当前目标。
    const stale = decodeDraftState({ active: true, kind: "refine", document: 2, revision: 5, stale: true, bounds: [0, 0, 4, 4], maskBounds: null, invalid: false });
    expect(stale).toMatchObject({ active: true, stale: true });
    expect(draftBelongsTo(stale, { document: 2, revision: 5 })).toBe(false);
  });
});

describe("快速蒙版只能经本域草稿进入（命令 id 改道判定）", () => {
  it("上游命令 id 被判为需改道，其它命令不受影响", () => {
    // 直通 `dispatch` 会绕过本域草稿：内核改正式文档、本域无记录，随后画笔报
    // "没有活动的快速蒙版会话"而保存却成功——兜底判定必须认得这个 id。
    expect(isQuickMaskCommand(QUICK_MASK_COMMAND)).toBe(true);
    expect(QUICK_MASK_COMMAND).toBe("select.editInQuickMaskMode");
    for (const id of ["select.all", "select.deselect", "select.object", "layer.layerMask.edit", ""]) {
      expect(isQuickMaskCommand(id)).toBe(false);
    }
  });
});
