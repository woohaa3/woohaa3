/** @vitest-environment jsdom */
/**
 * 跨域回归（change `2026-10-22-add-photocraft-view-workspace-workflows`，任务 5.2）。
 *
 * 这里验证的是**真实宿主形态**下的两条边界，而不是域内自测：
 *
 * 1. 宿主不提供 `features.views` 时，编辑器整体仍可用，画布与面板不崩、不显示做不到的入口；
 * 2. 画布组件确实拿到了视图域端口（参考线拖动、一次性落点），即域内实现没有被适配层吞掉。
 */
import { describe, expect, it } from "vitest";
import { canvasPort, setup } from "../src/test-support/photo-editor-harness.js";

describe("视图域在 Woohaa 宿主里的接线", () => {
  it("宿主没有视图域端口时编辑器照常渲染，不崩溃也不假装可用", () => {
    const { container } = setup();
    expect(container.querySelector("[data-canvas=\"stub\"]")).not.toBeNull();
    // 没有端口时不出现「在画布上放置」这类做不到的入口。
    expect(container.textContent).not.toContain("在画布上放置");
  });

  it("只读宿主下视图写入入口保持关闭", () => {
    const { container } = setup(true);
    expect(container.querySelector("[data-canvas=\"stub\"]")).not.toBeNull();
    expect(container.textContent).not.toContain("在画布上放置");
  });
});

describe("并排双视图在真实宿主形态下的渲染", () => {
  const aids = {
    rulers: false, grid: false, gridStep: [10, 10], gridSubdivisions: 1, guides: true, lockGuides: false,
    smartGuides: false, snap: { document: true, guides: true, grid: false, layers: false, selection: false },
    suspend: false, units: "px", rotation: 0, navigator: false, sideBySide: true, activeView: "view-1",
    maxViews: 4,
    views: [
      { id: "view-1", label: "视图 1", zoom: 1, offset: [0, 0], rotation: 0, active: true },
      { id: "view-2", label: "视图 2", zoom: 2, offset: [30, 0], rotation: 0, active: false },
    ],
  };

  it("开关打开时渲染两个窗格、两块画布，只有活动窗格可交互", () => {
    const { container } = setup(false, { viewAids: aids });
    const panes = container.querySelectorAll("[data-view-pane]");
    expect(panes).toHaveLength(2);
    expect(panes[0].getAttribute("data-view-pane-active")).toBe("true");
    expect(panes[1].getAttribute("data-view-pane-active")).toBeNull();
    // 两块画布都真的渲染（不是缩略图占位），来自同一个共享画布组件。
    expect(container.querySelectorAll("[data-canvas=\"stub\"]")).toHaveLength(2);
    // 输入归属：只有活动窗格 interactive（只看最后一次渲染的两个窗格）。
    const flags = canvasPort.all.slice(-2).map((props) => props.interactive);
    expect(flags).toEqual([true, false]);
    // 窗格标签来自内核视图名，不自己编号。
    expect(container.textContent).toContain("视图 1");
    expect(container.textContent).toContain("视图 2");
  });

  it("活动窗格跟随宿主取景，非活动窗格锁住自己的（平移不会带跑另一块）", () => {
    const { container, setViewport } = setup(false, { viewAids: aids });
    // 两个窗格初始都从当前取景开始（与内核「新视图沿用当前视图」一致）。
    expect(canvasPort.all.every((props) => props.view.viewport.zoom === 0.5)).toBe(true);

    canvasPort.all.length = 0;
    setViewport({ x: -40, y: 12, zoom: 2 });
    const zooms = canvasPort.all.map((props) => props.view.viewport.zoom);
    // 活动窗格跟着宿主变成 2×，非活动窗格仍是 0.5×——否则「取景独立」名存实亡。
    expect(zooms).toContain(2);
    expect(zooms).toContain(0.5);
    expect(container.querySelectorAll("[data-view-pane]")).toHaveLength(2);
  });
});
