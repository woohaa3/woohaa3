import { describe, expect, it } from "vitest";
import {
  addAnchorParams,
  applySelection,
  bendSegmentParams,
  commandForDrag,
  convertPointParams,
  deleteAnchorParams,
  dragOffset,
  hitTest,
  usablePath,
  type EditablePath,
  type PathHit,
} from "./path-edit.js";

const path: EditablePath = {
  subpaths: [
    {
      closed: false,
      knots: [
        { anchor: [0, 0] },
        { anchor: [100, 0], in: [90, -10], out: [110, 10], smooth: true },
        { anchor: [100, 100] },
      ],
    },
  ],
};

const anchor = (subpath: number, knot: number, distance = 0): PathHit => ({ subpath, knot, kind: "anchor", distance });

describe("路径命中（U12）", () => {
  it("只在换算后的源像素阈值内命中，且锚点优先于手柄", () => {
    expect(hitTest(path, [100.5, 0.2], 6, 1)).toMatchObject({ subpath: 0, knot: 1, kind: "anchor" });
    // 缩放 2 倍时源像素阈值减半：3 px 的偏移在 6 px 屏幕阈值内仍可命中。
    expect(hitTest(path, [103, 0], 6, 2)).toMatchObject({ kind: "anchor" });
    expect(hitTest(path, [103, 0], 6, 4)).toBeNull();
    expect(hitTest(path, [110, 10], 6, 1)).toMatchObject({ kind: "out", knot: 1 });
  });

  it("收回的控制柄不抢锚点命中", () => {
    const flat: EditablePath = { subpaths: [{ knots: [{ anchor: [5, 5], in: [5, 5], out: [5, 5] }] }] };
    expect(hitTest(flat, [5, 5], 6, 1)).toMatchObject({ kind: "anchor" });
  });

  it("多选：替换、加选与减选，且手柄不进入锚点选择", () => {
    expect(applySelection([anchor(0, 0)], anchor(0, 2))).toEqual([anchor(0, 2)]);
    expect(applySelection([anchor(0, 0)], anchor(0, 2), "add")).toEqual([anchor(0, 0), anchor(0, 2)]);
    expect(applySelection([anchor(0, 0), anchor(0, 2)], anchor(0, 0), "subtract")).toEqual([anchor(0, 2)]);
    expect(applySelection([anchor(0, 0)], anchor(0, 2), "add")).toHaveLength(2);
    expect(applySelection([anchor(0, 0)], anchor(0, 0), "add")).toHaveLength(1);
    expect(applySelection([anchor(0, 0)], { subpath: 0, knot: 1, kind: "out", distance: 0 }, "replace")).toEqual([]);
    expect(applySelection([anchor(0, 0)], null, "add")).toEqual([anchor(0, 0)]);
  });
});

describe("路径拖动与参数编译", () => {
  it("锚点拖动批量提交多选锚点的位移", () => {
    const drag = { hit: anchor(0, 1), from: [100, 0] as const, to: [120, 5] as const };
    expect(dragOffset(drag)).toEqual([20, 5]);
    const command = commandForDrag(drag, { name: "work" }, [anchor(0, 0), anchor(0, 2)]);
    expect(command.id).toBe("path.moveAnchors");
    expect(command.params).toEqual({ name: "work", anchors: [[0, 0], [0, 2]], move: [20, 5] });
    // 没有多选时只移动被拖的那个锚点。
    expect(commandForDrag(drag, { name: "work" }).params).toEqual({ name: "work", anchors: [[0, 1]], move: [20, 5] });
  });

  it("手柄拖动提交绝对目标坐标与目标路径定位", () => {
    const command = commandForDrag({ hit: { subpath: 0, knot: 1, kind: "out", distance: 1 }, from: [110, 10], to: [130, 20] }, { name: "layer", layer: 7 });
    expect(command.id).toBe("path.moveHandle");
    expect(command.params).toEqual({ name: "layer", layer: 7, subpath: 0, knot: 1, handle: "out", to: [130, 20] });
  });

  it("增删锚点、平滑尖角转换与弯折只改预期节点", () => {
    expect(addAnchorParams({ name: "work" }, anchor(0, 1)).params).toMatchObject({ subpath: 0, knot: 1, t: 0.5 });
    expect(() => addAnchorParams({ name: "work" }, anchor(0, 1), 0)).toThrow(/严格在 0 与 1 之间/);
    expect(deleteAnchorParams({ name: "layer", layer: 3 }, anchor(0, 2)).params).toEqual({ name: "layer", layer: 3, subpath: 0, knot: 2 });
    // 不带 out = 转尖角；带 out = 转平滑并镜像入向柄；curvature = 按当前状态双向翻转。
    expect(convertPointParams({ name: "work" }, anchor(0, 1)).params).toEqual({ name: "work", subpath: 0, knot: 1 });
    expect(convertPointParams({ name: "work" }, anchor(0, 1), [140, 40]).params).toMatchObject({ out: [140, 40] });
    expect(convertPointParams({ name: "work" }, anchor(0, 1), undefined, { curvature: true }).params)
      .toEqual({ name: "work", subpath: 0, knot: 1, curvature: true });
    expect(bendSegmentParams({ name: "work" }, anchor(0, 0), [3, 4], 0.25).params).toMatchObject({ t: 0.25, move: [3, 4] });
  });

  it("只有至少两个锚点的子路径可作为形状/蒙版来源", () => {
    expect(usablePath(path)).toBe(true);
    expect(usablePath({ subpaths: [{ knots: [{ anchor: [0, 0] }] }] })).toBe(false);
    expect(usablePath({ subpaths: [] })).toBe(false);
  });
});
