/**
 * BrushPresetPicker 渲染循环回归
 * @vitest-environment jsdom
 *
 * 真实缺陷链（2026-10-22 实施后回归）：
 *
 * 1. `PhotoEditorApp` 里 `brush` 每次渲染都是新对象（`usePaintTools` 内 `{...settings[current]}`）；
 * 2. `BrushPresetPicker` 有 `useEffect(() => setDynamics(dynamicsFromBrush(brush)), [brush])`；
 * 3. `dynamicsFromBrush` 每次返回**新对象**，于是 effect 每次都 setState；
 * 4. setState 触发重渲染 → 步骤 1 再造新 `brush` → effect 再跑：**无限渲染**。
 *
 * React 达到更新上限后抛 "Maximum update depth exceeded"，错误被上层捕获并把界面重置，
 * 表现为用户看到"闪过一个报错，工具自动切回选框"（`tool` 的初始值就是 `marquee`）。
 *
 * 修复要求：只有**真正内核参数变化**时才更新面板状态（按值比较，而不是按引用）。
 */
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { BrushPresetPicker } from "./brush-panels.js";
import type { BrushLibraryController, BrushLibraryState } from "./brush-library-state.js";
import { DEFAULT_BRUSH } from "./photo-editor-tools.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

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
    preview: () => null,
    restore: async () => undefined
  } as unknown as BrushLibraryController;
}

describe("笔刷面板渲染循环（真实缺陷复现）", () => {
  it("从工具栏打开独立预设弹层，选择后关闭并回传预设",()=>{
    const controller=stubLibrary(),onPick=vi.fn();
    const container=document.createElement("div");document.body.append(container);
    const root=createRoot(container);
    try {
      act(()=>root.render(<BrushPresetPicker controller={controller} brush={DEFAULT_BRUSH} onPick={onPick} onBrush={vi.fn()}/>));
      act(()=>container.querySelector<HTMLButtonElement>('[title="选择笔刷预设"]')!.click());
      const preset=document.querySelector<HTMLButtonElement>('[data-brush-preset="Hard Round"] > button')!;
      expect(preset).not.toBeNull();expect(container.contains(preset)).toBe(false);
      act(()=>preset.click());expect(onPick).toHaveBeenCalledWith("Hard Round");
      expect(document.querySelector(".photo-editor__brush-menu")).toBeNull();
    } finally {act(()=>root.unmount());container.remove();}
  });
  it("父组件每次渲染都新建 brush 时不得触发 maximum update depth", () => {
    const controller = stubLibrary();
    let renders = 0;
    const errors: string[] = [];
    const Probe = () => {
      // 复刻 usePaintTools：每次渲染都造新对象，内容不变但引用一定不同。
      const brush = { ...DEFAULT_BRUSH };
      renders += 1;
      return <BrushPresetPicker controller={controller} brush={brush} disabled={false} onPick={vi.fn()} onBrush={vi.fn()} />;
    };
    const container = document.createElement("div");
    document.body.append(container);
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    try {
      const root = createRoot(container);
      act(() => root.render(<Probe />));
      root.unmount();
    } finally {
      console.error = originalError;
      container.remove();
    }
    expect(errors.filter((entry) => entry.includes("Maximum update depth"))).toEqual([]);
    expect(renders).toBeLessThan(50);
  });
});
