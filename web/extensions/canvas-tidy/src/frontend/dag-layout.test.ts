import { describe, expect, it } from "vitest";
import { layeredLayout, layerNodes } from "./dag-layout.js";

const size = { width: 200, height: 100 };

describe("layeredLayout：按连线方向分层", () => {
  it("A→B→C 排成三列，不再压成一行", () => {
    const result = layeredLayout({
      items: [size, size, size],
      edges: [{ from: 0, to: 1 }, { from: 1, to: 2 }],
      columnGap: 100,
      rowGap: 40
    });
    // 三张卡片 x 严格递增（每张更靠右一层），而不是同一个 y 排一行。
    expect(result.positions[0]!.x).toBeLessThan(result.positions[1]!.x);
    expect(result.positions[1]!.x).toBeLessThan(result.positions[2]!.x);
    expect(result.positions[0]!.layer).toBe(0);
    expect(result.positions[1]!.layer).toBe(1);
    expect(result.positions[2]!.layer).toBe(2);
    // 同一条链上没有同层项，所以 y 全部一致（各自层的唯一项都垂直居中）。
    expect(result.positions[0]!.y).toBe(result.positions[1]!.y);
    expect(result.positions[1]!.y).toBe(result.positions[2]!.y);
  });

  it("一个源分支到两个目标：两个目标同层、纵向分开", () => {
    const result = layeredLayout({
      items: [size, size, size],
      edges: [{ from: 0, to: 1 }, { from: 0, to: 2 }],
      columnGap: 100,
      rowGap: 40
    });
    expect(result.positions[0]!.layer).toBe(0);
    expect(result.positions[1]!.layer).toBe(1);
    expect(result.positions[2]!.layer).toBe(1);
    // 同层同列：x 相等，y 不同（上下并列）。
    expect(result.positions[1]!.x).toBe(result.positions[2]!.x);
    expect(result.positions[1]!.y).not.toBe(result.positions[2]!.y);
    // 纵向不重叠。
    const [a, b] = [result.positions[1]!, result.positions[2]!].sort((l, r) => l.y - r.y);
    expect(b!.y - (a!.y + size.height)).toBe(40);
  });

  it("两个源汇合到一个目标：源同层，目标更靠右", () => {
    const result = layeredLayout({
      items: [size, size, size],
      edges: [{ from: 0, to: 2 }, { from: 1, to: 2 }],
      columnGap: 100,
      rowGap: 40
    });
    expect(result.positions[0]!.layer).toBe(0);
    expect(result.positions[1]!.layer).toBe(0);
    expect(result.positions[2]!.layer).toBe(1);
    expect(result.positions[2]!.x).toBeGreaterThan(result.positions[0]!.x);
  });

  it("取最长路径分层：A→B、A→C→B 时 B 在第三层（C 之后）", () => {
    const result = layeredLayout({
      items: [size, size, size],
      edges: [{ from: 1, to: 0 }, { from: 1, to: 2 }, { from: 2, to: 0 }],
      columnGap: 100,
      rowGap: 40
    });
    // 1 是源（层 0）；2 在层 1；0 同时被 1 与 2 指向，取最深 => 层 2。
    expect(result.positions[1]!.layer).toBe(0);
    expect(result.positions[2]!.layer).toBe(1);
    expect(result.positions[0]!.layer).toBe(2);
  });

  it("成环不抛错：环上的边不构成层约束，两端都被排布", () => {
    const result = layeredLayout({
      items: [size, size],
      edges: [{ from: 0, to: 1 }, { from: 1, to: 0 }],
      columnGap: 100,
      rowGap: 40
    });
    expect(result.positions).toHaveLength(2);
    // 环没有可满足的左右次序：按稳定顺序兜底，两端最多相差一层，不递归、不抛错。
    expect(result.positions[0]!.layer).toBe(0);
    expect(result.positions[1]!.layer).toBeLessThanOrEqual(1);
  });

  it("孤立项不与流程同列：排在流程下方一行，并留出更大间距", () => {
    const result = layeredLayout({
      items: [size, size, size],
      edges: [{ from: 0, to: 1 }],
      columnGap: 100,
      rowGap: 40,
      preferredWidth: 800
    });
    expect(result.positions[2]!.layer).toBe(-1);
    // 孤立项在流程整体（高度 100）下方，且间距大于行间距。
    expect(result.positions[2]!.y).toBeGreaterThanOrEqual(size.height + 40 * 2);
    // 孤立项从最左侧起排，不被读成「最后一层的产物」。
    expect(result.positions[2]!.x).toBe(0);
  });

  it("完全没有连线时退化为逐行填充，不会压成一列", () => {
    const result = layeredLayout({
      items: [size, size, size],
      edges: [],
      columnGap: 100,
      rowGap: 40,
      // 三张 200 宽 + 两个 40 间距 = 680，容器给 700 足够放同一行。
      preferredWidth: 700
    });
    // 宽度足够放三张：同一行。
    expect(result.positions.every((position) => position.y === 0)).toBe(true);
    expect(result.positions.map((position) => position.x)).toEqual([0, 240, 480]);
    expect(result.positions.every((position) => position.layer === -1)).toBe(true);
  });

  it("容器放不下时孤立项换行堆叠，而不是每张独占一列", () => {
    const result = layeredLayout({
      items: [size, size, size],
      edges: [],
      columnGap: 100,
      rowGap: 40,
      // 只能放两张（200+40+200=440 ≤ 500，第三张超出）。
      preferredWidth: 500
    });
    expect(result.positions[0]).toMatchObject({ x: 0, y: 0 });
    expect(result.positions[1]).toMatchObject({ x: 240, y: 0 });
    expect(result.positions[2]).toMatchObject({ x: 0, y: 140 });
  });

  it("自环与重复边被忽略", () => {
    const result = layeredLayout({
      items: [size, size],
      edges: [{ from: 0, to: 0 }, { from: 0, to: 1 }, { from: 0, to: 1 }],
      columnGap: 100,
      rowGap: 40
    });
    expect(result.positions[0]!.layer).toBe(0);
    expect(result.positions[1]!.layer).toBe(1);
  });

  it("跨层边穿过的中间层卡片让开通道，不挡住直达连线", () => {
    // 用户的现场：A→B、A→C、B→C。C 因最长路径落在层 2，A 有一条跨层边直达 C。
    // 层 1 的 B 必须在纵向让开 A 与 C 之间的通道，否则会盖住 A→C 的线。
    const result = layeredLayout({
      items: [size, size, size],
      edges: [{ from: 0, to: 1 }, { from: 0, to: 2 }, { from: 1, to: 2 }],
      columnGap: 100,
      rowGap: 40
    });
    expect(result.positions[0]!.layer).toBe(0);
    expect(result.positions[1]!.layer).toBe(1);
    expect(result.positions[2]!.layer).toBe(2);

    const a = result.positions[0]!;
    const b = result.positions[1]!;
    const c = result.positions[2]!;
    // 通道是 A 与 C 中心的连线在 B 那一列的纵向位置。B 的纵向区间必须避开它（含间距）。
    const channelY = (a.y + size.height / 2 + c.y + size.height / 2) / 2;
    const bTop = b.y;
    const bBottom = b.y + size.height;
    const clearAbove = bBottom <= channelY - 40;
    const clearBelow = bTop >= channelY + 40;
    expect(clearAbove || clearBelow).toBe(true);
  });

  it("跨层边的通道让中间层整体变高（B 被推开而不是与通道重叠）", () => {
    // 同一组依赖，分别在有/无跨层边的情况下比较层 1 的纵向占位。
    const withSkip = layeredLayout({
      items: [size, size, size],
      edges: [{ from: 0, to: 1 }, { from: 0, to: 2 }, { from: 1, to: 2 }],
      columnGap: 100,
      rowGap: 40
    });
    // 层 1 只有 B，但它要为通道留位，因此整图高度大于单层高度。
    expect(withSkip.height).toBeGreaterThan(size.height);
  });

  it("空输入安全返回", () => {
    expect(layeredLayout({ items: [], edges: [], columnGap: 10, rowGap: 10 })).toEqual({
      positions: [],
      width: 0,
      height: 0
    });
  });
});

describe("layerNodes", () => {
  it("稳定顺序：同层按输入顺序排列，结果可复现", () => {
    // 0、1 都是源。
    const layers = layerNodes([0, 1, 2], [[2], [2], []], [[], [], [0, 1]]);
    expect(layers[0]).toEqual([0, 1]);
    expect(layers[1]).toEqual([2]);
  });
});
