/** @vitest-environment jsdom */
/**
 * 面板槽位接线（U08–U16 的入口一半）。
 *
 * `sections.tsx` 是共享面板系统与本域之间唯一的接缝：它决定「形状与路径…」出现在哪个菜单、
 * 以及把哪些只读投影传给本域面板。这里固定三件容易悄悄漂移的事：
 * 槽位/顺序声明、`shapeLayers` 的统计口径（布尔运算的启用前置）、以及只读与图层透传。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { sections } from "./sections.js";
import type { FeaturePanelContext } from "../panel-context.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.replaceChildren(); });

const vector = sections.find(section => section.id === "vector")!;

function context(options: {
  layers?: { kind: string; selected: boolean }[];
  locked?: boolean;
  activeLayerId?: number | null;
  hasSelection?: boolean;
  /** 该图层在 `vectorSnapshot().shapes[]` 里的规范形状摘要。 */
  shapes?: Record<string, unknown>[];
} = {}) {
  const controller = {
    vectorSnapshot: () => ({ ok: true, value: { shapes: options.shapes ?? [], vectorMasks: [], paths: [], workPath: null, clippingPath: null } }),
    features: { vectors: { vectorPresets: () => ({ ok: true, value: { groups: [], custom: [] } }) } },
    vectorCommand: () => ({ ok: true, value: {} }),
  } as unknown as EditorWorkspaceController;
  return {
    readonly: false,

    controller,
    locked: options.locked ?? false,
    documentView: {
      layers: options.layers ?? [],
      hasSelection: options.hasSelection ?? false,
      revision: 3,
    },
    activeLayerId: options.activeLayerId ?? null,
    colors: { foreground: "#3366cc" },
  } as unknown as FeaturePanelContext;
}

function renderSection(ctx: FeaturePanelContext) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<>{vector.render(ctx)}</>));
  return container;
}

describe("形状与路径面板槽位", () => {
  it("声明在「窗口」菜单的 advanced 槽位，且入口唯一", () => {
    expect(vector.id).toBe("vector");
    expect(vector.placement).toBe("advanced");
    expect(vector.menu).toBe("窗口");
    expect(vector.label).toBe("路径与形状…");
    expect(sections.filter(section => section.id === "vector")).toHaveLength(1);
    expect(vector.order).toBe(8);
  });

  it("包一层带 data-advanced-section 的容器，供共享面板定位", () => {
    const container = renderSection(context());
    const section = container.querySelector("[data-advanced-section='vector']");
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("形状");
  });

  it("只读锁与活动图层按上下文透传（锁定后创建按钮禁用）", () => {
    const locked = renderSection(context({
 locked: true, activeLayerId: 5 }));
    const createButton = [...locked.querySelectorAll("button")].find(node => node.textContent === "创建形状")!;
    expect(createButton.disabled).toBe(true);

    const editable = renderSection(context({
 locked: false, activeLayerId: 5 }));
    const enabled = [...editable.querySelectorAll("button")].find(node => node.textContent === "创建形状")!;
    expect(enabled.disabled).toBe(false);
  });

  it("shapeLayers 只统计「已选中的形状层」，不把像素层或未选中的形状算进去", () => {
    // 只选中 1 个形状层（另有未选中形状与像素层）→ 「需要两个形状层」写进按钮 title，
    // 且按钮真的禁用；像素层与未选中形状不计入。
    const shapes = [{ layer: 1, name: "形状 1", kind: "rect", live: { kind: "rect", rect: [0, 0, 10, 10] } }];
    const one = renderSection(context({
      layers: [
        { kind: "shape", selected: true },
        { kind: "shape", selected: false },
        { kind: "pixel", selected: true },
      ],
      activeLayerId: 1,
      shapes,
    }));
    const unite = [...one.querySelectorAll("button")].find(node => node.textContent === "合并形状")!;
    expect(unite.disabled, "一个形状层时不能合并").toBe(true);
    expect(unite.getAttribute("title")).toContain("至少两个形状图层");

    // 两个已选形状层 + 活动层是形状 → 前置条件满足，按钮启用。
    const two = renderSection(context({
      layers: [
        { kind: "shape", selected: true },
        { kind: "shape", selected: true },
        { kind: "pixel", selected: true },
      ],
      activeLayerId: 1,
      shapes,
    }));
    const enabled = [...two.querySelectorAll("button")].find(node => node.textContent === "合并形状")!;
    expect(enabled.disabled).toBe(false);
  });
});
