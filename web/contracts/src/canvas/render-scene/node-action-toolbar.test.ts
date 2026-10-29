/**
 * 节点顶部操作横条纯几何（任务 3.1 / design D6/D7 修订）。
 *
 * 横条由 Bevy 在画布内绘制、Rust 命中，几何是世界坐标：覆盖默认顶部居中、固定 8 世界单位
 * 间距、动作从左到右不重叠、设置箭头独立矩形、摘要截断与顶部碰撞回退到节点下方。纯计算，
 * 不触碰 DOM 或渲染。Rust 侧镜像常量由 `render-scene.test.ts` 对齐断言。
 */
import { describe, expect, it } from "vitest";
import {
  NODE_ACTION_TOOLBAR_ACTION_HEIGHT,
  NODE_ACTION_TOOLBAR_GAP,
  NODE_ACTION_TOOLBAR_PAD,
  NODE_ACTION_TOOLBAR_SUMMARY_MAX_WIDTH,
  NODE_ACTION_TOOLBAR_VIEWPORT_MARGIN,
  SELECTION_ACTION_TOOLBAR_MIN_NODES,
  estimateNodeActionTextWidth,
  isNodeActionToolbarNodeType,
  nodeActionToolbarLayout,
  resolveNodeActionToolbarTarget,
  resolveSelectionActionToolbarTarget,
  truncateNodeActionText,
  type NodeActionToolbarAction
} from "./node-action-toolbar.js";

const NODE = { x: 500, y: 300, width: 200, height: 160 };
const VIEWPORT = { x: 0, y: 0, zoom: 1 };
const SURFACE = { width: 1000, height: 800 };

function actions(...labels: string[]): NodeActionToolbarAction[] {
  return labels.map((label) => ({ id: label, label, enabled: true }));
}

describe("nodeActionToolbarLayout（任务 3.1）", () => {
  it("无动作或不显示", () => {
    expect(nodeActionToolbarLayout({ node: NODE, actions: [] })).toBeNull();
  });

  it("默认在节点上方 8 单位并水平居中", () => {
    const layout = nodeActionToolbarLayout({ node: NODE, actions: actions("下载"), viewport: VIEWPORT, surface: SURFACE })!;
    expect(layout.placement).toBe("above");
    expect(layout.bar.y + layout.bar.height).toBeCloseTo(NODE.y - NODE_ACTION_TOOLBAR_GAP);
    expect(layout.bar.x + layout.bar.width / 2).toBeCloseTo(NODE.x + NODE.width / 2);
    expect(layout.bar.height).toBeCloseTo(NODE_ACTION_TOOLBAR_ACTION_HEIGHT + NODE_ACTION_TOOLBAR_PAD * 2);
    expect(layout.actions).toHaveLength(1);
    expect(layout.menus[0]).toBeNull();
  });

  it("动作从左到右排列且互不重叠，均在横条内", () => {
    const layout = nodeActionToolbarLayout({ node: NODE, actions: actions("下载", "转为片场"), viewport: VIEWPORT, surface: SURFACE })!;
    expect(layout.actions).toHaveLength(2);
    const [first, second] = layout.actions;
    expect(first!.x).toBeGreaterThanOrEqual(layout.bar.x);
    expect(second!.x).toBeGreaterThanOrEqual(first!.x + first!.width);
    expect(second!.x + second!.width).toBeLessThanOrEqual(layout.bar.x + layout.bar.width + 0.001);
  });

  it("带 menu 的动作后有独立设置箭头矩形（不与动作、摘要重叠）", () => {
    const withMenu: NodeActionToolbarAction[] = [
      { id: "download", label: "下载", enabled: true },
      { id: "convert", label: "转为片场", enabled: true, menu: true }
    ];
    const layout = nodeActionToolbarLayout({ node: NODE, actions: withMenu, viewport: VIEWPORT, surface: SURFACE })!;
    const chevron = layout.menus[1]!;
    expect(chevron).not.toBeNull();
    expect(chevron.x).toBeGreaterThanOrEqual(layout.actions[1]!.x + layout.actions[1]!.width);
    expect(chevron.width).toBeGreaterThan(0);
  });

  it("节点摘要在最左且在横条内；超长截断", () => {
    const layout = nodeActionToolbarLayout({
      node: NODE,
      actions: actions("下载", "转为片场"),
      summary: "一个非常非常非常非常非常非常非常非常非常非常长的模型名称",
      viewport: VIEWPORT,
      surface: SURFACE
    })!;
    expect(layout.summary).not.toBeNull();
    const summary = layout.summary!;
    expect(summary.text.endsWith("…")).toBe(true);
    expect(estimateNodeActionTextWidth(summary.text, 13)).toBeLessThanOrEqual(NODE_ACTION_TOOLBAR_SUMMARY_MAX_WIDTH + 0.001);
    expect(summary.rect.x).toBeGreaterThanOrEqual(layout.bar.x);
    expect(layout.actions[0]!.x).toBeGreaterThanOrEqual(summary.rect.x + summary.rect.width);
    expect(summary.rect.x + summary.rect.width).toBeLessThanOrEqual(layout.bar.x + layout.bar.width + 0.001);
  });

  it("顶部空间不足时回退到节点下方并保留 8 单位间距", () => {
    // 节点贴近顶部：屏幕上边 < 安全边距 → 下方。
    const nearTop = { x: 500, y: 0, width: 200, height: 160 };
    const layout = nodeActionToolbarLayout({
      node: nearTop,
      actions: actions("下载"),
      viewport: { x: 0, y: 0, zoom: 1 },
      surface: { width: 1000, height: 800 }
    })!;
    expect(layout.placement).toBe("below");
    expect(layout.bar.y).toBeCloseTo(nearTop.y + nearTop.height + NODE_ACTION_TOOLBAR_GAP);
  });
  it("缩放时保持按钮和间距的屏幕尺寸", () => {
    for (const zoom of [0.5, 1, 2]) {
      const layout = nodeActionToolbarLayout({ node: { ...NODE, x: 200, y: 200 }, actions: actions("创建片场"), viewport: { x: 0, y: 0, zoom }, surface: SURFACE })!;
      expect(layout.actions[0]!.height * zoom).toBeCloseTo(32);
      expect((200 - layout.bar.y - layout.bar.height) * zoom).toBeCloseTo(8);
    }
  });

  it("图标按钮固定 32px，视口边缘避让", () => {
    const zoom = 0.5;
    const layout = nodeActionToolbarLayout({ node: { ...NODE, x: -100, y: 0 }, actions: [{ id: "download", label: "下载", icon: "download", iconOnly: true, enabled: true }], viewport: { x: 0, y: 0, zoom }, surface: SURFACE })!;
    expect(layout.actions[0]!.width * zoom).toBeCloseTo(32);
    expect(layout.bar.x * zoom).toBeGreaterThanOrEqual(4);
    expect(layout.placement).toBe("below");
  });

  it("上下两侧均放不下时限制在视口内（change: 2026-10-16-add-group-selection-toolbar）", () => {
    // 大分组铺满视口高度：上方与下方都无法完整容纳横条 → 保持上方但钳制到视口内。
    const huge = { x: -200, y: 0, width: 1600, height: 800 };
    const layout = nodeActionToolbarLayout({
      node: huge,
      actions: actions("批量执行 · 3", "整理", "解组"),
      viewport: { x: 0, y: 0, zoom: 1 },
      surface: SURFACE
    })!;
    expect(layout.placement).toBe("above");
    const barTop = layout.bar.y;
    const barBottom = layout.bar.y + layout.bar.height;
    expect(barTop).toBeGreaterThanOrEqual(NODE_ACTION_TOOLBAR_VIEWPORT_MARGIN - 0.001);
    expect(barBottom).toBeLessThanOrEqual(SURFACE.height - NODE_ACTION_TOOLBAR_VIEWPORT_MARGIN + 0.001);
    // 横条覆盖分组内部（允许覆盖成员），但仍限制在视口内。
    expect(layout.bar.y).toBeLessThan(huge.y + huge.height);
  });

  it("目标完全移出视口时不呈现横条", () => {
    const offscreen = { x: 4000, y: 3000, width: 200, height: 160 };
    expect(nodeActionToolbarLayout({
      node: offscreen,
      actions: actions("批量执行 · 1"),
      viewport: { x: 0, y: 0, zoom: 1 },
      surface: SURFACE
    })).toBeNull();
  });
});

describe("truncateNodeActionText（任务 3.1）", () => {
  it("未超宽时原样返回，超宽时加省略号", () => {
    expect(truncateNodeActionText("下载", 12, 200)).toBe("下载");
    const long = "模型名称模型名称模型名称模型名称模型名称模型名称";
    const truncated = truncateNodeActionText(long, 12, 40);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated.length).toBeLessThan(long.length);
  });
});

describe("resolveNodeActionToolbarTarget（任务 3.1/3.9）", () => {
  const nodes = [
    { id: "img", type: "image" },
    { id: "vid", type: "video" },
    { id: "model", type: "model3d" },
    { id: "group", type: "group" },
    { id: "composite", type: "composite-asset" },
    { id: "text", type: "text" }
  ];

  it("单选适用类型节点时返回该节点及其通用类型", () => {
    expect(resolveNodeActionToolbarTarget({ selectedNodeIds: ["img"], nodes })).toEqual({ nodeId: "img", nodeType: "image" });
    expect(resolveNodeActionToolbarTarget({ selectedNodeIds: ["vid"], nodes })).toEqual({ nodeId: "vid", nodeType: "video" });
    expect(resolveNodeActionToolbarTarget({ selectedNodeIds: ["model"], nodes })).toEqual({ nodeId: "model", nodeType: "model3d" });
  });

  it("单选 group 时返回 group 目标（change: 2026-10-16-add-group-selection-toolbar）", () => {
    expect(resolveNodeActionToolbarTarget({ selectedNodeIds: ["group"], nodes })).toEqual({ nodeId: "group", nodeType: "group" });
  });

  it("多选、取消选择、非适用类型或不存在节点时隐藏", () => {
    expect(resolveNodeActionToolbarTarget({ selectedNodeIds: [], nodes })).toBeNull();
    expect(resolveNodeActionToolbarTarget({ selectedNodeIds: ["img", "vid"], nodes })).toBeNull();
    expect(resolveNodeActionToolbarTarget({ selectedNodeIds: ["text"], nodes })).toBeNull();
    expect(resolveNodeActionToolbarTarget({ selectedNodeIds: ["composite"], nodes })).toEqual({ nodeId: "composite", nodeType: "composite-asset" });
    expect(resolveNodeActionToolbarTarget({ selectedNodeIds: ["missing"], nodes })).toBeNull();
    // 部分成员（未规范化为 group）的多选不显示分组横条。
    expect(resolveNodeActionToolbarTarget({ selectedNodeIds: ["img", "group"], nodes })).toBeNull();
  });

  it("复合资产也能通过通用横条呈现扩展动作", () => {
    expect(isNodeActionToolbarNodeType("image")).toBe(true);
    expect(isNodeActionToolbarNodeType("video")).toBe(true);
    expect(isNodeActionToolbarNodeType("model3d")).toBe(true);
    expect(isNodeActionToolbarNodeType("group")).toBe(true);
    expect(isNodeActionToolbarNodeType("text")).toBe(false);
    expect(isNodeActionToolbarNodeType("composite-asset")).toBe(true);
  });
});

describe("resolveSelectionActionToolbarTarget（change: 2026-10-16-add-group-selection-toolbar）", () => {
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "group" }];

  it("选中 ≥2 个仍存在的节点时返回这些稳定 nodeId", () => {
    expect(resolveSelectionActionToolbarTarget({ selectedNodeIds: ["a", "b"], nodes })).toEqual({ nodeIds: ["a", "b"] });
    expect(resolveSelectionActionToolbarTarget({ selectedNodeIds: ["a", "b", "group"], nodes })).toEqual({ nodeIds: ["a", "b", "group"] });
  });

  it("单选、空选择或少于 2 个存在节点时隐藏", () => {
    expect(resolveSelectionActionToolbarTarget({ selectedNodeIds: [], nodes })).toBeNull();
    expect(resolveSelectionActionToolbarTarget({ selectedNodeIds: ["a"], nodes })).toBeNull();
    expect(resolveSelectionActionToolbarTarget({ selectedNodeIds: ["a", "missing"], nodes })).toBeNull();
  });

  it("忽略已从 working projection 移除的节点，并去重", () => {
    expect(resolveSelectionActionToolbarTarget({ selectedNodeIds: ["a", "missing", "b", "a"], nodes })).toEqual({ nodeIds: ["a", "b"] });
  });

  it("最少节点数与常量一致", () => {
    expect(SELECTION_ACTION_TOOLBAR_MIN_NODES).toBe(2);
  });
});
