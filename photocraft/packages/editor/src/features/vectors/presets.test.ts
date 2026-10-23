import { describe, expect, it } from "vitest";
import {
  MAX_CUSTOM_SHAPES,
  MAX_PRESET_KNOTS,
  MAX_PRESET_NAME,
  MAX_PRESET_SUBPATHS,
  MAX_SNAPSHOT_BYTES,
  decodeLibrary,
  defineCustomShapeParams,
  libraryEntries,
  matchesDigest,
  newPresetParams,
  placePresetParams,
  presetEditParams,
  restoreSnapshotParams,
  snapshotWithinBudget,
} from "./presets.js";
import { cornerKnot } from "./pen-tools.js";

const library = {
  groups: [{ name: "基本形状", shapes: [{ name: "矩形", digest: "0123456789abcdef", subpaths: 1 }] }],
  custom: [{ name: "箭头", digest: "fedcba9876543210", subpaths: 2 }],
  revision: 3,
};

describe("形状库解码（U16）", () => {
  it("解码内置组与自定形状，并展开成选择器条目", () => {
    const decoded = decodeLibrary(library)!;
    expect(decoded.groups[0]!.shapes[0]).toEqual({ name: "矩形", digest: "0123456789abcdef", subpaths: 1 });
    expect(libraryEntries(decoded)).toEqual([
      { group: "基本形状", entry: { name: "矩形", digest: "0123456789abcdef", subpaths: 1 }, custom: false },
      { group: "自定形状", entry: { name: "箭头", digest: "fedcba9876543210", subpaths: 2 }, custom: true },
    ]);
  });

  it("结构不符或越界返回 null，调用方保留上一份有效库", () => {
    expect(decodeLibrary(null)).toBeNull();
    expect(decodeLibrary({ groups: [] })).toBeNull();
    expect(decodeLibrary({ groups: [], custom: [{ name: " ", subpaths: 0 }] })).toBeNull();
    expect(decodeLibrary({ groups: [], custom: [{ name: "x", subpaths: 0, digest: "not-a-digest" }] })).toBeNull();
    expect(decodeLibrary({ groups: [], custom: [{ name: "x" }] })).toBeNull();
    expect(decodeLibrary({ groups: [], custom: [{ name: "x", subpaths: -1 }] })).toBeNull();
    expect(decodeLibrary({ groups: [], custom: [{ name: "x".repeat(MAX_PRESET_NAME + 1), subpaths: 0 }] })).toBeNull();
    expect(decodeLibrary({ groups: [{ name: "g", shapes: [{ name: "x", subpaths: 0 }] }], custom: [], revision: -1 })).toBeNull();
    expect(decodeLibrary({ groups: [], custom: new Array(MAX_CUSTOM_SHAPES + 1).fill({ name: "x", subpaths: 0 }) })).toBeNull();
  });

  it("空库与省略 revision 仍然有效", () => {
    expect(decodeLibrary({ groups: [], custom: [] })).toEqual({ groups: [], custom: [] });
  });
});

describe("预设参数编译", () => {
  it("放置预设要求名称与正矩形", () => {
    expect(placePresetParams("星形", [0, 0, 40, 30], { group: "基本形状", keepAspect: true, fill: "#112233" }))
      .toEqual({ preset: "星形", rect: [0, 0, 40, 30], group: "基本形状", keepAspect: true, fill: "#112233" });
    expect(() => placePresetParams(" ", [0, 0, 1, 1])).toThrow(/预设/);
    expect(() => placePresetParams("x", [0, 0, 0, 1])).toThrow(/大于 0/);
    expect(() => placePresetParams("x", [0, 0, 1, Number.NaN])).toThrow(/有限数值/);
  });

  it("库编辑动作校验名称与分组", () => {
    expect(presetEditParams({ action: "delete", preset: "x" })).toEqual({ action: "delete", preset: "x" });
    expect(() => presetEditParams({ action: "rename", preset: "x", name: "  " })).toThrow(/名称/);
    expect(() => presetEditParams({ action: "move", preset: "x", to: " " })).toThrow(/目标分组/);
    expect(() => presetEditParams({ action: "newGroup", name: "y".repeat(MAX_PRESET_NAME + 1) })).toThrow(/名称/);
  });

  it("从路径定义形状与另存预设保持名称有界", () => {
    expect(defineCustomShapeParams("  箭头 ")).toEqual({ name: "箭头" });
    expect(defineCustomShapeParams("箭头", "工作路径")).toEqual({ name: "箭头", path: "工作路径" });
    expect(() => defineCustomShapeParams("   ")).toThrow(/名称/);
    expect(() => defineCustomShapeParams("y".repeat(MAX_PRESET_NAME + 1))).toThrow(/200/);
    expect(newPresetParams(" 星星 ", { group: "自定", path: "work" })).toEqual({ name: "星星", group: "自定", path: "work" });
    expect(() => newPresetParams("")).toThrow(/预设名称/);
  });

  it("快照字节预算按 1 MiB 裁定", () => {
    expect(MAX_SNAPSHOT_BYTES).toBe(1 << 20);
    expect(snapshotWithinBudget("x".repeat(MAX_SNAPSHOT_BYTES))).toBe(true);
    expect(snapshotWithinBudget("x".repeat(MAX_SNAPSHOT_BYTES + 1))).toBe(false);
  });
});

describe("快照恢复（原子替换）", () => {
  const path = { subpaths: [{ closed: false, knots: [cornerKnot([0, 0]), cornerKnot([10, 10])] }] };

  it("合法快照整批通过并裁掉名称两侧空白", () => {
    expect(restoreSnapshotParams([{ name: " 箭头 ", path }])).toEqual([{ name: "箭头", path }]);
  });

  it("任一条目非法即整体拒绝，不产生半个月库", () => {
    expect(() => restoreSnapshotParams(null)).toThrow(/数组/);
    expect(() => restoreSnapshotParams([{ name: "a", path }, { name: "a", path }])).toThrow(/重复/);
    expect(() => restoreSnapshotParams([{ name: "a", path }, { name: "b", path: { subpaths: [] } }])).toThrow(/路径无效/);
    expect(() => restoreSnapshotParams([{ name: "a", path: { subpaths: [{ knots: [] }] } }])).toThrow(/缺少锚点/);
    expect(() => restoreSnapshotParams([{ name: "a", path: { subpaths: [{ knots: [[1e9, 0]] }] } }])).toThrow(/坐标非法/);
    expect(() => restoreSnapshotParams([{ name: "a", path: { subpaths: [{ knots: [{ anchor: [0, 0], out: [Number.NaN, 0] }] }] } }])).toThrow(/坐标非法/);
    expect(() => restoreSnapshotParams([{ name: "a", path: { subpaths: [{ knots: [[0, 0]] }] } }, { name: "b" }])).toThrow(/路径无效/);
    const tooMany = new Array(MAX_CUSTOM_SHAPES + 1).fill({ name: "a", path });
    expect(() => restoreSnapshotParams(tooMany.map((entry, index) => ({ ...entry, name: `n${index}` })))).toThrow(/上限/);
    const heavy = { subpaths: new Array(300).fill({ knots: new Array(MAX_PRESET_KNOTS).fill({ anchor: [0, 0] }) }) };
    expect(() => restoreSnapshotParams([{ name: "a", path: heavy }])).toThrow(/路径无效/);
  });

  it("摘要只用于核对已应用形状，不是身份权威", () => {
    expect(matchesDigest({ name: "矩形", digest: "0123456789abcdef" }, "0123456789abcdef")).toBe(true);
    expect(matchesDigest({ name: "矩形", digest: "0123456789abcdef" }, "0000000000000000")).toBe(false);
    expect(matchesDigest(undefined, "0123456789abcdef")).toBe(false);
  });

  it("组名只在真实分组时下发（自定形状是合成组，带组名会被内核判为找不到）", () => {
    // 内置组：带 group，内核据此收窄查找。
    expect(presetEditParams({ action: "delete", preset: "Star", group: "Symbols" }))
      .toEqual({ action: "delete", preset: "Star", group: "Symbols" });
    // 自定形状：不带 group。
    expect(presetEditParams({ action: "rename", preset: "箭头", name: "箭头2" }))
      .toEqual({ action: "rename", preset: "箭头", name: "箭头2" });
  });

  it("库编辑的拒绝条件在提交前裁定", () => {
    expect(() => presetEditParams({ action: "rename", preset: "a", name: "   " })).toThrow(/不能为空/);
    expect(() => presetEditParams({ action: "rename", preset: "a", name: "x".repeat(MAX_PRESET_NAME + 1) })).toThrow(/200/);
    expect(() => presetEditParams({ action: "move", preset: "a", to: "  " })).toThrow(/目标分组/);
    expect(() => presetEditParams({ action: "move", preset: "a", to: "Symbols", group: "Symbols" })).toThrow(/相同/);
    expect(() => presetEditParams({ action: "newGroup", name: "" })).toThrow(/不能为空/);
    expect(() => presetEditParams({ action: "deleteGroup", group: " " })).toThrow(/选择要删除的分组/);
  });

  it("几何裁定委托协议解码器，库级预算仍在本域", () => {
    // 结构/坐标由 `vectorPathWithinBudget` 裁定：对象锚点缺 `anchor` 一律拒绝。
    expect(() => restoreSnapshotParams([{ name: "a", path: { subpaths: [{ knots: [{ out: [1, 1] }] }] } }]))
      .toThrow(/缺少锚点坐标/);
    // 预设专属上限（256 子路径）比通用路径预算（4096）更严，必须在这里裁定。
    const many = { subpaths: new Array(MAX_PRESET_SUBPATHS + 1).fill({ knots: [[0, 0], [1, 1]] }) };
    expect(() => restoreSnapshotParams([{ name: "a", path: many }])).toThrow(/路径无效/);
    // 恰好 256 个子路径仍然合法——边界不能被写成「小于」。
    const exact = { subpaths: new Array(MAX_PRESET_SUBPATHS).fill({ knots: [[0, 0], [1, 1]] }) };
    expect(restoreSnapshotParams([{ name: "a", path: exact }])).toHaveLength(1);
  });
});
