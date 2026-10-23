import { expect, it } from "vitest";
import { EDITOR_FEATURES, FEATURE_TOOLS, FEATURE_SECTIONS, isFeatureGestureTool, isFeatureStrokeTool, isFeatureVectorTool } from "./index.js";
import { DOCUMENT_COORDINATES } from "./coordinates.js";
import { VECTOR_TOOLS } from "./vectors/vector-tools.js";

it("assembles every domain once without exposing unfinished tools or sections", () => {
  expect(EDITOR_FEATURES.map(feature => feature.id)).toEqual(["files", "io", "vectors", "selections", "channels", "painting", "retouch", "adjustments", "modes", "filters", "composition", "layers", "smart", "type", "views", "customization", "history", "animation"]);
  expect(FEATURE_TOOLS.map(tool => tool.id)).toEqual(["move", "marquee", "lasso", "polygon-lasso", "magnetic-lasso", "wand", "quick", "crop", "brush", "pencil", "colorReplacement", "eraser", "backgroundEraser", "magicEraser", "gradient", "bucket", "eyedropper", "text", "clone", "heal", "retouch", "pen", ...VECTOR_TOOLS.map(tool => tool.id), "hand", "zoom"]);
  expect(new Set(FEATURE_SECTIONS.map(section => section.id)).size).toBe(32);
  expect(FEATURE_SECTIONS.map(section => section.id).sort()).toEqual(["actions", "adjustments", "applyImage", "automation", "blending", "calculations", "channels", "colorRange", "compose", "customization", "dataSets", "filesCopy", "filesFileInfo", "filesNewDocument", "fillLayer", "filter", "histogram", "history", "interchange", "layerComps", "matting", "modes", "painting", "refine", "retouch", "selection", "smartObject", "stylePresets", "timeline", "typography", "vector", "viewAids"]);
  const animation = EDITOR_FEATURES.find(feature => feature.id === "animation");
  expect(animation?.tools).toEqual([]);
  expect(animation?.sections.map(section => section.id)).toEqual(["timeline"]);
  // 通道域没有工具，只有挂在「图像」菜单下的三个参数面板。
  const channels = EDITOR_FEATURES.find(feature => feature.id === "channels")!;
  expect(channels.tools).toEqual([]);
  expect(channels.sections.map(section => section.id)).toEqual(["channels", "applyImage", "calculations"]);
  expect(FEATURE_SECTIONS.filter(section => section.menu === "图像").map(section => section.id))
    .toEqual(expect.arrayContaining(["applyImage", "calculations"]));
  expect(FEATURE_SECTIONS.find(section => section.id === "channels")?.menu).toBe("窗口");
  // history 贡献面板但不贡献画布工具：历史/动作/数据集都是面板工作流。
  const history = EDITOR_FEATURES.find(feature => feature.id === "history");
  expect(history?.tools).toEqual([]);
  expect(history?.sections.map(section => section.id)).toEqual(["history", "actions", "dataSets", "automation"]);
  // 模式转换不是手势工具，但入口必须真的挂上（否则面板实现了却点不到）。
  const modes = EDITOR_FEATURES.find(feature => feature.id === "modes")!;
  expect(modes.tools).toEqual([]);
  expect(modes.sections.map(section => section.id)).toEqual(["modes"]);
  expect(modes.sections[0]).toMatchObject({ menu: "图像", placement: "advanced" });
  // 图层菜单：本域新增面板全部追加在既有 vector(0) / smartObject(1) 之后，不改已有项顺序。
  expect(EDITOR_FEATURES.find(feature => feature.id === "layers")?.sections.map(section => [section.id, section.menu, section.menuOrder])).toEqual([
    ["fillLayer", "图层", 2], ["blending", "图层", 3], ["matting", "图层", 4], ["layerComps", "窗口", 5], ["stylePresets", "窗口", 6]
  ]);
  // customization 已有真实入口：一个 section 和对应面板，但仍然不新增工具。
  const customization = EDITOR_FEATURES.find(feature => feature.id === "customization")!;
  expect(customization.tools).toEqual([]);
  expect(customization.sections.map(section => section.id)).toEqual(["customization"]);
});

it("uses one reversible document/client mapping and rejects unlaid-out viewports", () => {
  const viewport = { left: 123, top: 45, width: 300, height: 200, documentWidth: 600, documentHeight: 400 };
  const client = DOCUMENT_COORDINATES.documentToView({ x: -8, y: 240 }, viewport)!;
  expect(DOCUMENT_COORDINATES.viewToDocument(client.x, client.y, viewport, false)).toEqual({ x: -8, y: 240 });
  expect(DOCUMENT_COORDINATES.documentToView({ x: 2, y: 3 }, { ...viewport, width: 0 })).toBeNull();
});

it("retains gesture arbitration and pixel/mask support at the shared canvas boundary", () => {
  expect(FEATURE_TOOLS.filter(tool => isFeatureStrokeTool(tool.id)).map(tool => tool.id)).toEqual(["brush", "pencil", "colorReplacement", "eraser", "backgroundEraser", "gradient", "clone", "heal", "retouch"]);
  expect(isFeatureGestureTool("text")).toBe(false);
  expect(isFeatureGestureTool("move")).toBe(false);
  expect(isFeatureGestureTool("marquee")).toBe(true);
  const pen = FEATURE_TOOLS.find(tool => tool.id === "pen");
  expect(pen?.canRun({ readonly: false, mode: "rgb-u8", rotationDegrees: 0, target: "mask" })).toMatchObject({ enabled: false });
});

it("矢量工具登记为独立手势，不被误判成点/笔迹，也不与既有工具冲突", () => {
  const vector = FEATURE_TOOLS.filter(tool => isFeatureVectorTool(tool.id));
  // 12 个工具逐个可在工具栏选中，且画布路由到域内归约器而不是笔迹分支。
  expect(vector.map(tool => tool.id)).toEqual(VECTOR_TOOLS.map(tool => tool.id));
  expect(vector.filter(tool => isFeatureStrokeTool(tool.id))).toEqual([]);
  expect(vector.filter(tool => isFeatureGestureTool(tool.id))).toEqual([]);
  // 归约器的三种手势与画布按 `gesture` 路由的三种取值逐一对应（拼错会静默落到平移分支）。
  expect(new Set(vector.map(tool => tool.gesture))).toEqual(new Set(["shape", "pen", "path"]));
  // id 与 order 全域唯一：重复 order 会让工具栏顺序不确定。
  expect(new Set(FEATURE_TOOLS.map(tool => tool.id)).size).toBe(FEATURE_TOOLS.length);
  expect(new Set(FEATURE_TOOLS.map(tool => tool.order)).size).toBe(FEATURE_TOOLS.length);
  // 只读时全部禁用；mask 目标不支持（与像素工具契约一致）。
  for (const tool of vector) {
    expect(tool.canRun({ readonly: true, mode: "rgb-u8", rotationDegrees: 0, target: "pixels" })).toMatchObject({ enabled: false });
    expect(tool.canRun({ readonly: false, mode: "rgb-u8", rotationDegrees: 0, target: "pixels" })).toMatchObject({ enabled: true });
  }
});
