import { expect, it } from "vitest";
import { buildStroke, DEFAULT_BRUSH } from "./tool-parameters.js";
import { feature } from "./index.js";

it("preserves mask strokes, pen pressure and explicit brush dynamics after extraction", () => {
  const stroke = buildStroke([{ x: 2, y: 5, pressure: 0.25 }], { ...DEFAULT_BRUSH, target: "mask", dynamics: { pressureSize: true } });
  expect(stroke).toMatchObject({ points: [[2, 5, 0.25]], target: "mask", brush: { pressureSize: true } });
  const brush = feature.tools.find(tool => tool.id === "brush");
  expect(brush?.canRun({ readonly: false, mode: "rgb-u8", rotationDegrees: 0, target: "mask" })).toEqual({ enabled: true });
  expect(brush?.canRun({ readonly: true, mode: "rgb-u8", rotationDegrees: 0, target: "mask" }).enabled).toBe(false);
});

it("publishes the painting workflow section and every wired tool", () => {
  // 面板（含非拖动入口）已发布：渐变/油漆桶/魔术橡皮/吸管/对称/色板/预设可直接提交命令。
  expect(feature.sections.map(section => section.id)).toEqual(["painting"]);
  expect(feature.sections[0]!.menu).toBe("窗口");
  // 工具轨只发布有真实画布落笔路径的工具（任务 3.4 接线后这些全部可拖动/单击落笔）。
  expect(feature.tools.map(tool => tool.id)).toEqual([
    "brush", "eraser",
    "pencil", "colorReplacement", "backgroundEraser",
    "magicEraser", "gradient", "bucket", "eyedropper"
  ]);
  // 每个工具都必须声明手势与可运行判定，否则工具轨会渲染出不可用或不可落笔的按钮。
  for (const tool of feature.tools) {
    expect(typeof tool.gesture).toBe("string");
    expect(tool.canRun({ readonly: false, mode: "rgb-u8", rotationDegrees: 0, target: "pixels" })).toMatchObject({ enabled: true });
    expect(tool.canRun({ readonly: true, mode: "rgb-u8", rotationDegrees: 0, target: "pixels" }).enabled).toBe(false);
  }
});
