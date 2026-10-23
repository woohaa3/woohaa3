/**
 * 滤镜清单解码与几何编辑回归（U46–U49）。
 *
 * 这里只锁定界面侧契约：内核清单解码的有界性、画廊组合的顺序/可见性、模糊画廊控制点、
 * 消失点平面与广角约束的夹取。像素与命令语义在 Rust 侧由 `features/filters` 的单测覆盖。
 */
import { expect, it } from "vitest";
import {
  FILTER_LIMITS,
  addConstraint,
  addClone,
  addCurvePoint,
  addEffect,
  addLight,
  addPaste,
  addPin,
  addPlane,
  FILTER_KERNEL_SIZE,
  blurPaths,
  blurPinKey,
  blurPins,
  filterKernel,
  identityKernel,
  lensStraighten,
  newStraighten,
  catalogueCategories,
  coerceParam,
  currentValue,
  decodeFilterCatalogue,
  decodeFilterDraft,
  decodeFilterLast,
  decodeFilterMapSources,
  decodeFilterStack,
  defaultParams,
  moveEffect,
  newEffect,
  normalizePoint,
  paramStep,
  removeConstraint,
  removeEffect,
  removePin,
  removePlane,
  replaceEffect,
  setEffectParam,
  setPlaneCorner,
  stackEffects,
  stackParams,
  toggleEffect,
  vanishingPlanes,
  curveSplits,
  curveUsable,
  decodeFilterLayerSources,
  decodeFilterPathSources,
  flamePath,
  setCloneBrush,
  setCloneGeometry,
  setPaste,
  filterCurve,
  filterHsl,
  filterLights,
  filterWheel,
  moveCurvePoint,
  moveLight,
  newLight,
  newPaste,
  removeCurvePoint,
  removeLight,
  wideAngleConstraints,
  vanishingClones,
  vanishingPastes,
  withClones,
  withCurve,
  withCurveSplits,
  withFlamePath,
  withHslBand,
  withLights,
  withWheel,
  type FilterLight,
  withBlurPaths,
  withBlurPins,
  withKernel,
  withStraighten,
  withConstraints,
  withMapDocument,
  withMapLayer,
  withShearPoints,
  addShearPoint,
  defaultShearPoints,
  mapLayerOf,
  moveShearPoint,
  removeShearPoint,
  shearPoints,
  shearUsable,
  withPastes,
  withPlanes,
  type FilterCatalogue,
  type FilterEntry
} from "./catalogue.js";

const param = (key: string, kind: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind,
  min: null,
  max: null,
  default: null,
  choices: [],
  ...extra
});

function catalogueJson(): unknown {
  return {
    filters: [
      {
        id: "filter.blur.gaussianBlur",
        label: "高斯模糊",
        category: "模糊",
        kind: "simple",
        usesColours: false,
        needsMap: false,
        params: [param("radius", "number", { min: 0.1, max: 1000, default: 1 })]
      },
      {
        id: "filter.noise.addNoise",
        label: "添加杂色",
        category: "杂色",
        kind: "random",
        usesColours: false,
        needsMap: false,
        params: [param("amount", "number", { min: 0.1, max: 400, default: 12.5 }), param("seed", "integer", { min: 0, max: 4294967295 })]
      },
      {
        id: "filter.filterGallery",
        label: "滤镜库…",
        category: "滤镜库",
        kind: "galleryStack",
        usesColours: false,
        needsMap: false,
        params: [param("foreground", "color", { default: "#000000" }), param("background", "color", { default: "#000000" })]
      }
    ],
    gallery: {
      categories: ["Artistic", "Texture"],
      filters: [
        {
          key: "cutout",
          name: "剪贴画",
          category: "Artistic",
          command: "filter.gallery.cutout",
          params: [param("numberOfLevels", "integer", { min: 2, max: 8, default: 4 }), param("edgeFidelity", "integer", { min: 0, max: 3, default: 2 })]
        },
        {
          key: "filmGrain",
          name: "胶片颗粒",
          category: "Texture",
          command: "filter.gallery.filmGrain",
          params: [param("grain", "number", { min: 0, max: 20, default: 4 })]
        }
      ]
    },
    limits: { maxEffects: 32, maxPins: 16, maxPlanes: 8, maxParams: 96, maxResourcePoints: 64, seedMax: 4294967295 }
  };
}

function decoded(): FilterCatalogue {
  const catalogue = decodeFilterCatalogue(catalogueJson());
  expect(catalogue).not.toBeNull();
  return catalogue!;
}

it("解码内核清单并保留分类顺序", () => {
  const catalogue = decoded();
  expect(catalogue.filters.map((entry) => entry.id)).toEqual([
    "filter.blur.gaussianBlur",
    "filter.noise.addNoise",
    "filter.filterGallery"
  ]);
  expect(catalogue.limits).toEqual(FILTER_LIMITS);
  expect(catalogueCategories(catalogue).map((group) => [group.category, group.filters.length])).toEqual([
    ["模糊", 1],
    ["杂色", 1],
    ["滤镜库", 1]
  ]);
});

it("拒绝结构损坏或超限的清单（面板不画半套滑杆）", () => {
  const base = catalogueJson() as { filters: Record<string, unknown>[] };
  const mutate = (apply: (value: { filters: Record<string, unknown>[] }) => void) => {
    const value = structuredClone(base);
    apply(value);
    return decodeFilterCatalogue(value);
  };
  expect(mutate((value) => { value.filters[0]!.kind = "nope"; })).toBeNull();
  expect(mutate((value) => { value.filters[0]!.id = "blur.gaussianBlur"; })).toBeNull();
  expect(mutate((value) => { value.filters[0]!.params = [param("radius", "number", { min: 10, max: 1 })]; })).toBeNull();
  expect(mutate((value) => { value.filters[0]!.params = [param("quality", "choice")]; })).toBeNull();
  expect(mutate((value) => { value.filters[0]!.params = [param("x", "number"), param("x", "number")]; })).toBeNull();
  expect(mutate((value) => { value.filters = []; })).toBeNull();
  // 内核可以更严，不能比协议下界更宽。
  expect(mutate((value) => { (value as unknown as { limits: unknown }).limits = { maxEffects: 999 }; })).toBeNull();
  expect(decodeFilterCatalogue({ filters: [], gallery: { filters: [] } })).toBeNull();
  expect(decodeFilterCatalogue(null)).toBeNull();
});

it("解码草稿、上次滤镜与默认组合", () => {
  expect(decodeFilterDraft(null)).toBeNull();
  expect(decodeFilterDraft({ filter: "filter.blur.gaussianBlur", label: "高斯模糊", category: "模糊", kind: "Simple", layer: 4, params: { radius: 2 } }))
    .toEqual({ filter: "filter.blur.gaussianBlur", label: "高斯模糊", category: "模糊", kind: "Simple", layer: 4, params: { radius: 2 } });
  expect(decodeFilterDraft({ filter: "filter.blur.gaussianBlur", label: "高斯模糊", category: "模糊", kind: "Simple", layer: -1, params: {} })).toBeNull();
  // 只回核心字段的宿主也要能用：元数据与目标图层可由命令自身补位。
  expect(decodeFilterDraft({ filter: "filter.blur.gaussianBlur" }))
    .toEqual({ filter: "filter.blur.gaussianBlur", label: "filter.blur.gaussianBlur", category: "", kind: "", layer: 0, params: {} });
  expect(decodeFilterDraft({ filter: "filter.blur.gaussianBlur", label: 4 })).toBeNull();

  expect(decodeFilterLast({ available: false })).toEqual({ available: false, reason: "还没有可重复的滤镜" });
  const last = decodeFilterLast({ available: true, filter: "filter.sharpen.unsharpMask", label: "USM 锐化", params: { amount: 200 } });
  expect(last).toEqual({ available: true, filter: "filter.sharpen.unsharpMask", label: "USM 锐化", params: { amount: 200 } });
  expect(decodeFilterLast({ available: true, filter: "filter.sharpen.unsharpMask", label: "", params: {} })).toBeNull();

  expect(decodeFilterStack({ effects: [{ filter: "cutout", params: { numberOfLevels: 5 } }] }))
    .toEqual([{ filter: "cutout", params: { numberOfLevels: 5 }, visible: true }]);
  expect(decodeFilterStack({ effects: [] })).toBeNull();
  expect(decodeFilterStack({ effects: [{ filter: "cutout" }] })).toBeNull();
});

it("默认参数跳过 seed 与结构型字段", () => {
  const catalogue = decoded();
  const noise = catalogue.filters.find((entry) => entry.id === "filter.noise.addNoise")!;
  expect(defaultParams(noise)).toEqual({ amount: 12.5 });
  const gallery = catalogue.filters.find((entry) => entry.id === "filter.filterGallery")!;
  expect(defaultParams(gallery)).toEqual({ foreground: "#000000", background: "#000000" });
});

it("标量输入按内核范围与类型夹取，非法值直接拒绝", () => {
  const radius = { key: "radius", kind: "number" as const, min: 0.1, max: 1000, default: 1, choices: [] };
  expect(coerceParam(radius, "2.5")).toBe(2.5);
  expect(coerceParam(radius, 0)).toBeNull();
  expect(coerceParam(radius, Number.NaN)).toBeNull();
  expect(coerceParam(radius, 1001)).toBeNull();
  const levels = { key: "numberOfLevels", kind: "integer" as const, min: 2, max: 8, default: 4, choices: [] };
  expect(coerceParam(levels, 5)).toBe(5);
  expect(coerceParam(levels, 5.5)).toBeNull();
  expect(coerceParam(levels, 9)).toBeNull();
  const quality = { key: "quality", kind: "choice" as const, min: null, max: null, default: "good", choices: ["draft", "good", "best"] };
  expect(coerceParam(quality, "best")).toBe("best");
  expect(coerceParam(quality, "nope")).toBeNull();
  const colour = { key: "foreground", kind: "color" as const, min: null, max: null, default: "#ffffff", choices: [] };
  expect(coerceParam(colour, "#AABBCC")).toBe("#aabbcc");
  expect(coerceParam(colour, "red")).toBeNull();
  const resource = { key: "pins", kind: "resource" as const, min: null, max: null, default: null, choices: [] };
  expect(coerceParam(resource, [])).toBeNull();
  expect(paramStep(radius)).toBe(1);
  expect(paramStep({ ...radius, min: 0, max: 1 })).toBe(0.01);
  expect(currentValue(radius, { radius: 4 })).toBe(4);
  expect(currentValue(radius, {})).toBe(1);
});

it("画廊组合支持添加、替换、上下移、可见性与参数写入，且拒绝无可见效果", () => {
  const catalogue = decoded();
  const cutout = catalogue.gallery.filters[0]!;
  const grain = catalogue.gallery.filters[1]!;
  let effects = addEffect([], newEffect(cutout));
  expect(effects[0]).toEqual({ filter: "cutout", params: { numberOfLevels: 4, edgeFidelity: 2 }, visible: true });
  effects = addEffect(effects, newEffect(grain));
  expect(effects.map((effect) => effect.filter)).toEqual(["cutout", "filmGrain"]);
  effects = setEffectParam(effects, 1, "grain", 8);
  expect(effects[1]!.params.grain).toBe(8);
  effects = moveEffect(effects, 1, -1);
  expect(effects.map((effect) => effect.filter)).toEqual(["filmGrain", "cutout"]);
  effects = replaceEffect(effects, 0, cutout);
  expect(effects[0]).toEqual({ filter: "cutout", params: { numberOfLevels: 4, edgeFidelity: 2 }, visible: true });
  effects = toggleEffect(effects, 0);
  expect(effects[0]!.visible).toBe(false);
  expect(stackParams(effects)).not.toBeNull();
  expect(stackParams(toggleEffect(effects, 1))).toBeNull();
  expect(stackParams([])).toBeNull();
  effects = removeEffect(effects, 0);
  expect(effects).toHaveLength(1);
  // 上限来自内核目录，超出后不再增长。
  const many = Array.from({ length: FILTER_LIMITS.maxEffects }, () => newEffect(cutout));
  expect(addEffect(many, newEffect(cutout), FILTER_LIMITS.maxEffects)).toHaveLength(FILTER_LIMITS.maxEffects);
  // `seed` 不属于组合参数（随机由各效果自己的参数决定）。
  expect(stackParams(newEffect(cutout) ? [newEffect(cutout)] : [], { seed: 7 })!.seed).toBeUndefined();
});

it("参数里的效果栈可以还原成面板状态", () => {
  expect(stackEffects({ effects: [{ filter: "cutout", params: { numberOfLevels: 5 }, visible: false }] }))
    .toEqual([{ filter: "cutout", params: { numberOfLevels: 5 }, visible: false }]);
  expect(stackEffects({})).toEqual([]);
  expect(stackEffects({ effects: [{ filter: 3 }] })).toEqual([]);
});

it("模糊画廊控制点默认取中心，写回后中心与点列表一致", () => {
  expect(blurPins({ centerX: 0.25, centerY: 0.75, blur: 30 }, 16)).toEqual([{ x: 0.25, y: 0.75, blur: 30 }]);
  const pins = blurPins({ pins: [{ x: 0.1, y: 0.2, blur: 5 }, { x: 2, y: -1, blur: 900 }] }, 16);
  expect(pins).toEqual([{ x: 0.1, y: 0.2, blur: 5 }, { x: 1, y: 0, blur: 500 }]);
  let next = addPin(pins, { x: 0.5, y: 0.5, blur: 10 }, 16);
  expect(next).toHaveLength(3);
  next = removePin(next, 0);
  expect(next.map((pin) => pin.x)).toEqual([1, 0.5]);
  // 至少保留一个控制点，否则内核没有几何可用。
  expect(removePin([{ x: 0.5, y: 0.5, blur: 1 }], 0)).toHaveLength(1);
  const params = withBlurPins({ centerX: 0.5, centerY: 0.5, blur: 15 }, next);
  expect(params.centerX).toBe(1);
  expect(params.centerY).toBe(0);
  expect(withBlurPins({ centerX: 0.5 }, []).pins).toBeUndefined();
  expect(addPin(Array.from({ length: 16 }, () => ({ x: 0, y: 0, blur: 1 })), { x: 0.5, y: 0.5, blur: 1 }, 16)).toHaveLength(16);
});

const entryOf = (overrides: Record<string, unknown>) => ({
  id: "filter.blurGallery.fieldBlur",
  label: "",
  category: "",
  kind: "blurGallery",
  usesColours: false,
  needsMap: false,
  ...overrides
}) as unknown as FilterEntry;

it("没有 pins 声明的命令不会被塞进 pins", () => {
  // 移轴模糊的几何是中心/角度/焦点带；路径模糊的是 paths。
  // 无条件写 pins 会让内核以「没有参数 pins」拒绝整次草稿，滤镜在面板里完全不可用。
  const tilt = entryOf({ id: "filter.blurGallery.tiltShift", params: [param("centerX", "number"), param("centerY", "number")] });
  const sent = withBlurPins({ centerX: 0.5, centerY: 0.5 }, [{ x: 0.2, y: 0.8, blur: 20 }], tilt);
  expect(sent).not.toHaveProperty("pins");
  expect(sent).toMatchObject({ centerX: 0.2, centerY: 0.8 });

  const pins = entryOf({ params: [param("pins", "resource", { resource: true })] });
  expect(withBlurPins({}, [{ x: 0.3, y: 0.4, blur: 12 }], pins).pins).toEqual([{ x: 0.3, y: 0.4, blur: 12 }]);
});

it("旋转模糊的控制点模糊量用 blurAngle 且受命令范围约束", () => {
  const spin = entryOf({
    id: "filter.blurGallery.spinBlur",
    params: [param("blurAngle", "number", { min: 0, max: 360, default: 15 }), param("pins", "resource")]
  });
  expect(blurPinKey(spin)).toBe("blurAngle");
  expect(blurPinKey(entryOf({ params: [param("pins", "resource")] }))).toBe("blur");
  // 读：内核回执里的 blurAngle 直接成为面板的模糊量；旧的 blur 也能读回来。
  expect(blurPins({ pins: [{ x: 0.5, y: 0.5, blurAngle: 120 }] }, 16, spin)).toEqual([{ x: 0.5, y: 0.5, blur: 120 }]);
  expect(blurPins({ pins: [{ x: 0.5, y: 0.5, blur: 40 }] }, 16, spin)).toEqual([{ x: 0.5, y: 0.5, blur: 40 }]);
  // 写：字段名与上限都跟着声明走，不会被夹到通用 500 或写成 blur。
  const sent = withBlurPins({}, [{ x: 0.5, y: 0.5, blur: 900 }], spin);
  expect(sent.pins).toEqual([{ x: 0.5, y: 0.5, blurAngle: 360 }]);
});

it("路径模糊的 paths 是唯一几何来源，首条起止点同步到标量", () => {
  const pathBlur = entryOf({
    id: "filter.blurGallery.pathBlur",
    params: [
      param("speed", "number", { min: 0, max: 500, default: 50 }),
      param("taper", "number", { min: 0, max: 100, default: 0 }),
      param("startX", "number"), param("startY", "number"),
      param("endX", "number"), param("endY", "number"),
      param("paths", "resource")
    ]
  });
  // 没有显式 paths 时按起止点兜底出一条，与内核的默认一致。
  expect(blurPaths({ startX: 0.1, startY: 0.2, endX: 0.9, endY: 0.8, speed: 80, taper: 10 }, 16))
    .toEqual([{ points: [[0.1, 0.2], [0.9, 0.8]], speed: 80, taper: 10 }]);
  // 落单的点、非数值的点、越界坐标都被丢弃或夹紧。
  expect(blurPaths({ paths: [{ points: [[0.5, 0.5]] }] }, 16)).toHaveLength(1);
  expect(blurPaths({ paths: [{ points: [["a", 0.5], [0.5, 0.5]] }] }, 16)[0]!.points)
    .toEqual([[0.2, 0.5], [0.8, 0.5]]);
  const sent = withBlurPaths({ startX: 0.2, startY: 0.5, endX: 0.8, endY: 0.5 }, [
    { points: [[0.05, 0.15], [1.4, -0.2]], speed: 900, taper: -3 }
  ], pathBlur);
  expect(sent.paths).toEqual([{ points: [[0.05, 0.15], [1, 0]], speed: 500, taper: 0 }]);
  expect(sent).toMatchObject({ startX: 0.05, startY: 0.15, endX: 1, endY: 0 });
  // 没声明 paths 的命令不写这个字段。
  expect(withBlurPaths({}, [{ points: [[0, 0], [1, 1]], speed: 1, taper: 1 }], entryOf({ params: [] })))
    .not.toHaveProperty("paths");
});

it("自定卷积的核有 25 项，缺失时退回恒等核，写回时夹取并整成 25 项", () => {
  const custom = entryOf({ id: "filter.other.custom", kind: "simple", params: [param("kernel", "resource"), param("scale", "number")] });
  expect(FILTER_KERNEL_SIZE).toBe(25);
  expect(identityKernel()).toHaveLength(25);
  expect(identityKernel()[12]).toBe(1);
  expect(identityKernel().filter((value) => value !== 0)).toHaveLength(1);
  // 没有 kernel / 项数不对：退回恒等核，而不是画一个空网格。
  expect(filterKernel({})[12]).toBe(1);
  expect(filterKernel({ kernel: [1, 2, 3] })[12]).toBe(1);
  // 非数值按 0，越界夹到内核范围。
  const read = filterKernel({ kernel: Array.from({ length: 25 }, (_, index) => (index === 0 ? "x" : index === 1 ? 5000 : index === 2 ? -5000 : 0)) });
  expect(read.slice(0, 3)).toEqual([0, 999, -999]);
  const sent = withKernel({ scale: 2 }, Array.from({ length: 25 }, () => 1), custom);
  expect(sent.kernel).toHaveLength(25);
  expect(sent).toMatchObject({ scale: 2 });
  // 未声明 kernel 的命令不写这个字段。
  expect(withKernel({}, identityKernel(), entryOf({ params: [] }))).not.toHaveProperty("kernel");
});

it("镜头校正的拉直线用文档像素，写回时夹取并取整", () => {
  const lens = entryOf({ id: "filter.lensCorrection", kind: "lens", params: [param("straighten", "resource"), param("angle", "number")] });
  const size = { width: 1000, height: 500 };
  // 没有拉直线时是 null（内核此时不做拉直旋转），不是一条假的水平线。
  expect(lensStraighten({})).toBeNull();
  expect(lensStraighten({ straighten: [[10, 20]] })).toBeNull();
  expect(lensStraighten({ straighten: [[10, 20], ["a", 30]] })).toBeNull();
  expect(lensStraighten({ straighten: [[10, 20], [90, 40]] })).toEqual({ a: [10, 20], b: [90, 40] });
  // 默认线贯穿画面中部：正好对应「不旋转」。
  expect(newStraighten(size)).toEqual({ a: [250, 250], b: [750, 250] });
  // 写回：端点夹在画布内并取整，`straighten` 是唯一几何来源。
  const sent = withStraighten({ angle: 3 }, { a: [-20, 12.6], b: [1200, 900] }, size, lens);
  expect(sent.straighten).toEqual([[0, 13], [1000, 500]]);
  expect(sent).toMatchObject({ angle: 3 });
  // 清除：删掉字段而不是写 null（内核按数组解析）。
  expect(withStraighten({ angle: 3, straighten: [[0, 0], [1, 1]] }, null, size, lens)).not.toHaveProperty("straighten");
  // 未声明 straighten 的命令不写这个字段。
  expect(withStraighten({}, newStraighten(size), size, entryOf({ params: [] }))).not.toHaveProperty("straighten");
});

it("消失点平面可增删改角点（文档像素），且数量受上限约束", () => {
  expect(vanishingPlanes({}, 8)).toEqual([]);
  const size = { width: 1000, height: 500 };
  let planes = addPlane([], size, undefined, 8);
  expect(planes).toHaveLength(1);
  expect(planes[0]!.corners).toEqual([[200, 100], [800, 100], [800, 400], [200, 400]]);
  planes = setPlaneCorner(planes, 0, 1, [900, 50], size);
  expect(planes[0]!.corners[1]).toEqual([900, 50]);
  // 越界与非法值夹在画布内，不会写出内核必然拒绝的角点。
  expect(setPlaneCorner(planes, 0, 1, [2000, -40], size)[0]!.corners[1]).toEqual([1000, 0]);
  expect(setPlaneCorner(planes, 0, 1, [Number.NaN, 10], size)[0]!.corners[1]).toEqual([900, 50]);
  planes = setPlaneCorner(planes, 0, 5, [50, 50], size);
  expect(planes[0]!.corners).toHaveLength(4);
  expect(withPlanes({}, planes).planes).toEqual(planes);
  expect(vanishingPlanes({ planes: [{ from: 0 }] }, 8)).toEqual([]);
  expect(removePlane(planes, 0)).toEqual([]);
  expect(addPlane(Array.from({ length: 8 }, () => ({ corners: [[0, 0], [100, 0], [100, 100], [0, 100]] as [number, number][] as never })), size, undefined, 8)).toHaveLength(8);
  // 相对坐标（0–1）不再是合法平面：默认平面必须按画布像素生成。
  expect(planes[0]!.corners[0]![0]).toBeGreaterThan(1);
});

it("自适应广角约束线可增删，方向限定为内核选项", () => {
  const size = { width: 1000, height: 400 };
  expect(wideAngleConstraints({}, 64)).toEqual([]);
  const constraints = wideAngleConstraints({ constraints: [{ a: [0, 200], b: [1000, 200], orientation: "vertical" }] }, 64);
  expect(constraints).toEqual([{ a: [0, 200], b: [1000, 200], orientation: "vertical" }]);
  expect(wideAngleConstraints({ constraints: [{ a: [0, 0], b: [1, 0], orientation: "diagonal" }] }, 64)[0]!.orientation).toBe("free");
  // 新约束用文档像素，不是 0–1 相对值。
  const added = addConstraint(constraints, size);
  expect(added).toHaveLength(2);
  expect(added[1]).toEqual({ a: [100, 200], b: [900, 200], orientation: "horizontal" });
  expect(withConstraints({}, added).constraints).toHaveLength(2);
  expect(removeConstraint(added, 0)).toHaveLength(1);
  expect(addConstraint(Array.from({ length: 64 }, () => ({ a: [0, 0] as [number, number], b: [100, 100] as [number, number], orientation: "free" as const })), size, undefined, 64)).toHaveLength(64);
});

it("画布坐标换算成 0–1，非法视口不产生点", () => {
  expect(normalizePoint(50, 25, 100, 50)).toEqual([0.5, 0.5]);
  expect(normalizePoint(-10, 200, 100, 50)).toEqual([0, 1]);
  expect(normalizePoint(1, 1, 0, 10)).toBeNull();
  expect(normalizePoint(Number.NaN, 1, 10, 10)).toBeNull();
});

it("解码位移图来源：丢弃单条非法项，但端口返回非列表要整份失败", () => {
  expect(decodeFilterMapSources({
    documents: [
      { index: 0, name: "底图.pcraft", width: 1000, height: 500, active: true },
      { index: 1, name: "位移图.pcraft", width: 800, height: 600 }
    ]
  })).toEqual([
    { index: 0, name: "底图.pcraft", width: 1000, height: 500, active: true, layers: [] },
    { index: 1, name: "位移图.pcraft", width: 800, height: 600, active: false, layers: [] }
  ]);
  // 单条坏掉只丢那一行：少一个候选比整块不可用更合理。
  expect(decodeFilterMapSources({
    documents: [
      { index: -1, name: "坏", width: 10, height: 10 },
      { index: 3, name: "好.pcraft", width: 10, height: 10 },
      { index: 4, name: 42, width: 10, height: 10 },
      { index: 5, name: "负尺寸.pcraft", width: -1, height: 10 },
      "nope"
    ]
  })).toEqual([{ index: 3, name: "好.pcraft", width: 10, height: 10, active: false, layers: [] }]);
  expect(decodeFilterMapSources({ documents: "nope" })).toBeNull();
  expect(decodeFilterMapSources({})).toBeNull();
  expect(decodeFilterMapSources(null)).toBeNull();
});

it("写回位移图来源只动 mapDocument，换来源时清掉旧图层号与本机路径", () => {
  const base = { horizontal: 6, vertical: 6 };
  expect(withMapDocument(base, "位移图.pcraft")).toEqual({ ...base, mapDocument: "位移图.pcraft" });
  // 本域不接受本机路径：即便旧参数里有，也会被清掉。
  const legacy = { ...base, mapPath: "/tmp/map.psd" };
  expect(withMapDocument(legacy, "位移图.pcraft")).toEqual({ ...base, mapDocument: "位移图.pcraft" });
  // 换文档时旧图层号没有意义，一并删除。
  const layered = { ...base, mapDocument: "底图.pcraft", mapLayer: 3 };
  expect(withMapDocument(layered, "位移图.pcraft")).toEqual({ ...base, mapDocument: "位移图.pcraft" });
  expect(withMapDocument(layered, 7)).toEqual(base);
  expect(withMapDocument(layered, "")).toEqual(base);
  expect(withMapDocument(base, null)).toEqual(base);
  // 纯函数：入参不被改写。
  expect(base).toEqual({ horizontal: 6, vertical: 6 });
  expect(legacy.mapPath).toBe("/tmp/map.psd");
});

// ---------------------------------------------------------------- Camera Raw：曲线 / HSL / 分级 / 光源

const cameraRaw = () => entryOf({
  id: "filter.cameraRaw",
  kind: "cameraRaw",
  params: [
    param("pointCurve", "resource"),
    param("pointCurveRed", "resource"),
    param("curveSplits", "resource"),
    param("hslHue", "resource"),
    param("hslSat", "resource"),
    param("hslLum", "resource"),
    param("gradeShadows", "resource"),
    param("gradeGlobal", "resource")
  ]
});

it("点曲线：空曲线合法，单点/递减/越界都收敛成不调整", () => {
  const entry = cameraRaw();
  // 空数组是内核接受的「不调整」。
  expect(withCurve({}, "pointCurve", [], entry)).toEqual({ pointCurve: [] });
  // 合法的两点曲线原样写回。
  expect(withCurve({}, "pointCurve", [[0, 0], [128, 200], [255, 255]], entry))
    .toEqual({ pointCurve: [[0, 0], [128, 200], [255, 255]] });
  // 单点 / 输入递减 / 越界都会被内核拒绝：写回时换成空曲线而不是把坏数据送出去。
  expect(withCurve({}, "pointCurve", [[128, 128]], entry)).toEqual({ pointCurve: [] });
  expect(withCurve({}, "pointCurve", [[255, 255], [0, 0]], entry)).toEqual({ pointCurve: [] });
  expect(withCurve({}, "pointCurve", [[0, 0], [0, 255]], entry)).toEqual({ pointCurve: [] });
  // 读回来时同样把坏数据当「未调整」，面板不会画出用户的编辑。
  expect(filterCurve({ pointCurve: [[128, 128]] }, "pointCurve")).toEqual([]);
  expect(filterCurve({ pointCurve: [[0, 0], [300, 255]] }, "pointCurve")).toEqual([]);
  expect(filterCurve({}, "pointCurve")).toEqual([]);
});

it("点曲线：加点是插值有序的，删除保两端，移动不越过邻居", () => {
  // 没有点时从对角线开始，加点后输入仍然严格递增。
  const added = addCurvePoint([], [128, 90]);
  expect(added).toEqual([[0, 0], [128, 90], [255, 255]]);
  // 与既有输入重复时不动（否则内核按「输入不递增」拒绝整条曲线）。
  expect(addCurvePoint(added, [128, 40])).toEqual(added);
  // 端点不能被删掉：只剩一点的非空曲线会被内核拒绝。
  expect(removeCurvePoint(added, 0)).toEqual(added);
  expect(removeCurvePoint(added, added.length - 1)).toEqual(added);
  expect(removeCurvePoint(added, 1)).toEqual([[0, 0], [255, 255]]);
  // 中间点被邻居夹住，不会产生非法输入序列。
  expect(moveCurvePoint(added, 1, [999, 90])[1]).toEqual([254, 90]);
  expect(moveCurvePoint(added, 1, [-5, 90])[1]).toEqual([1, 90]);
  // 点数上限与内核一致，超限后不再增长。
  let many: [number, number][] = [[0, 0], [255, 255]];
  for (let index = 1; index < 20; index += 1) many = addCurvePoint(many, [index * 12, index * 12]);
  expect(many.length).toBeLessThanOrEqual(16);
  expect(curveUsable(many)).toBe(true);
});

it("HSL 恒为 8 段、分级转盘夹到内核范围", () => {
  const entry = cameraRaw();
  // 少一项或多一项都会被内核按定长数组拒绝：写回时始终补齐到 8 段。
  expect(withHslBand({}, "hslHue", [10, 20], entry).hslHue).toHaveLength(8);
  expect(withHslBand({}, "hslSat", Array.from({ length: 12 }, () => 50), entry).hslSat).toHaveLength(8);
  expect(withHslBand({}, "hslLum", [999, -999], entry).hslLum).toEqual([100, -100, 0, 0, 0, 0, 0, 0]);
  // 坏数据读回来是全 0（= 不调整），不是半组随机值。
  expect(filterHsl({ hslHue: [1, 2, 3] }).hue).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  // 转盘：色相按 360 取模，饱和/明度夹取。
  expect(withWheel({}, "gradeShadows", { hue: 400, sat: 150, lum: -150 }, entry).gradeShadows)
    .toEqual({ hue: 40, sat: 100, lum: -100 });
  expect(filterWheel({ gradeShadows: { hue: -90, sat: 40, lum: 20 } }, "gradeShadows"))
    .toEqual({ hue: 270, sat: 40, lum: 20 });
});

it("curveSplits 恰好三项且保持递增", () => {
  const entry = cameraRaw();
  expect(curveSplits({})).toEqual([25, 50, 75]);
  expect(curveSplits({ curveSplits: [10, 80] })).toEqual([25, 50, 75]);
  expect(withCurveSplits({}, [10, 50, 90], entry).curveSplits).toEqual([10, 50, 90]);
  // 越界被夹回 5–95，避免内核按范围拒绝。
  expect(withCurveSplits({}, [0, 120, 200], entry).curveSplits).toEqual([5, 95, 95]);
});

it("光源组：默认一盏可见灯，增删有上下限，颜色按 RGB 写回", () => {
  const entry = entryOf({ id: "filter.render.lightingEffects", kind: "simple", params: [param("lights", "resource")] });
  const one = addLight([], newLight(), 16);
  expect(one).toHaveLength(1);
  expect(one[0]).toMatchObject({ kind: "spot", intensity: 75, color: [255, 255, 255] });
  // 至少留一盏：空光源组会让内核退回顶层单灯字段，画面完全变样。
  expect(removeLight(one, 0)).toEqual(one);
  // 夹取：位置 0–1、强度 −100–100、锥角 1–89。
  const clamped = moveLight(one, 0, { x: 9, intensity: 900, cone: 0 })[0]!;
  expect(clamped.x).toBe(1);
  expect(clamped.intensity).toBe(100);
  expect(clamped.cone).toBe(1);
  const sent = withLights({}, [{ ...newLight(), color: [12, 34, 56] }], entry);
  expect((sent.lights as FilterLight[])[0]!.color).toEqual([12, 34, 56]);
  // 没声明 lights 的命令不写该字段。
  expect(withLights({}, [newLight()], entryOf({ params: [] }))).not.toHaveProperty("lights");
  // 读：非对象/越界字段被夹取，不会把坏灯送进内核。
  const read = filterLights({ lights: [{ kind: "laser", x: 5, intensity: 500 }, "nope"] });
  expect(read).toHaveLength(1);
  expect(read[0]).toMatchObject({ kind: "spot", x: 1, intensity: 100 });
});

it("透视克隆：坐标按文档像素夹取，缺来源/缺落笔的项直接丢弃", () => {
  const entry = entryOf({ id: "filter.vanishingPoint", kind: "vanishingPoint", params: [param("planes", "resource"), param("clone", "resource")] });
  const size = { width: 200, height: 120 };
  const one = addClone([], size);
  expect(one).toHaveLength(1);
  expect(withClones({}, one, entry).clone).toEqual([
    { source: [25, 21], points: [[50, 42], [80, 42]], size: 40, hardness: 50, opacity: 100 }
  ]);
  // 越界坐标被夹进画布：内核按文档像素取点，越界笔画会被静默略过。
  const moved = setCloneGeometry(one, 0, "source", [-50, 999], size);
  expect(moved[0]!.source).toEqual([0, 120]);
  // 笔尖参数按内核范围夹取。
  expect(setCloneBrush(one, 0, { size: 9999, hardness: -5, opacity: 200 })[0]).toMatchObject({ size: 2000, hardness: 0, opacity: 100 });
  // 缺 source 或缺落笔点的条目要丢掉：保留会让整条命令按「clone N: source」拒绝。
  expect(vanishingClones({ clone: [{ points: [[1, 2]] }, { source: [1, 2] }, { source: [3, 4], points: [[5, 6]] }, "nope"] }))
    .toEqual([{ source: [3, 4], points: [[5, 6]], size: 40, hardness: 50, opacity: 100 }]);
  // 空列表清掉字段，未声明 clone 的命令不写。
  expect(withClones({ clone: [] }, [], entry)).toEqual({});
  expect(withClones({}, one, entryOf({ params: [] }))).not.toHaveProperty("clone");
});

it("透视粘贴：平面号越界/坐标非数值的项丢弃，layer 为空时不留字段", () => {
  const entry = entryOf({ id: "filter.vanishingPoint", kind: "vanishingPoint", params: [param("planes", "resource"), param("paste", "resource")] });
  // 只有 2 个平面时，plane=2 的粘贴会被内核以「no plane 2」拒绝，读的时候就要丢掉。
  expect(vanishingPastes({ paste: [{ plane: 2, at: [0.5, 0.5] }, { plane: 0, at: [0.5, 0.5] }] }, 2))
    .toEqual([{ plane: 0, layer: null, at: [0.5, 0.5], width: 0.5 }]);
  expect(vanishingPastes({ paste: [{ plane: 0 }, { plane: -1, at: [0, 0] }, "nope"] }, 2)).toEqual([]);
  // at 越界夹进 0–1，宽度夹到内核范围的 0.01–10。
  expect(vanishingPastes({ paste: [{ plane: 0, at: [-3, 7], width: 999 }] }, 1)[0])
    .toMatchObject({ at: [0, 1], width: 10 });
  // 剪贴板来源：`layer` 字段必须缺席（内核把 null 当非法类型，缺失才等于剪贴板）。
  const clipboard = withPastes({}, [newPaste(0, null)], entry);
  expect((clipboard.paste as Record<string, unknown>[])[0]).not.toHaveProperty("layer");
  // 指定图层时写 id。
  expect((withPastes({}, [newPaste(1, 7)], entry).paste as Record<string, unknown>[])[0])
    .toMatchObject({ plane: 1, layer: 7, at: [0.5, 0.5], width: 0.5 });
  // 空列表清字段；未声明不写；平面号被夹回可用范围。
  expect(withPastes({ paste: [] }, [], entry)).toEqual({});
  expect(withPastes({}, [newPaste()], entryOf({ params: [] }))).not.toHaveProperty("paste");
  expect(setPaste([newPaste(1, 7)], 0, { plane: 99 }, 2)[0]!.plane).toBe(1);
  expect(addPaste(Array.from({ length: 3 }, () => newPaste()), newPaste(), 3)).toHaveLength(3);
});

it("解码粘贴图层来源：坏行丢掉整块，形状不对返回 null", () => {
  expect(decodeFilterLayerSources({ layers: [
    { id: 3, name: "图层 2", active: true, width: 800, height: 600 },
    { id: -1, name: "坏", width: 1, height: 1 },
    { id: 4, name: 42, width: 1, height: 1 },
    "nope"
  ] })).toEqual([{ id: 3, name: "图层 2", active: true, width: 800, height: 600 }]);
  // 没有 layers 字段 = 端口不可用，不能伪装成「没有图层」。
  expect(decodeFilterLayerSources({})).toBeNull();
  expect(decodeFilterLayerSources(null)).toBeNull();
});

it("火焰路径按名字写回，空值/工作路径等于跟随默认", () => {
  const entry = entryOf({ id: "filter.render.flame", kind: "simple", params: [param("path", "resource")] });
  expect(withFlamePath({}, "路径 1", entry)).toEqual({ path: "路径 1" });
  // 空与 "work" 都是「跟随默认」：写进去只会让内核去找一条叫 work 的已保存路径。
  expect(withFlamePath({ path: "路径 1" }, null, entry)).toEqual({});
  expect(withFlamePath({ path: "路径 1" }, "", entry)).toEqual({});
  expect(flamePath({ path: "路径 1" })).toBe("路径 1");
  expect(flamePath({ path: "work" })).toBeNull();
  expect(flamePath({ path: "" })).toBeNull();
  expect(flamePath({})).toBeNull();
  // 未声明 path 的命令不写该字段。
  expect(withFlamePath({}, "路径 1", entryOf({ params: [] }))).not.toHaveProperty("path");
});

it("解码火焰路径来源：坏名丢弃，形状不对返回 null", () => {
  expect(decodeFilterPathSources({ paths: [{ name: "路径 1" }, { name: "" }, { name: 42 }, "nope"], hasWorkPath: true }))
    .toEqual({ paths: ["路径 1"], hasWorkPath: true });
  expect(decodeFilterPathSources({ paths: [] })).toEqual({ paths: [], hasWorkPath: false });
  // 没有 paths 字段 = 端口不可用，不能伪装成「文档没有路径」。
  expect(decodeFilterPathSources({})).toBeNull();
  expect(decodeFilterPathSources(null)).toBeNull();
});

// ---------------------------------------------------------------- 切变曲线（`points`）

const shear = () => entryOf({
  id: "filter.distort.shear",
  kind: "distort",
  params: [param("amount", "number", { min: -100, max: 100, default: 0 }), param("points", "resource")]
});

it("切变：缺省曲线按 amount 生成三点，与内核一致", () => {
  // 内核在无 `points` 时用 [0,0] [0.5, amount/100] [1,0]；面板显示同一条，用户才知道拖哪。
  expect(defaultShearPoints(0)).toEqual([[0, 0], [0.5, 0], [1, 0]]);
  expect(defaultShearPoints(40)).toEqual([[0, 0], [0.5, 0.4], [1, 0]]);
  // amount 超出 ±100 时按内核的 clamp 收敛，而不是生成越界曲线。
  expect(defaultShearPoints(999)).toEqual([[0, 0], [0.5, 1], [1, 0]]);
  expect(defaultShearPoints(-999)).toEqual([[0, 0], [0.5, -1], [1, 0]]);
});

it("切变：读出曲线时丢掉坏项；乱序或空列表按「没有自定义曲线」处理", () => {
  expect(shearPoints({ points: [[0, 0], [0.5, 0.3], [1, 0]] })).toEqual([[0, 0], [0.5, 0.3], [1, 0]]);
  // 内核要求 x 单调不减；乱序会被整条拒绝，这里回退到 amount 而不是把坏数据送出去。
  expect(shearPoints({ points: [[1, 0], [0, 0]] })).toEqual([]);
  // 非数值条目丢弃；丢完若仍单调可用就保留其余。
  expect(shearPoints({ points: [[0, 0], ["x", 0], [1, 0]] })).toEqual([[0, 0], [1, 0]]);
  expect(shearPoints({ points: [] })).toEqual([]);
  expect(shearPoints({})).toEqual([]);
  expect(shearPoints({ points: "nope" })).toEqual([]);
});

it("切变：曲线可用性与内核的 1–64 点、单调约束一致", () => {
  expect(shearUsable([])).toBe(true);
  expect(shearUsable([[0.5, 0.2]])).toBe(true);
  expect(shearUsable([[0, 0], [0.5, 0.2], [1, 0]])).toBe(true);
  expect(shearUsable([[0, 0], [0, 0.5]])).toBe(true); // 重复 t 会被内核 dedup，不算非法
  expect(shearUsable([[0.5, 0], [0, 0]])).toBe(false);
  const many = Array.from({ length: 65 }, (_, i) => [i / 64, 0] as [number, number]);
  expect(shearUsable(many)).toBe(false);
  expect(shearUsable(many.slice(0, 64))).toBe(true);
});

it("切变：加点保持 t 单调，重复 t 与满额时不动", () => {
  const base: [number, number][] = [[0, 0], [1, 0]];
  expect(addShearPoint(base)).toEqual([[0, 0], [0.5, 0], [1, 0]]);
  // 与既有 t 重合：原样返回，避免「加了点却看不到」。
  expect(addShearPoint(base, [0, 0.5])).toEqual(base);
  // 乱序插入会被排好，内核收到的仍是单调序列。
  const unsorted = addShearPoint([[0, 0], [1, 0]], [0.2, 0.3]);
  expect(unsorted.map(([t]) => t)).toEqual([0, 0.2, 1]);
  const full = Array.from({ length: 64 }, (_, i) => [i / 63, 0] as [number, number]);
  expect(addShearPoint(full, [0.5, 0.1])).toHaveLength(64);
  // 越界的 t 被夹到 1，与既有末点重合，因此原样返回（不会出现两个 t=1 的点）。
  expect(addShearPoint(base, [5, 5])).toEqual(base);
  // 中间插入越界 offset 时只夹 offset，不夹 t。
  expect(addShearPoint(base, [0.5, 5])).toEqual([[0, 0], [0.5, 1], [1, 0]]);
});

it("切变：删点与移点都不破坏约束", () => {
  const three: [number, number][] = [[0, 0], [0.5, 0.3], [1, 0]];
  expect(removeShearPoint(three, 1)).toEqual([[0, 0], [1, 0]]);
  // 只剩一点时保留：内核要求至少一点。
  expect(removeShearPoint([[0.5, 0.2]], 0)).toEqual([[0.5, 0.2]]);
  // 中间点被夹在相邻 t 之间，offset 夹在 ±1。
  expect(moveShearPoint(three, 1, [5, 9])).toEqual([[0, 0], [1, 1], [1, 0]]);
  expect(moveShearPoint(three, 1, [-5, -9])).toEqual([[0, 0], [0, -1], [1, 0]]);
});

it("切变：写回只在声明了 points 时生效，清空即交还 amount", () => {
  const entry = shear();
  expect(withShearPoints({ amount: 20 }, [[0, 0], [0.5, 0.5], [1, 0]], entry)).toMatchObject({
    points: [[0, 0], [0.5, 0.5], [1, 0]]
  });
  // 清空曲线：删掉 points 并把 amount 归零，否则会跳回一个用户没设过的旧形状。
  expect(withShearPoints({ amount: 20, points: [[0, 0], [1, 0]] }, [], entry)).toEqual({ amount: 0 });
  // 不可用曲线也不写成 []：内核会以「需要 1–64 个点」整条拒绝。
  expect(withShearPoints({ amount: 20 }, [[1, 0], [0, 0]], entry)).toEqual({ amount: 0 });
  // 未声明 points 的命令不塞这个字段。
  const noPoints = entryOf({ id: "filter.blur.gaussianBlur", params: [param("amount", "number")] });
  expect(withShearPoints({ amount: 20 }, [[0, 0], [1, 0]], noPoints)).toEqual({ amount: 20 });
});

// ---------------------------------------------------------------- 位移图图层（`mapLayer`）

it("位移图来源带上每份文档的图层，坏图层只丢那一行", () => {
  const decoded = decodeFilterMapSources({
    documents: [
      {
        index: 0,
        name: "位移图.pcraft",
        width: 800,
        height: 600,
        layers: [{ id: 3, name: "上层" }, { id: -1, name: "坏" }, { id: 4, name: "下层" }]
      },
      // 老端口不带 layers：按「没有可用图层」处理，文档本身仍可用。
      { index: 1, name: "底图.pcraft", width: 100, height: 100 }
    ]
  });
  expect(decoded).toEqual([
    { index: 0, name: "位移图.pcraft", width: 800, height: 600, active: false, layers: [{ id: 3, name: "上层" }, { id: 4, name: "下层" }] },
    { index: 1, name: "底图.pcraft", width: 100, height: 100, active: false, layers: [] }
  ]);
});

it("写回位移图图层：没选文档、非法 id 或 null 都删字段", () => {
  const base = { horizontal: 6, vertical: 6, mapDocument: "位移图.pcraft" };
  expect(withMapLayer(base, 3)).toEqual({ ...base, mapLayer: 3 });
  expect(withMapLayer(base, null)).toEqual(base);
  expect(withMapLayer(base, -1)).toEqual(base);
  expect(withMapLayer(base, 1.5)).toEqual(base);
  // 没有位移图文档时保留图层号没有意义（会被拿去别的文档里找图层）。
  expect(withMapLayer({ horizontal: 6 }, 3)).toEqual({ horizontal: 6 });
  expect(base).toEqual({ horizontal: 6, vertical: 6, mapDocument: "位移图.pcraft" });
});

it("读出位移图图层：只认非负整数", () => {
  expect(mapLayerOf({ mapLayer: 3 })).toBe(3);
  expect(mapLayerOf({ mapLayer: 0 })).toBe(0);
  expect(mapLayerOf({ mapLayer: "3" })).toBeNull();
  expect(mapLayerOf({ mapLayer: -2 })).toBeNull();
  expect(mapLayerOf({})).toBeNull();
});
