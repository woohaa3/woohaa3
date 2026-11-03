/**
 * 悬停胶囊「添加到对话框」的显示条件与几何
 * （参考稿：指针停在图片上时卡片下缘浮出大胶囊，而不是选中后出现在顶部横条里）。
 */
import { describe, expect, it } from "vitest";
import {
  HOVER_COMPOSER_GAP,
  HOVER_COMPOSER_HEIGHT,
  HOVER_COMPOSER_MARGIN,
  hoverComposerBox,
  resolveComposerAction,
  resolveHoverComposerTarget
} from "./hover-composer.js";

const NODES = [
  { id: "img", type: "image" },
  { id: "vid", type: "video" },
  { id: "txt", type: "text" },
  { id: "grp", type: "group" },
  { id: "model", type: "model3d" }
];

const base = { pinnedNodeId: null, focusActive: false, writable: true, nodes: NODES };

describe("悬停胶囊目标", () => {
  it("指针下的图片/视频/文本节点浮出胶囊", () => {
    expect(resolveHoverComposerTarget({ ...base, hoveredNodeId: "img" })).toEqual({ nodeId: "img", nodeType: "image" });
    expect(resolveHoverComposerTarget({ ...base, hoveredNodeId: "vid" })).toEqual({ nodeId: "vid", nodeType: "video" });
    expect(resolveHoverComposerTarget({ ...base, hoveredNodeId: "txt" })).toEqual({ nodeId: "txt", nodeType: "text" });
  });

  it("分组与模型卡片没有生成面板，不浮出", () => {
    expect(resolveHoverComposerTarget({ ...base, hoveredNodeId: "grp" })).toBeNull();
    expect(resolveHoverComposerTarget({ ...base, hoveredNodeId: "model" })).toBeNull();
  });

  it("悬停为空时用记住的节点兜住（指针移进胶囊期间画布会清空 hover）", () => {
    expect(resolveHoverComposerTarget({ ...base, hoveredNodeId: null, pinnedNodeId: "img" }))
      .toEqual({ nodeId: "img", nodeType: "image" });
  });

  it("新的悬停节点优先于记住的节点", () => {
    expect(resolveHoverComposerTarget({ ...base, hoveredNodeId: "vid", pinnedNodeId: "img" }))
      .toEqual({ nodeId: "vid", nodeType: "video" });
  });

  it("聚焦或无悬停时不浮出", () => {
    expect(resolveHoverComposerTarget({ ...base, hoveredNodeId: "img", focusActive: true })).toBeNull();
    expect(resolveHoverComposerTarget({ ...base, hoveredNodeId: null })).toBeNull();
  });

  it("只读画布不参与显示判定（按钮置灰由组件负责）", () => {
    expect(resolveHoverComposerTarget({ ...base, hoveredNodeId: "img" }))
      .toEqual({ nodeId: "img", nodeType: "image" });
  });

  it("节点已从画布移除时不浮出（记住的 id 不制造幽灵胶囊）", () => {
    expect(resolveHoverComposerTarget({ ...base, hoveredNodeId: null, pinnedNodeId: "gone" })).toBeNull();
  });
});

describe("悬停胶囊几何", () => {
  it("浮在卡片下方外侧，不压卡片本体（历史条与 resize 抓手仍可点）", () => {
    const card = { left: 100, top: 50, width: 400, height: 300 };
    expect(hoverComposerBox(card)).toEqual({
      left: 100,
      top: 50 + 300 + HOVER_COMPOSER_GAP,
      width: 400,
      height: HOVER_COMPOSER_HEIGHT
    });
  });

  it("卡片下缘贴近视口底部时翻到上方", () => {
    const viewport = { width: 1200, height: 800 };
    // 卡片底 790，下方放不下 → 上方。
    const box = hoverComposerBox({ left: 100, top: 600, width: 400, height: 190 }, viewport)!;
    expect(box.top).toBe(600 - HOVER_COMPOSER_GAP - HOVER_COMPOSER_HEIGHT);
    expect(box.top).toBeGreaterThanOrEqual(HOVER_COMPOSER_MARGIN);
  });

  it("上下都放不下时钳制进视口，不渲染到视口外", () => {
    const viewport = { width: 1200, height: 800 };
    // 卡片比视口还高：竖长图卡片，下缘在视口外。
    const box = hoverComposerBox({ left: 100, top: -200, width: 400, height: 1400 }, viewport)!;
    expect(box.top).toBeGreaterThanOrEqual(HOVER_COMPOSER_MARGIN);
    expect(box.top + HOVER_COMPOSER_HEIGHT).toBeLessThanOrEqual(viewport.height - HOVER_COMPOSER_MARGIN);
  });

  it("左右越界时钳制进视口", () => {
    const viewport = { width: 1200, height: 800 };
    const right = hoverComposerBox({ left: 1100, top: 100, width: 400, height: 300 }, viewport)!;
    expect(right.left).toBe(viewport.width - HOVER_COMPOSER_MARGIN - right.width);
    const left = hoverComposerBox({ left: -80, top: 100, width: 400, height: 300 }, viewport)!;
    expect(left.left).toBe(HOVER_COMPOSER_MARGIN);
  });

  it("卡片太小时不浮出", () => {
    expect(hoverComposerBox({ left: 0, top: 0, width: 120, height: 300 })).toBeNull();
    expect(hoverComposerBox({ left: 0, top: 0, width: 400, height: 80 })).toBeNull();
  });

  it("未测量出矩形时不浮出", () => {
    expect(hoverComposerBox(null)).toBeNull();
  });
});

describe("resolveComposerAction", () => {
  const nodes = [{ id: "a", type: "image" }, { id: "b", type: "image" }, { id: "g", type: "group" }];

  it("底部开着别的节点的面板 → 连成它的参考", () => {
    expect(resolveComposerAction({ targetNodeId: "a", primaryNodeId: "b", nodes })).toEqual({ type: "connect", panelNodeId: "b" });
  });

  it("没有打开的面板、点的就是当前节点、或当前节点没有面板 → 只选中", () => {
    expect(resolveComposerAction({ targetNodeId: "a", primaryNodeId: null, nodes })).toEqual({ type: "select" });
    expect(resolveComposerAction({ targetNodeId: "a", primaryNodeId: "a", nodes })).toEqual({ type: "select" });
    expect(resolveComposerAction({ targetNodeId: "a", primaryNodeId: "g", nodes })).toEqual({ type: "select" });
    expect(resolveComposerAction({ targetNodeId: "a", primaryNodeId: "gone", nodes })).toEqual({ type: "select" });
  });
});
