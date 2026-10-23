/** @vitest-environment jsdom */
/**
 * 填充层/混合/去边/图层复合面板的交互检查（U57、U60、U62、U64）。
 *
 * 只断言**域内契约**：端口缺失时不渲染、参数逐项传给会话、拒绝原因显示、
 * 只读时全部控件禁用。像素与命令语义由 Rust 侧测试覆盖。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { BlendingPanel, FillLayerPanel, LayerCompPanel, MattingPanel, StylePresetPanel } from "./panels.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); });

function mount(node: (readonly: boolean) => JSX.Element) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (readonly = false) => act(() => root.render(node(readonly)));
  render();
  return { container, render };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === label);
  if (!found) throw new Error(`找不到按钮：${label}`);
  return found;
}

/** React 受控输入必须走原生 setter，否则 `value` 赋值不会触发 onChange。 */
function type(target: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function choose(container: HTMLElement, index: number, value: string) {
  const select = container.querySelectorAll<HTMLSelectElement>("select")[index];
  if (!select) throw new Error(`找不到下拉框 ${index}`);
  act(() => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
}

/** 只实现本域用到的端口；其余方法缺失正好验证「端口不可用就不渲染」。 */
function controller(overrides: Record<string, unknown> = {}): EditorWorkspaceController {
  const layers = {
    createFillLayer: vi.fn(() => ({ ok: true, value: { kind: "solid", layer: 3 } })),
    fillLayerInfo: vi.fn(() => ({ ok: true, value: { kind: "solid", color: "#3366ff", layer: 3 } })),
    previewFillLayer: vi.fn(() => ({ ok: true, value: { info: { kind: "solid" }, preview: { width: 2, height: 2, pixels: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } })),
    applyFillLayer: vi.fn(() => ({ ok: true, value: { kind: "solid", changed: true } })),
    previewBlending: vi.fn(() => ({ ok: true, value: { preview: { width: 2, height: 2, pixels: [] }, revision: 4 } })),
    applyBlending: vi.fn(() => ({ ok: true, value: { changed: true } })),
    matting: vi.fn(() => ({ ok: true, value: { changed: true } })),
    layerComp: vi.fn(() => ({ ok: true, value: { result: { changed: true }, comps: { comps: [{ id: 1, name: "显示态", missingLayers: [] }], lastApplied: 1, hasLastDocumentState: true } } })),
    layerComps: vi.fn(() => ({ ok: true, value: { comps: [{ id: 1, name: "显示态", missingLayers: [7] }], lastApplied: 1, hasLastDocumentState: true } })),
    stylePresets: vi.fn(() => ({ ok: true, value: { changed: false, presetsRevision: 3, presets: { groups: [{ name: "默认", presets: [{ name: "金色" }] }] } } })),
    layerCommand: vi.fn(() => ({ ok: true, value: { changed: true } })),
  };
  const patternLibrary = vi.fn(() => ({ ok: true, value: { presets: [], patternPresets: [{ id: "grid", name: "格子" }] } }));
  // 视图模型：混合面板读回活动层；默认没有文档（只验证「端口缺失/无活动层」的路径）。
  const currentView = () => ({ document: null });
  return { patternLibrary, currentView, features: { layers }, ...overrides } as unknown as EditorWorkspaceController;
}

it("填充层面板按种类收集参数并区分新建/预览/应用", () => {
  const port = controller();
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  const { container } = mount((readonly) => <FillLayerPanel controller={port} readonly={readonly} activeLayerId={3} />);

  // 端口提供的图案出现在下拉里（切到图案种类才渲染图案选择）。
  choose(container, 0, "pattern");
  expect([...container.querySelectorAll("option")].map((option) => option.textContent)).toContain("格子");
  choose(container, 0, "solid");
  // 选中已有填充层时读回规范参数。
  expect(layers.fillLayerInfo).toHaveBeenCalledWith(3);

  act(() => button(container, "新建填充层").click());
  expect(layers.createFillLayer).toHaveBeenCalledWith("solid", { color: "#3366ff" });

  act(() => button(container, "应用参数").click());
  expect(layers.applyFillLayer).toHaveBeenCalledWith(3, "solid", { color: "#3366ff" });

  act(() => button(container, "预览").click());
  expect(layers.previewFillLayer).toHaveBeenCalledWith(3, "solid", { color: "#3366ff" });
});

it("填充层停用面板：端口缺失时不渲染，只读时不可操作", () => {
  const empty = mount((readonly) => <FillLayerPanel controller={controller({ features: { layers: {} } })} readonly={readonly} activeLayerId={null} />);
  expect(empty.container.textContent).toBe("");
  act(() => root.unmount());

  const { container, render } = mount((readonly) => <FillLayerPanel controller={controller()} readonly={readonly} activeLayerId={3} />);
  render(true);
  for (const control of container.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button, input, select")) {
    expect(control.disabled).toBe(true);
  }
});

it("混合面板把分离端点与成组开关原样送出，并在拖动时预览", () => {
  const port = controller();
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  const { container } = mount((readonly) => <BlendingPanel controller={port} readonly={readonly} activeLayerId={3} />);
  const ranges = [...container.querySelectorAll<HTMLInputElement>("input")].filter((entry) => entry.type === "text");
  type(ranges[0]!, "30,60,200,235");
  expect(layers.previewBlending).toHaveBeenCalled();
  const last = layers.previewBlending.mock.lastCall![0] as Record<string, unknown>;
  expect((last.blendIf as { thisLayer: number[] }).thisLayer).toEqual([30, 60, 200, 235]);

  act(() => button(container, "应用混合选项").click());
  expect(layers.applyBlending).toHaveBeenCalled();
  const applied = layers.applyBlending.mock.lastCall![0] as Record<string, unknown>;
  expect(applied).toMatchObject({ layer: 3, knockout: "none", blendInteriorEffectsAsGroup: false, blendClippedLayersAsGroup: true });
  expect(applied.channels).toEqual([true, true, true]);
});

it("去边面板按命令只发送对应参数", () => {
  const port = controller();
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  const { container } = mount((readonly) => <MattingPanel controller={port} readonly={readonly} activeLayerId={3} />);
  act(() => button(container, "应用").click());
  expect(layers.matting).toHaveBeenLastCalledWith("layer.matting.defringe", { layer: 3, width: 1 }, false);

  choose(container, 0, "layer.matting.colorDecontaminate");
  act(() => button(container, "预览").click());
  expect(layers.matting).toHaveBeenLastCalledWith("layer.matting.colorDecontaminate", { layer: 3, amount: 100, radius: 4 }, true);

  choose(container, 0, "layer.matting.removeBlackMatte");
  act(() => button(container, "应用").click());
  expect(layers.matting).toHaveBeenLastCalledWith("layer.matting.removeBlackMatte", { layer: 3 }, false);
});

it("图层复合面板列出复合、报告缺失层并按名称切换", () => {
  const port = controller();
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  const { container } = mount((readonly) => <LayerCompPanel controller={port} readonly={readonly} revision={1} />);
  expect(container.textContent).toContain("缺 1 层");

  choose(container, 0, "显示态");
  act(() => button(container, "切换").click());
  expect(layers.layerComp).toHaveBeenLastCalledWith("layerComp.apply", { comp: "显示态" });

  type(container.querySelector<HTMLInputElement>("input:not([type])")!, "显示态");
  act(() => button(container, "新建复合").click());
  expect(layers.layerComp).toHaveBeenLastCalledWith("layerComp.new", { name: "显示态", visibility: true, position: true, appearance: true });
});

it("图层复合面板把内核拒绝原因显示出来，而不是静默忽略", () => {
  const port = controller();
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  layers.layerComp = vi.fn(() => ({ ok: false, code: "command-failed", message: "复合超过上限（64）" }));
  const { container } = mount((readonly) => <LayerCompPanel controller={port} readonly={readonly} revision={0} />);
  act(() => button(container, "新建复合").click());
  expect(container.textContent).toContain("复合超过上限（64）");
});

/**
 * U61：样式预设面板必须能**管理**预设，而不只是应用。
 *
 * 面板只在 `stylePresets` 端口存在时渲染；列表来自真实偏好库，保存/重命名/删除都发对应
 * 动作，且任何一个都不应触碰文档内容刷新。
 */
it("样式预设面板列出偏好库并把管理动作发往内核", () => {
  const port = controller();
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  const { container, render } = mount((readonly) => <StylePresetPanel controller={port} readonly={readonly} activeLayerId={3} />);

  // 挂载即列出（不带参数），并把库里的预设名渲染进下拉。
  expect(layers.stylePresets).toHaveBeenCalledWith("style.presets.list", {});
  const select = container.querySelector<HTMLSelectElement>("select")!;
  expect([...select.options].map((option) => option.value)).toContain("金色");

  // 从当前层保存：带上活动层 id 与名称。
  const nameInput = container.querySelector<HTMLInputElement>("input[placeholder='另存为…']")!;
  type(nameInput, "我的样式");
  act(() => { button(container, "从当前层保存").click(); });
  expect(layers.stylePresets).toHaveBeenCalledWith("style.presets.new", { name: "我的样式", layer: 3 });

  // 选中后重命名 / 删除发对应动作。
  choose(container, 0, "金色");
  type(nameInput, "改过的名字");
  act(() => { button(container, "重命名").click(); });
  expect(layers.stylePresets).toHaveBeenCalledWith("style.presets.edit", { action: "rename", preset: "金色", name: "改过的名字" });
  act(() => { button(container, "删除").click(); });
  expect(layers.stylePresets).toHaveBeenCalledWith("style.presets.edit", { action: "delete", preset: "改过的名字" });

  // 恢复默认不需要选中任何预设。
  act(() => { button(container, "恢复默认").click(); });
  expect(layers.stylePresets).toHaveBeenCalledWith("style.presets.reset", {});

  // 只读时全部控件禁用。
  render(true);
  expect(button(container, "恢复默认").disabled).toBe(true);
  expect(button(container, "从当前层保存").disabled).toBe(true);
});

it("样式预设端口缺失时不渲染该面板", () => {
  const port = controller();
  delete (port.features as unknown as { layers: Record<string, unknown> }).layers.stylePresets;
  const { container } = mount((readonly) => <StylePresetPanel controller={port} readonly={readonly} activeLayerId={3} />);
  expect(container.querySelector("[data-style-preset-panel]")).toBeNull();
});

/**
 * U57：确认填充层参数真的**读回**了内核的规范参数。
 *
 * 之前只断言「发出去什么」，读不回来就等于每次打开面板都会用默认值覆盖已保存的渐变。
 */
it("填充层按 fillLayerInfo 读回渐变端点/透明度/反相/仿色/对齐与图案相位", () => {
  const port = controller();
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  layers.fillLayerInfo = vi.fn(() => ({ ok: true, value: {
    kind: "gradient", layer: 3,
    gradient: { style: "radial", angle: 30, scale: 1.5, reverse: true, dither: true, align: false,
      offset: [12, -4], stops: [[0, "#ff0000"], [1, "#00ff00"]], transparency: [[0, 100], [1, 0]] }
  } }));
  const { container } = mount((readonly) => <FillLayerPanel controller={port} readonly={readonly} activeLayerId={3} />);
  const colorInputs = [...container.querySelectorAll<HTMLInputElement>("input[type='color']")];
  expect(colorInputs.map((input) => input.value)).toEqual(["#ff0000", "#00ff00"]);
  const texts = [...container.querySelectorAll<HTMLInputElement>("input:not([type='color']):not([type='number']):not([type='checkbox'])")];
  expect(texts.map((input) => input.value)).toContain("0:100, 1:0");
  expect(texts.map((input) => input.value)).toContain("12,-4");
  const checks = [...container.querySelectorAll<HTMLInputElement>("input[type='checkbox']")];
  expect(checks.map((input) => input.checked)).toEqual([true, true, false]);

  act(() => button(container, "应用参数").click());
  const applied = layers.applyFillLayer.mock.lastCall! as [number, string, Record<string, unknown>];
  expect(applied[0]).toBe(3);
  expect(applied[1]).toBe("gradient");
  expect(applied[2]).toMatchObject({ stops: [[0, "#ff0000"], [1, "#00ff00"]], style: "radial", angle: 30, scale: 1.5, reverse: true, dither: true, align: false, offset: [12, -4], transparency: [[0, 100], [1, 0]] });
});

it("填充层预览把内核像素画到画布上（不是只有一句提示）", () => {
  const port = controller();
  const { container } = mount((readonly) => <FillLayerPanel controller={port} readonly={readonly} activeLayerId={3} />);
  expect(container.querySelector("[data-workflow-preview]")).toBeNull();
  act(() => button(container, "预览").click());
  const canvas = container.querySelector<HTMLCanvasElement>("[data-workflow-preview='填充层预览']");
  expect(canvas).not.toBeNull();
  // jsdom 无 2D 上下文时不会崩：画布尺寸仍来自内核预览。
  expect([canvas!.width, canvas!.height]).toEqual([2, 2]);
});

/**
 * U57：预览失败时不能留下上一份像素，否则用户会以为新参数已经生效。
 */
it("填充层预览失败时清空画布并显示原因", () => {
  const port = controller();
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  const { container } = mount((readonly) => <FillLayerPanel controller={port} readonly={readonly} activeLayerId={3} />);
  layers.previewFillLayer = vi.fn(() => ({ ok: false, message: "渐变至少需要两个端点" }));
  act(() => button(container, "预览").click());
  expect(container.textContent).toContain("渐变至少需要两个端点");
  expect(container.querySelector("[data-workflow-preview]")).toBeNull();
});

/**
 * U60：高级混合必须读回已保存值。
 *
 * 读不回来，「应用」就会用面板默认值覆盖用户已有的 Blend If / 挖空 / 蒙版隐藏效果。
 */
it("混合面板从活动层读回 Blend If、通道、挖空与两个蒙版开关", () => {
  const port = controller({ currentView: () => ({ document: { layers: [{
    id: 3, blend: "Multiply", channels: [true, true, false, true],
    advancedBlending: { knockout: "shallow", blendInterior: true, blendClipped: true, transparencyShapes: true, layerMaskHidesEffects: true, vectorMaskHidesEffects: true },
    blendIf: [{ channel: 1, thisLayer: [30, 60, 200, 235], underlying: [10, 250] }],
  }] } }) });
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  const { container } = mount((readonly) => <BlendingPanel controller={port} readonly={readonly} activeLayerId={3} />);
  const selects = [...container.querySelectorAll<HTMLSelectElement>("select")];
  expect(selects[0]!.value).toBe("multiply");
  expect(selects[1]!.value).toBe("shallow");
  expect(selects[2]!.value).toBe("red");
  const texts = [...container.querySelectorAll<HTMLInputElement>("input")].filter((input) => input.type === "text");
  expect(texts[0]!.value).toBe("30,60,200,235");
  expect(texts[1]!.value).toBe("10,250");
  // 通道复选框在最前；其后的两个是 Blend If 分离端点开关，再往后才是五个混合选项开关。
  const boxes = [...container.querySelectorAll<HTMLInputElement>("input[type='checkbox']")];
  expect(boxes.slice(0, 3).map((input) => input.checked)).toEqual([true, true, false]);
  expect(boxes.slice(5).every((input) => input.checked)).toBe(true);
  // 已保存的端点状态决定分离开关：本图层 4 端点＝已分离，下层 2 端点＝未分离。
  expect(boxes.slice(3, 5).map((input) => input.checked)).toEqual([true, false]);

  act(() => button(container, "应用混合选项").click());
  expect(layers.applyBlending).toHaveBeenLastCalledWith(expect.objectContaining({
    // 面板只暴露 R/G/B 三个开关；内核状态可能多报 alpha，第 4 项不参与界面。
    layer: 3, blend: "multiply", knockout: "shallow", channels: [true, true, false],
    layerMaskHidesEffects: true, vectorMaskHidesEffects: true,
    blendIf: { channel: "red", thisLayer: [30, 60, 200, 235], underlying: [10, 250] },
  }));
});

it("混合预览把合成像素画出来", () => {
  const port = controller();
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  layers.previewBlending = vi.fn(() => ({ ok: true, value: { preview: { width: 3, height: 2, pixels: new Array(24).fill(0) }, revision: 4 } }));
  const { container } = mount((readonly) => <BlendingPanel controller={port} readonly={readonly} activeLayerId={3} />);
  const ranges = [...container.querySelectorAll<HTMLInputElement>("input")].filter((input) => input.type === "text");
  type(ranges[0]!, "30,60,200,235");
  const canvas = container.querySelector<HTMLCanvasElement>("[data-workflow-preview='混合预览']");
  expect(canvas).not.toBeNull();
  expect([canvas!.width, canvas!.height]).toEqual([3, 2]);
});

/** U62：去边/净化的预览必须是真实像素。 */
it("去边面板把预览像素画出来，应用后清空", () => {
  const port = controller();
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  layers.matting = vi.fn(() => ({ ok: true, value: { preview: { width: 2, height: 2, pixels: new Array(16).fill(0) } } }));
  const { container } = mount((readonly) => <MattingPanel controller={port} readonly={readonly} activeLayerId={3} />);
  act(() => button(container, "预览").click());
  expect(container.querySelector("[data-workflow-preview='去边与净化预览']")).not.toBeNull();
  layers.matting = vi.fn(() => ({ ok: true, value: { changed: true } }));
  act(() => button(container, "应用").click());
  expect(container.querySelector("[data-workflow-preview]")).toBeNull();
});

/** 形状不对的内核响应不画：宁可没有预览，也不画一张错的。 */
it("预览像素长度与尺寸不符时不渲染画布", () => {
  const port = controller();
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  layers.previewFillLayer = vi.fn(() => ({ ok: true, value: { info: { kind: "solid" }, preview: { width: 4, height: 4, pixels: [1, 2, 3] } } }));
  const { container } = mount((readonly) => <FillLayerPanel controller={port} readonly={readonly} activeLayerId={3} />);
  act(() => button(container, "预览").click());
  expect(container.querySelector("[data-workflow-preview]")).toBeNull();
});

/**
 * U61：样式跨层动作与预设应用都必须真的发往内核。
 *
 * 之前面板只有「应用预设」，用户无法先保存自己的一份样式；拷贝/粘贴/转层也没有入口。
 */
it("样式预设面板把跨层动作与预设应用发往内核", () => {
  const port = controller();
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  const { container } = mount((readonly) => <StylePresetPanel controller={port} readonly={readonly} activeLayerId={3} />);
  act(() => button(container, "拷贝样式").click());
  expect(layers.layerCommand).toHaveBeenLastCalledWith("layer.layerStyle.copyLayerStyle", { layer: 3 });
  act(() => button(container, "粘贴样式").click());
  expect(layers.layerCommand).toHaveBeenLastCalledWith("layer.layerStyle.pasteLayerStyle", { layer: 3 });
  act(() => button(container, "清除样式").click());
  expect(layers.layerCommand).toHaveBeenLastCalledWith("layer.layerStyle.clear", { layer: 3 });
  act(() => button(container, "效果转层").click());
  expect(layers.layerCommand).toHaveBeenLastCalledWith("layer.layerStyle.createLayer", { layer: 3 });
  act(() => button(container, "样式栅格化").click());
  expect(layers.layerCommand).toHaveBeenLastCalledWith("layer.rasterize.layerStyle", { layer: 3 });

  const scaleInput = container.querySelector<HTMLInputElement>("input[type='number']")!;
  type(scaleInput, "150");
  act(() => button(container, "缩放效果").click());
  expect(layers.layerCommand).toHaveBeenLastCalledWith("layer.layerStyle.scaleEffects", { layer: 3, scale: 150 });

  choose(container, 0, "金色");
  act(() => button(container, "应用预设").click());
  expect(layers.layerCommand).toHaveBeenLastCalledWith("style.presets.apply", { preset: "金色", layer: 3 });
});

/** U64：复合属性动作（改名/注释/选项/恢复/缺失层检查）都要可达。 */
it("图层复合面板发送属性动作并显示快照", () => {
  const port = controller();
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  layers.layerComps = vi.fn(() => ({ ok: true, value: { comps: [{
    id: 1, name: "显示态", missingLayers: [], visibility: true, position: false, appearance: false,
    snapshot: [{ layer: 4, visible: true, position: null, appearance: null }],
  }], lastApplied: 1, hasLastDocumentState: true } }));
  const { container } = mount((readonly) => <LayerCompPanel controller={port} readonly={readonly} revision={1} />);
  choose(container, 0, "显示态");
  expect(container.querySelector("[data-comp-snapshot]")!.textContent).toContain("#4 可见=true");

  type(container.querySelector<HTMLInputElement>("input[placeholder='新名称']")!, "改名后");
  act(() => button(container, "重命名").click());
  expect(layers.layerComp).toHaveBeenLastCalledWith("layerComp.rename", { comp: "显示态", name: "改名后" });

  type(container.querySelector<HTMLInputElement>("input[placeholder='备注']")!, "说明");
  act(() => button(container, "保存注释").click());
  expect(layers.layerComp).toHaveBeenLastCalledWith("layerComp.setComment", { comp: "改名后", comment: "说明" });

  act(() => button(container, "保存选项").click());
  expect(layers.layerComp).toHaveBeenLastCalledWith("layerComp.setOptions", { comp: "改名后", visibility: true, position: true, appearance: true });

  act(() => button(container, "恢复上次状态").click());
  expect(layers.layerComp).toHaveBeenLastCalledWith("layerComp.restoreLastDocumentState", {});

  // 只有 `updateWarnings` 的报告在 `result` 内：面板要把缺失层报出来。
  layers.layerComp = vi.fn(() => ({ ok: true, value: { result: { warnings: [{ name: "显示态", missingLayers: [7, 8] }] }, comps: { comps: [] } } }));
  act(() => button(container, "检查缺失层").click());
  expect(container.textContent).toContain("缺 2 层");
});

/**
 * U64「导出」：浏览器宿主没有目录权限，因此导出走真实下载通道交付权威快照。
 *
 * 导出只序列化 `layerComps()` 已给的快照，不重算、不写文档；没有复合时明确说明原因，
 * 下载通道不可用时报告失败而不是假装已保存。
 */
it("图层复合导出把权威快照写成 JSON 下载", async () => {
  const port = controller();
  const create = vi.fn(() => "blob:comps");
  const revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  let written = "";
  const BlobMock = vi.fn((parts: unknown[]) => { written = String(parts[0]); return { type: "application/json" } as unknown as Blob; });
  vi.stubGlobal("Blob", BlobMock);

  const { container } = mount((readonly) => <LayerCompPanel controller={port} readonly={readonly} revision={1} />);
  act(() => button(container, "导出快照 JSON").click());

  expect(BlobMock).toHaveBeenCalledOnce();
  const payload = JSON.parse(written);
  expect(payload.format).toBe("photocraft-layer-comps");
  expect(payload.comps[0]).toMatchObject({ name: "显示态", missingLayers: [7] });
  expect(Array.isArray(payload.comps[0].snapshot)).toBe(true);
  expect(click).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledWith("blob:comps");
  vi.unstubAllGlobals();
});

it("没有复合时导出按钮禁用而不是静默生成空文件", () => {
  const port = controller();
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  layers.layerComps = vi.fn(() => ({ ok: true, value: { comps: [], lastApplied: null, hasLastDocumentState: false } }));
  const { container } = mount((readonly) => <LayerCompPanel controller={port} readonly={readonly} revision={1} />);
  expect(button(container, "导出快照 JSON").disabled).toBe(true);
});

/**
 * U60：分离端点必须有真正的滑块，而不只有一串手输数字。
 *
 * 两个手柄是「合并端点」，四个手柄才是「分离端点」——后者定义过渡宽度。滑块在邻居之间夹住，
 * 因此面板不会把交叉端点送去内核再靠报错纠正。
 */
it("Blend If 滑块按分离端点产生四个手柄并在相邻值之间夹住", () => {
  const port = controller({ currentView: () => ({ document: { layers: [{
    id: 3, blend: "Normal", channels: [true, true, true],
    advancedBlending: { knockout: "none", blendInterior: false, blendClipped: true, transparencyShapes: true, layerMaskHidesEffects: false, vectorMaskHidesEffects: false },
    blendIf: [{ channel: 0, thisLayer: [0, 255], underlying: [20, 40, 200, 240] }],
  }] } }) });
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  const { container } = mount((readonly) => <BlendingPanel controller={port} readonly={readonly} activeLayerId={3} />);

  const merged = [...container.querySelectorAll<HTMLInputElement>("input[type='range']")].slice(0, 2);
  expect(merged.map((input) => input.value)).toEqual(["0", "255"]);
  const split = [...container.querySelectorAll<HTMLInputElement>("input[type='range']")].slice(2);
  expect(split.map((input) => input.value)).toEqual(["20", "40", "200", "240"]);

  // 第二手柄拖到 250 会被第四手柄之前的位置夹住（不能与更后的端点交叉）。
  act(() => {
    const handle = container.querySelector<HTMLInputElement>("[data-blend-if-handle='下层-1']")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(handle, "250");
    handle.dispatchEvent(new Event("input", { bubbles: true }));
    handle.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const previewed = layers.previewBlending.mock.lastCall![0] as { blendIf: { underlying: number[] } };
  expect(previewed.blendIf.underlying).toEqual([20, 200, 200, 240]);

  // 勾上「分离」后，原来合并的两端点变成四个手柄（过渡宽度从 0 开始）。
  act(() => {
    const toggle = [...container.querySelectorAll<HTMLInputElement>("input[type='checkbox']")].find((input) => input.parentElement!.textContent!.includes("本图层分离端点"))!;
    toggle.click();
  });
  const expanded = [...container.querySelectorAll<HTMLInputElement>("input[type='range']")].slice(0, 4);
  expect(expanded.map((input) => input.value)).toEqual(["0", "0", "255", "255"]);
});

/**
 * U57：填充层的矢量蒙版必须能从面板选择，否则 `path` 参数只有内核能用。
 */
it("填充层面板列出文档路径并只在新建时发送 path", () => {
  const port = controller({ vectorSnapshot: () => ({ ok: true, value: { paths: [{ name: "work" }, { name: "轮廓" }], vectorMasks: [], shapes: [] } }) });
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  const { container } = mount((readonly) => <FillLayerPanel controller={port} readonly={readonly} activeLayerId={3} />);
  const maskSelect = [...container.querySelectorAll<HTMLSelectElement>("select")][1]!;
  expect([...maskSelect.options].map((option) => option.value)).toEqual(["", "work", "轮廓"]);

  act(() => { maskSelect.value = "轮廓"; maskSelect.dispatchEvent(new Event("change", { bubbles: true })); });
  act(() => button(container, "新建填充层").click());
  expect(layers.createFillLayer).toHaveBeenLastCalledWith("solid", { color: "#3366ff", path: "轮廓" });
  // 编辑既有填充层不带 path：改参数不该换掉蒙版类型。
  act(() => button(container, "应用参数").click());
  expect(layers.applyFillLayer.mock.lastCall![2]).not.toHaveProperty("path");
});

/**
 * U61：效果转层到另一层（`transferEffects`）与效果默认值（`defaultFor`/`makeDefault`）
 * 之前只在内核里有、界面上没有入口。
 */
it("样式预设面板提供复制/移动效果到目标层与效果默认值管理", () => {
  const port = controller({ currentView: () => ({ document: { layers: [{ id: 3, name: "源" }, { id: 9, name: "目标" }] } }) });
  const layers = (port.features as unknown as { layers: Record<string, ReturnType<typeof vi.fn>> }).layers;
  const { container } = mount((readonly) => <StylePresetPanel controller={port} readonly={readonly} activeLayerId={3} />);

  const targetSelect = container.querySelector<HTMLSelectElement>("[data-style-target]")!;
  expect(button(container, "复制效果到目标层").disabled).toBe(true);
  act(() => { targetSelect.value = "9"; targetSelect.dispatchEvent(new Event("change", { bubbles: true })); });
  act(() => button(container, "复制效果到目标层").click());
  expect(layers.layerCommand).toHaveBeenLastCalledWith("layer.layerStyle.transferEffects", { from: 3, to: 9, copy: true });
  act(() => button(container, "移动效果到目标层").click());
  expect(layers.layerCommand).toHaveBeenLastCalledWith("layer.layerStyle.transferEffects", { from: 3, to: 9, copy: false });

  // 默认值：读回的是会话偏好（`presets.params`），改 JSON 后写回。
  layers.stylePresets = vi.fn((id: string, params: Record<string, unknown>) => id === "layer.layerStyle.defaultFor"
    ? { ok: true, value: { changed: false, presetsRevision: 1, presets: { params: { distance: 5, color: "#000000" }, user: false } } }
    : { ok: true, value: { changed: false, presetsRevision: 2, presets: { kind: params.kind } } });
  act(() => button(container, "读取默认值").click());
  const textarea = container.querySelector<HTMLTextAreaElement>("[data-effect-defaults='dropShadow']")!;
  expect(textarea.value).toContain("\"distance\": 5");
  expect(container.textContent).toContain("出厂默认");

  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "{\"distance\": 12}");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => button(container, "设为该效果默认").click());
  // 保存后会立刻读回默认值，因此这里断言「发过」，而不是「最后一次」。
  expect(layers.stylePresets).toHaveBeenCalledWith("layer.layerStyle.makeDefault", { kind: "dropShadow", params: { distance: 12 } });

  // 非法 JSON 在面板就被拦下，不发往内核。
  const calls = (layers.stylePresets as ReturnType<typeof vi.fn>).mock.calls.length;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "{oops");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => button(container, "设为该效果默认").click());
  expect((layers.stylePresets as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  expect(container.textContent).toContain("不是合法 JSON");
});
