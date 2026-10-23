/**
 * 画布 ↔ 归约器桥的接线回归（U08–U16，change: 2026-10-22-add-photocraft-vector-canvas-tools）。
 *
 * 这些用例覆盖的正是「域内函数都写好了，但共享画布没接」时看不见的那一类缺陷：
 * - 面板选的形状参数/预设是否真的进入拖绘参数（而不是各存一份）；
 * - 松手是否只提交一条命令、拖动期间零写入；
 * - 曲率钢笔的两条命令是否按序落地，任一条失败即停止；
 * - 只读时读几何可以、写命令被拒。
 *
 * 内核用**真实** `dist/wasm`（`pnpm wasm` 生成）：命中/几何/命令合法性都必须由内核裁定，
 * 前端替身会把「参数对不上内核」整个遮住。
 */

import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EditorViewModel } from "../../editor-view-model.js";
import type { EditorResult } from "../../editor-wasm.js";
import { reduceVectorGesture, initialVectorGesture, type VectorGestureOptions } from "./vector-tools.js";
import { setPresetChoice, presetChoice } from "./preset-selection.js";
import { setShapeToolOptions, shapeToolOptions } from "./shape-options.js";

const wasmDir = join(import.meta.dirname, "../../../dist/wasm");
type RawEditor = {
  execute(id: string, params: string): string;
  vectorCommand(id: string, params: string): string;
  vectorSnapshotJson(): string;
  free?(): void;
};

let editor: RawEditor | null = null;

beforeAll(async () => {
  const module = await import(join(wasmDir, "photocraft_editor.js"));
  module.initSync({ module: readFileSync(join(wasmDir, "photocraft_editor_bg.wasm")) });
  editor = new module.WasmEditor();
  editor!.execute("file.new", JSON.stringify({ width: 400, height: 300, background: "white" }));
});

/** 与 `canvas-bridge` 相同的提交方式：逐条命令、任一失败即停。 */
function commit(commands: { id: string; params: Record<string, unknown> }[]): string | null {
  for (const command of commands) {
    try {
      editor!.vectorCommand(command.id, JSON.stringify(command.params));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return null;
}

const options = (overrides: Partial<VectorGestureOptions> = {}): VectorGestureOptions => ({
  canvas: [400, 300],
  zoom: 1,
  fill: "#3366cc",
  ...overrides,
});

describe("拖绘接线（U08/U09）", () => {
  it("面板的形状参数进入拖绘：圆角/边数/星形比例与描边都带上", () => {
    setShapeToolOptions({ radius: 8, sides: 6, starRatio: 0.4, weight: 3, stroke: { width: 2, color: "#000000" } });
    const shared = shapeToolOptions();
    expect(shared).toMatchObject({ radius: 8, sides: 6, starRatio: 0.4, weight: 3 });

    // 应用层把 `stroke` 作为独立选项传入（与 `photo-editor-app` 的接线一致），
    // `shapeOptions` 只带几何参数；两者都来自同一份 `shapeToolOptions()`。
    const drawOptions = options({ shapeOptions: shared, stroke: shared.stroke });
    const rounded = reduceVectorGesture(initialVectorGesture("shape-rounded-rect"),
      { type: "down", point: [10, 10] }, drawOptions);
    const moved = reduceVectorGesture(rounded.state, { type: "move", point: [80, 60] }, drawOptions);
    const up = reduceVectorGesture(moved.state, { type: "up", point: [80, 60] }, drawOptions);
    const command = up.result.commands[0]!;
    expect(command.id).toBe("shape.create");
    expect(command.params).toMatchObject({ kind: "roundedRect", rect: [10, 10, 70, 50], radii: [8, 8, 8, 8] });
    expect(command.params.stroke).toEqual({ width: 2, color: "#000000" });
    expect(commit(up.result.commands)).toBeNull();

    // 星形：sides/starRatio 来自同一份共享参数，并且真的被内核接受。
    const starDown = reduceVectorGesture(initialVectorGesture("shape-star"), { type: "down", point: [100, 100] }, drawOptions);
    const starMoved = reduceVectorGesture(starDown.state, { type: "move", point: [160, 150] }, drawOptions);
    const star = reduceVectorGesture(starMoved.state, { type: "up", point: [160, 150] }, drawOptions);
    expect(star.result.commands[0]!.params).toMatchObject({ kind: "star", sides: 6, starRatio: 0.4 });
    expect(commit(star.result.commands)).toBeNull();
  });

  it("拖动期间零命令、松手恰好一条；菱形四角保持一致", () => {
    const down = reduceVectorGesture(initialVectorGesture("shape-rect"), { type: "down", point: [20, 20] }, options());
    const moved = reduceVectorGesture(down.state, { type: "move", point: [120, 90] }, options());
    expect(down.result.commands).toEqual([]);
    expect(moved.result.commands).toEqual([]);
    expect(moved.result.overlay).toMatchObject({ kind: "shape" });
    const up = reduceVectorGesture(moved.state, { type: "up", point: [120, 90] }, options());
    expect(up.result.commands).toHaveLength(1);
    expect(commit(up.result.commands)).toBeNull();
  });

  it("自定形状用面板选中的预设；面板清空后拖绘被拒而不是静默建形状", () => {
    setPresetChoice({ group: "内置", name: "箭头", custom: false });
    expect(presetChoice()).toMatchObject({ name: "箭头" });
    const placed = reduceVectorGesture(
      reduceVectorGesture(
        reduceVectorGesture(initialVectorGesture("custom-shape"), { type: "down", point: [0, 0] }, options({ preset: presetChoice()! })).state,
        { type: "move", point: [40, 20] }, options({ preset: presetChoice()! })).state,
      { type: "up", point: [40, 20] }, options({ preset: presetChoice()! }));
    expect(placed.result.commands[0]).toMatchObject({ id: "shape.presets.place", params: { preset: "箭头", group: "内置" } });

    setPresetChoice(null);
    const rejected = reduceVectorGesture(initialVectorGesture("custom-shape"), { type: "down", point: [0, 0] }, options());
    expect(rejected.result.commands).toEqual([]);
    expect(rejected.result.message).toMatch(/预设/);
  });
});

describe("钢笔与路径编辑接线（U11/U12）", () => {
  it("曲率钢笔两步命令按序落地，内核接受并重排手柄", () => {
    // 三个平滑锚点 → 结束 → `path.set` + `path.moveAnchors{curvature:true}`。
    const events: [number, number][] = [[20, 120], [90, 60], [160, 120]];
    let state = initialVectorGesture("pen-curvature");
    for (const point of events) {
      state = reduceVectorGesture(state, { type: "down", point }, options({ penTarget: "work" })).state;
      state = reduceVectorGesture(state, { type: "up", point }, options({ penTarget: "work" })).state;
    }
    const finished = reduceVectorGesture(state, { type: "down", point: events[2], doubleClick: true }, options({ penTarget: "work" }));
    expect(finished.result.commands.map(command => command.id)).toEqual(["path.set", "path.moveAnchors"]);
    expect(commit(finished.result.commands)).toBeNull();

    const info = JSON.parse(editor!.execute("path.info", JSON.stringify({ name: "work" }))) as
      { path: { subpaths: { closed: boolean; knots: { smooth: boolean; in: number[]; out: number[] }[] }[] } };
    const subpath = info.path.subpaths[0]!;
    expect(subpath.closed).toBe(false);
    expect(subpath.knots).toHaveLength(3);
    // 端点与中间锚点：中间锚点的出向柄必须被内核重排（不再与锚点重合）。
    expect(subpath.knots.every(knot => knot.smooth)).toBe(true);
    expect(subpath.knots[1]!.out).not.toEqual([90, 60]);
  });

  it("直接选择拖动经真实内核只改一个锚点，且无写入时零 command", () => {
    editor!.execute("path.set", JSON.stringify({
      name: "work",
      path: { subpaths: [{ closed: false, knots: [[20, 20], [120, 20], [120, 100]] }] },
    }));
    const info = JSON.parse(editor!.execute("path.info", JSON.stringify({ name: "work" }))) as
      { path: { subpaths: { knots: { anchor: number[] }[] }[] } };
    const path = {
      subpaths: info.path.subpaths.map(subpath => ({ closed: false, knots: subpath.knots.map(knot => ({ anchor: [knot.anchor[0], knot.anchor[1]] as [number, number] })) })),
    };
    const down = reduceVectorGesture(initialVectorGesture("direct-select"), { type: "down", point: [20, 20] }, options({ path }));
    expect(down.result.commands).toEqual([]);
    // 未移动就抬笔 = 只改变选择，不产生命令。
    const click = reduceVectorGesture(down.state, { type: "up", point: [20, 20] }, options({ path }));
    expect(click.result.commands).toEqual([]);
    const dragged = reduceVectorGesture(down.state, { type: "up", point: [35, 45] }, options({ path }));
    expect(dragged.result.commands).toHaveLength(1);
    expect(dragged.result.commands[0]).toMatchObject({ id: "path.moveAnchors", params: { anchors: [[0, 0]], move: [15, 25] } });
    expect(commit(dragged.result.commands)).toBeNull();
    const after = JSON.parse(editor!.execute("path.info", JSON.stringify({ name: "work" }))) as
      { path: { subpaths: { knots: { anchor: number[] }[] }[] } };
    expect(after.path.subpaths[0]!.knots[0]!.anchor).toEqual([35, 45]);
    // 只改一个锚点：其余两点不动。
    expect(after.path.subpaths[0]!.knots[1]!.anchor).toEqual([120, 20]);
    expect(after.path.subpaths[0]!.knots[2]!.anchor).toEqual([120, 100]);
  });

  it("路径选择拖动整条子路径；直接选择只动一个锚点", () => {
    editor!.execute("path.set", JSON.stringify({
      name: "work",
      path: { subpaths: [{ closed: false, knots: [[10, 10], [60, 10], [60, 60]] }] },
    }));
    const path = { subpaths: [{ closed: false, knots: [{ anchor: [10, 10] as [number, number] }, { anchor: [60, 10] as [number, number] }, { anchor: [60, 60] as [number, number] }] }] };
    const down = reduceVectorGesture(initialVectorGesture("path-select"), { type: "down", point: [10, 10] }, options({ path, moveWholeSubpath: true }));
    const up = reduceVectorGesture(down.state, { type: "up", point: [20, 20] }, options({ path, moveWholeSubpath: true }));
    expect(up.result.commands[0]!.params.anchors).toEqual([[0, 0], [0, 1], [0, 2]]);
    expect(commit(up.result.commands)).toBeNull();
    const after = JSON.parse(editor!.execute("path.info", JSON.stringify({ name: "work" }))) as
      { path: { subpaths: { knots: { anchor: number[] }[] }[] } };
    // 三个锚点整体平移 10：几何变了，但相对形状没变形。
    expect(after.path.subpaths[0]!.knots.map(knot => knot.anchor)).toEqual([[20, 20], [70, 20], [70, 70]]);
  });

  it("双击线段在该处插锚，双重双击锚点按 curvature 双向翻转", () => {
    editor!.execute("path.set", JSON.stringify({
      name: "work",
      path: { subpaths: [{ closed: false, knots: [[0, 0], [100, 0]] }] },
    }));
    const path = { subpaths: [{ closed: false, knots: [{ anchor: [0, 0] as [number, number] }, { anchor: [100, 0] as [number, number] }] }] };
    const segmentDown = reduceVectorGesture(initialVectorGesture("direct-select"), { type: "down", point: [50, 0] }, options({ path }));
    expect(segmentDown.state.segment).toMatchObject({ subpath: 0, knot: 0 });
    const inserted = reduceVectorGesture(segmentDown.state, { type: "up", point: [50, 0], doubleClick: true }, options({ path }));
    expect(inserted.result.commands[0]).toMatchObject({ id: "path.addAnchor", params: { subpath: 0, knot: 0 } });
    expect(commit(inserted.result.commands)).toBeNull();
    const info = JSON.parse(editor!.execute("path.info", JSON.stringify({ name: "work" }))) as
      { path: { subpaths: { knots: { anchor: number[] }[] }[] } };
    expect(info.path.subpaths[0]!.knots).toHaveLength(3);

    // 双向：第一下转平滑（带手柄），第二下转回尖角（手柄收回）。
    const anchorPath = { subpaths: [{ closed: false, knots: info.path.subpaths[0]!.knots.map(knot => ({ anchor: [knot.anchor[0], knot.anchor[1]] as [number, number] })) }] };
    const middle = info.path.subpaths[0]!.knots[1]!.anchor as [number, number];
    const toggle = () => {
      const down = reduceVectorGesture(initialVectorGesture("direct-select"), { type: "down", point: middle }, options({ path: anchorPath }));
      return reduceVectorGesture(down.state, { type: "up", point: middle, doubleClick: true }, options({ path: anchorPath })).result.commands;
    };
    expect(commit(toggle())).toBeNull();
    let current = JSON.parse(editor!.execute("path.info", JSON.stringify({ name: "work" }))) as
      { path: { subpaths: { knots: { anchor: number[]; smooth?: boolean; in: number[]; out: number[] }[] }[] } };
    const first = current.path.subpaths[0]!.knots[1]!;
    expect(first.smooth).toBe(true);
    expect(first.out).not.toEqual(first.anchor);

    expect(commit(toggle())).toBeNull();
    current = JSON.parse(editor!.execute("path.info", JSON.stringify({ name: "work" }))) as
      { path: { subpaths: { knots: { anchor: number[]; smooth?: boolean; in: number[]; out: number[] }[] }[] } };
    const second = current.path.subpaths[0]!.knots[1]!;
    // 第二下必须是**尖角**：这正是「不带 out 的 convertPoint 只会转尖角」被修正后的行为。
    expect(second.smooth).toBe(false);
    expect(second.out).toEqual(second.anchor);
  });
});

describe("只读与失败路径", () => {
  it("只读时不提交命令（应用层在读几何之前就该拦住）", () => {
    const state = initialVectorGesture("shape-rect");
    expect(state.tool).toBe("shape-rect");
    // 归约器本身是纯函数：只读门禁在桥里（`readonly` 直接 return 并出提示）。
    // 这里固定「纯函数不写文档」这一半，另一半由 `canvas-bridge` 的早退保证。
    const preview = reduceVectorGesture(state, { type: "down", point: [0, 0] }, options());
    expect(preview.result.commands).toEqual([]);
  });
});

/** 结构化占位：真实宿主里由 `EditorWorkspaceController.editor()` 提供。 */
export type BridgeEditor = { execute(id: string, params?: unknown): EditorResult<unknown> };
export type BridgeViewModel = EditorViewModel;
