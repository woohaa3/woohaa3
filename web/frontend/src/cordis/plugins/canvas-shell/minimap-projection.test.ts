/**
 * 小地图投影与视口换算的纯回归（2026-10-26）。
 *
 * 不挂载 React、不读 DOM：覆盖节点可见性、有效尺寸、连线取舍、等比映射与视口框。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, nodeWorldRect, type ServerCanvas } from "@woohaa3/contracts";
import {
  fitMinimapTransform,
  minimapPoint,
  minimapPointToWorld,
  minimapRect,
  projectMinimap,
  viewportCenteredOn,
  viewportWorldRect
} from "./minimap-projection.js";

type NodeSpec = {
  id: string;
  type?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  parentId?: string;
};

function canvas(
  nodes: NodeSpec[],
  edges: Array<{ id: string; source: string; target: string }> = [],
  nodeData: Record<string, unknown> = {}
): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.type ?? "image",
        position: { x: node.x, y: node.y },
        ...(node.width !== undefined ? { width: node.width } : {}),
        ...(node.height !== undefined ? { height: node.height } : {}),
        ...(node.parentId !== undefined ? { parentId: node.parentId } : {})
      })),
      edges: edges.map((edge) => ({ ...edge, sourceHandle: null, targetHandle: null, data: {} }))
    },
    nodeData: nodeData as ServerCanvas["nodeData"]
  };
}

describe("projectMinimap", () => {
  it("投影可见节点的世界矩形、类型与名称，并保留两端可见的连线", () => {
    const projection = projectMinimap(canvas(
      [
        { id: "text", type: "text", x: 0, y: 0 },
        { id: "model", type: "model3d", x: 320, y: 40 },
        { id: "video", type: "video", x: 0, y: 300 }
      ],
      [
        { id: "edge-1", source: "text", target: "model" },
        { id: "edge-2", source: "text", target: "video" }
      ],
      { model: { title: "积木小屋" }, text: { prompt: "雨夜街道" } }
    ));
    expect(projection.nodes.map((node) => node.id)).toEqual(["text", "model", "video"]);
    expect(projection.nodes[0]).toMatchObject({
      kind: "text",
      model: false,
      group: false,
      title: "雨夜街道"
    });
    expect(projection.nodes[1]).toMatchObject({
      kind: "model",
      model: true,
      title: "积木小屋"
    });
    // 富内容节点使用有效渲染尺寸 248×232，而不是缺省 196×64。
    expect(projection.nodes[0]!.rect).toEqual({ x: 0, y: 0, width: 248, height: 232 });
    expect(projection.edges).toHaveLength(2);
    expect(projection.bounds).toEqual({ x: 0, y: 0, width: 568, height: 532 });
  });

  it("收起分组隐藏后代，分组自身用紧凑展示矩形", () => {
    const state = canvas(
      [
        { id: "group", type: "group", x: 100, y: 100, width: 520, height: 380 },
        { id: "a", type: "image", x: 20, y: 20, parentId: "group" },
        { id: "b", type: "image", x: 280, y: 20, parentId: "group" }
      ],
      [],
      { group: { groupCollapsed: true } }
    );
    const projection = projectMinimap(state);
    expect(projection.nodes.map((node) => node.id)).toEqual(["group"]);
    expect(projection.nodes[0]!.group).toBe(true);
    // 紧凑矩形 196×112，固定底边中点；组自身布局尺寸仍按成员派生。
    const byId = new Map(state.document.nodes.map((node) => [node.id, node]));
    const layout = nodeWorldRect(state.document.nodes[0]!, byId);
    const rect = projection.nodes[0]!.rect;
    expect(rect.width).toBe(196);
    expect(rect.height).toBe(112);
    expect(rect.y + rect.height).toBe(layout.y + layout.height);
    expect(rect.x + rect.width / 2).toBe(layout.x + layout.width / 2);
  });

  it("复合资产内部的受管节点不进入小地图，边随之省略", () => {
    const projection = projectMinimap(canvas(
      [
        { id: "film", type: "composite-asset", x: 0, y: 0 },
        { id: "object", type: "model3d", x: 30, y: 30, parentId: "film" },
        { id: "shot", type: "film-set-shot-preview", x: 60, y: 10, parentId: "film" },
        { id: "image", type: "image", x: 600, y: 0 }
      ],
      [
        { id: "inside", source: "object", target: "shot" },
        { id: "outside", source: "film", target: "image" }
      ]
    ));
    expect(projection.nodes.map((node) => node.id)).toEqual(["film", "image"]);
    expect(projection.edges.map((edge) => edge.id)).toEqual(["outside"]);
  });

  it("空画布返回空投影", () => {
    expect(projectMinimap(null)).toEqual({ nodes: [], edges: [], bounds: null });
    expect(projectMinimap(canvas([]))).toEqual({ nodes: [], edges: [], bounds: null });
  });
});

describe("小地图映射与视口换算", () => {
  it("等比容纳包围盒并居中留白", () => {
    const transform = fitMinimapTransform({ x: 0, y: 0, width: 100, height: 50 }, null, 216, 136, 8);
    expect(transform).toEqual({ scale: 2, offsetX: 8, offsetY: 18 });
    expect(minimapRect({ x: 0, y: 0, width: 100, height: 50 }, transform))
      .toEqual({ x: 8, y: 18, width: 200, height: 100 });
    expect(minimapPoint({ x: 50, y: 25 }, transform)).toEqual({ x: 108, y: 68 });
    expect(minimapPointToWorld({ x: 108, y: 68 }, transform)).toEqual({ x: 50, y: 25 });
  });

  it("空画布用视口范围兜底，视口框不贴边", () => {
    const viewportRect = viewportWorldRect({ x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 })!;
    const transform = fitMinimapTransform(null, viewportRect, 216, 136, 8);
    const viewport = minimapRect(viewportRect, transform);
    expect(viewport.x).toBeGreaterThan(0);
    expect(viewport.y).toBeGreaterThan(0);
    expect(viewport.x + viewport.width).toBeLessThan(216);
    expect(viewport.y + viewport.height).toBeLessThan(136);
  });

  it("视口世界矩形按缩放与平移反算", () => {
    expect(viewportWorldRect({ x: 100, y: 50, zoom: 0.5 }, { width: 800, height: 600 }))
      .toEqual({ x: -200, y: -100, width: 1600, height: 1200 });
    expect(viewportWorldRect(null, { width: 800, height: 600 })).toBeNull();
    expect(viewportWorldRect({ x: 0, y: 0, zoom: 1 }, { width: 0, height: 600 })).toBeNull();
  });

  it("把点击的世界点放到画布中心并保持缩放", () => {
    expect(viewportCenteredOn({ x: 100, y: 50 }, { x: 0, y: 0, zoom: 2 }, { width: 800, height: 600 }))
      .toEqual({ x: 200, y: 200, zoom: 2 });
  });
});
