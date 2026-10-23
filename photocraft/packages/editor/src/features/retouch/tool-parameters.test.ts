import { expect, it } from "vitest";
import {
  CLONE_SOURCE_SLOTS,
  DEFAULT_REGION_OPTIONS,
  DEFAULT_RETOUCH_OPTIONS,
  RETOUCH_COMMANDS,
  clampRegionOptions,
  clampRetouchOptions,
  cloneOverlayParams,
  cloneSourceSetParams,
  decodeCloneSources,
  decodeHistorySources,
  describeRetouchFailure,
  isRegionRetouchCommand,
  regionParams,
  retouchStrokeParams,
  validateRegionGesture,
  validateRetouchOptions
} from "./tool-parameters.js";
import { DEFAULT_BRUSH } from "../painting/tool-parameters.js";

it("registers every U37/U38/U39 command with a gesture and an option group", () => {
  const ids = RETOUCH_COMMANDS.map((entry) => entry.id);
  for (const id of [
    "paint.patch",
    "paint.contentAwareMove",
    "paint.remove",
    "paint.redEye",
    "paint.patternStamp",
    "paint.historyBrush",
    "paint.dodge",
    "paint.burn",
    "paint.sponge"
  ]) {
    expect(ids).toContain(id);
  }
  expect(RETOUCH_COMMANDS.filter((entry) => entry.gesture === "region").map((entry) => entry.id))
    .toEqual(["paint.patch", "paint.contentAwareMove", "paint.redEye"]);
  expect(isRegionRetouchCommand("paint.patch")).toBe(true);
  expect(isRegionRetouchCommand("paint.patternStamp")).toBe(false);
});

it("sends saturate/desaturate for the sponge instead of the shared blend mode", () => {
  const sponge = retouchStrokeParams("paint.sponge", [{ x: 4, y: 4 }], DEFAULT_BRUSH, { ...DEFAULT_RETOUCH_OPTIONS, spongeMode: "saturate" });
  expect(sponge).toMatchObject({ mode: "saturate", vibrance: true });
  // 覆盖通用模板写入的 mode:"normal"（上轮实测会让编辑器落进错误边界）。
  const base = retouchStrokeParams("paint.sponge", [{ x: 1, y: 1 }], DEFAULT_BRUSH, DEFAULT_RETOUCH_OPTIONS);
  expect(base?.mode).toBe("desaturate");
  expect(base?.mode).not.toBe("normal");
});

it("maps tone range, exposure, strength and pattern options onto kernel parameter names", () => {
  const dodge = retouchStrokeParams("paint.dodge", [{ x: 2, y: 3 }], DEFAULT_BRUSH, {
    ...DEFAULT_RETOUCH_OPTIONS,
    toneRange: "highlights",
    exposure: 70,
    protectTones: false
  });
  expect(dodge).toMatchObject({ range: "highlights", exposure: 70, protectTones: false });
  expect(dodge).not.toHaveProperty("toneRange");
  const pattern = retouchStrokeParams("paint.patternStamp", [{ x: 2, y: 3 }], DEFAULT_BRUSH, {
    ...DEFAULT_RETOUCH_OPTIONS,
    patternId: "weave",
    patternScale: 220,
    patternAngle: 30,
    patternAligned: false,
    patternImpressionist: true
  });
  expect(pattern).toMatchObject({ pattern: "weave", scale: 220, angle: 30, aligned: false, impressionist: true });
  const smudge = retouchStrokeParams("paint.smudge", [{ x: 2, y: 3 }], DEFAULT_BRUSH, {
    ...DEFAULT_RETOUCH_OPTIONS,
    strength: 80,
    fingerPainting: true
  });
  expect(smudge).toMatchObject({ strength: 80, fingerPainting: true });
  const history = retouchStrokeParams("paint.historyBrush", [{ x: 2, y: 3 }], DEFAULT_BRUSH, {
    ...DEFAULT_RETOUCH_OPTIONS,
    historyState: 3
  });
  expect(history).toMatchObject({ state: 3 });
});

it("freezes clone sampling and transform into the stroke parameters", () => {
  const params = retouchStrokeParams("paint.cloneStamp", [{ x: 5, y: 6 }], DEFAULT_BRUSH, {
    ...DEFAULT_RETOUCH_OPTIONS,
    sampleLayer: "currentAndBelow"
  }, {
    layer: 7,
    source: [20, 21],
    anchor: [5, 6],
    aligned: false,
    transform: { scale: [200, 150], rotation: 30, flipH: true, flipV: false }
  });
  expect(params).toMatchObject({
    layer: 7,
    sampleLayer: "currentAndBelow",
    source: [20, 21],
    anchor: [5, 6],
    aligned: false,
    scale: [200, 150],
    rotation: 30,
    flipH: true,
    flipV: false
  });
});

it("rejects out-of-range tool parameters before any kernel call", () => {
  expect(validateRetouchOptions("paint.dodge", { ...DEFAULT_RETOUCH_OPTIONS, exposure: 0 })).toContain("曝光");
  expect(validateRetouchOptions("paint.sponge", { ...DEFAULT_RETOUCH_OPTIONS, spongeMode: "normal" as never })).toContain("加色");
  expect(validateRetouchOptions("paint.patternStamp", { ...DEFAULT_RETOUCH_OPTIONS, patternScale: 0 })).toContain("缩放");
  expect(validateRetouchOptions("paint.smudge", { ...DEFAULT_RETOUCH_OPTIONS, strength: 101 })).toContain("强度");
  expect(validateRetouchOptions("paint.historyBrush", { ...DEFAULT_RETOUCH_OPTIONS, historyState: -1 })).toContain("历史源");
  expect(retouchStrokeParams("paint.dodge", [{ x: 1, y: 1 }], DEFAULT_BRUSH, { ...DEFAULT_RETOUCH_OPTIONS, exposure: 0 })).toBeNull();
  // 钳制而不是把越界值送进内核
  expect(clampRetouchOptions({ exposure: 0, strength: 1000, patternScale: 5000 }).exposure).toBe(1);
  expect(clampRetouchOptions({ exposure: 0, strength: 1000, patternScale: 5000 }).strength).toBe(100);
  expect(clampRetouchOptions({ exposure: 0, strength: 1000, patternScale: 5000 }).patternScale).toBe(1000);
});

it("builds region parameters only for a complete gesture", () => {
  const noOffset = regionParams("paint.patch", DEFAULT_REGION_OPTIONS, { offset: null });
  expect(noOffset).toBeNull();
  expect(validateRegionGesture("paint.patch", DEFAULT_REGION_OPTIONS, { offset: null })).toContain("偏移");
  const patch = regionParams("paint.patch", { ...DEFAULT_REGION_OPTIONS, patchMode: "destination", structure: 6, color: 2.5 }, { offset: [10, -4], layer: 3 });
  expect(patch).toMatchObject({ offset: [10, -4], mode: "destination", structure: 6, color: 2.5, layer: 3 });
  const move = regionParams("paint.contentAwareMove", { ...DEFAULT_REGION_OPTIONS, moveMode: "extend", scaleX: 150, rotate: 15 }, { offset: [0, 8] });
  expect(move).toMatchObject({ offset: [0, 8], mode: "extend", scaleX: 150, scaleY: 100, rotate: 15 });
  // 红眼是点集，不是拖动：没有点就不能开始。
  expect(validateRegionGesture("paint.redEye", DEFAULT_REGION_OPTIONS, { points: [] })).toContain("红眼");
  const redEye = regionParams("paint.redEye", { ...DEFAULT_REGION_OPTIONS, redEyePupilSize: 60, redEyeDarken: 80 }, { points: [[4, 5], [8, 9]], layer: 2 });
  expect(redEye).toMatchObject({ layer: 2, points: [[4, 5], [8, 9]], pupilSize: 60, darken: 80 });
  expect(clampRegionOptions({ structure: 9, color: 20 }).structure).toBe(7);
  expect(clampRegionOptions({ structure: 9, color: 20 }).color).toBe(10);
});

it("decodes history sources and clone slots without inventing entries", () => {
  const sources = decodeHistorySources({
    states: [
      { index: 0, label: "打开", current: false, available: false },
      { index: 1, label: "减淡", current: true, available: true },
      { index: 2, label: "缺索引" }
    ],
    layer: 4
  });
  expect(sources).toEqual([
    { index: 0, label: "打开", current: false, available: false },
    { index: 1, label: "减淡", current: true, available: true },
    { index: 2, label: "缺索引", current: false, available: false }
  ]);
  expect(decodeHistorySources({ states: "nope" })).toEqual([]);
  const clones = decodeCloneSources({
    active: 2,
    sources: [
      { index: 0, source: [1, 2], anchor: null, offset: [1, 2], layer: 3, width: 200, height: 100, linked: true, rotation: 30, flipH: true, flipV: false },
      { index: 1, source: null }
    ],
    // 读取的是内核 serde 输出（snake_case）；写回用命令参数的 camelCase（见 cloneOverlayParams）。
    overlay: { show: false, opacity: 40, clipped: false, auto_hide: false, invert: true, blend: "difference" }
  });
  expect(clones?.active).toBe(2);
  expect(clones?.slots[0]).toMatchObject({ index: 0, source: [1, 2], width: 200, rotation: 30, flipH: true, linked: true });
  expect(clones?.slots[1]).toMatchObject({ index: 1, source: null, width: 100, rotation: 0 });
  expect(clones?.overlay).toMatchObject({ show: false, opacity: 40, clipped: false, autoHide: false, invert: true, blend: "difference" });
  expect(decodeCloneSources({ active: 0 })).toBeNull();
  expect(cloneSourceSetParams(9, { width: 4000, rotation: 400, flipV: true })).toMatchObject({ index: CLONE_SOURCE_SLOTS - 1, width: 1000, rotation: 180, flipV: true });
  expect(cloneOverlayParams({ opacity: 400, blend: "darken" })).toEqual({ opacity: 100, blend: "darken" });
});

it("describes a kernel failure without losing the specific reason", () => {
  expect(describeRetouchFailure({ ok: false, code: "retouch-active", message: "请先确认或取消当前修饰操作" }))
    .toBe("请先确认或取消当前修饰操作");
  expect(describeRetouchFailure({ ok: false, code: "retouch-active", message: "" })).toContain("修饰");
  expect(describeRetouchFailure({ ok: false, code: "no-document", message: "" })).toContain("文档");
});
