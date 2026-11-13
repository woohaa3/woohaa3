/**
 * 画布几何：定位视口、有效尺寸、对齐与分布（change: 2026-10-09-improve-canvas-workflow，任务 4.1/4.3）。
 */
import { describe, expect, it } from "vitest";
import {
  computeAlignment,
  computeCenteredViewport,
  computeDistribution,
  computeLocateViewport,
  effectiveNodeSize,
  unionRects,
  type AlignableNode
} from "./geometry.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";

describe("effectiveNodeSize", () => {
  it("普通类型使用参考尺寸，显式尺寸优先", () => {
    expect(effectiveNodeSize({ type: "text", width: undefined, height: undefined })).toEqual({ width: 248, height: 232 });
    expect(effectiveNodeSize({ type: "text", width: 300, height: 250 })).toEqual({ width: 300, height: 250 });
  });

  it("卡片尺寸只服务 2D 卡片：模型不再扩展为 248×232 / 196×64 预览卡片", () => {
    expect(effectiveNodeSize({ type: "text", width: 248, height: 232 })).toEqual({ width: 248, height: 232 });
    expect(effectiveNodeSize({ type: COMPOSITE_ASSET_NODE_TYPE, width: 260, height: 195 })).toEqual({ width: 260, height: 195 });
    // 模型没有卡片：保留显式数值，只按共享最小尺寸收敛，不做模型最小预览高度扩展。
    expect(effectiveNodeSize({ type: "model3d", width: 196, height: 64 })).toEqual({ width: 196, height: 64 });
    expect(effectiveNodeSize({ type: "model3d", width: 320, height: 117 })).toEqual({ width: 320, height: 117 });
  });

  it("显式尺寸低于共享下限时收敛到下限", () => {
    expect(effectiveNodeSize({ type: "text", width: 50, height: 50 })).toEqual({ width: 180, height: 64 });
  });
});

describe("computeCenteredViewport", () => {
  it("保持传入缩放，把目标中心移到可用中心", () => {
    const viewport = computeCenteredViewport({
      bounds: { x: 800, y: 400, width: 260, height: 195 },
      hostSize: { width: 1000, height: 800 },
      zoom: 1
    });
    expect(viewport).not.toBeNull();
    expect(viewport!.zoom).toBe(1);
    // 目标中心 (930, 497.5) 映射到宿主中心 (500,400)。
    expect(930 * viewport!.zoom + viewport!.x).toBeCloseTo(500, 3);
    expect(497.5 * viewport!.zoom + viewport!.y).toBeCloseTo(400, 3);
  });

  it("无效目标返回 null", () => {
    expect(computeCenteredViewport({ bounds: { x: 0, y: 0, width: 0, height: 0 }, hostSize: { width: 1000, height: 800 }, zoom: 1 })).toBeNull();
    expect(computeCenteredViewport({ bounds: { x: NaN, y: 0, width: 10, height: 10 }, hostSize: { width: 1000, height: 800 }, zoom: 1 })).toBeNull();
    expect(computeCenteredViewport({ bounds: { x: 0, y: 0, width: 10, height: 10 }, hostSize: null, zoom: 1 })).toBeNull();
  });

  it("安全区改变可用中心", () => {
    const viewport = computeCenteredViewport({
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      hostSize: { width: 1000, height: 800 },
      zoom: 1,
      safeArea: { left: 0, top: 0, right: 400, bottom: 0 }
    });
    expect(5 * 1 + viewport!.x).toBeCloseTo(300, 3);
  });
});

describe("computeLocateViewport", () => {  it("把目标居中并限制在缩放范围内", () => {
    const viewport = computeLocateViewport({
      bounds: { x: 0, y: 0, width: 248, height: 232 },
      viewport: { x: 0, y: 0, zoom: 1 },
      hostSize: { width: 1000, height: 800 },
      padding: 64
    });
    expect(viewport).not.toBeNull();
    expect(viewport!.zoom).toBeGreaterThan(0);
    expect(viewport!.zoom).toBeLessThanOrEqual(12);
    // 目标中心落在可用中心
    const centerX = 0.5 * 248 * viewport!.zoom + viewport!.x;
    const centerY = 0.5 * 232 * viewport!.zoom + viewport!.y;
    expect(centerX).toBeCloseTo(500, 3);
    expect(centerY).toBeCloseTo(400, 3);
  });

  it("无效目标（零尺寸）返回 null，不移动到原点", () => {
    expect(computeLocateViewport({
      bounds: { x: NaN, y: 0, width: 248, height: 232 },
      viewport: { x: 0, y: 0, zoom: 1 },
      hostSize: { width: 1000, height: 800 }
    })).toBeNull();
    expect(computeLocateViewport({
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      viewport: { x: 0, y: 0, zoom: 1 },
      hostSize: { width: 1000, height: 800 }
    })).toBeNull();
  });

  it("避让 DOM 面板：安全区改变可用中心", () => {
    const viewport = computeLocateViewport({
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      viewport: { x: 0, y: 0, zoom: 1 },
      hostSize: { width: 1000, height: 800 },
      padding: 0,
      safeArea: { left: 0, top: 0, right: 400, bottom: 0 }
    });
    const centerX = 50 * viewport!.zoom + viewport!.x;
    expect(centerX).toBeCloseTo(300, 3);
  });
});

describe("computeAlignment", () => {
  const nodes: AlignableNode[] = [
    { id: "a", rect: { x: 0, y: 0, width: 100, height: 50 } },
    { id: "b", rect: { x: 200, y: 100, width: 50, height: 80 } },
    { id: "c", rect: { x: 400, y: 40, width: 80, height: 60 } }
  ];

  it("左对齐使用选区最左边界", () => {
    const result = computeAlignment(nodes, "left");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.positions.get("a")!.x).toBe(0);
    expect(result.positions.get("b")!.x).toBe(0);
    expect(result.positions.get("c")!.x).toBe(0);
    // y 不变
    expect(result.positions.get("b")!.y).toBe(100);
  });

  it("右对齐使用选区最右边界", () => {
    const result = computeAlignment(nodes, "right");
    if (!result.ok) return;
    expect(result.positions.get("a")!.x).toBe(380);
    expect(result.positions.get("b")!.x).toBe(430);
    expect(result.positions.get("c")!.x).toBe(400);
  });

  it("水平居中", () => {
    const result = computeAlignment(nodes, "h-center");
    if (!result.ok) return;
    expect(result.positions.get("a")!.x).toBe(190);
    expect(result.positions.get("b")!.x).toBe(215);
  });

  it("少于两个对象拒绝", () => {
    expect(computeAlignment([nodes[0]!], "left").ok).toBe(false);
    expect(computeAlignment([], "left").ok).toBe(false);
  });
});

describe("computeDistribution", () => {
  it("水平等距分布固定两端外边界且按 nodeId 稳定排序", () => {
    const nodes: AlignableNode[] = [
      { id: "a", rect: { x: 0, y: 0, width: 100, height: 50 } },
      { id: "b", rect: { x: 100, y: 0, width: 50, height: 50 } },
      { id: "c", rect: { x: 300, y: 0, width: 50, height: 50 } }
    ];
    const result = computeDistribution(nodes, "horizontal");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 两端固定：a 起点 0，c 终点 350
    expect(result.positions.get("a")!.x).toBe(0);
    expect(result.positions.get("c")!.x).toBe(300);
    // 间距 g = (350 - 200) / 2 = 75；b 起点 = 0 + 100 + 75 = 175
    expect(result.positions.get("b")!.x).toBe(175);
  });

  it("空间不足（g < 0）拒绝", () => {
    const nodes: AlignableNode[] = [
      { id: "a", rect: { x: 0, y: 0, width: 200, height: 50 } },
      { id: "b", rect: { x: 10, y: 0, width: 200, height: 50 } },
      { id: "c", rect: { x: 20, y: 0, width: 200, height: 50 } }
    ];
    const result = computeDistribution(nodes, "horizontal");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("空间不足");
  });

  it("少于三个对象拒绝", () => {
    const two: AlignableNode[] = [
      { id: "a", rect: { x: 0, y: 0, width: 100, height: 50 } },
      { id: "b", rect: { x: 300, y: 0, width: 100, height: 50 } }
    ];
    expect(computeDistribution(two, "horizontal").ok).toBe(false);
  });
});

describe("unionRects", () => {
  it("并集覆盖全部矩形；空集合返回 null", () => {
    expect(unionRects([])).toBeNull();
    expect(unionRects([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 20, y: -5, width: 10, height: 10 }
    ])).toEqual({ x: 0, y: -5, width: 30, height: 15 });
  });
});

describe("effectiveCanvasNodeSize 只服务 2D 卡片", () => {
  it("文本卡片、复合资产与无卡片模型各自取自己的尺寸规则", () => {
    // 文本卡片：显式尺寸原样保留（不低于下限）。
    expect(effectiveNodeSize({ type: "text", width: 300, height: 250 })).toEqual({ width: 300, height: 250 });
    // 复合资产：规范基准矩形（不套用模型卡片扩展）。
    expect(effectiveNodeSize({ type: "composite-asset" })).toEqual({ width: 260, height: 195 });
    // 无卡片模型：不再出现 248×232 / 196×64 的卡片扩展或模型最小预览高度。
    expect(effectiveNodeSize({ type: "model3d", width: 196, height: 64 })).toEqual({ width: 196, height: 64 });
    expect(effectiveNodeSize({ type: "model3d", width: 320, height: 117 })).toEqual({ width: 320, height: 117 });
  });
});
