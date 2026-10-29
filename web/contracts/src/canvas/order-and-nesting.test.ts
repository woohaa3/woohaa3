import { COMPOSITE_ASSET_SCOPE_AXIS_Y } from "./render-scene/composite-asset-scope.js";
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { normalizeCanvas } from "./domain/normalization.js";
import type { ServerCanvas } from "./domain/types.js";
import {
  sanitizeSerializedParentIds,
  sanitizeWoohaa3CanvasParentIds,
} from "./domain/core/group-parenting.js";
import type { Woohaa3CanvasNode } from "./domain/core/canvas-runtime.js";
import { buildCanvasRenderScene } from "./render-scene.js";
import { canvasGroundAnchor, compareCanvasGroundOrder } from "./ground-anchor.js";

/**
 * 地面锚点 2D 顺序回归（change: 2026-10-27-order-canvas-layers-by-ground-anchor，任务 1.3）
 * 与嵌套组拆分回归（任务 5.3）。
 */
function scene(
  nodes: ServerCanvas["document"]["nodes"],
  nodeData: ServerCanvas["nodeData"] = {},
) {
  const canvas = createEmptyWoohaa3ServerCanvas("order", "2026-10-27T00:00:00Z");
  canvas.document.nodes = nodes;
  canvas.nodeData = nodeData;
  return {
    canvas,
    ids: buildCanvasRenderScene({ canvas }).nodes.map((node) => node.id),
  };
}

const group = (id: string, y: number, height = 300) =>
  ({ id, type: "group", position: { x: 0, y }, width: 400, height }) as const;
const text = (id: string, y: number, parentId?: string) =>
  ({
    id,
    type: "text",
    ...(parentId ? { parentId } : {}),
    position: { x: 10, y },
  }) as const;
const filmSet = (id: string, y: number, parentId?: string, height = 200) =>
  ({
    id,
    type: "composite-asset",
    ...(parentId ? { parentId } : {}),
    position: { x: 0, y },
    width: 260,
    height,
  }) as const;

describe("canvas ground anchor", () => {
  it("uses the absolute rect bottom edge and id tie-break only", () => {
    expect(canvasGroundAnchor({ y: 120, height: 80 })).toBe(200);
    expect(
      compareCanvasGroundOrder(
        { id: "b", anchor: 200 },
        { id: "a", anchor: 200 },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareCanvasGroundOrder(
        { id: "a", anchor: 100 },
        { id: "z", anchor: 200 },
      ),
    ).toBeLessThan(0);
  });

  it("uses the visible ground diamond bottom for composite assets, not the content rect", () => {
    // 地面菱形外包框半高使用当前相机 pitch 的投影轴。
    expect(
      canvasGroundAnchor({
        y: 0,
        height: 300,
        compositeAsset: { scopeGround: { cx: 0, cy: 250, hx: 100, hz: 100 } },
      }),
    ).toBeCloseTo(250 + COMPOSITE_ASSET_SCOPE_AXIS_Y * 200, 5);
    // rect 形状（无 scopeGround）仍用矩形底边。
    expect(
      canvasGroundAnchor({ y: 0, height: 300, compositeAsset: {} }),
    ).toBe(300);
  });
});

describe("2D container emission order", () => {
  it("does not depend on document order or the moment the group was created", () => {
    const grouped = scene([
      group("g", 100),
      text("member", 40, "g"),
      text("free", 600),
    ]);
    const createdEarlier = scene([
      text("member", 40, "g"),
      text("free", 600),
      group("g", 100),
    ]);
    expect(grouped.ids).toEqual(["free", "g", "member"]);
    expect(createdEarlier.ids).toEqual(grouped.ids);
  });

  it("keeps ungrouped nodes in document order below every container", () => {
    // free2 的底边远大于组 g，但它没有 parentId 且不是容器，仍在最下层并按文档顺序。
    const { ids } = scene([
      text("free2", 1000),
      group("g", 0, 100),
      text("free1", 0),
      text("member", 10, "g"),
    ]);
    expect(ids).toEqual(["free2", "free1", "g", "member"]);
  });

  it("orders same-anchor containers by ascending node id", () => {
    const { ids } = scene([
      group("g2", 0),
      group("g1", 0),
      text("m2", 10, "g2"),
      text("m1", 10, "g1"),
    ]);
    expect(ids.filter((id) => id.startsWith("g"))).toEqual(["g1", "g2"]);
  });

  it("counts a top-level film set as a container but a film set in a group as a member", () => {
    const { ids } = scene([
      filmSet("set", 0, undefined, 200),
      group("g", 100),
      // 组内片场的绝对底边远大于组，但仍按成员跟随组，不重新进入容器排序。
      filmSet("innerSet", 10, "g", 2000),
      text("member", 40, "g"),
    ]);
    expect(ids).toEqual(["set", "g", "innerSet", "member"]);
  });

  it("orders film sets by visible ground bottom, not by the content fit rect", () => {
    // 用户画布里的重叠对：导演场矩形底边 3227.25、地面底角约 3070.25；
    // 小复合资产矩形底边 3110.75、地面底角约 3078.25。按矩形大场在前，按地面小场在前。
    const { ids } = scene([
      {
        id: "stage",
        type: "composite-asset",
        position: { x: -1479, y: 2286.25 },
        width: 1254,
        height: 941,
      },
      {
        id: "prop",
        type: "composite-asset",
        position: { x: -739, y: 2915.75 },
        width: 260,
        height: 195,
      },
    ]);
    expect(2286.25 + 941).toBeGreaterThan(2915.75 + 195);
    expect(ids).toEqual(["prop", "stage"]);
  });

  it("keeps the container order stable when a group is collapsed", () => {
    const nodes = [
      group("a", 0),
      text("ma", 40, "a"),
      group("b", 100, 300),
      text("mb", 40, "b"),
    ];
    const expanded = scene(nodes);
    const collapsed = scene(nodes, { a: { groupCollapsed: true } });
    const containers = (ids: string[]) => ids.filter((id) => id === "a" || id === "b");
    expect(containers(expanded.ids)).toEqual(["a", "b"]);
    expect(containers(collapsed.ids)).toEqual(["a", "b"]);
    expect(collapsed.ids).not.toContain("ma");
    expect(expanded.ids.indexOf("a")).toBeLessThan(expanded.ids.indexOf("ma"));
  });
});

describe("nested group normalization", () => {
  type NestedNode = {
    id: string;
    type: string;
    parentId?: string;
    position: { x: number; y: number };
    width: number;
    height: number;
  };
  function nestedNodes(): NestedNode[] {
    return [
      { id: "outer", type: "group", position: { x: 100, y: 200 }, width: 500, height: 400 },
      { id: "mid", type: "group", parentId: "outer", position: { x: 40, y: 50 }, width: 300, height: 250 },
      { id: "leaf", type: "text", parentId: "mid", position: { x: 10, y: 20 }, width: 200, height: 100 },
    ];
  }

  it("splits historical nested groups with absolute positions, members and nodeData intact", () => {
    const nodes = nestedNodes();
    const split = sanitizeSerializedParentIds(nodes);
    const mid = split.find((node) => node.id === "mid")!;
    const leaf = split.find((node) => node.id === "leaf")!;
    expect(mid.parentId).toBeUndefined();
    expect(mid.position).toEqual({ x: 140, y: 250 });
    expect(leaf.parentId).toBe("mid");
    expect(leaf.position).toEqual({ x: 10, y: 20 });
    // 拆分不改变任何节点的绝对位置。
    const absolute = (id: string) => {
      const node = split.find((entry) => entry.id === id)!;
      const parent = node.parentId
        ? split.find((entry) => entry.id === node.parentId)
        : undefined;
      return { x: node.position.x + (parent?.position.x ?? 0), y: node.position.y + (parent?.position.y ?? 0) };
    };
    expect(absolute("mid")).toEqual({ x: 140, y: 250 });
    expect(absolute("leaf")).toEqual({ x: 150, y: 270 });
    // 幂等：再跑一遍返回同一引用，不产生新变化。
    expect(sanitizeSerializedParentIds(split)).toBe(split);
  });

  it("applies the same split on the runtime node read path", () => {
    const runtime = nestedNodes() as unknown as Woohaa3CanvasNode[];
    const split = sanitizeWoohaa3CanvasParentIds(runtime);
    expect(split.find((node) => node.id === "mid")).toMatchObject({
      parentId: undefined,
      position: { x: 140, y: 250 },
    });
    expect(split.find((node) => node.id === "leaf")!.parentId).toBe("mid");
    expect(sanitizeWoohaa3CanvasParentIds(split)).toBe(split);
  });

  it("normalizes a loaded canvas without moving the promoted group or its members", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("nested", "2026-10-27T00:00:00Z");
    canvas.document.nodes = nestedNodes();
    canvas.nodeData = { mid: { title: "历史组" } };
    const normalized = normalizeCanvas(canvas);
    const mid = normalized.document.nodes.find((node) => node.id === "mid")!;
    expect(mid.parentId).toBeUndefined();
    expect(mid.position).toEqual({ x: 140, y: 250 });
    expect(normalized.nodeData.mid).toEqual({ title: "历史组" });
    expect(
      normalized.document.nodes.find((node) => node.id === "leaf")!.parentId,
    ).toBe("mid");
    expect(normalizeCanvas(normalized).document.nodes).toEqual(normalized.document.nodes);
  });
});
