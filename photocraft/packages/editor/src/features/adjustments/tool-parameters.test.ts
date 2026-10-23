// 只验证参数结构与控件语义；不采集真实像素或截图。
import { expect, it } from "vitest";
import {
  ADJUSTMENT_COMMANDS,
  ADJUSTMENT_KINDS,
  CURVE_CHANNELS,
  HUE_RANGES,
  PARAMETERLESS_COMMANDS,
  PARAMETERLESS_KINDS,
  SELECTIVE_RANGES,
  buildBlackWhite,
  buildChannelMixer,
  buildColorBalance,
  buildCurveMap,
  buildCurves,
  buildEyedropper,
  buildGradientStops,
  buildHueRange,
  buildHueSaturation,
  buildLevels,
  buildLevelsChannel,
  buildMatchColor,
  buildPhotoFilter,
  buildReplaceColor,
  buildSelectiveColor,
  buildShadowsHighlights,
  curveOf,
  curveMapOf,
  decodeDirectTargets,
  defaultAdjustmentParams,
  insertGradientStop,
  isParameterlessTarget,
  levelsOf,
  mixHex,
  normalizeHexColor,
  pointsFromMap,
  smoothCurveMap,
  validCurveMap
} from "./tool-parameters.js";

it("每类调整都有中性参数，且与内核参数表同名", () => {
  for (const kind of ADJUSTMENT_KINDS) {
    const params = defaultAdjustmentParams(kind);
    expect(params, kind).toBeTypeOf("object");
    // 照片滤镜默认给一个真实预设 id，可选颜色默认给方法，其余给实际键。
    for (const [key, value] of Object.entries(params)) {
      expect(value, `${kind}.${key}`).not.toBeUndefined();
    }
  }
  expect(defaultAdjustmentParams("invert")).toEqual({});
  expect(defaultAdjustmentParams("levels")).toEqual({ inBlack: 0, gamma: 1, inWhite: 255, outBlack: 0, outWhite: 255 });
  // 命令清单与内核的整条命令 id 一一对应，不能出现逐类调整里没有的 id。
  for (const command of ADJUSTMENT_COMMANDS) expect(command.startsWith("image.")).toBe(true);
});

it("曲线按通道增量写参数，切换通道不覆盖别的曲线", () => {
  const red = buildCurves("red", [[0, 0], [64, 120], [255, 255]]);
  expect(red).toEqual({ red: [[0, 0], [64, 120], [255, 255]] });
  const rgb = buildCurves("rgb", [[0, 0], [128, 200], [255, 255]]);
  expect(rgb.points).toEqual([[0, 0], [128, 200], [255, 255]]);
  expect(rgb).not.toHaveProperty("red");
  // 同一个对象里合并后四个通道各自保留。
  const merged = { ...red, ...buildCurves("green", [[0, 0], [128, 40], [255, 255]]), ...rgb };
  const channels = CURVE_CHANNELS.filter((channel) => curveOf(merged, channel) !== null);
  expect(channels).toHaveLength(4);
  expect(curveOf(merged, "red")[1]).toEqual([64, 120]);
  expect(curveOf(merged, "green")[1]).toEqual([128, 40]);
  expect(curveOf(merged, "blue")).toEqual([[0, 0], [255, 255]]);
  expect(curveOf(null, "rgb")).toEqual([[0, 0], [255, 255]]);
  // 铅笔与平滑是曲线通道共用的标志。
  expect(buildCurves("blue", [[0, 0], [255, 255]], { pencil: true, smooth: 3 })).toEqual({ blue: [[0, 0], [255, 255]], pencil: true, smooth: 3 });
  expect(buildCurves("blue", [[0, 0], [255, 255]], { smooth: 99 }).smooth).toBe(10);
  // 铅笔曲线写整条 256 级映射并默认打开 pencil，避免被当成点曲线解析。
  const map = Array.from({ length: 256 }, (_, index) => 255 - index);
  expect(buildCurveMap("rgb", map)).toMatchObject({ pencil: true });
  expect((buildCurveMap("rgb", map).points as number[]).length).toBe(256);
  expect(buildCurveMap("red", map, { pencil: true }).red).toHaveLength(256);
  expect(buildCurveMap("red", map).points).toBeUndefined();
  // 缺项按恒等补齐，越界夹紧。
  expect(buildCurveMap("rgb", [300, -5]).points).toEqual([255, 0, ...Array.from({ length: 254 }, (_, index) => index + 2)]);
  // 参数是点曲线时按直线换算成映射（切到铅笔不跳曲线）。
  expect(curveMapOf({ points: [[0, 0], [128, 64], [255, 255]] }, "rgb")[64]).toBe(32);
  expect(curveMapOf({ red: map }, "red")).toEqual(map);
  expect(curveMapOf(null, "rgb")).toEqual(Array.from({ length: 256 }, (_, index) => index));
  // 非法控制点无法表示成合法曲线，取通道时退回恒等而不是给出半截数据。
  expect(curveOf({ points: [[0, 0]] }, "rgb")).toEqual([[0, 0], [255, 255]]);
  expect(validCurveMap(Array.from({ length: 256 }, (_, index) => index))).toBe(true);
  expect(validCurveMap([1, 2, 3])).toBe(false);
  expect(smoothCurveMap([0, 100, 0]).length).toBe(3);
});

it("铅笔映射折回控制点时输入严格递增、点数远小于内核上限", () => {
  const map = Array.from({ length: 256 }, (_, index) => (index < 128 ? 0 : 255));
  const points = pointsFromMap(map);
  expect(points).toHaveLength(9);
  const inputs = points.map(([input]) => input);
  expect(inputs).toEqual([...inputs].sort((a, b) => a - b));
  expect(new Set(inputs).size).toBe(inputs.length);
  expect(points[0]![0]).toBe(0);
  expect(points.at(-1)![0]).toBe(255);
  // 走向保留：前段 0、后段 255。
  expect(points[2]![1]).toBe(0);
  expect(points.at(-2)![1]).toBe(255);
});

it("色阶端点与分通道各自成组，输出端点不再被忽略", () => {
  expect(buildLevels({ inBlack: 12, gamma: 1.25, inWhite: 240, outBlack: 8, outWhite: 250 }))
    .toEqual({ inBlack: 12, gamma: 1.25, inWhite: 240, outBlack: 8, outWhite: 250 });
  expect(buildLevelsChannel("red", { inBlack: 5, gamma: 1, inWhite: 250, outBlack: 0, outWhite: 255 }))
    .toEqual({ red: { inBlack: 5, gamma: 1, inWhite: 250, outBlack: 0, outWhite: 255 } });
  const params = { outWhite: 240, red: { inBlack: 5, gamma: 1, inWhite: 250, outBlack: 0, outWhite: 255 } };
  expect(levelsOf(params, "rgb").outWhite).toBe(240);
  expect(levelsOf(params, "red").inBlack).toBe(5);
  expect(levelsOf(params, "blue")).toEqual({ inBlack: 0, gamma: 1, inWhite: 255, outBlack: 0, outWhite: 255 });
});

it("色相六色域与着色、黑白 Tint 都保留已有参数", () => {
  const ranges = Object.fromEntries(HUE_RANGES.map((range) => [range, buildHueRange(10, -20, 5, [-45, -15, 15, 45])]));
  const colorized = buildHueSaturation(35, 25, 8, { colorize: true, ranges });
  expect(colorized.colorize).toBe(true);
  expect(colorized.hue).toBe(35);
  for (const range of HUE_RANGES) expect(colorized[range]).toMatchObject({ hue: 10, saturation: -20, lightness: 5 });
  // 非着色时色相是被移位的角度范围。
  expect(buildHueSaturation(200, 0, 0).hue).toBe(180);
  expect(buildHueSaturation(-200, 0, 0).hue).toBe(-180);
  expect(buildHueRange(0, 0, 0, [400, 0, 0, 0]).range).toEqual([360, 0, 0, 0]);

  const bw = buildBlackWhite({ reds: 10, blues: 90 }, { enabled: true, color: "#C8A06A" });
  expect(bw.tint).toBe(true);
  expect(bw.tintColor).toBe("#c8a06a");
  expect(bw.reds).toBe(10);
  expect(bw.blues).toBe(90);
  expect(bw.greens).toBe(40);
  // 非法颜色不静默替换成别的语义：回落到内核中性 Tint。
  expect(buildBlackWhite({}, { enabled: true, color: "c8a06a" }).tintColor).toBe("#e1d3b3");
  expect(normalizeHexColor(" #C8A06A ")).toBe("#c8a06a");
  expect(normalizeHexColor("#c8a06")).toBeNull();
});

it("新调整类型给出内核认识的参数形状", () => {
  expect(buildColorBalance([10, -10, 0], [0, 0, 0], [0, 0, 20], false))
    .toEqual({ shadows: [10, -10, 0], midtones: [0, 0, 0], highlights: [0, 0, 20], preserveLuminosity: false });
  expect(buildChannelMixer({ red: [40, 40, 20, 0] }, true)).toEqual({ monochrome: true, red: [40, 40, 20, 0] });
  expect(buildPhotoFilter("warming85", 25, "#EC8A00")).toEqual({ filter: "warming85", density: 25, preserveLuminosity: true, color: "#ec8a00" });
  expect(buildPhotoFilter("warming85", 250).density).toBe(100);
  expect(buildGradientStops([[1, "#ffffff"], [0, "#000000"]])).toEqual([[0, "#000000"], [1, "#ffffff"]]);
  expect(buildSelectiveColor("absolute", "neutrals", [10, -5, 0, 100]))
    .toEqual({ method: "absolute", neutrals: [10, -5, 0, 100] });
  expect(buildSelectiveColor("relative", "reds", [200, 0, 0, 0]).reds).toEqual([100, 0, 0, 0]);
  expect(defaultAdjustmentParams("selectiveColor").method).toBe("relative");
  expect(SELECTIVE_RANGES).toHaveLength(9);
});

it("渐变新增站点落在最大空隙里且位置严格递增", () => {
  // 直接追加 [1, …] 会与末站点同位置，内核要求严格递增 ⇒ 参数整体非法。
  const added = insertGradientStop([[0, "#000000"], [1, "#ffffff"]]);
  expect(added).toEqual([[0, "#000000"], [0.5, "#808080"], [1, "#ffffff"]]);
  const positions = added.map(([position]) => position);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  expect(new Set(positions).size).toBe(positions.length);
  // 多个同样宽的空隙时取靠前的那个（确定性优先，避免同一操作在不同实现里落点不同）。
  const right = insertGradientStop([[0, "#000000"], [0.5, "#000000"], [1, "#ffffff"]]);
  expect(right.map(([position]) => position)).toEqual([0, 0.25, 0.5, 1]);
  // 空隙过窄时保持原样，不生成重复位置。
  expect(insertGradientStop([[0, "#000000"], [0.001, "#ffffff"]])).toHaveLength(2);
  // 上限 64 个站点。
  const many = Array.from({ length: 64 }, (_, index) => [index / 63, "#000000"] as [number, string]);
  expect(insertGradientStop(many)).toHaveLength(64);
  expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  expect(mixHex("bad", "#ffffff", 0.5)).toBe("#808080");
  expect(mixHex("#ff0000", "#0000ff", 2)).toBe("#0000ff");
});

it("吸管与自动/匹配命令只生成本域接通的键", () => {
  expect(buildEyedropper("black", { color: [0.1, 0.2, 0.3] })).toEqual({ point: "black", color: [0.1, 0.2, 0.3] });
  expect(buildEyedropper("white", { at: [12.6, 3.2], size: 5 })).toEqual({ point: "white", at: [13, 3], size: 5 });
  expect(buildEyedropper("gray", { at: [0, 0], size: 500 }).size).toBe(101);
  const shadows = buildShadowsHighlights({ shadowAmount: 40, highlightAmount: 500 });
  expect(shadows.shadowAmount).toBe(40);
  expect(shadows.highlightAmount).toBe(100);
  expect(shadows).not.toHaveProperty("midtones");
  const replace = buildReplaceColor({ color: "#ff0000", fuzziness: 30, localized: true, points: [[4, 5]] });
  expect(replace).toEqual({ color: "#ff0000", fuzziness: 30, hue: 0, saturation: 0, lightness: 0, localized: true, range: 100, points: [[4, 5]] });
  // 跨文档来源不生成：需要共享的冻结源快照端口。
  expect(buildMatchColor({ neutralize: true })).toEqual({ luminance: 100, intensity: 100, fade: 0, neutralize: true });
  expect(buildMatchColor({ luminance: 0, intensity: 500 }).luminance).toBe(1);
  expect(buildMatchColor({ intensity: 500 }).intensity).toBe(200);
});

it("无参数目标单独列出，界面据此渲染显式起点", () => {
  // 反相与五条无参数命令都没有滑杆可拖；漏掉任何一个都会让入口不可达。
  expect(PARAMETERLESS_KINDS).toEqual(["invert"]);
  expect([...PARAMETERLESS_COMMANDS]).toEqual([
    "image.autoTone",
    "image.autoContrast",
    "image.autoColor",
    "image.adjustments.desaturate",
    "image.adjustments.equalize"
  ]);
  for (const target of [...PARAMETERLESS_KINDS, ...PARAMETERLESS_COMMANDS]) expect(isParameterlessTarget(target), target).toBe(true);
  // 有参数的目标不能出现「应用调整」，否则会以缺省参数静默提交。
  expect(isParameterlessTarget("brightnessContrast")).toBe(false);
  expect(isParameterlessTarget("image.adjustments.shadowsHighlights")).toBe(false);
  // 清单本身必须来自已实现类型/命令，不能凭空虚增。
  for (const kind of PARAMETERLESS_KINDS) expect(ADJUSTMENT_KINDS).toContain(kind);
  for (const command of PARAMETERLESS_COMMANDS) expect(ADJUSTMENT_COMMANDS).toContain(command);
  // 无参数类型的中性参数就是空对象。
  expect(defaultAdjustmentParams("invert")).toEqual({});
});

it("目标清单解码只接受本域认识的结构与 id，并保留可选来源文档", () => {
  const decoded = decodeDirectTargets({
    kinds: ["curves", "colorLookup", "invert"],
    commands: ["image.autoTone", "image.adjustments.colorLookup"],
    allKinds: ["curves", "invert", "levelz"],
    allCommands: ["image.autoTone"],
    documents: [
      { index: 0, name: "来源", width: 64, height: 48, active: false },
      { index: 1, name: "目标", width: 32, height: 24, active: true },
      { index: -1, name: "非法索引" },
      { name: "缺索引" },
      "not-a-document"
    ]
  });
  expect(decoded).not.toBeNull();
  expect(decoded!.kinds).toEqual(["curves", "invert"]);
  expect(decoded!.commands).toEqual(["image.autoTone"]);
  expect(decoded!.allKinds).toEqual(["curves", "invert"]);
  // 只有结构完整的文档进入来源清单；缺 documents 时是空清单（旧内核不报错）。
  expect(decoded!.documents).toEqual([
    { index: 0, name: "来源", width: 64, height: 48, active: false },
    { index: 1, name: "目标", width: 32, height: 24, active: true }
  ]);
  // 结构不符时返回 null，界面不显示半截入口。
  expect(decodeDirectTargets(null)).toBeNull();
  expect(decodeDirectTargets({ kinds: ["curves"] })).toBeNull();
  expect(decodeDirectTargets({ kinds: [1], commands: [], allKinds: [], allCommands: [] })).toBeNull();
  expect(decodeDirectTargets({ kinds: [], commands: [], allKinds: [], allCommands: [] })!.documents).toEqual([]);
});

it("匹配颜色可指定来源文档与来源层，省略来源时按本图统计", () => {
  const own = buildMatchColor({ neutralize: true });
  expect(own).not.toHaveProperty("source");
  expect(own).toMatchObject({ luminance: 100, intensity: 100, fade: 0, neutralize: true });
  const cross = buildMatchColor({ luminance: 120, source: 2, sourceLayer: 7, useSelectionInSource: true });
  expect(cross).toMatchObject({ luminance: 120, source: 2, sourceLayer: 7, useSelectionInSource: true });
  // 越界/小数被归一成合法索引与图层 id。
  expect(buildMatchColor({ source: -3 }).source).toBe(0);
  expect(buildMatchColor({ source: 1.6 }).source).toBe(2);
  expect(buildMatchColor({ sourceLayer: 0 }).sourceLayer).toBe(1);
});
