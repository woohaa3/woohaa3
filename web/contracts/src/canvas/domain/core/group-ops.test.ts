/**
 * group-ops 单元测试（change: add-canvas-node-grouping，任务 1.1）。
 *
 * `parentId` 是成员关系的唯一事实源；节点在有父级时使用局部坐标。
 * 本文件覆盖：创建、嵌套绝对坐标、部分解组、拖入/拖出、自适应尺寸、
 * 选择展开、selection 规范化与悬空 parent 修复。
 */
import { describe, expect, it } from "vitest";
import type { Woohaa3CanvasNode } from "./canvas-runtime";
import {
  captureWoohaa3CanvasGroupRects,
  expandSelectionWithGroups,
  expandWoohaa3CanvasSelectionWithGroupDescendants,
  findGroupContainingCenter,
  getGroupRequiredMinSize,
  getGroupLayoutSizes,
  getWoohaa3CanvasNodeAbsolutePosition,
  getWoohaa3CanvasSelectionBounds,
  groupWoohaa3CanvasNodes,
  mergeDraggedNodePositions,
  normalizeWoohaa3CanvasGroupSelection,
  refitWoohaa3CanvasGroups,
  reparentDraggedNodes,
  sanitizeWoohaa3CanvasParentIds,
  sortNodesParentsFirst,
  ungroupWoohaa3CanvasNodes
} from "./group-ops";

/** 造一个顶层或成员节点；`parentId` 存在即成员，position 为局部坐标。 */
function node(
  id: string,
  position: { x: number; y: number },
  extra: Partial<Woohaa3CanvasNode> = {}
): Woohaa3CanvasNode {
  return {
    id,
    type: "image",
    position,
    width: 200,
    height: 100,
    data: {},
    ...extra
  };
}

function byId(nodes: Woohaa3CanvasNode[]): Map<string, Woohaa3CanvasNode> {
  return new Map(nodes.map((entry) => [entry.id, entry]));
}

describe("groupWoohaa3CanvasNodes", () => {
  it("左右上 40px、底部 80px 包围节点并保持成员绝对坐标", () => {
    const nodes = [node("a", { x: 100, y: 100 }), node("b", { x: 400, y: 300 })];
    const result = groupWoohaa3CanvasNodes(nodes, ["a", "b"]);
    expect(result).not.toBeNull();
    const { nodes: next, groupId } = result!;

    const group = next.find((entry) => entry.id === groupId)!;
    expect(group.type).toBe("group");
    // 包围盒 = (100,100)-(600,400)，每侧 padding 40。
    expect(group.position).toEqual({ x: 60, y: 60 });
    expect(group.width).toBe(580); // 500 + 80
    expect(group.height).toBe(420); // 300 + 40 + 80

    // 成员相对坐标 = 绝对 - group 原点，绝对位置不变。
    const a = next.find((entry) => entry.id === "a")!;
    expect(a.parentId).toBe(groupId);
    expect(a.position).toEqual({ x: 40, y: 40 });
    expect(getWoohaa3CanvasNodeAbsolutePosition(a, byId(next))).toEqual({ x: 100, y: 100 });
  });

  it("少于两个节点时不打组", () => {
    expect(groupWoohaa3CanvasNodes([node("a", { x: 0, y: 0 })], ["a"])).toBeNull();
  });

  it("忽略选中的 group（只把非 group 节点收为成员）", () => {
    const existingGroup = node("g1", { x: 0, y: 0 }, { type: "group", width: 400, height: 400 });
    const result = groupWoohaa3CanvasNodes([existingGroup, node("a", { x: 10, y: 10 }), node("b", { x: 50, y: 50 })], ["g1", "a", "b"]);
    expect(result).not.toBeNull();
    // g1 保持顶层，未被收进新组。
    expect(result!.nodes.find((entry) => entry.id === "g1")!.parentId).toBeUndefined();
  });

  it("父节点排在子节点之前（renderer 依赖该顺序）", () => {
    const result = groupWoohaa3CanvasNodes([node("a", { x: 0, y: 0 }), node("b", { x: 300, y: 0 })], ["a", "b"])!;
    expect(result.nodes[0]!.type).toBe("group");
  });
});

describe("嵌套 group 的绝对坐标", () => {
  it("沿 parentId 链累加得到画布绝对坐标", () => {
    const outer = node("o", { x: 100, y: 100 }, { type: "group" });
    const inner = node("i", { x: 20, y: 30 }, { type: "group", parentId: "o" });
    const leaf = node("l", { x: 5, y: 7 }, { parentId: "i" });
    const nodes = [outer, inner, leaf];
    expect(getWoohaa3CanvasNodeAbsolutePosition(leaf, byId(nodes))).toEqual({ x: 125, y: 137 });
  });

  it("parentId 成环时不无限循环", () => {
    const a = node("a", { x: 1, y: 1 }, { parentId: "b" });
    const b = node("b", { x: 2, y: 2 }, { parentId: "a" });
    // 有环时只累加有限次，能返回有限数值即可（不挂起）。
    const pos = getWoohaa3CanvasNodeAbsolutePosition(a, byId([a, b]));
    expect(Number.isFinite(pos.x)).toBe(true);
    expect(Number.isFinite(pos.y)).toBe(true);
  });

  it("sortNodesParentsFirst 把父级排在子级前", () => {
    const leaf = node("l", { x: 0, y: 0 }, { parentId: "g" });
    const group = node("g", { x: 0, y: 0 }, { type: "group" });
    const sorted = sortNodesParentsFirst([leaf, group]);
    expect(sorted.map((entry) => entry.id)).toEqual(["g", "l"]);
  });
});

describe("ungroupWoohaa3CanvasNodes", () => {
  it("解散 group：成员转回绝对坐标并清除 parentId", () => {
    const group = node("g", { x: 100, y: 50 }, { type: "group", width: 500, height: 400 });
    const a = node("a", { x: 10, y: 20 }, { parentId: "g" });
    const b = node("b", { x: 200, y: 120 }, { parentId: "g" });
    const result = ungroupWoohaa3CanvasNodes([group, a, b], ["g"]);
    expect(result).not.toBeNull();
    expect(result!.nodes.find((entry) => entry.id === "g")).toBeUndefined();
    const nextA = result!.nodes.find((entry) => entry.id === "a")!;
    expect(nextA.parentId).toBeUndefined();
    expect(nextA.position).toEqual({ x: 110, y: 70 });
    expect(result!.ungroupedNodeIds.sort()).toEqual(["a", "b"]);
  });

  it("部分选中只把选中的成员移出，保留 group 与其余成员", () => {
    const group = node("g", { x: 100, y: 50 }, { type: "group", width: 500, height: 400 });
    const a = node("a", { x: 10, y: 20 }, { parentId: "g" });
    const b = node("b", { x: 200, y: 120 }, { parentId: "g" });
    const result = ungroupWoohaa3CanvasNodes([group, a, b], ["a"]);
    expect(result).not.toBeNull();
    expect(result!.nodes.find((entry) => entry.id === "g")).toBeDefined();
    expect(result!.nodes.find((entry) => entry.id === "a")!.parentId).toBeUndefined();
    expect(result!.nodes.find((entry) => entry.id === "b")!.parentId).toBe("g");
  });

  it("无可解散对象时返回 null", () => {
    expect(ungroupWoohaa3CanvasNodes([node("a", { x: 0, y: 0 })], ["a"])).toBeNull();
  });

  it("解散嵌套 group 时成员上提到祖父级且绝对位置不变", () => {
    const outer = node("g1", { x: 100, y: 100 }, { type: "group", width: 600, height: 600 });
    const inner = node("g2", { x: 50, y: 50 }, { type: "group", parentId: "g1", width: 300, height: 300 });
    const leaf = node("leaf", { x: 10, y: 10 }, { parentId: "g2" });
    const nodes = [outer, inner, leaf];
    expect(getWoohaa3CanvasNodeAbsolutePosition(leaf, byId(nodes))).toEqual({ x: 160, y: 160 });

    const result = ungroupWoohaa3CanvasNodes(nodes, ["g2"])!;
    const next = result.nodes.find((entry) => entry.id === "leaf")!;
    // 上提到 g1 下（而不是顶层），并把绝对位置烘焙成相对 g1 的局部坐标。
    expect(next.parentId).toBe("g1");
    expect(getWoohaa3CanvasNodeAbsolutePosition(next, byId(result.nodes))).toEqual({ x: 160, y: 160 });
  });

  it("解散顶层 group 时成员成为顶层且绝对位置不变", () => {
    const outer = node("g1", { x: 100, y: 100 }, { type: "group", width: 600, height: 600 });
    const inner = node("g2", { x: 50, y: 50 }, { type: "group", parentId: "g1", width: 300, height: 300 });
    const result = ungroupWoohaa3CanvasNodes([outer, inner], ["g1"])!;
    const nextInner = result.nodes.find((entry) => entry.id === "g2")!;
    expect(nextInner.parentId).toBeUndefined();
    expect(nextInner.position).toEqual({ x: 150, y: 150 });
  });
});

describe("reparentDraggedNodes", () => {
  const group = node("g", { x: 0, y: 0 }, { type: "group", width: 400, height: 300 });
  const stray = node("s", { x: 500, y: 500 });

  it("显式指定目标 group 时归入并把绝对位置保持", () => {
    const result = reparentDraggedNodes([group, stray], ["s"], "g");
    expect(result.reparented).toBe(true);
    const s = result.nodes.find((entry) => entry.id === "s")!;
    expect(s.parentId).toBe("g");
    // group 会自适应扩展以容纳新成员，绝对位置不跳变。
    expect(getWoohaa3CanvasNodeAbsolutePosition(s, byId(result.nodes))).toEqual({ x: 500, y: 500 });
  });

  it("无显式目标时按落点中心命中 group", () => {
    const inside = node("s", { x: 100, y: 100 });
    const result = reparentDraggedNodes([group, inside], ["s"]);
    expect(result.reparented).toBe(true);
    expect(result.nodes.find((entry) => entry.id === "s")!.parentId).toBe("g");
  });

  it("无命中且原本有 parentId 时解除父子并烘焙绝对坐标", () => {
    // 成员绝对中心落在 group 外（g 在 (0,0) 400x300，成员在 (500,500)）。
    const member = node("m", { x: 500, y: 500 }, { parentId: "g" });
    const result = reparentDraggedNodes([group, member], ["m"]);
    expect(result.reparented).toBe(true);
    const m = result.nodes.find((entry) => entry.id === "m")!;
    expect(m.parentId).toBeUndefined();
    expect(m.position).toEqual({ x: 500, y: 500 });
  });

  it("在自身 group 内拖动不脱离（命中当前父级保持不变）", () => {
    const member = node("m", { x: 20, y: 30 }, { parentId: "g" });
    const moved = { ...member, position: { x: 60, y: 70 } };
    const result = reparentDraggedNodes([group, moved], ["m"]);
    expect(result.reparented).toBe(false);
  });

  it("group 自身不参与 reparent", () => {
    const other = node("g2", { x: 800, y: 0 }, { type: "group" });
    const result = reparentDraggedNodes([group, other], ["g2"], "g");
    expect(result.reparented).toBe(false);
  });

  it("归入后 group 扩展到容纳越界成员", () => {
    const far = node("f", { x: 900, y: 900 });
    const result = reparentDraggedNodes([group, far], ["f"], "g");
    const g = result.nodes.find((entry) => entry.id === "g")!;
    expect(g.width).toBeGreaterThan(400);
    expect(g.height).toBeGreaterThan(300);
  });
});

describe("refitWoohaa3CanvasGroups", () => {
  it("成员外移时扩展容器并保持成员绝对位置", () => {
    const group = node("g", { x: 0, y: 0 }, { type: "group", width: 300, height: 300 });
    const member = node("m", { x: 500, y: 10 }, { parentId: "g" });
    const result = refitWoohaa3CanvasGroups([group, member], ["g"]);
    expect(result.changed).toBe(true);
    const g = result.nodes.find((entry) => entry.id === "g")!;
    expect(g.width).toBeGreaterThan(300);
    const m = result.nodes.find((entry) => entry.id === "m")!;
    expect(getWoohaa3CanvasNodeAbsolutePosition(m, byId(result.nodes))).toEqual({ x: 500, y: 10 });
  });

  it("无子节点或几何未变时不改动", () => {
    const group = node("g", { x: 0, y: 0 }, { type: "group" });
    expect(refitWoohaa3CanvasGroups([group], ["g"]).changed).toBe(false);
  });

  it("floors 保底尺寸不被成员收缩破坏", () => {
    const group = node("g", { x: 0, y: 0 }, { type: "group", width: 600, height: 600 });
    const member = node("m", { x: 10, y: 10 }, { parentId: "g" });
    const floors = new Map([["g", { x: 0, y: 0, width: 600, height: 600 }]]);
    const result = refitWoohaa3CanvasGroups([group, member], ["g"], floors);
    if (result.changed) {
      const g = result.nodes.find((entry) => entry.id === "g")!;
      expect(g.width).toBeGreaterThanOrEqual(600);
      expect(g.height).toBeGreaterThanOrEqual(600);
    }
  });
});

describe("getGroupRequiredMinSize", () => {
  it("按直接成员的包围盒给出最小尺寸", () => {
    const group = node("g", { x: 0, y: 0 }, { type: "group" });
    const a = node("a", { x: 0, y: 0 }, { parentId: "g" });
    const b = node("b", { x: 300, y: 200 }, { parentId: "g" });
    const min = getGroupRequiredMinSize([group, a, b], "g");
    expect(min.minWidth).toBeGreaterThanOrEqual(500);
    expect(min.minHeight).toBeGreaterThanOrEqual(300);
  });

  it("无子节点时回退到默认节点尺寸", () => {
    const group = node("g", { x: 0, y: 0 }, { type: "group" });
    const min = getGroupRequiredMinSize([group], "g");
    expect(min.minWidth).toBeGreaterThan(0);
    expect(min.minHeight).toBeGreaterThan(0);
  });
});

describe("findGroupContainingCenter", () => {
  it("中心落在 group 内时返回该 group", () => {
    const group = node("g", { x: 0, y: 0 }, { type: "group", width: 400, height: 400 });
    const n = node("n", { x: 100, y: 100 });
    expect(findGroupContainingCenter([group, n], "n")).toBe("g");
  });

  it("中心在 group 外时返回 null", () => {
    const group = node("g", { x: 0, y: 0 }, { type: "group", width: 100, height: 100 });
    const n = node("n", { x: 500, y: 500 });
    expect(findGroupContainingCenter([group, n], "n")).toBeNull();
  });

  it("group 自身不作为候选", () => {
    const group = node("g", { x: 0, y: 0 }, { type: "group", width: 400, height: 400 });
    expect(findGroupContainingCenter([group], "g")).toBeNull();
  });
});

describe("选择展开与分析", () => {
  it("expandWoohaa3CanvasSelectionWithGroupDescendants 递归含后代", () => {
    const outer = node("o", { x: 0, y: 0 }, { type: "group" });
    const inner = node("i", { x: 0, y: 0 }, { type: "group", parentId: "o" });
    const leaf = node("l", { x: 0, y: 0 }, { parentId: "i" });
    const other = node("x", { x: 0, y: 0 });
    const expanded = expandWoohaa3CanvasSelectionWithGroupDescendants([outer, inner, leaf, other], ["o"]);
    expect(expanded.map((entry) => entry.id).sort()).toEqual(["i", "l", "o"]);
  });

  it("expandSelectionWithGroups 只返回叶子（group 展开为非 group）", () => {
    const outer = node("o", { x: 0, y: 0 }, { type: "group" });
    const leaf = node("l", { x: 0, y: 0 }, { parentId: "o" });
    const top = node("t", { x: 0, y: 0 });
    const leaves = expandSelectionWithGroups([outer, top], [outer, leaf, top]);
    expect(leaves.map((entry) => entry.id).sort()).toEqual(["l", "t"]);
  });

  it("normalizeWoohaa3CanvasGroupSelection 完整选中成员时规范化为 group", () => {
    const group = node("g", { x: 0, y: 0 }, { type: "group" });
    const a = node("a", { x: 0, y: 0 }, { parentId: "g" });
    const b = node("b", { x: 0, y: 0 }, { parentId: "g" });
    const normalized = normalizeWoohaa3CanvasGroupSelection([group, a, b], ["a", "b"]);
    expect(normalized).toEqual(["g"]);
  });

  it("部分选中成员时移除 group、保留成员", () => {
    const group = node("g", { x: 0, y: 0 }, { type: "group" });
    const a = node("a", { x: 0, y: 0 }, { parentId: "g" });
    const b = node("b", { x: 0, y: 0 }, { parentId: "g" });
    const normalized = normalizeWoohaa3CanvasGroupSelection([group, a, b], ["a"]);
    expect(normalized).toEqual(["a"]);
  });

  it("captureWoohaa3CanvasGroupRects 只记录 group 的绝对矩形", () => {
    const group = node("g", { x: 10, y: 20 }, { type: "group", width: 300, height: 200 });
    const n = node("n", { x: 0, y: 0 });
    const rects = captureWoohaa3CanvasGroupRects([group, n]);
    expect([...rects.keys()]).toEqual(["g"]);
    expect(rects.get("g")).toEqual({ x: 10, y: 20, width: 300, height: 200 });
  });

  it("getWoohaa3CanvasSelectionBounds 用绝对坐标计算可见包围盒", () => {
    const group = node("g", { x: 100, y: 100 }, { type: "group" });
    // 显式尺寸在共享下限（180×64）之上时按原值读取。
    const child = node("c", { x: 20, y: 30 }, { parentId: "g", width: 200, height: 100 });
    const bounds = getWoohaa3CanvasSelectionBounds([child], [group, child])!;
    expect(bounds).toEqual({ x: 120, y: 130, width: 200, height: 100 });
  });

  it("getWoohaa3CanvasSelectionBounds 按共享下限放大过小的显式尺寸", () => {
    const group = node("g", { x: 100, y: 100 }, { type: "group" });
    // 50×50 低于 MIN_NODE_WIDTH/MIN_NODE_HEIGHT，读取时收敛到下限，与被渲染的卡片一致。
    const child = node("c", { x: 20, y: 30 }, { parentId: "g", width: 50, height: 50 });
    const bounds = getWoohaa3CanvasSelectionBounds([child], [group, child])!;
    expect(bounds).toEqual({ x: 120, y: 130, width: 180, height: 64 });
  });
});

describe("sanitizeWoohaa3CanvasParentIds", () => {
  it("悬空 parentId 被移除且坐标烘焙为绝对", () => {
    const orphan = node("o", { x: 15, y: 25 }, { parentId: "missing" });
    const result = sanitizeWoohaa3CanvasParentIds([orphan]);
    expect(result[0]!.parentId).toBeUndefined();
    expect(result[0]!.position).toEqual({ x: 15, y: 25 });
  });

  it("parent 存在时原样返回（无变化引用相等）", () => {
    const group = node("g", { x: 0, y: 0 }, { type: "group" });
    const child = node("c", { x: 1, y: 2 }, { parentId: "g" });
    const nodes = [group, child];
    expect(sanitizeWoohaa3CanvasParentIds(nodes)).toBe(nodes);
  });
});

describe("mergeDraggedNodePositions", () => {
  it("用最新拖拽坐标覆盖 store 节点", () => {
    const storeNode = node("n", { x: 0, y: 0 });
    const latest = node("n", { x: 50, y: 60 }, { width: 300, height: 150 });
    const merged = mergeDraggedNodePositions([storeNode], [latest], ["n"]);
    expect(merged[0]!.position).toEqual({ x: 50, y: 60 });
    expect(merged[0]!.width).toBe(300);
    expect(merged[0]!.height).toBe(150);
  });

  it("非拖拽节点保持原值", () => {
    const keep = node("k", { x: 5, y: 5 });
    const merged = mergeDraggedNodePositions([keep], [node("k", { x: 99, y: 99 })], ["other"]);
    expect(merged[0]!.position).toEqual({ x: 5, y: 5 });
  });
});


describe("group footer layout projection", () => {
  it("existing groups gain footer space without mutating members or stored dimensions", () => {
    const nodes = [node("g", {x: 0, y: 0}, {type: "group", width: 300, height: 180}),
      node("m", {x: 40, y: 40}, {parentId: "g"})];
    const before = structuredClone(nodes);
    expect(getGroupLayoutSizes(nodes).get("g")).toEqual({width: 300, height: 220});
    expect(getGroupRequiredMinSize(nodes, "g")).toEqual({minWidth: 280, minHeight: 220});
    expect(nodes).toEqual(before);
  });
  it("nested groups include their own footer and live member size overrides", () => {
    const nodes = [node("g", {x: 0, y: 0}, {type: "group", width: 300, height: 220}),
      node("inner", {x: 40, y: 40}, {type: "group", parentId: "g", width: 280, height: 200}),
      node("m", {x: 40, y: 40}, {parentId: "inner"})];
    const sizes = getGroupLayoutSizes(nodes, new Map([["m", {width: 400, height: 300}]]));
    expect(sizes.get("inner")).toEqual({width: 480, height: 420});
    expect(sizes.get("g")).toEqual({width: 560, height: 540});
  });
  it("manual enlargement stays intact; resize previews may shrink back to the protected minimum", () => {
    const nodes = [node("g", {x: 0, y: 0}, {type: "group", width: 900, height: 800}),
      node("m", {x: 40, y: 40}, {parentId: "g"})];
    expect(getGroupLayoutSizes(nodes).get("g")).toEqual({width: 900, height: 800});
    expect(getGroupLayoutSizes(nodes, new Map([["g", {width: 280, height: 220}]])).get("g"))
      .toEqual({width: 280, height: 220});
  });
  it("手工缩到成员边界后按存储尺寸渲染，不再被左右/上留白撑回", () => {
    // 成员右边界贴住组框右边、底部留出 80 页脚：历史上宽度会被 +40 撑回 440。
    const nodes = [node("g", {x: 0, y: 0}, {type: "group", width: 400, height: 400}),
      node("m", {x: 200, y: 220}, {parentId: "g"})];
    expect(getGroupLayoutSizes(nodes).get("g")).toEqual({width: 400, height: 400});
  });
});
