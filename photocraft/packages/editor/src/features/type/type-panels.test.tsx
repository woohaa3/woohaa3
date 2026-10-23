/** @vitest-environment jsdom */
/**
 * 文字面板接线回归（change: 2026-10-22-add-photocraft-typography-workflows）。
 *
 * 只检查真实 DOM 上的入口接线：单一「字符与段落」段落渲染五个面板、参数经域会话发出、
 * 只读与无文字层时入口禁用、查询失败时把内核原因显示出来。不创建内核，也不截图。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { EditorWorkspaceController, EditorSnapshot } from "../../editor-workspace.js";
import { sections } from "./sections.js";
import { feature } from "./index.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function setup(options: { locked?: boolean; kind?: "text" | "pixel"; queryFails?: boolean; layerLocked?: boolean; noLayerId?: boolean } = {}) {
  const calls: { command: string; params: Record<string, unknown> }[] = [];
  const queries: { query: string; params: Record<string, unknown> }[] = [];
  const type = {
    applyTypography: vi.fn((_params: Record<string, unknown>) => ({ ok: true, value: {} })),
    checkFont: vi.fn(() => ({ ok: true, value: {} })),
    typeCommand: vi.fn((id: string, params: Record<string, unknown>) => {
      calls.push({ command: id, params });
      return { ok: true, value: { result: { count: 1 }, changed: true } };
    }),
    typeQuery: vi.fn((id: string, params: Record<string, unknown>) => {
      queries.push({ query: id, params });
      if (options.queryFails) return { ok: false, code: "command-failed", message: "内核拒绝" };
      if (id.endsWith(".list")) {
        return { ok: true, value: { styles: [{ id: 1, name: "标题" }], current: { character: 2, paragraph: null } } };
      }
      if (id === "type.info") return { ok: true, value: { runs: [{ style: { ligatures: false, features: [{ tag: "frac", value: 1 }] } }] } };
      if (id === "edit.checkSpelling") return { ok: true, value: { misspellings: [{ layer: 1, start: 0, end: 3, word: "teh", suggestions: ["the"] }] } };
      if (id === "type.resolveMissingFonts") return { ok: true, value: { missing: ["Gone"] } };
      return { ok: true, value: {} };
    })
  };
  const snapshot = { view: { document: { revision: 3 } } } as unknown as EditorSnapshot;
  const controller = { features: { type }, snapshot: () => snapshot } as unknown as EditorWorkspaceController;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const activeLayer = {
    id: 5,
    kind: options.kind ?? "text",
    name: "文字",
    effectiveLocks: { all: options.layerLocked ?? false, transparency: false, pixels: false, position: false, artboard: false }
  };
  act(() => root!.render(<>{sections[0]!.render({
    readonly: false,

    controller,
    locked: options.locked ?? false,
    documentView: snapshot.view.document as never,
    activeLayer: activeLayer as never,
    activeLayerId: options.noLayerId ? null : 5,
    colors: { foreground: "#000000" },
    brush: { color: "#000000" },
    refreshPreview: vi.fn(),
    updateAids: vi.fn(),
    retouchTool: "heal",
    retouchSample: null,
    retouchAligned: true,
    setRetouchAligned: vi.fn(),
    setMessage: vi.fn()
  })}</>));
  return { container, controller, type, calls, queries };
}

const byText = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text)!;

it("单一「字符与段落」入口按顺序渲染五个面板，并保持唯一 section", () => {
  const { container } = setup();
  expect(sections).toHaveLength(1);
  expect(sections[0]!.id).toBe("typography");
  expect(feature.sections).toBe(sections);
  const groups = [...container.querySelectorAll<HTMLElement>(".photo-editor__advanced-group")];
  expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["排版", "样式库", "OpenType", "文字外观与转换", "文字工具"]);
  expect(container.querySelector("[data-typography]")).not.toBeNull();
  expect(container.querySelector("[data-type-opentype]")).not.toBeNull();
  expect(container.querySelector("[data-type-tools]")).not.toBeNull();
});

it("样式列表与 OpenType 状态在渲染期之后由查询取回，不在渲染期发内核调用", () => {
  const { container, queries } = setup();
  expect(queries.some((entry) => entry.query === "type.characterStyle.list")).toBe(true);
  expect(queries.some((entry) => entry.query === "type.info")).toBe(true);
  const styleSelect = container.querySelectorAll<HTMLSelectElement>('[data-type-styles] select')[1]!;
  expect([...styleSelect.options].map((option) => option.textContent)).toEqual(["（当前：2）", "标题"]);
  // 标准连字被内核关掉、分数打开：复选框状态来自 type.info。
  const boxes = [...container.querySelectorAll<HTMLInputElement>('[data-type-opentype] input[type="checkbox"]')];
  expect(boxes[0]!.checked).toBe(false);
  expect(boxes.at(-1)!.checked).toBe(true);
});

it("排版按钮把参数发给域会话，Warp/蒙版/替换走白名单命令", () => {
  const { container, type, calls } = setup();
  act(() => byText(container, "应用排版").click());
  // 行距初值是「自动」（`null`），因此**不发** `leading`：发 `leading:0` 会把行高压成 0pt，
  // 也会让「只点了应用排版」被判成内容变化。
  expect(type.applyTypography).toHaveBeenLastCalledWith({ tracking: 0, baselineShift: 0, kerning: "metrics", layer: 5 });
  act(() => byText(container, "调整该字符对").click());
  expect(type.applyTypography).toHaveBeenLastCalledWith({ kernPair: { at: 1, by: 0 }, layer: 5 });

  act(() => byText(container, "应用变形").click());
  act(() => byText(container, "取消变形").click());
  act(() => byText(container, "转换为形状").click());
  act(() => byText(container, "用字形建立选区").click());
  const findInput = container.querySelector<HTMLInputElement>('[data-type-tools] input:not([type="checkbox"])')!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(findInput, "旧");
    findInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => byText(container, "全部替换").click());
  expect(calls.map((call) => call.command)).toEqual([
    "type.warpText",
    "type.warpText",
    "type.convertToShape",
    "type.createSelection",
    "edit.findAndReplaceText"
  ]);
  expect(calls[0]!.params).toEqual({ style: "arc", bend: 50, horizontalDistortion: 0, verticalDistortion: 0, layer: 5 });
  expect(calls[1]!.params).toEqual({ style: "none", layer: 5 });
  expect(calls[3]!.params).toEqual({ layer: 5 });
});

it("行距留空表示自动行距，不把 0pt 当成用户输入", () => {
  // 上游 `type.setStyle` 的 `leading:0` 是「行高 0pt」，不是「回到自动」；自动行距是
  // `leading:null`/`"auto"`。初值若写成 0，用户只点一下「应用排版」就会把内容判脏。
  const { container, type } = setup();
  const leading = container.querySelectorAll<HTMLInputElement>('[data-typography] input[type="number"]')[0]!;
  expect(leading.value).toBe("");
  expect(leading.placeholder).toBe("自动");
  act(() => byText(container, "应用排版").click());
  expect(type.applyTypography).toHaveBeenLastCalledWith({
    tracking: 0,
    baselineShift: 0,
    kerning: "metrics",
    layer: 5
  });
  // 真填了数字才带上这个键。
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(leading, "42");
    leading.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => byText(container, "应用排版").click());
  expect(type.applyTypography).toHaveBeenLastCalledWith({
    leading: 42,
    tracking: 0,
    baselineShift: 0,
    kerning: "metrics",
    layer: 5
  });
  // 再清空回到自动行距：不发送这个键。
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(leading, "");
    leading.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => byText(container, "应用排版").click());
  expect(type.applyTypography.mock.lastCall?.[0]).not.toHaveProperty("leading");
});

it("只读与无文字层时禁用入口，查询失败显示内核原因", () => {
  const readonly = setup({
 locked: true }).container;
  for (const button of readonly.querySelectorAll<HTMLButtonElement>("button")) expect(button.disabled).toBe(true);
  for (const input of readonly.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")) expect(input.disabled).toBe(true);

  const pixel = setup({ kind: "pixel" }).container;
  expect(pixel.textContent).toContain("选择文字图层");
  // 没有可用图层 id 时只能建空样式，按钮文案不能声称「采用当前格式」。
  const noId = setup({ noLayerId: true }).container;
  expect(byText(noId, "新建空样式")).toBeTruthy();
  expect(noId.textContent).not.toContain("新建并采用当前格式");

  const failed = setup({ queryFails: true }).container;
  expect(failed.textContent).toContain("内核拒绝");
});

/**
 * 样式库的每条命令都要有真实界面入口：本次就发现 `duplicate` 与选项 `set` 曾被漏接
 * （清单与内核都登记了，面板却没有按钮）。这里按真实 DOM 点击，断言命令与参数。
 */
it("样式库提供复制与样式选项入口，参数按已填字段发出", () => {
  const { container, type, calls } = setup();
  // 选中列表里的「标题」（id 1），后续按钮才对已选样式生效。
  const styleSelect = container.querySelectorAll<HTMLSelectElement>('[data-type-styles] select')[1]!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(styleSelect, "1");
    styleSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });

  act(() => byText(container, "复制样式").click());
  expect(calls.at(-1)?.command).toBe("type.characterStyle.duplicate");
  expect(calls.at(-1)?.params).toEqual({ id: 1 });

  // 只填「字号」：不能把空字段当 0 一起发出去。
  const sizeInput = [...container.querySelectorAll<HTMLLabelElement>("[data-type-styles] label")]
    .find((label) => label.textContent?.startsWith("字号"))!
    .querySelector("input")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(sizeInput, "48");
    sizeInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => byText(container, "修改样式选项").click());
  expect(calls.at(-1)?.command).toBe("type.characterStyle.set");
  expect(calls.at(-1)?.params).toEqual({ id: 1, attrs: { size: 48 } });

  // 段落样式用同一套控件，但只提供段落属性；切换类别会清空选择，需重新选中。
  const kindSelect = container.querySelectorAll<HTMLSelectElement>('[data-type-styles] select')[0]!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(kindSelect, "paragraphStyle");
    kindSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // 段落类别下没有「字号」输入，只有段落属性。
  const labels = [...container.querySelectorAll<HTMLLabelElement>("[data-type-styles] label")].map((label) => label.textContent ?? "");
  expect(labels.some((text) => text.startsWith("字号"))).toBe(false);
  expect(labels.some((text) => text.startsWith("段前"))).toBe(true);

  const paragraphSelect = container.querySelectorAll<HTMLSelectElement>('[data-type-styles] select')[1]!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(paragraphSelect, "1");
    paragraphSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() => byText(container, "复制样式").click());
  expect(calls.at(-1)?.command).toBe("type.paragraphStyle.duplicate");
  expect(type.typeCommand).toHaveBeenCalled();
});

it("查找替换提供单向「替换当前」，字体列表走只读查询", () => {
  const { container, calls, queries } = setup();
  const inputs = container.querySelectorAll<HTMLInputElement>("[data-type-tools] input:not([type=\"checkbox\"])");
  const setValue = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  act(() => { setValue(inputs[0]!, "旧"); setValue(inputs[1]!, "新"); });
  act(() => byText(container, "替换当前").click());
  // 光标由「查找下一个」建立；这里只断言命令与参数，不断言结果文案。
  expect(calls.at(-1)?.command).toBe("edit.findAndReplaceText");
  expect(calls.at(-1)?.params).toEqual({ find: "旧", replace: "新", action: "change" });

  act(() => byText(container, "列出当前字族").click());
  expect(queries.some((entry) => entry.query === "type.fonts")).toBe(true);
});

it("文字图层全部锁定时禁用写入并说明原因，只读查询仍可用", () => {
  const { container, calls, queries } = setup({ layerLocked: true });
  expect(container.querySelector("[data-type-locked]")?.textContent).toContain("已全部锁定");
  const effects = container.querySelector<HTMLElement>("[data-type-effects]")!;
  for (const button of effects.querySelectorAll<HTMLButtonElement>("button")) expect(button.disabled).toBe(true);
  for (const box of container.querySelectorAll<HTMLInputElement>('[data-type-opentype] input[type="checkbox"]')) expect(box.disabled).toBe(true);

  // 字体替换改写文档里所有文字层，锁定时必须禁用并说明；纯列缺字体仍是只读，照常可用。
  expect(container.querySelector("[data-type-font-locked]")?.textContent).toContain("全部锁定");
  // 「查找下一个」还需要查询词；先填入，才能区分「因锁定禁用」与「因空输入禁用」。
  const findInput = container.querySelectorAll<HTMLInputElement>("[data-type-tools] input:not([type=\"checkbox\"])")[0]!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(findInput, "Type");
    findInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  for (const label of ["用字形建立选区", "建立选区并删除文字层", "全部替换", "按映射替换", "全部替换为默认字族"]) {
    expect(byText(container, label).disabled, label).toBe(true);
  }
  // 只读动作不受锁定影响：列缺字体、查找、拼写检查、列字族。
  for (const label of ["列出缺失字体", "查找下一个", "检查拼写", "列出当前字族"]) {
    expect(byText(container, label).disabled, label).toBe(false);
  }

  // 只读查询照常进行：锁定只挡写入。
  expect(queries.some((entry) => entry.query === "type.info")).toBe(true);
  expect(calls).toEqual([]);
});
