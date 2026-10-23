/**
 * 笔刷高级动态面板的装配回归（U30）
 * @vitest-environment jsdom
 *
 * 面板只做三件事：投影内核设置、编译补丁、显示失败原因。这里锁住两条最容易坏的行为：
 *
 * 1. 混合模式走 `paint.stroke` 顶层 `mode`（不是 `dynamics` 补丁）；
 * 2. 响应曲线非法输入**不写状态**（不把非法曲线送去内核改像素）。
 */
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { BrushPresetPicker, BrushQuickFields } from "./brush-panels.js";
import type { BrushLibraryController, BrushLibraryState } from "./brush-library-state.js";
import { DEFAULT_BRUSH } from "./tool-parameters.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function stubLibrary(): BrushLibraryController {
  const state: BrushLibraryState = {
    list: {
      presets: [{ name: "Hard Round", group: "round", folder: [], origin: "builtin", sampled: false }],
      count: 1,
      groups: [{ group: "round", count: 1 }]
    },
    current: "Hard Round",
    busy: false,
    persistence: "unsaved",
    message: null,
    report: null
  };
  return {
    subscribe: () => () => undefined,
    snapshot: () => state,
    select: () => true,
    brushSettings: () => ({ size: 24, hardness: 0.8 }),
    previewPreset: () => null,
    preview: () => null
  } as unknown as BrushLibraryController;
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
    unmount: () => { act(() => root.unmount()); container.remove(); }
  };
}

function changeValue(element: Element, value: string) {
  const node = element as HTMLInputElement | HTMLSelectElement;
  const prototype = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("U30 笔刷高级动态面板", () => {
  it("混合模式作为顶层 mode 回传，其余仍是 brush 补丁", () => {
    const onBrush = vi.fn();
    const view = render(<BrushQuickFields brush={DEFAULT_BRUSH} disabled={false} onBrush={onBrush} />);
    try {
      const select = view.find<HTMLSelectElement>("[data-brush-blend-mode]")!;
      expect(select.value).toBe("normal");
      act(() => changeValue(select, "colorDodge"));
      expect(onBrush).toHaveBeenCalledWith({ mode: "colorDodge" });
      // 尺寸仍走标量参数。
      act(() => changeValue(view.all<HTMLInputElement>('input[type="number"]')[0]!, "48"));
      expect(onBrush).toHaveBeenLastCalledWith({ size: 48 });
    } finally {
      view.unmount();
    }
  });

  it("笔刷设置里的纹理开关与曲线先校验再提交", () => {
    const onBrush = vi.fn();
    const view = render(
      <BrushPresetPicker controller={stubLibrary()} brush={DEFAULT_BRUSH} disabled={false} onPick={vi.fn()} onBrush={onBrush} />
    );
    try {
      act(() => view.find<HTMLButtonElement>('[title="选择笔刷预设"]')!.click());
      act(() => view.all<HTMLButtonElement>("button").find((button) => button.textContent === "笔刷设置")!.click());
      // Popover 走 portal：设置面板在 document.body 上，不在容器里。
      const texture = document.querySelector("[data-brush-texture]")!;
      expect(texture.getAttribute("data-brush-texture")).toBe("off");
      const enable = [...texture.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][0]!;
      act(() => enable.click());
      expect(onBrush).toHaveBeenCalled();
      const patch = onBrush.mock.calls.at(-1)![0] as Record<string, unknown>;
      expect((patch.texture as Record<string, unknown>).enabled).toBe(true);

      // 非法曲线：显示原因，但不再发出补丁（补丁里不能出现非法点集）。
      const curve = document.querySelector<HTMLInputElement>('[data-brush-curve="大小"]')!;
      const before = onBrush.mock.calls.length;
      act(() => changeValue(curve, "0,0; 2,3"));
      expect(onBrush.mock.calls.length).toBe(before);
      expect(document.body.textContent).toContain("曲线格式非法");

      // 合法曲线：写入 shapeDynamics.size.curve。
      act(() => changeValue(curve, "0,0; 0.5,0.2; 1,1"));
      const legal = onBrush.mock.calls.at(-1)![0] as Record<string, Record<string, Record<string, unknown>>>;
      expect(legal.shapeDynamics!.size!.curve).toEqual([[0, 0], [0.5, 0.2], [1, 1]]);
    } finally {
      view.unmount();
    }
  });
});
