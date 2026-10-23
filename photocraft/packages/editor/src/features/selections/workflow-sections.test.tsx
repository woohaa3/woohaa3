/** @vitest-environment jsdom */
/**
 * U17–U24 在既有菜单分区里的装配回归。
 *
 * 共享外壳（`features/index.ts`、`photo-editor-app.tsx`、`boundaries.test.ts`）是结构前置的单一
 * 写入范围，本域不新增 section id 或工具 id。因此这里锁定的是：新入口确实挂在「选择」菜单的
 * 三个既有分区里，并且菜单项本身与真实工作流一致。
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { FeaturePanelContext } from "../panel-context.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import { sections } from "./sections.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ok(value: unknown = null) { return { ok: true as const, value }; }

/** 本域会话替身：全部 U17–U24 入口都在，行为只回最小的合法回执。 */
function session() {
  return {
    draftState: vi.fn(() => ok({ active: false })),
    selectLine: vi.fn(() => ok({ bounds: [0, 3, 100, 1] })),
    beginMagneticLasso: vi.fn(() => ok({ bounds: [1, 1, 10, 10], invalid: false })),
    updateMagneticLasso: vi.fn(() => ok({ bounds: [1, 1, 10, 10], invalid: false })),
    saveNamedSelection: vi.fn(() => ok({ saved: true })),
    loadNamedSelection: vi.fn(() => ok({ loaded: true })),
    beginColorGrow: vi.fn(() => ok({ bounds: [0, 0, 4, 4], invalid: false })),
    updateColorGrow: vi.fn(() => ok({ bounds: [0, 0, 4, 4], invalid: false })),
    beginQuickMask: vi.fn(() => ok({ quickMask: true })),
    paintQuickMask: vi.fn(() => ok({ strokes: 1 })),
    exitQuickMask: vi.fn(() => ok({ committed: true })),
    beginSmartSelect: vi.fn(() => ok({ bounds: [2, 2, 6, 6] })),
    beginColorRange: vi.fn(() => ok({ bounds: [0, 0, 8, 8], invalid: false })),
    updateColorRange: vi.fn(() => ok({ bounds: [0, 0, 9, 9], invalid: false })),
    beginRefineEdge: vi.fn(() => ok({ bounds: [0, 0, 8, 8], invalid: false })),
    updateRefineEdge: vi.fn(() => ok({ bounds: [0, 0, 8, 8], invalid: false })),
    editLayerMask: vi.fn(() => ok({ mask: { density: 30, feather: 4 } })),
    layerMaskProperties: vi.fn(() => ok({
    channelTarget: { kind: "composite" },
 layer: 1, mask: { enabled: true, linked: true, density: 100, feather: 0 }, view: null, editTarget: "pixels" })),
    viewLayerMask: vi.fn(() => ok({ mode: "gray" })),
    commitSelectionDraft: vi.fn(() => ok({ committed: true })),
    cancelSelectionDraft: vi.fn(() => ok({ cancelled: true })),
    // 既有 P5 契约（选区修改参数面板）。
    beginSelectionModify: vi.fn(() => ok({ bounds: [0, 0, 4, 4] })),
    updateSelectionModify: vi.fn(() => ok({ bounds: [0, 0, 4, 4] })),
    commitSelectionModify: vi.fn(() => ok({ committed: true })),
    cancelSelectionModify: vi.fn(() => ok({ cancelled: true })),
    prepareRefineEdge: vi.fn(() => ok({ params: {} }))
  };
}

function context(selections: ReturnType<typeof session>): { context: FeaturePanelContext; dispatch: ReturnType<typeof vi.fn> } {
  // 既有 P5 面板走控制器方法 + 命令表，新入口走 `features.selections`；两者都要装配。
  const commands = new Map([["select.colorRange", { allowed: true, enabled: true }], ["select.refineEdge", { allowed: true, enabled: true }]]);
  const dispatch = vi.fn(() => ok(null));
  const controller = {
    features: { selections },
    snapshot: () => ({ view: { document: { revision: 1 } }, commands }),
    beginSelectionModify: selections.beginSelectionModify,
    updateSelectionModify: selections.updateSelectionModify,
    commitSelectionModify: selections.commitSelectionModify,
    cancelSelectionModify: selections.cancelSelectionModify,
    prepareRefineEdge: selections.prepareRefineEdge,
    dispatch
  } as unknown as EditorWorkspaceController;
  return {
    dispatch,
    context: {
    readonly: false,

      controller,
      locked: false,
      documentView: {
    channelTarget: { kind: "composite" },

        name: "art", width: 100, height: 80, mode: "Rgb", depthBits: 8, activeLayerId: 1, selectedLayerIds: [1],
        hasSelection: true, editTarget: "pixels", maskView: null, transformFrame: null, selectionOutline: [],
        selectionFrame: null, canUndo: true, canRedo: false, revision: 1, history: [], redoHistory: [],
        layers: [{ id: 1, name: "背景", kind: "raster" } as never]
      },
      activeLayer: { id: 1, name: "背景", kind: "raster" } as never,
      activeLayerId: 1,
      colors: { foreground: "#ff0000" },
      brush: { color: "#000000" },
      refreshPreview: vi.fn(),
      updateAids: vi.fn(),
      retouchTool: "paint.blur",
      retouchSample: null,
      retouchAligned: false,
      setRetouchAligned: vi.fn(),
      setMessage: vi.fn()
    } satisfies FeaturePanelContext
  };
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = null; container = null; });

/** 渲染一个既有分区的全部子面板。 */
function renderSection(id: "selection" | "colorRange" | "refine") {
  const section = sections.find((entry) => entry.id === id)!;
  const selections = session();
  const built = context(selections);
  const element = section.render(built.context) as React.ReactElement;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(element));
  return { selections, dispatch: built.dispatch };
}

it("「选择」菜单仍只有三个分区 id，新入口挂在其内", () => {
  expect(sections.map((section) => section.id)).toEqual(["selection", "colorRange", "refine"]);
  expect(sections.every((section) => section.menu === "选择")).toBe(true);
  // 菜单顺序就是工作流顺序：建立/修补 → 取样 → 细化与蒙版。
  expect([...sections].sort((a, b) => a.menuOrder - b.menuOrder).map((section) => section.id))
    .toEqual(["selection", "colorRange", "refine"]);
});

it("第一个分区装配 U17–U21 的全部入口", () => {
  const { selections } = renderSection("selection");
  const labels = Array.from(container!.querySelectorAll("section")).map((section) => section.getAttribute("aria-label"));
  expect(labels).toEqual([
    "选区修改",
    "单行/单列选框",
    "磁性套索",
    "命名选区",
    "按颜色扩大",
    "传统对象选择",
    "快速蒙版"
  ]);
  // 每个入口都真的把本域会话当端点（不是渲染一个孤立按钮）。
  act(() => Array.from(container!.querySelectorAll("button")).find((entry) => entry.textContent?.includes("建立一像素"))!.click());
  expect(selections.selectLine).toHaveBeenCalledTimes(1);
  act(() => Array.from(container!.querySelectorAll("button")).find((entry) => entry.textContent?.includes("预览追踪"))!.click());
  expect(selections.beginMagneticLasso).toHaveBeenCalledTimes(1);
  act(() => Array.from(container!.querySelectorAll("button")).find((entry) => entry.textContent?.includes("预览候选"))!.click());
  expect(selections.beginSmartSelect).toHaveBeenCalledTimes(1);
  act(() => Array.from(container!.querySelectorAll("button")).find((entry) => entry.textContent?.includes("进入快速蒙版"))!.click());
  expect(selections.beginQuickMask).toHaveBeenCalledTimes(1);
});

it("第二个分区在既有色彩范围面板旁装配多点取样", () => {
  const { selections } = renderSection("colorRange");
  const labels = Array.from(container!.querySelectorAll("section")).map((section) => section.getAttribute("aria-label"));
  expect(labels).toEqual(["色彩范围", "色彩范围取样"]);
  act(() => Array.from(container!.querySelectorAll("button")).find((entry) => entry.textContent?.includes("取样 +"))!.click());
  expect(selections.beginColorRange).toHaveBeenCalledTimes(1);
});

it("第三个分区装配真实修边预览与蒙版属性", () => {
  const { selections, dispatch } = renderSection("refine");
  const labels = Array.from(container!.querySelectorAll("section")).map((section) => section.getAttribute("aria-label"));
  expect(labels).toEqual(["选择并遮住工作区", "像素蒙版", "选择并遮住"]);
  act(() => Array.from(container!.querySelectorAll("button")).find((entry) => entry.textContent?.includes("预览边缘"))!.click());
  expect(selections.beginRefineEdge).toHaveBeenCalledTimes(1);
  expect(selections.layerMaskProperties).toHaveBeenCalled();
  act(() => Array.from(container!.querySelectorAll("button")).find((entry) => entry.textContent?.includes("独立查看"))!.click());
  expect(selections.viewLayerMask).toHaveBeenCalledWith({ mode: "gray", layer: 1 });
  // `\` 的切换走内核命令 `layer.toggleMaskOverlay`，与会话查看共用同一状态。
  act(() => Array.from(container!.querySelectorAll("button")).find((entry) => entry.textContent?.includes("切换叠加"))!.click());
  expect(dispatch).toHaveBeenCalledWith("layer.toggleMaskOverlay", { layer: 1 });
});
