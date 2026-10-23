import { describe, expect, it } from "vitest";
import { addKnot, canFinish, closeDraft, continueFrom, cornerKnot, curvatureParams, emptyDraft, finishDraft, freehandDraft, knotCount, pathSetParams, removeKnot, smoothKnot, type PenPath } from "./pen-tools.js";

describe("钢笔草稿（U11）", () => {
  it("默认角点：控制柄全部收回，闭合状态为 false", () => {
    const knot = cornerKnot([12, 34]);
    expect(knot).toEqual({ anchor: [12, 34], in: [12, 34], out: [12, 34], smooth: false });
    expect(emptyDraft().subpaths[0]).toEqual({ closed: false, knots: [] });
  });

  it("拖出控制柄得到对称平滑点；Alt 只留出向柄", () => {
    const smooth = smoothKnot([10, 10], [20, 10]);
    expect(smooth.smooth).toBe(true);
    expect(smooth.out).toEqual([20, 10]);
    expect(smooth.in).toEqual([0, 10]);
    const broken = smoothKnot([10, 10], [20, 10], true);
    expect(broken.smooth).toBe(false);
    expect(broken.in).toEqual([10, 10]);
    expect(broken.out).toEqual([20, 10]);
  });

  it("追加/删除锚点不修改原草稿", () => {
    const base = emptyDraft();
    const one = addKnot(base, { point: [1, 2] });
    expect(knotCount(base)).toBe(0);
    expect(knotCount(one)).toBe(1);
    expect(knotCount(removeKnot(one))).toBe(0);
  });

  it("开放路径保持开放：默认结束不闭合，点回首锚点才闭合", () => {
    const draft = addKnot(addKnot(addKnot(emptyDraft(), { point: [0, 0] }), { point: [10, 0] }), { point: [10, 10] });
    const open = finishDraft(draft, false)!;
    expect(open.subpaths[0]!.closed).toBe(false);
    const closed = finishDraft(closeDraft(draft), true)!;
    expect(closed.subpaths[0]!.closed).toBe(true);
  });

  it("少于两个锚点不可提交；闭合子路径也不强行用两点闭合", () => {
    expect(canFinish(emptyDraft())).toBe(false);
    expect(finishDraft(addKnot(emptyDraft(), { point: [1, 1] }))).toBeNull();
    const two = addKnot(addKnot(emptyDraft(), { point: [0, 0] }), { point: [5, 5] });
    expect(canFinish(two)).toBe(true);
    expect(closeDraft(two).subpaths[0]!.closed).toBe(false);
  });

  it("续接只允许开放子路径，并深拷贝锚点", () => {
    const path: PenPath = { subpaths: [{ closed: false, knots: [cornerKnot([0, 0]), cornerKnot([4, 4])] }] };
    const draft = continueFrom(path)!;
    expect(knotCount(draft)).toBe(2);
    draft.subpaths[0]!.knots[0]!.anchor[0] = 99;
    expect(path.subpaths[0]!.knots[0]!.anchor[0]).toBe(0);
    expect(continueFrom({ subpaths: [{ closed: true, knots: [cornerKnot([0, 0])] }] })).toBeNull();
    expect(continueFrom({ subpaths: [] })).toBeNull();
  });

  it("自由钢笔按容差去重采样点并生成平滑锚点", () => {
    const draft = freehandDraft([[0, 0], [0.2, 0.2], [10, 0], [20, 0]], 1.5);
    expect(knotCount(draft)).toBe(3);
    expect(draft.subpaths[0]!.knots[1]!.smooth).toBe(true);
    expect(freehandDraft([[0, 0], [0.1, 0]]).subpaths[0]!.knots).toHaveLength(0);
  });

  it("曲率钢笔与路径落盘参数使用内核命令同形", () => {
    expect(curvatureParams(1, [2, 3], [4, 5])).toEqual({ anchors: [[1, 2], [1, 3]], move: [4, 5], curvature: true });
    const path: PenPath = { subpaths: [{ closed: false, knots: [cornerKnot([0, 0])] }] };
    expect(pathSetParams("work", path)).toEqual({ name: "work", path });
  });
});
