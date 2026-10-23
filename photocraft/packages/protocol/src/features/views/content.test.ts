/**
 * 视图/分析数据有界契约测试（U70–U73，change:
 * `2026-10-22-add-photocraft-view-workspace-workflows`）。
 *
 * 覆盖：
 * - 旧工程兼容：缺省字段一律合法且视为空；
 * - 参考线：每轴数量、坐标、颜色条目必须与真实参考线对应；
 * - 测量比例/标尺线/计数分组：非正长度、越界坐标、尺寸与活动索引；
 * - 注释：数量、文本/作者长度与位置；
 * - `viewDocumentDataProblem` 返回具体字段名而不是笼统失败。
 *
 * 上限与 Rust `photocraft-project-verify` 的 `features/views` 常量一致，两边必须同时改动。
 */
import { describe, expect, it } from "vitest";
import {
  VIEW_DATA_LIMITS,
  isEmptyViewDocumentData,
  validCountGroups,
  validGuideSet,
  validMeasurementScale,
  validNotes,
  validRuler,
  viewDocumentDataProblem,
  type ViewCountGroup,
  type ViewDocumentData,
  type ViewNote
} from "./content.js";

const group = (overrides: Partial<ViewCountGroup> = {}): ViewCountGroup => ({
  name: "组 1",
  color: [255, 0, 0],
  markerSize: 4,
  labelSize: 12,
  visible: true,
  points: [[1, 2]],
  ...overrides
});

const note = (overrides: Partial<ViewNote> = {}): ViewNote => ({
  author: "美术",
  color: [255, 255, 0],
  text: "补光",
  position: [4, 5],
  popup: [24, 25, 264, 165],
  open: true,
  modified: "2026-10-22T00:00:00Z",
  ...overrides
});

describe("视图数据的有界契约", () => {
  it("缺省与空值视为合法的旧工程数据", () => {
    expect(viewDocumentDataProblem(undefined)).toBeNull();
    expect(viewDocumentDataProblem({})).toBeNull();
    expect(viewDocumentDataProblem({ guides: {}, notes: [] })).toBeNull();
    expect(isEmptyViewDocumentData(undefined)).toBe(true);
    expect(isEmptyViewDocumentData({})).toBe(true);
    expect(isEmptyViewDocumentData({ guides: {}, rulerOrigin: [0, 0], notes: [] })).toBe(true);
    expect(isEmptyViewDocumentData({ measurement: { scale: { pixelLength: 2, logicalLength: 2, units: "pixels" } } })).toBe(true);
  });

  it("参考线数量、坐标与颜色索引必须自洽", () => {
    expect(validGuideSet(null)).toBe(true);
    expect(validGuideSet({ horizontal: [10, -20.5], vertical: [0] })).toBe(true);
    expect(validGuideSet({ horizontal: [Number.NaN] })).toBe(false);
    expect(validGuideSet({ horizontal: [VIEW_DATA_LIMITS.maxCoordinate + 1] })).toBe(false);
    expect(validGuideSet({ horizontal: new Array(VIEW_DATA_LIMITS.maxGuidesPerAxis + 1).fill(1) })).toBe(false);
    // 颜色按「方向 + 位置」索引参考线，指向不存在的线视为数据自相矛盾。
    expect(validGuideSet({ horizontal: [10], colors: [{ vertical: false, position: 10, rgb: [1, 2, 3] }] })).toBe(true);
    expect(validGuideSet({ horizontal: [10], colors: [{ vertical: true, position: 10, rgb: [1, 2, 3] }] })).toBe(false);
    expect(validGuideSet({ horizontal: [10], colors: [{ vertical: false, position: 10, rgb: [1, 2, 300] }] })).toBe(false);
    expect(viewDocumentDataProblem({ guides: { vertical: [Number.POSITIVE_INFINITY] } })).toBe("guides");
  });

  it("测量比例要求两段长度为正且单位非空有界", () => {
    expect(validMeasurementScale(undefined)).toBe(true);
    expect(validMeasurementScale({ pixelLength: 72, logicalLength: 25.4, units: "mm" })).toBe(true);
    expect(validMeasurementScale({ pixelLength: 0, logicalLength: 1, units: "mm" })).toBe(false);
    expect(validMeasurementScale({ pixelLength: 1, logicalLength: -1, units: "mm" })).toBe(false);
    expect(validMeasurementScale({ pixelLength: 1, logicalLength: 1, units: "   " })).toBe(false);
    expect(validMeasurementScale({ pixelLength: 1, logicalLength: 1, units: "x".repeat(VIEW_DATA_LIMITS.maxUnitChars + 1) })).toBe(false);
    expect(viewDocumentDataProblem({ measurement: { scale: { pixelLength: 0, logicalLength: 1, units: "mm" } } })).toBe("measurement");
  });

  it("标尺线两端与量角器点都在画布坐标域内", () => {
    expect(validRuler(undefined)).toBe(true);
    expect(validRuler({ start: [0, 0], end: [10, 10] })).toBe(true);
    expect(validRuler({ start: [0, 0], end: [10, 10], protractor: null })).toBe(true);
    expect(validRuler({ start: [0, Number.NaN], end: [1, 1] })).toBe(false);
    expect(validRuler({ start: [0, 0], end: [1, 1], protractor: [2] as unknown as [number, number] })).toBe(false);
    expect(viewDocumentDataProblem({ measurement: { ruler: { start: [0, 0], end: [1, 1e9] } } })).toBe("measurement");
  });

  it("计数分组逐组尺寸有界、合计标记不超预算、活动索引指向真实分组", () => {
    expect(validCountGroups(undefined)).toBe(true);
    expect(validCountGroups([group(), group({ name: "组 2", points: [] })], 1)).toBe(true);
    expect(validCountGroups([group({ markerSize: VIEW_DATA_LIMITS.minMarkerSize - 1 })])).toBe(false);
    expect(validCountGroups([group({ markerSize: VIEW_DATA_LIMITS.maxMarkerSize + 1 })])).toBe(false);
    expect(validCountGroups([group({ labelSize: VIEW_DATA_LIMITS.maxLabelSize + 1 })])).toBe(false);
    expect(validCountGroups([group({ name: "x".repeat(VIEW_DATA_LIMITS.maxCountGroupNameChars + 1) })])).toBe(false);
    expect(validCountGroups([group({ points: [[0, Number.NaN]] })])).toBe(false);
    expect(validCountGroups([group(), group()], 2)).toBe(false);
    expect(validCountGroups([group()], 0)).toBe(true);
    const tooManyGroups = Array.from({ length: VIEW_DATA_LIMITS.maxCountGroups + 1 }, () => group({ points: [] }));
    expect(validCountGroups(tooManyGroups, 0)).toBe(false);
    expect(viewDocumentDataProblem({ measurement: { countGroups: [group({ markerSize: 0 })] } })).toBe("measurement");
  });

  it("注释数量、作者/文本长度与位置有界", () => {
    expect(validNotes(undefined)).toBe(true);
    expect(validNotes([note(), note({ open: false })])).toBe(true);
    // 注释允许落在画布外（用户可能先放便签再挪画布）。
    expect(validNotes([note({ position: [-40, -40] })])).toBe(true);
    expect(validNotes([note({ author: "a".repeat(VIEW_DATA_LIMITS.maxNoteAuthorChars + 1) })])).toBe(false);
    expect(validNotes([note({ text: "字".repeat(VIEW_DATA_LIMITS.maxNoteTextChars + 1) })])).toBe(false);
    expect(validNotes([note({ position: [0, Number.POSITIVE_INFINITY] })])).toBe(false);
    expect(validNotes([note({ popup: [0, 0, 1] as unknown as [number, number, number, number] })])).toBe(false);
    expect(validNotes(new Array(VIEW_DATA_LIMITS.maxNotes + 1).fill(note()))).toBe(false);
    expect(viewDocumentDataProblem({ notes: [note({ open: "yes" as unknown as boolean })] })).toBe("notes");
  });

  it("超预算的标记数组在逐点校验前按长度拒绝（解码前累计预算）", () => {
    // 稀疏数组：旧实现会跳过空洞逐点校验，先遍历一遍再判预算。这里要求预算先于解码生效。
    const sparse = new Array(VIEW_DATA_LIMITS.maxCountMarkers + 1) as unknown as [number, number][];
    expect(validCountGroups([group({ points: sparse })])).toBe(false);
    // 恰好用完预算仍然合法（上限是包含的）。
    const exact = Array.from({ length: VIEW_DATA_LIMITS.maxCountMarkers }, () => [1, 2] as [number, number]);
    expect(validCountGroups([group({ points: exact })])).toBe(true);
    const overBudget = [...exact, [3, 4] as [number, number]];
    expect(validCountGroups([group({ points: overBudget })])).toBe(false);
  });

  it("上限与 Rust 核验常量逐项一致（改一处必须同时改另一处）", () => {
    // 对照 `rust/crates/project-verify/src/features/views/mod.rs` 的公开常量。
    expect(VIEW_DATA_LIMITS).toEqual({
      maxGuidesPerAxis: 4096,
      maxCoordinate: 1.0e7,
      maxCountGroups: 256,
      maxCountMarkers: 100_000,
      maxNotes: 1024,
      maxNoteAuthorChars: 256,
      maxNoteTextChars: 64 * 1024,
      maxUnitChars: 32,
      maxCountGroupNameChars: 256,
      minMarkerSize: 1,
      maxMarkerSize: 10,
      minLabelSize: 8,
      maxLabelSize: 72,
    });
  });

  it("非空视图数据不会被误判为旧工程空值", () => {
    const data: ViewDocumentData = {
      guides: { horizontal: [10], vertical: [], colors: [] },
      rulerOrigin: [5, 5],
      measurement: {
        scale: { pixelLength: 72, logicalLength: 25.4, units: "mm" },
        countGroups: [group()],
        activeCountGroup: 0,
        ruler: { start: [0, 0], end: [10, 10] }
      },
      notes: [note()]
    };
    expect(viewDocumentDataProblem(data)).toBeNull();
    expect(isEmptyViewDocumentData(data)).toBe(false);
    expect(isEmptyViewDocumentData({ guides: { horizontal: [10] } })).toBe(false);
    expect(isEmptyViewDocumentData({ notes: [note()] })).toBe(false);
  });
});
