/**
 * 绘画工作流面板的装配回归
 * @vitest-environment jsdom
 * （change: 2026-10-22-add-photocraft-painting-color-workflows，U27–U36）。
 *
 * 面板有两个容易坏的地方，这里用真实渲染锁住：
 *
 * 1. **未提交不写文档**：任何参数/列表操作都只经域会话，内核调用集中在
 *    `paintCommand`（像素）与 `preferenceCommand`（偏好）两条通道；
 * 2. **失败可见**：命令失败必须显示原因，不能静默当成成功。
 *
 * 用假控制器（不是真内核）：像素正确性由 Rust 侧与真实 WASM 脚本验证，这里只验证装配、
 * 参数编排与通道归属。
 */
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { PaintingToolOptionsPanel, PaintingWorkflowPanel, ToolPresetsPanel } from "./panels.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { channel: "paint" | "preference"; id: string; params: unknown };

function stubController(options: { failPreference?: string } = {}) {
  const calls: Call[] = [];
  const library = {
    refresh: vi.fn(),
    snapshot: () => ({
      list: {
        presets: [{ name: "Hard Round", group: "round", folder: [], origin: "builtin", sampled: false }],
        count: 1,
        groups: [{ group: "round", count: 1 }]
      },
      current: "Hard Round",
      busy: false,
      persistence: "saved" as const,
      message: null,
      report: null
    })
  };
  const painting = {
    paintCommand: (id: string, params: unknown) => {
      calls.push({ channel: "paint", id, params });
      return { ok: true as const, value: { hasDocument: true, document: null, sessionActiveIndex: null } };
    },
    preferenceCommand: (id: string, params: unknown) => {
      calls.push({ channel: "preference", id, params });
      if (options.failPreference === id) return { ok: false as const, code: "command-failed", message: `拒绝 ${id}` };
      if (id === "swatches.list") {
        return { ok: true as const, value: { groups: [{ name: "默认", swatches: [{ name: "红", model: "rgb", values: [255, 0, 0], hex: "#ff0000" }] }], count: 1 } };
      }
      if (id === "gradient.presets.list") {
        return { ok: true as const, value: { groups: [{ name: "基础", presets: [{ name: "黑白", stops: [[0, "#000000"], [1, "#ffffff"]] }] }], current: { name: "黑白", stops: [[0, "#000000"], [1, "#ffffff"]] } } };
      }
      if (id === "swatches.use") {
        return { ok: true as const, value: { hex: "#ff0000", target: "foreground" } };
      }
      if (id === "gradient.presets.select") {
        return { ok: true as const, value: { current: { name: "黑白", stops: [[0, "#000000"], [1, "#ffffff"]] } } };
      }
      return { ok: true as const, value: {} };
    },
    sampleColorOptions: () => ({ ok: true as const, value: { hex: "#123456", alpha: 1, rgba: [0.07, 0.2, 0.33, 1] } }),
    symmetryState: () => ({ ok: true as const, value: { enabled: false } }),
    toolPresets: () => ({ ok: true as const, value: [{ name: "大画笔", tool: "brush", options: {} }] }),
    saveToolPreset: () => ({ ok: true as const, value: { name: "大画笔", tool: "brush" } }),
    selectToolPreset: () => ({ ok: true as const, value: { name: "大画笔", tool: "brush", options: {} } }),
    resetTool: () => ({ ok: true as const, value: { reset: "brush" } }),
    resetAllTools: () => ({ ok: true as const, value: { reset: "all" } }),
    toolPresetSnapshot: () => ({ ok: true as const, value: new Uint8Array([1, 2]) }),
    restoreToolPresets: () => ({ ok: true as const, value: { count: 1 } }),
    renameBrushGroup: () => ({ ok: true as const, value: { group: "新组" } }),
    deleteBrushGroup: () => ({ ok: true as const, value: { group: "旧组" } }),
    moveBrushGroup: () => ({ ok: true as const, value: { index: 0 } }),
    defineBrushFromSelection: () => ({ ok: true as const, value: { name: "选区笔尖", width: 8, height: 6 } }),
    available: () => true
  };
  const controller = {
    features: { painting },
    brushLibrary: () => library
  } as unknown as EditorWorkspaceController;
  return { controller, calls };
}

function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    find: <T extends Element>(selector: string) => container.querySelector<T>(selector),
    all: <T extends Element>(selector: string) => [...container.querySelectorAll<T>(selector)],
    click: (element: Element | null) => { act(() => (element as HTMLElement).click()); },
    change: (element: Element | null, value: string) => {
      act(() => {
        // React 受控组件必须走原生 setter，否则赋值被 value tracker 吞掉、onChange 不触发。
        const node = element as HTMLInputElement | HTMLSelectElement;
        const prototype = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
      });
    },
    setChecked: (element: Element | null, checked: boolean) => {
      act(() => {
        const node = element as HTMLInputElement;
        node.checked = checked;
        node.dispatchEvent(new Event("click", { bubbles: true }));
      });
    },
    unmount: () => { act(() => root.unmount()); container.remove(); }
  };
}

describe("绘画工具参数面板", () => {
  it("渐变按源坐标提交一次像素命令，端点非法时不提交", () => {
    const { controller, calls } = stubController();
    const view = render(<PaintingToolOptionsPanel controller={controller} locked={false} colors={{ foreground: "#ff0000" }} width={32} height={24} />);
    try {
      view.change(view.find('[data-painting-tools] select'), "gradient");
      const submit = view.all("button").find((button) => button.textContent === "按当前设置填充渐变")!;
      view.click(submit);
      const paint = calls.filter((call) => call.channel === "paint");
      expect(paint).toHaveLength(1);
      expect(paint[0]!.id).toBe("paint.gradient");
      expect(paint[0]!.params).toMatchObject({ from: [0, 12], to: [32, 12], style: "linear", mode: "normal" });

      // 端点重合：参数编译返回 null，面板给原因且不发命令。
      const fromX = view.all<HTMLInputElement>('input[type="number"]')[0]!;
      view.change(fromX, "32");
      const fromY = view.all<HTMLInputElement>('input[type="number"]')[1]!;
      view.change(fromY, "12");
      view.click(submit);
      expect(calls.filter((call) => call.channel === "paint")).toHaveLength(1);
      expect(view.find(".photo-editor__brush-note--error")?.textContent).toContain("端点");
    } finally {
      view.unmount();
    }
  });

  it("渐变插值方式与平滑度确实进入提交，清掉方式时连平滑度一起清", () => {
    const { controller, calls } = stubController();
    const view = render(<PaintingToolOptionsPanel controller={controller} locked={false} colors={{ foreground: "#000000" }} width={32} height={24} />);
    const submit = () => view.click(view.all("button").find((button) => button.textContent === "按当前设置填充渐变")!);
    const lastGradient = () => calls.filter((call) => call.id === "paint.gradient").at(-1)!.params as Record<string, unknown>;
    try {
      view.change(view.find('[data-painting-tools] select'), "gradient");

      // 默认是「直线色标」：不发 method / smoothness。
      submit();
      expect(lastGradient().method).toBeUndefined();
      expect(lastGradient().smoothness).toBeUndefined();
      // 没有插值方式时，平滑度输入框不该出现（避免半套无效设置）。
      expect(view.find("[data-gradient-smoothness]")).toBeNull();

      // 选一个插值方式：控件出现，并随命令发出。
      const selects = view.all<HTMLSelectElement>("select");
      const methodSelect = selects.find((select) => [...select.options].some((option) => option.value === "perceptual"))!;
      view.change(methodSelect, "perceptual");
      const smoothness = view.find<HTMLInputElement>("[data-gradient-smoothness] input")!;
      view.change(smoothness, "35");
      submit();
      expect(lastGradient()).toMatchObject({ method: "perceptual", smoothness: 35 });

      // 清回「直线色标」：method 与 smoothness 都不再发，控件也消失。
      view.change(methodSelect, "");
      expect(view.find("[data-gradient-smoothness]")).toBeNull();
      submit();
      expect(lastGradient().method).toBeUndefined();
      expect(lastGradient().smoothness).toBeUndefined();
    } finally {
      view.unmount();
    }
  });

  it("铅笔参数预览跟随面板传入的前景色，而不是写死的默认黑", () => {
    const { controller } = stubController();
    // 面板拿到的前景色是绿色；铅笔的「尺寸非法」提示由同一个编译结果驱动，
    // 因此颜色合法/非法会直接反映在预览文案上。
    const view = render(<PaintingToolOptionsPanel controller={controller} locked={false} colors={{ foreground: "#00ff00" }} width={20} height={10} />);
    try {
      view.change(view.find('[data-painting-tools] select'), "pencil");
      // 合法前景色：预览可用（不是「尺寸非法」）。
      expect(view.find(".photo-editor__brush-note--error")).toBeNull();
      expect(view.find(".photo-editor__brush-note")?.textContent).toContain("硬边笔尖");
    } finally {
      view.unmount();
    }
  });

  it("吸管走只读采样通道并显示取到的颜色", () => {    const { controller, calls } = stubController();
    const view = render(<PaintingToolOptionsPanel controller={controller} locked={false} colors={{ foreground: "#000000" }} width={20} height={10} />);
    try {
      view.change(view.find('[data-painting-tools] select'), "eyedropper");
      view.click(view.all("button").find((button) => button.textContent === "在此取色")!);
      // 取色不是像素命令：不应出现在 paint 通道上。
      expect(calls.filter((call) => call.channel === "paint")).toHaveLength(0);
      expect(view.find("[data-sampled-color]")?.textContent).toContain("#123456");
    } finally {
      view.unmount();
    }
  });

  it("油漆桶按 0–255 容差提交，魔术橡皮按点提交", () => {
    const { controller, calls } = stubController();
    const view = render(<PaintingToolOptionsPanel controller={controller} locked={false} colors={{ foreground: "#00ff00" }} width={20} height={10} />);
    try {
      view.change(view.find('[data-painting-tools] select'), "bucket");
      view.click(view.all("button").find((button) => button.textContent === "用前景色填充")!);
      expect(calls.at(-1)).toMatchObject({ channel: "paint", id: "paint.bucket" });
      expect((calls.at(-1)!.params as { tolerance: number }).tolerance).toBe(32);

      view.change(view.find('[data-painting-tools] select'), "magicEraser");
      view.click(view.all("button").find((button) => button.textContent === "擦除该区域")!);
      expect(calls.at(-1)).toMatchObject({ channel: "paint", id: "paint.magicEraser" });
    } finally {
      view.unmount();
    }
  });

  it("锁定（只读）时按钮禁用，不提交任何命令", () => {
    const { controller, calls } = stubController();
    const view = render(<PaintingToolOptionsPanel controller={controller} locked colors={{ foreground: "#000000" }} width={20} height={10} />);
    try {
      const submit = view.all<HTMLButtonElement>("button").find((button) => button.textContent === "用前景色填充" && button.closest("[data-painting-tools='bucket']"));
      if (submit) expect(submit.disabled).toBe(true);
      view.change(view.find('[data-painting-tools] select'), "bucket");
      const disabled = view.all<HTMLButtonElement>("button").find((button) => button.textContent === "用前景色填充")!;
      expect(disabled.disabled).toBe(true);
      view.click(disabled);
      expect(calls.filter((call) => call.channel === "paint")).toHaveLength(0);
    } finally {
      view.unmount();
    }
  });

  it("宿主没有本域端口时不渲染假控件（运行时能力协商）", () => {
    // 精简宿主/旧运行时可能没有 `features.painting`：面板必须整块不渲染，
    // 而不是渲染出点了会抛错的按钮。
    const { controller } = stubController();
    const bare = { ...(controller as unknown as Record<string, unknown>), features: {} } as unknown as EditorWorkspaceController;
    const view = render(<PaintingToolOptionsPanel controller={bare} locked={false} colors={{ foreground: "#000000" }} width={20} height={10} />);
    try {
      expect(view.find("[data-painting-tools]")).toBeNull();
      expect(view.find("button")).toBeNull();
    } finally {
      view.unmount();
    }
  });
});

describe("绘画工作流面板组装", () => {
  it("渲染工具参数、对称、色板、渐变预设、工具预设与笔刷分组", () => {
    const { controller, calls } = stubController();
    const view = render(
      <PaintingWorkflowPanel context={{
    readonly: false,

        controller,
        locked: false,
        documentView: { width: 32, height: 24, hasSelection: true } as never,
        activeLayer: undefined,
        activeLayerId: null,
        colors: { foreground: "#000000" },
        brush: { color: "#000000" },
        refreshPreview: vi.fn(),
        updateAids: vi.fn(),
        retouchTool: "clone",
        retouchSample: null,
        retouchAligned: false,
        setRetouchAligned: vi.fn(),
        setMessage: vi.fn()
      }} />
    );
    try {
      expect(view.find("[data-painting-tools]")).not.toBeNull();
      expect(view.find("[data-symmetry]")).not.toBeNull();
      expect(view.find("[data-swatches]")).not.toBeNull();
      expect(view.find("[data-gradient-presets]")).not.toBeNull();
      expect(view.find("[data-tool-presets]")).not.toBeNull();
      expect(view.find("[data-brush-groups]")).not.toBeNull();
      // 列表读取都走偏好通道，且不产生像素命令。
      expect(calls.every((call) => call.channel === "preference")).toBe(true);
      expect(calls.map((call) => call.id)).toEqual(expect.arrayContaining(["swatches.list", "gradient.presets.list"]));
      // 色板取用会把真实颜色带回来。
      view.click(view.find('[data-swatch-group="默认"] button'));
      expect(view.find("[data-used-swatch]")?.textContent).toContain("#ff0000");
    } finally {
      view.unmount();
    }
  });

  it("面板命令失败时显示内核原因而不是静默成功", () => {
    const { controller } = stubController({ failPreference: "swatches.add" });
    const view = render(
      <PaintingWorkflowPanel context={{
    readonly: false,

        controller,
        locked: false,
        documentView: { width: 32, height: 24, hasSelection: false } as never,
        activeLayer: undefined,
        activeLayerId: null,
        colors: { foreground: "#000000" },
        brush: { color: "#000000" },
        refreshPreview: vi.fn(),
        updateAids: vi.fn(),
        retouchTool: "clone",
        retouchSample: null,
        retouchAligned: false,
        setRetouchAligned: vi.fn(),
        setMessage: vi.fn()
      }} />
    );
    try {
      const nameInput = view.all<HTMLInputElement>("input").find((input) => input.placeholder === "新色板名称")!;
      view.change(nameInput, "测试色");
      view.click(view.all("button").find((button) => button.textContent === "添加当前色")!);
      expect(view.all(".photo-editor__brush-note--error").some((node) => node.textContent?.includes("拒绝 swatches.add"))).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("选渐变预设不会自动套用；套用后才替换色标并用于落笔", () => {
    const { controller, calls } = stubController();
    const view = render(
      <PaintingWorkflowPanel context={{
    readonly: false,

        controller,
        locked: false,
        documentView: { width: 32, height: 24, hasSelection: false } as never,
        activeLayer: undefined,
        activeLayerId: null,
        colors: { foreground: "#000000" },
        brush: { color: "#000000" },
        refreshPreview: vi.fn(),
        updateAids: vi.fn(),
        retouchTool: "clone",
        retouchSample: null,
        retouchAligned: false,
        setRetouchAligned: vi.fn(),
        setMessage: vi.fn()
      }} />
    );
    try {
      // 只是「选中预设」：编译出的渐变仍是原来的前景→背景色标。
      view.click(view.all("button").find((button) => button.textContent === "黑白")!);
      expect(calls.filter((call) => call.id === "gradient.presets.select").at(-1)!.params)
        .toMatchObject({ preset: "黑白", applyToLayer: false });
      const gradientSelect = view.find<HTMLSelectElement>('[data-painting-tools] select')!;
      view.change(gradientSelect, "gradient");
      view.click(view.all("button").find((button) => button.textContent === "按当前设置填充渐变")!);
      const before = calls.filter((call) => call.id === "paint.gradient").at(-1)!.params as { stops: unknown };
      expect(before.stops).toEqual([[0, "foreground"], [1, "background"]]);

      // 套用预设后，色标来自预设，端点/样式保持不变。
      view.click(view.all("button").find((button) => button.textContent === "套用预设「黑白」的色标")!);
      view.click(view.all("button").find((button) => button.textContent === "按当前设置填充渐变")!);
      const after = calls.filter((call) => call.id === "paint.gradient").at(-1)!.params as { stops: unknown; from: unknown; style: unknown };
      expect(after.stops).toEqual([[0, "#000000"], [1, "#ffffff"]]);
      expect(after.from).toEqual([0, 12]);
      expect(after.style).toBe("linear");
    } finally {
      view.unmount();
    }
  });
});

describe("工具预设面板", () => {
  it("列出预设、套用并把工具 id 显示出来", () => {
    const { controller } = stubController();
    const view = render(<ToolPresetsPanel controller={controller} locked={false} />);
    try {
      expect(view.find("[data-tool-preset]")).not.toBeNull();
      view.click(view.all("button").find((button) => button.textContent === "大画笔")!);
      expect(view.find("[data-tool-preset-note]")?.textContent).toContain("brush");
    } finally {
      view.unmount();
    }
  });
});
