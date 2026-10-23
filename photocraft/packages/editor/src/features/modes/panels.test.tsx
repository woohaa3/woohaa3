/** @vitest-environment jsdom */
// 只验证面板接线与门禁（不采集 canvas 像素；像素结果由 Rust 域测试覆盖）。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import type { FeaturePanelContext } from "../panel-context.js";
import { IMAGE_MODE_TARGETS, type ImageModePlan } from "./mode-data.js";
import { ModesPanel } from "./panels.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 没有 canvas 实现：本文件只验证接线，把 `getContext` 换成空实现避免噪声。
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const pixels = (width: number, height: number) => {
  const bytes = new Uint8Array(width * height * 4).fill(128);
  return { width, height, pixels: bytes };
};

const modeInfo = (overrides: Record<string, unknown> = {}) => ({
  mode: "rgb",
  rawMode: "Rgb",
  depth: 8,
  colorTable: null,
  duotone: null,
  layers: 1,
  targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: id !== "rgb", reason: id === "rgb" ? "当前已是 RGB 颜色" : null })),
  revision: 3,
  contentHash: "hash-3",
  readOnly: false,
  trap: { available: false, requires: "cmyk", reason: "陷印是 CMYK 印前步骤" },
  ...overrides
});

const modePlan = (overrides: Partial<ImageModePlan> = {}): ImageModePlan => ({
  report: {
    target: "grayscale", label: "Grayscale", fromMode: "rgb", toMode: "grayscale", depth: 8,
    layersBefore: 1, layersAfter: 1, flattened: false, dropped: {}, lossy: false,
    colorCount: null, colors: null, transparentIndex: null, inks: null,
    notes: ["转换为灰度合并颜色通道，图层与蒙版保留。"], changed: true
  },
  preview: pixels(4, 4),
  baseRevision: 3,
  baseContentHash: "hash-3",
  changed: true,
  ...overrides
});

function setup(info: Record<string, unknown> = {}, owner: { documentId: string | null; generation: number } = { documentId: null, generation: 0 }) {
  const modes = {
    modeInfo: vi.fn(() => ({ ok: true as const, value: modeInfo(info) })),
    planMode: vi.fn(() => ({ ok: true as const, value: modePlan() })),
    applyMode: vi.fn(() => ({ ok: true as const, value: modePlan({ committed: true }) })),
    planColorTable: vi.fn(() => ({ ok: true as const, value: modePlan({ report: { ...modePlan().report, target: "color-table", label: "Color Table" } }) })),
    applyColorTable: vi.fn(() => ({ ok: true as const, value: modePlan({ committed: true }) }))
  };
  const controller = { features: { modes }, documentOwner: () => currentOwner } as unknown as EditorWorkspaceController;
  let currentOwner = owner;
  const refreshPreview = vi.fn();
  const setMessage = vi.fn();
  const documentView = (): NonNullable<FeaturePanelContext["documentView"]> => ({
    channelTarget: { kind: "composite" },

    name: "test", width: 8, height: 8, mode: "Rgb", depthBits: 8, activeLayerId: 1, selectedLayerIds: [1],
    hasSelection: false, editTarget: "pixels", maskView: null, transformFrame: null, selectionOutline: [],
    selectionFrame: null, canUndo: false, canRedo: false, revision: 3, history: [], redoHistory: [], layers: []
  });
  const context: FeaturePanelContext = {
    readonly: false,

    controller,
    locked: false,
    documentView: documentView(),
    activeLayer: undefined,
    activeLayerId: null,
    colors: { foreground: "#000000" },
    brush: { color: "#000000" },
    refreshPreview,
    updateAids: vi.fn(),
    retouchTool: "clone",
    retouchSample: null,
    retouchAligned: false,
    setRetouchAligned: vi.fn(),
    setMessage
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<ModesPanel {...context} />));
  /** 换一份文档重渲染（修订号可相同；可同时换归属）。 */
  const rerenderWithDocument = (
    patch: Partial<NonNullable<FeaturePanelContext["documentView"]>>,
    nextOwner?: { documentId: string | null; generation: number }
  ) => {
    if (nextOwner) currentOwner = nextOwner;
    act(() => root!.render(<ModesPanel {...context} documentView={{ ...documentView(), ...patch }} />));
  };
  return { container, modes, refreshPreview, setMessage, rerenderWithDocument };
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent?.includes(label))!;

/** 受控输入必须走原生 value setter 再派发 `input`，否则 React 的 value tracker 会吞掉改动。 */
const setInput = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

it("renders the real mode readout and keeps trap closed with a reason", () => {
  const { container, modes } = setup();
  expect(modes.modeInfo).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[data-mode-readout]")?.textContent).toContain("RGB");
  expect(container.querySelector("[data-mode-readout]")?.textContent).toContain("修订 3");
  const trap = container.querySelector("[data-trap]");
  expect(trap?.getAttribute("data-trap")).toBe("closed");
  expect(trap?.textContent).toContain("CMYK");
  expect((button(container, "陷印") as HTMLButtonElement).disabled).toBe(true);
});

it("explains that a bitmap document's reported depth is the channel sample depth", () => {
  const rgb = setup();
  // RGB 文档不该出现位图专用说明。
  expect(rgb.container.querySelector("[data-mode-bitmap-depth]")).toBeNull();
  act(() => rgb.container.remove());
  act(() => root?.unmount());
  root = null;
  const bitmap = setup({ mode: "bitmap", rawMode: "Bitmap" });
  const note = bitmap.container.querySelector("[data-mode-bitmap-depth]");
  expect(note?.textContent).toContain("1 位/像素");
  // 说明和读数并列出现，不能只改文案而不报真实深度。
  expect(bitmap.container.querySelector("[data-mode-readout]")?.textContent).toContain("8 位/通道");
});

it("previews and confirms only the previewed parameters", () => {
  const { container, modes, refreshPreview, setMessage } = setup();
  act(() => button(container, "预览").click());
  expect(modes.planMode).toHaveBeenLastCalledWith("grayscale", {});
  expect(container.querySelector("[data-mode-preview]")).not.toBeNull();
  expect(container.querySelector("[data-mode-report]")?.textContent).toContain("8 位/通道");

  act(() => button(container, "确认").click());
  expect(modes.applyMode).toHaveBeenCalledTimes(1);
  const [appliedTarget, appliedPlan, appliedParams] = modes.applyMode.mock.calls[0] as unknown as [string, ImageModePlan, Record<string, unknown>];
  expect(appliedTarget).toBe("grayscale");
  expect(appliedPlan.baseRevision).toBe(3);
  expect(appliedPlan.baseContentHash).toBe("hash-3");
  expect(appliedParams).toEqual({});
  expect(refreshPreview).toHaveBeenCalledTimes(1);
  expect(setMessage).toHaveBeenCalledWith("已转换为灰度");
});

it("invalidates the preview when a parameter changes so a stale candidate cannot commit", () => {
  const { container, modes } = setup();
  act(() => button(container, "预览").click());
  expect(container.querySelector("[data-mode-preview]")).not.toBeNull();

  const target = container.querySelector("select")!;
  act(() => {
    target.value = "indexed";
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.querySelector("[data-mode-preview]")).toBeNull();
  expect((button(container, "确认") as HTMLButtonElement).disabled).toBe(true);
  expect(modes.applyMode).not.toHaveBeenCalled();
});

it("explains a blocked target instead of offering a preview", () => {
  const { container } = setup();
  const target = container.querySelector("select")!;
  // rgb 在 RGB 文档里不可用：选中后必须给出原因，并禁用预览。
  // 不可用目标仍可选择（否则用户永远看不到原因，等于占位）。
  expect(container.querySelector("[data-mode-target-available='false']")).not.toBeNull();
  act(() => {
    target.value = "rgb";
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.querySelector("[data-mode-blocked]")?.textContent).toContain("RGB");
  expect((button(container, "预览") as HTMLButtonElement).disabled).toBe(true);
});

it("opens on a usable target instead of a blocked default", () => {
  // 灰度文档里「灰度」不可用：面板默认停在灰度会让预览一进来就是禁用状态，像是坏了。
  const { container } = setup({
    mode: "grayscale",
    targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: id !== "grayscale", reason: id === "grayscale" ? "当前已是灰度" : null }))
  });
  const target = container.querySelector("select") as HTMLSelectElement;
  expect(target.value).toBe("rgb");
  expect(container.querySelector("[data-mode-blocked]")).toBeNull();
  expect((button(container, "预览") as HTMLButtonElement).disabled).toBe(false);
});

it("does not keep re-correcting a target the user picked on purpose", () => {
  // 纠正只针对首次打开：用户选一个不可用目标来读原因后，普通编辑（修订变化）不该把它顶掉。
  const { container, rerenderWithDocument } = setup({
    mode: "grayscale",
    targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: id !== "grayscale", reason: id === "grayscale" ? "当前已是灰度" : null }))
  });
  const target = container.querySelector("select")!;
  act(() => {
    target.value = "grayscale";
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.querySelector("[data-mode-blocked]")?.textContent).toContain("灰度");
  rerenderWithDocument({ revision: 4 });
  // 仍是用户选的那个目标，原因照旧可见。
  expect((container.querySelector("select") as HTMLSelectElement).value).toBe("grayscale");
});

it("drops the pending preview when the document generation changes", () => {
  // 同名称/尺寸/修订的另一份文档，或关闭后重开的同一节点：预览必须作废，
  // 否则界面上留着一份不属于当前文档的报告（任务 3.3）。
  const { container, modes, rerenderWithDocument } = setup({}, { documentId: "doc-a", generation: 1 });
  act(() => button(container, "预览").click());
  expect(container.querySelector("[data-mode-preview]")).not.toBeNull();
  const callsBefore = modes.modeInfo.mock.calls.length;

  rerenderWithDocument({}, { documentId: "doc-a", generation: 2 });
  expect(modes.modeInfo.mock.calls.length).toBeGreaterThan(callsBefore);
  expect(container.querySelector("[data-mode-preview]")).toBeNull();
  // 换文档后必须重新预览才能确认。
  expect(button(container, "确认").hasAttribute("disabled")).toBe(true);
});

it("surfaces the export matrix instead of leaving PSD silently available outside RGB", () => {
  const { container } = setup({
    mode: "duotone",
    duotone: { inks: [{ name: "Black", color: "#000000", curve: [] }] },
    targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: id !== "duotone", reason: null }))
  });
  const hint = container.querySelector("[data-mode-export]")?.textContent ?? "";
  expect(hint).toContain("PNG 可用");
  expect(hint).toContain("工程 可用");
  // 共享 PSD 导出只接受 RGB/U8：双色调必须显示关闭及真实原因，不能承诺一个必然失败的入口。
  expect(hint).toContain("PSD 关闭");
  expect(hint).toContain("RGB/U8");
  expect(hint).toContain("双色调");
  expect(hint).not.toContain("往返未验收");

  const rgb = setup();
  expect(rgb.container.querySelector("[data-mode-export]")?.textContent).toContain("PSD 可用");

  // 灰度同样不能导出 PSD（内核在预检阶段拒绝非 RGB 文档）。
  const gray = setup({
    mode: "grayscale",
    targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: true, reason: null }))
  });
  const grayHint = gray.container.querySelector("[data-mode-export]")?.textContent ?? "";
  expect(grayHint).toContain("PSD 关闭");
  expect(grayHint).toContain("RGB/U8");
  expect(grayHint).toContain("PNG 可用");
});

it("edits a real color table and previews a preset replacement", () => {
  const { container, modes } = setup({
    mode: "indexed",
    colorTable: { colors: ["#000000", "#808080", "#ffffff"], transparent: null },
    targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: id !== "indexed", reason: null }))
  });
  const swatches = container.querySelectorAll("[data-color-swatch], [data-color-index]");
  expect(swatches).toHaveLength(3);
  expect(container.querySelector("[data-color-index='1']")?.getAttribute("data-color-value")).toBe("#808080");

  // 选第二个色块后改它 → 变成自定义表，并把整表交给内核。
  act(() => (container.querySelector("[data-color-index='1']") as HTMLButtonElement).click());
  expect(container.querySelector("[data-color-index='1']")?.getAttribute("data-color-selected")).toBe("true");
  const colorInputs = [...container.querySelectorAll("input[type='color']")] as HTMLInputElement[];
  const tableColor = colorInputs[0]!;
  setInput(tableColor, "#00ff00");
  setInput(tableColor, "#00ff00");
  act(() => button(container, "预览颜色表").click());
  // 面板只交参数；`maxSide` 由工作区会话补上（见 workspace.test.ts）。
  expect(modes.planColorTable).toHaveBeenLastCalledWith({
    colors: ["#000000", "#00ff00", "#ffffff"],
    transparent: null
  });

  // 预设整表替换只传 table，不把旧条目混进去。
  const preset = [...container.querySelectorAll("select")].at(-1)!;
  act(() => {
    preset.value = "grayscale";
    preset.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() => button(container, "预览颜色表").click());
  expect(modes.planColorTable).toHaveBeenLastCalledWith({ table: "grayscale", transparent: null });
});

it("drops a stale transparent index when a preset replaces the table", () => {
  // 预设会整表替换（web 只有 216 条）：保留旧的透明索引会被内核以「超出 0–215」拒绝，
  // 用户会看到一次必失败的预览。切到预设时必须清掉它。
  const { container, modes } = setup({
    mode: "indexed",
    colorTable: { colors: ["#000000", "#ffffff", "#808080"], transparent: 2 },
    targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: id !== "indexed", reason: null }))
  });
  const preset = [...container.querySelectorAll("select")].at(-1)!;
  act(() => {
    preset.value = "web";
    preset.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() => button(container, "预览颜色表").click());
  expect(modes.planColorTable).toHaveBeenLastCalledWith({ table: "web", transparent: null });

  // 切回自定义时交给用户重新指定，不会凭空补一个索引。
  act(() => {
    preset.value = "custom";
    preset.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() => button(container, "预览颜色表").click());
  expect(modes.planColorTable).toHaveBeenLastCalledWith({ colors: ["#000000", "#ffffff", "#808080"], transparent: null });
});

it("never offers a confirm that the kernel would reject as no-change", () => {
  // 内核在 `changed=false` 时返回 `no-change` 错误，而报告同时写着「确认不会新增历史」。
  // 两处说法必须一致：按钮应直接禁用，而不是让用户点出一条红色错误。
  const unchanged = modePlan({ changed: false, report: { ...modePlan().report, changed: false } });
  const { container, modes } = setup();
  modes.planMode.mockReturnValue({ ok: true as const, value: unchanged });
  act(() => button(container, "预览").click());
  expect(container.querySelector("[data-mode-preview]")).not.toBeNull();
  expect(container.textContent).toContain("确认不会新增历史");
  expect((button(container, "确认") as HTMLButtonElement).disabled).toBe(true);

  // 真的会改动时按钮仍可点。
  modes.planMode.mockReturnValue({ ok: true as const, value: modePlan() });
  act(() => button(container, "预览").click());
  expect((button(container, "确认") as HTMLButtonElement).disabled).toBe(false);
});

it("keeps a previewed color table valid while only switching the edited swatch", () => {
  // 点色块只改「正在编辑哪一格」，不改转换参数。旧实现把整个 `tableDraft` 当依赖，
  // 于是预览后点一下别的色块就把预览作废、「确认颜色表」变灰——用户看到一次无原因的失效。
  const { container } = setup({
    mode: "indexed",
    colorTable: { colors: ["#000000", "#808080", "#ffffff"], transparent: null },
    targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: id !== "indexed", reason: null }))
  });
  act(() => button(container, "预览颜色表").click());
  expect((button(container, "确认颜色表") as HTMLButtonElement).disabled).toBe(false);

  act(() => (container.querySelector("[data-color-index='2']") as HTMLButtonElement).click());
  expect(container.querySelector("[data-color-index='2']")?.getAttribute("data-color-selected")).toBe("true");
  expect((button(container, "确认颜色表") as HTMLButtonElement).disabled).toBe(false);

  // 但真的改了颜色就必须作废：确认时只能提交刚刚预览过的参数。
  const tableColor = [...container.querySelectorAll("input[type='color']")][0] as HTMLInputElement;
  setInput(tableColor, "#00ff00");
  expect((button(container, "确认颜色表") as HTMLButtonElement).disabled).toBe(true);
});

it("keeps the transparent index empty instead of silently setting index 0", () => {
  // 清空输入框时 `Number("") === 0`：旧实现会把「没有透明索引」悄悄改成索引 0，
  // 于是原本不透明的 0 号色变成透明孔。空串必须映射回 null。
  const { container, modes } = setup({
    mode: "indexed",
    colorTable: { colors: ["#000000", "#ffffff"], transparent: null },
    targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: id !== "indexed", reason: null }))
  });
  const transparent = [...container.querySelectorAll("input[type='number']")]
    .find((input) => (input as HTMLInputElement).max === "1") as HTMLInputElement;
  setInput(transparent, "1");
  act(() => button(container, "预览颜色表").click());
  expect(modes.planColorTable).toHaveBeenLastCalledWith({ colors: ["#000000", "#ffffff"], transparent: 1 });

  setInput(transparent, "");
  act(() => button(container, "预览颜色表").click());
  expect(modes.planColorTable).toHaveBeenLastCalledWith({ colors: ["#000000", "#ffffff"], transparent: null });
});

it("clears a duotone curve that drops below two points instead of leaving a phantom point", () => {
  // 内核 `parse_inks` 只在点数 ≥2 时采用曲线，1 点会静默退回恒等曲线；界面上留着那个点就成了假状态。
  const { container, modes } = setup({
    mode: "duotone",
    duotone: { inks: [
      { name: "Black", color: "#000000", curve: [[0, 0], [50, 40], [100, 90]] },
      { name: "Warm Brown", color: "#9e612e", curve: [[0, 0], [100, 100]] }
    ] },
    targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: true, reason: null }))
  });
  const target = container.querySelector("select")!;
  act(() => {
    target.value = "duotone";
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const curve = container.querySelector("[data-ink-curve='Black']")!;
  // 3 → 2：保留剩下两个点。
  act(() => (curve.querySelectorAll("button")[0] as HTMLButtonElement).click());
  act(() => button(container, "预览").click());
  let params = (modes.planMode.mock.calls.at(-1) as unknown as [string, { inks: { curve: [number, number][] }[] }])[1];
  expect(params.inks[0].curve).toHaveLength(2);

  // 2 → 1：不能留一个内核会忽略的点。
  const curveAgain = container.querySelector("[data-ink-curve='Black']")!;
  act(() => (curveAgain.querySelectorAll("button")[0] as HTMLButtonElement).click());
  act(() => button(container, "预览").click());
  params = (modes.planMode.mock.calls.at(-1) as unknown as [string, { inks: { curve: [number, number][] }[] }])[1];
  expect(params.inks[0].curve).toEqual([]);
});

it("never leaves an unsaveable curve when adding points", () => {
  // 与删除对称：内核只在点数 ≥2 时采用曲线。从空曲线添点若只补 1 点，界面会留下内核丢掉的点。
  const { container, modes } = setup({
    mode: "duotone",
    duotone: { inks: [
      { name: "Black", color: "#000000", curve: [] },
      { name: "Warm Brown", color: "#9e612e", curve: [[0, 0], [100, 100]] }
    ] },
    targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: true, reason: null }))
  });
  const target = container.querySelector("select")!;
  act(() => {
    target.value = "duotone";
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const curveOf = () => container.querySelector("[data-ink-curve='Black']")!;
  const addButton = () => [...curveOf().querySelectorAll("button")].at(-1) as HTMLButtonElement;

  // 空曲线 → 一次补成可保存的恒等曲线，不留 1 点。
  act(() => addButton().click());
  expect(curveOf().querySelectorAll("input[type='number']").length).toBe(4);
  act(() => button(container, "预览").click());
  let params = (modes.planMode.mock.calls.at(-1) as unknown as [string, { inks: { curve: [number, number][] }[] }])[1];
  expect(params.inks[0].curve).toEqual([[0, 0], [100, 100]]);

  // 已可保存时再添点照常追加。
  act(() => addButton().click());
  act(() => button(container, "预览").click());
  params = (modes.planMode.mock.calls.at(-1) as unknown as [string, { inks: { curve: [number, number][] }[] }])[1];
  expect(params.inks[0].curve).toHaveLength(3);
});

it("renders duotone ink editors and sends the edited inks", () => {
  const { container, modes } = setup({
    mode: "grayscale",
    targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: true, reason: null }))
  });
  const target = container.querySelector("select")!;
  act(() => {
    target.value = "duotone";
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const inks = container.querySelectorAll("[data-duotone-ink]");
  expect(inks).toHaveLength(2);

  const name = inks[0].querySelector("input[type='text']") as HTMLInputElement;
  setInput(name, "Warm");
  act(() => button(container, "预览").click());
  const params = (modes.planMode.mock.calls.at(-1) as unknown as [string, { type: string; inks: { name: string; color: string }[] }])[1];
  expect(params.type).toBe("duotone");
  // 新建双色调时用与内核同名的默认油墨（Black / Warm Brown）。
  expect(params.inks.map((ink) => ink.name)).toEqual(["Warm", "Warm Brown"]);
});

it("loads the document's real inks instead of overwriting them with defaults", () => {
  // 打开已有的双色调文档时，确认必须沿用文档里的油墨；否则一次确认就会静默替换用户油墨。
  const inks = [
    { name: "Iron", color: "#111111", curve: [[0, 0], [100, 90]] },
    { name: "Gold", color: "#aaaa33", curve: [] },
    { name: "Slate", color: "#334455", curve: [] }
  ];
  const { container, modes } = setup({
    mode: "duotone",
    duotone: { inks },
    targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: true, reason: null }))
  });
  const target = container.querySelector("select")!;
  act(() => {
    target.value = "duotone";
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const rendered = [...container.querySelectorAll("[data-duotone-ink]")];
  expect(rendered).toHaveLength(3);
  expect((rendered[0].querySelector("input[type='text']") as HTMLInputElement).value).toBe("Iron");
  expect((rendered[1].querySelector("input[type='text']") as HTMLInputElement).value).toBe("Gold");
  // 类型由油墨数量推导：3 种 → 三色调。
  const type = [...container.querySelectorAll("select")].at(-1) as HTMLSelectElement;
  expect(type.value).toBe("tritone");

  act(() => button(container, "预览").click());
  const params = (modes.planMode.mock.calls.at(-1) as unknown as [string, { type: string; inks: typeof inks }])[1];
  expect(params.type).toBe("tritone");
  expect(params.inks).toEqual(inks);
});

it("drops the preview when the document switches without a revision change", () => {
  // 两份新文档都可能是修订 3：切文档时只靠修订号不会重取，旧预览会留着。
  const { container, rerenderWithDocument } = setup();
  act(() => button(container, "预览").click());
  expect(container.querySelector("[data-mode-preview]")).not.toBeNull();

  rerenderWithDocument({ name: "other" });
  expect(container.querySelector("[data-mode-preview]")).toBeNull();
  expect((button(container, "确认") as HTMLButtonElement).disabled).toBe(true);
});

it("states that the tool matrix is kernel-enforced now that the cross-domain gate is wired", () => {
  const { container } = setup({
    mode: "indexed",
    colorTable: { colors: ["#000000", "#ffffff"], transparent: null },
    targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: id !== "indexed", reason: null }))
  });
  const section = container.querySelector("[data-mode-tools='indexed']");
  expect(section?.querySelector("[data-mode-tools-closed='enforced']")?.textContent).toContain("当前模式不可用");
  // 门禁已接通：文案必须陈述既成事实，不能再留「尚未接通」的旧说法。
  expect(section?.querySelector("[data-mode-tools-gate='enforced']")?.textContent).toContain("由内核强制");
  expect(section?.textContent).not.toContain("尚未接通");
  expect(section?.textContent).not.toContain("建议保持关闭");

  // RGB 全部可用时既没有关闭项，也没有门禁说明。
  const rgb = setup();
  expect(rgb.container.querySelector("[data-mode-tools-closed='enforced']")).toBeNull();
  expect(rgb.container.querySelector("[data-mode-tools-gate='enforced']")).toBeNull();
});

it("does not judge tools or exports for color models outside this change's scope", () => {
  // CMYK/Lab：实测绘制、文字、工程保存与 PNG 导出都正常，只有 PSD 被共享预检拒绝。
  // 面板既不能说「全部工具可用」（越权），也不能说「建议保持关闭」（假的）。
  const { container } = setup({
    mode: null,
    rawMode: "Cmyk",
    targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: false, reason: "当前色彩模型不在本次模式范围" }))
  });
  const tools = container.querySelector("[data-mode-tools='unsupported']");
  expect(tools?.querySelector("[data-mode-tools-gate='out-of-scope']")?.textContent).toContain("本域不判定工具支持");
  expect(tools?.querySelector("[data-mode-tools-closed='enforced']")).toBeNull();
  expect(tools?.querySelector("[data-mode-tools-gate='enforced']")).toBeNull();
  expect(tools?.querySelector("[data-mode-tools-gate='pending']")).toBeNull();
  expect(tools?.textContent).not.toContain("全部工具可用");

  const summary = container.querySelector("[data-mode-export='unsupported']")?.textContent ?? "";
  expect(summary).toContain("PNG 不做判定");
  expect(summary).toContain("工程 不做判定");
  // PSD 是真实预检结果，仍然明确关闭。
  expect(summary).toContain("PSD 关闭");
  expect(summary).not.toContain("PNG 关闭");
});

it("reports the transport error and keeps no preview when planning fails", () => {
  const { container, modes } = setup();
  modes.planMode.mockReturnValueOnce({ ok: false as never, code: "image.mode", message: "文档已变化，请重新预览后再确认" } as never);
  act(() => button(container, "预览").click());
  expect(container.querySelector("[data-mode-preview]")).toBeNull();
  expect(container.querySelector("[data-mode-message='error']")?.textContent).toBe("文档已变化，请重新预览后再确认");
  expect((button(container, "确认") as HTMLButtonElement).disabled).toBe(true);
});
