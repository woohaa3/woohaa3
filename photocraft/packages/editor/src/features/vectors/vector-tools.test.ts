import { describe, expect, it } from "vitest";
import {
  VECTOR_TOOLS,
  draftFromPoints,
  initialVectorGesture,
  reduceVectorGesture,
  reduceVectorKey,
  vectorTool,
  type VectorGestureOptions,
  type VectorGestureState,
  type VectorPointer,
} from "./vector-tools.js";
import { cornerKnot, type PenPath } from "./pen-tools.js";
import type { EditablePath } from "./path-edit.js";

const options: VectorGestureOptions = { canvas: [800, 600], zoom: 2 };
const at = (point: [number, number], extra: Partial<VectorPointer> = {}): VectorPointer => ({ type: "move", point, ...extra });
const down = (point: [number, number], extra: Partial<VectorPointer> = {}): VectorPointer => ({ type: "down", point, ...extra });
const up = (point: [number, number], extra: Partial<VectorPointer> = {}): VectorPointer => ({ type: "up", point, ...extra });

/** 依次喂入事件，返回最后的命令与状态。 */
function run(tool: string, events: VectorPointer[], overrides: Partial<VectorGestureOptions> = {}) {
  let state: VectorGestureState = initialVectorGesture(tool);
  let result = { overlay: state.overlay, commands: [] as { id: string; params: Record<string, unknown> }[] } as ReturnType<typeof reduceVectorGesture>["result"];
  for (const event of events) {
    const step = reduceVectorGesture(state, event, { ...options, ...overrides });
    state = step.state;
    result = step.result;
  }
  return { state, result };
}

describe("矢量工具清单", () => {
  it("形状/钢笔/路径三组工具顺序稳定且 id 唯一", () => {
    expect(VECTOR_TOOLS.map(tool => tool.id)).toEqual([
      "shape-rect", "shape-rounded-rect", "shape-ellipse", "shape-triangle", "shape-polygon", "shape-star", "shape-line",
      "pen-freeform", "pen-curvature", "path-select", "direct-select", "custom-shape",
    ]);
    expect(new Set(VECTOR_TOOLS.map(tool => tool.id)).size).toBe(VECTOR_TOOLS.length);
    expect(new Set(VECTOR_TOOLS.map(tool => tool.order)).size).toBe(VECTOR_TOOLS.length);
    expect(vectorTool("nope")).toBeUndefined();
  });
});

describe("形状拖绘手势（U08/U09）", () => {
  it("拖动预览只更新叠加层，松手才提交一条 shape.create", () => {
    const preview = run("shape-rect", [down([10, 10]), at([60, 40])]);
    expect(preview.result.commands).toEqual([]);
    expect(preview.result.overlay).toMatchObject({ kind: "shape" });

    const committed = run("shape-rect", [down([10, 10]), at([60, 40]), up([60, 40])], { fill: "#ff0000" });
    expect(committed.result.commands).toHaveLength(1);
    expect(committed.result.commands[0]).toMatchObject({
      id: "shape.create",
      params: { kind: "rect", rect: [10, 10, 50, 30], fill: "#ff0000" },
    });
    expect(committed.state.overlay).toEqual({ kind: "none" });
    expect(committed.state.dragging).toBe(false);
  });

  it("Shift/Alt 修饰键进入同一份几何，星形带内外比例", () => {
    const shifted = run("shape-ellipse", [down([10, 10], { shift: true }), at([60, 30], { shift: true }), up([60, 30], { shift: true })]);
    expect(shifted.result.commands[0]!.params.rect).toEqual([10, 10, 50, 50]);
    const centered = run("shape-star", [down([100, 100], { alt: true }), at([140, 130], { alt: true }), up([140, 130], { alt: true })], { shapeOptions: { sides: 7, starRatio: 0.4 } });
    expect(centered.result.commands[0]!.params).toMatchObject({ kind: "star", rect: [60, 70, 80, 60], sides: 7, starRatio: 0.4 });
  });

  it("零面积/未开始拖动不提交，并给出可读提示", () => {
    const zero = run("shape-rect", [down([10, 10]), at([10, 10]), up([10, 10])]);
    expect(zero.result.commands).toEqual([]);
    expect(zero.result.message).toMatch(/面积为零/);
    const noDown = run("shape-rect", [move(), up([5, 5])]);
    expect(noDown.result.commands).toEqual([]);
    function move(): VectorPointer { return { type: "move", point: [5, 5] }; }
  });

  it("Escape 取消丢弃预览且不产生历史", () => {
    const cancelled = run("shape-rect", [down([10, 10]), at([40, 40]), { type: "cancel", point: [40, 40] }, up([40, 40])]);
    expect(cancelled.result.commands).toEqual([]);
    expect(cancelled.state.dragging).toBe(false);
  });

  it("自定形状拖绘提交 shape.presets.place，未选预设只提示", () => {
    const placed = run("custom-shape", [down([0, 0]), at([40, 20]), up([40, 20])], { preset: { name: "箭头", group: "自定形状" }, fill: "#123456" });
    expect(placed.result.commands[0]).toEqual({
      id: "shape.presets.place",
      params: { preset: "箭头", group: "自定形状", rect: [0, 0, 40, 20], fill: "#123456" },
    });
    const missing = run("custom-shape", [down([0, 0])]);
    expect(missing.result.commands).toEqual([]);
    expect(missing.result.message).toMatch(/预设/);
  });
});

describe("钢笔手势（U11）", () => {
  it("单击落锚点；双击或 Enter 结束为开放路径", () => {
    const closedByDefault = run("pen-freeform", [down([10, 10]), up([10, 10]), down([40, 10]), up([40, 10]), up([40, 10])]);
    expect(closedByDefault.result.commands).toEqual([]);

    const finished = run("pen-freeform", [down([10, 10]), up([10, 10]), down([40, 10]), up([40, 10]), down([40, 40], { doubleClick: true })]);
    const command = finished.result.commands[0]!;
    expect(command.id).toBe("path.set");
    const path = command.params.path as PenPath;
    expect(path.subpaths[0]!.closed).toBe(false);
    expect(path.subpaths[0]!.knots).toHaveLength(2);
  });

  it("按下后拖动拉出对称控制柄；Alt 只留出向柄", () => {
    const smooth = run("pen-freeform", [down([20, 20]), at([30, 20], { moved: true }), up([30, 20])]);
    const knot = (smooth.state.overlay as { draft: { subpaths: { knots: { in: number[]; out: number[] }[] }[] } }).draft.subpaths[0]!.knots[0]!;
    expect(knot.out).toEqual([30, 20]);
    expect(knot.in).toEqual([10, 20]);

    const broken = run("pen-freeform", [down([20, 20], { alt: true }), at([30, 20], { moved: true, alt: true }), up([30, 20])]);
    const sharp = (broken.state.overlay as { draft: { subpaths: { knots: { in: number[]; out: number[] }[] }[] } }).draft.subpaths[0]!.knots[0]!;
    expect(sharp.in).toEqual([20, 20]);
    expect(sharp.out).toEqual([30, 20]);
  });

  it("点回首锚点才闭合；少于两个锚点结束给出提示", () => {
    const closed = run("pen-freeform", [
      down([10, 10]), up([10, 10]),
      down([40, 10]), up([40, 10]),
      down([40, 40]), up([40, 40]),
      // 缩放 2 倍时 6 px 屏幕阈值 = 3 源像素。
      down([11, 10]),
    ]);
    expect((closed.result.commands[0]!.params.path as PenPath).subpaths[0]!.closed).toBe(true);

    const tooFew = run("pen-freeform", [down([10, 10]), up([10, 10]), down([10, 10], { doubleClick: true })]);
    expect(tooFew.result.commands).toEqual([]);
    expect(tooFew.result.message).toMatch(/至少需要两个锚点/);
  });

  it("路径落点可切到形状层或矢量蒙版，未选图层时明确拒绝", () => {
    const events = [down([10, 10]), up([10, 10]), down([40, 10]), up([40, 10]), down([40, 40], { doubleClick: true })];
    const shape = run("pen-freeform", events, { penTarget: "shape", fill: "#00ff00" });
    expect(shape.result.commands[0]).toMatchObject({ id: "shape.create", params: { kind: "path", fill: "#00ff00" } });
    const mask = run("pen-freeform", events, { penTarget: "mask", layer: 4 });
    expect(mask.result.commands[0]).toMatchObject({ id: "layer.vectorMask.add", params: { layer: 4 } });
    const noLayer = run("pen-freeform", events, { penTarget: "mask" });
    expect(noLayer.result.commands).toEqual([]);
    expect(noLayer.result.message).toMatch(/选择一个图层/);
  });

  it("续接已有开放路径：点末端接上，闭合路径不续接", () => {
    const open: PenPath = { subpaths: [{ closed: false, knots: [cornerKnot([10, 10]), cornerKnot([40, 10])] }] };
    // 单击末端锚点 → 接上（这一击不落新锚点），再补一个锚点后双击结束。
    const resumed = run("pen-freeform", [down([40, 10]), up([40, 10]), down([70, 40]), up([70, 40]), down([70, 40], { doubleClick: true })], { continuePath: open });
    const path = resumed.result.commands[0]!.params.path as PenPath;
    // 续接后仍带着原有锚点，没有从空白草稿重开。
    expect(path.subpaths[0]!.knots.map(knot => knot.anchor)).toEqual([[10, 10], [40, 10], [70, 40]]);
    expect(path.subpaths[0]!.closed).toBe(false);

    // 闭合路径没有可延长末端：退回普通空草稿，双击时不提交半成品。
    const closedPath: PenPath = { subpaths: [{ closed: true, knots: [cornerKnot([0, 0]), cornerKnot([9, 0]), cornerKnot([9, 9])] }] };
    const rejected = run("pen-freeform", [down([9, 9], { doubleClick: true })], { continuePath: closedPath });
    expect(rejected.result.commands).toEqual([]);
  });

  it("单击已有开放路径的末端才开始续接，落在别处仍是新路径", () => {
    // 两条开放子路径：命中的是**末端锚点**所在的那条，而不是永远接最后一条。
    const two: PenPath = { subpaths: [
      { closed: false, knots: [cornerKnot([0, 0]), cornerKnot([50, 0])] },
      { closed: false, knots: [cornerKnot([0, 80]), cornerKnot([50, 80])] },
    ] };
    const resumed = run("pen-freeform", [down([50, 0])], { continuePath: two });
    expect(resumed.state.overlay).toMatchObject({ kind: "pen" });
    const draft = (resumed.state.overlay as { draft: { subpaths: { knots: { anchor: number[] }[] }[] } }).draft;
    // 接的是第一条（命中点 [50,0] 的末端），且不额外落锚：锚点仍是 2 个。
    expect(draft.subpaths[0]!.knots.map(knot => knot.anchor)).toEqual([[0, 0], [50, 0]]);
    expect(resumed.result.commands).toEqual([]);

    // 末端之外的空处：不续接，从空白草稿落新锚点。
    const fresh = run("pen-freeform", [down([300, 300])], { continuePath: two });
    const freshDraft = (fresh.state.overlay as { draft: { subpaths: { knots: unknown[] }[] } }).draft;
    expect(freshDraft.subpaths[0]!.knots).toHaveLength(1);
  });

  it("续接到命名路径时写回原名，曲率重排也发往同一名字", () => {
    const named: PenPath = { subpaths: [{ closed: false, knots: [cornerKnot([0, 0]), cornerKnot([40, 0])] }] };
    const events = [down([40, 0]), down([80, 20]), down([120, 0], { doubleClick: true })];
    const written = run("pen-curvature", events, { continuePath: named, pathName: "P" });
    expect(written.result.commands.map(command => command.id)).toEqual(["path.set", "path.moveAnchors"]);
    expect(written.result.commands[0]!.params.name).toBe("P");
    expect((written.result.commands[1]!.params as { name: string }).name).toBe("P");
    // 没有 open 时续接注释里那条陷阱：`layer` 不是可写名字，退回 work。
    const layerName = run("pen-freeform", [down([0, 0]), up([0, 0]), down([10, 10]), up([10, 10]), down([10, 10], { doubleClick: true })], { pathName: "layer" });
    expect(layerName.result.commands[0]!.params.name).toBe("work");
  });

  it("自由钢笔采样：提供采样点时落成平滑折线，未提供时保持逐点落锚", () => {
    const samples: [number, number][] = [[10, 10], [30, 14], [50, 10], [70, 20]];
    const caught = run("pen-freeform", [down([10, 10]), at([70, 20], { moved: true }), up([70, 20])], { freehandPoints: samples });
    const draft = (caught.state.overlay as { draft: { subpaths: { knots: { smooth: boolean }[] }[] } }).draft;
    expect(draft.subpaths[0]!.knots.length).toBe(samples.length);
    expect(draft.subpaths[0]!.knots.every(knot => knot.smooth)).toBe(true);

    // 不提供采样 = 既有逐点语义不变。
    const plain = run("pen-freeform", [down([10, 10]), up([10, 10])]);
    const plainDraft = (plain.state.overlay as { draft: { subpaths: { knots: unknown[] }[] } }).draft;
    expect(plainDraft.subpaths[0]!.knots).toHaveLength(1);
  });

  it("曲率钢笔：落平滑锚点，结束时先落路径再由内核重排手柄", () => {
    // 双击是“结束手势”，不会额外落锚（与既有钢笔语义一致），故 3 个锚点都在双击之前。
    const events = [down([10, 100]), up([10, 100]), down([60, 60]), up([60, 60]), down([110, 100]), up([110, 100]), down([110, 100], { doubleClick: true })];
    const result = run("pen-curvature", events);
    expect(result.result.commands[0]!.id).toBe("path.set");
    expect(result.result.commands[1]).toEqual({
      id: "path.moveAnchors",
      params: { name: "work", anchors: [[0, 1]], move: [0, 0], curvature: true },
    });
    // 草稿锚点必须是 smooth，否则内核的 curvature 重排会跳过它们。
    const knots = (result.result.commands[0]!.params.path as PenPath).subpaths[0]!.knots;
    expect(knots.every(knot => knot.smooth)).toBe(true);

    // 少于 3 个锚点时没有可依的相邻点：不制造空的 curvature 命令。
    const short = run("pen-curvature", [down([10, 10]), up([10, 10]), down([40, 40]), up([40, 40]), down([40, 40], { doubleClick: true })]);
    expect(short.result.commands.map(command => command.id)).toEqual(["path.set"]);
  });

  it("键盘：Enter 完成开放路径、Backspace 撤一个锚点、Escape 丢弃", () => {
    const draft = draftFromPoints([[0, 0], [10, 0], [10, 10]]);
    const state: VectorGestureState = { ...initialVectorGesture("pen-freeform"), overlay: { kind: "pen", draft } };
    expect(reduceVectorKey(state, "Enter").result.commands[0]!.id).toBe("path.set");
    const removed = reduceVectorKey(state, "Backspace");
    expect((removed.state.overlay as { draft: { subpaths: { knots: unknown[] }[] } }).draft.subpaths[0]!.knots).toHaveLength(2);
    expect(reduceVectorKey(state, "Escape").result.overlay).toEqual({ kind: "none" });
    const last = reduceVectorKey({ ...initialVectorGesture("pen-freeform"), overlay: { kind: "pen", draft: draftFromPoints([[0, 0]]) } }, "Backspace");
    expect(last.result.overlay).toEqual({ kind: "none" });
  });
});

describe("路径编辑手势（U12）", () => {
  const path: EditablePath = {
    subpaths: [{ closed: false, knots: [{ anchor: [10, 10] }, { anchor: [60, 10] }, { anchor: [60, 60] }] }],
  };

  it("命中锚点后拖动只提交一次 path.moveAnchors", () => {
    const dragged = run("direct-select", [down([10, 10]), at([25, 30], { moved: true }), up([25, 30])], { path });
    expect(dragged.result.commands).toHaveLength(1);
    expect(dragged.result.commands[0]).toMatchObject({
      id: "path.moveAnchors",
      params: { name: "work", anchors: [[0, 0]], move: [15, 20] },
    });
    expect(dragged.result.overlay).toMatchObject({ kind: "anchors" });
  });

  it("Shift 多选后拖动批量移动；空白点击清空选择", () => {
    const state: VectorGestureState = { ...initialVectorGesture("direct-select"), selection: [{ subpath: 0, knot: 1, kind: "anchor", distance: 0 }] };
    const step = reduceVectorGesture(state, down([10, 10], { shift: true }), { ...options, path });
    expect(step.state.selection).toHaveLength(2);
    const drag = reduceVectorGesture(step.state, up([15, 15]), { ...options, path });
    expect(drag.result.commands[0]!.params.anchors).toEqual([[0, 1], [0, 0]]);

    const cleared = reduceVectorGesture({ ...state, selection: [state.selection![0]!] }, down([500, 500]), { ...options, path });
    expect(cleared.state.selection).toEqual([]);
    expect(cleared.result.commands).toEqual([]);
  });

  it("双击锚点转换平滑/尖角；未命中锚点不产生命令", () => {
    const convert = run("direct-select", [down([60, 10]), up([60, 10], { doubleClick: true })], { path });
    // 必须是 `curvature: true`：不带 `out` 的 convertPoint 只会转尖角，双击无法切回平滑。
    expect(convert.result.commands[0]).toMatchObject({ id: "path.convertPoint", params: { subpath: 0, knot: 1, curvature: true } });
    const empty = run("direct-select", [down([700, 500]), up([700, 500], { doubleClick: true })], { path });
    expect(empty.result.commands).toEqual([]);
  });

  it("没有可用路径时不发命令；取消回到无叠加层", () => {
    expect(run("direct-select", [down([10, 10]), up([10, 10])]).result.commands).toEqual([]);
    const cancelled = run("direct-select", [down([10, 10]), { type: "cancel", point: [10, 10] }], { path });
    expect(cancelled.result.commands).toEqual([]);
    expect(cancelled.result.overlay).toMatchObject({ kind: "anchors", hover: null });
  });

  it("路径编辑目标可指向形状层或矢量蒙版（带 layer）", () => {
    const dragged = run("direct-select", [down([10, 10]), up([20, 10])], { path, target: { name: "layer", layer: 9 } });
    expect(dragged.result.commands[0]!.params).toMatchObject({ name: "layer", layer: 9 });
  });
});

it("未知工具不消费指针事件", () => {
  const step = reduceVectorGesture(initialVectorGesture("nope"), down([0, 0]), options);
  expect(step.result.commands).toEqual([]);
  expect(step.result.overlay).toEqual({ kind: "none" });
});

it("角点导出与内核锚点结构同形", () => {
  expect(cornerKnot([1, 2])).toEqual({ anchor: [1, 2], in: [1, 2], out: [1, 2], smooth: false });
});
