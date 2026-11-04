import { describe, expect, it } from "vitest";
import type { ServerCanvas } from "./domain/types.js";
import { SHARED_WORLD_VERSION } from "./shared-world.js";
import {
  canvasGroupAcceptsMember,
  canvasGroupMembers,
  projectCanvasGroup,
  validateCanvasGroupChange
} from "./group-authoring-scope.js";

function canvas(overrides: Partial<ServerCanvas> = {}): ServerCanvas {
  const base: ServerCanvas = {
    id: "c1",
    title: "画布",
    revision: 1,
    document: {
      schemaVersion: "asset-canvas-v1",
      updatedAt: "2026-11-03T00:00:00.000Z",
      nodes: [
        { id: "group", type: "workflow-group-2d", position: { x: 0, y: 0 }, width: 260, height: 195 },
        { id: "a", type: "text", position: { x: 20, y: 20 }, width: 200, height: 120 },
        { id: "b", type: "image", position: { x: 240, y: 20 }, width: 200, height: 120 },
        { id: "outside", type: "text", position: { x: 800, y: 800 }, width: 200, height: 120 },
        { id: "area", type: "scene-area", position: { x: 900, y: 0 }, width: 200, height: 120 }
      ],
      edges: [
        { id: "e-ab", source: "a", target: "b", data: {} },
        { id: "e-ao", source: "a", target: "outside", data: {} }
      ]
    },
    nodeData: {
      group: { title: "组", workflowGroup2d: { kind: "workflow-group-2d", version: SHARED_WORLD_VERSION, groupId: "g1", scopeVersion: "v1", memberNodeIds: ["a", "b", "area", "missing"] } },
      a: { prompt: "a" },
      b: { prompt: "b" },
      outside: { prompt: "outside" },
      area: { sceneArea: { kind: "scene-area", version: SHARED_WORLD_VERSION, areaId: "a1", scopeVersion: "v1", bounds: { min: { u: 0, v: 0 }, max: { u: 1, v: 1 } } } }
    },
    assets: [],
    jobs: [],
    updatedAt: "2026-11-03T00:00:00.000Z"
  };
  return { ...base, ...overrides };
}

describe("2D 组作用域纯规则", () => {
  it("成员只来自 memberNodeIds，忽略悬空引用与不可收录对象", () => {
    const members = canvasGroupMembers(canvas(), "group");
    expect([...members].sort()).toEqual(["a", "b", "group"]);
    expect(canvasGroupAcceptsMember(canvas(), "area")).toBe(false);
    expect(canvasGroupAcceptsMember(canvas(), "outside")).toBe(true);
  });

  it("组投影只保留根组与成员，并裁掉跨组连线", () => {
    const projected = projectCanvasGroup(canvas(), "group");
    expect(projected.document.nodes.map((node) => node.id).sort()).toEqual(["a", "b", "group"]);
    expect(projected.document.edges.map((edge) => edge.id)).toEqual(["e-ab"]);
    expect(projected.document.nodes.find((node) => node.id === "group")?.parentId).toBeUndefined();
  });

  it("允许改组自身尺寸与成员位置，拒绝组外改动", () => {
    const before = canvas();
    const allowed = structuredClone(before);
    allowed.document.nodes.find((node) => node.id === "group")!.width = 400;
    allowed.document.nodes.find((node) => node.id === "a")!.position = { x: 40, y: 40 };
    expect(validateCanvasGroupChange(before, allowed, "group")).toBeNull();

    const outsideChanged = structuredClone(before);
    outsideChanged.document.nodes.find((node) => node.id === "outside")!.position = { x: 0, y: 0 };
    expect(validateCanvasGroupChange(before, outsideChanged, "group")).toMatch(/组外节点/);
  });

  it("新建节点必须同时进入成员表", () => {
    const before = canvas();
    const after = structuredClone(before);
    after.document.nodes.push({ id: "new", type: "text", position: { x: 500, y: 40 }, width: 200, height: 120 });
    after.nodeData.new = { prompt: "new" };
    expect(validateCanvasGroupChange(before, after, "group")).toMatch(/新节点 new 必须在 2D 组内/);
    (after.nodeData.group as { workflowGroup2d: { memberNodeIds: string[] } }).workflowGroup2d.memberNodeIds.push("new");
    expect(validateCanvasGroupChange(before, after, "group")).toBeNull();
  });
});
