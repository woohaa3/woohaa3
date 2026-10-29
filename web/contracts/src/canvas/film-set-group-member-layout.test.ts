import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3CanvasDocument } from "./domain/core/document-schema.js";
import { groupBottomPadding, groupPadding } from "./domain/core/group-geometry.js";
import { createFilmSetGroupMarker } from "./film-set-group.js";
import {
  ensureFilmSetGroupMemberLayout,
  FILM_SET_MEMBER_GAP,
  planFilmSetMemberGrid
} from "./film-set-group-member-layout.js";
import type { ServerCanvas, Woohaa3CanvasSerializedNode } from "./domain/index.js";

function canvas(): ServerCanvas {
  return {
    id: "canvas",
    title: "测试",
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    document: createEmptyWoohaa3CanvasDocument(),
    nodeData: {},
    assets: [],
    jobs: []
  };
}

const member = (id: string, position: { x: number; y: number }, width = 260, height = 195): Woohaa3CanvasSerializedNode =>
  ({ id, type: "model3d", parentId: "film", position, width, height });

function filmSet(members: Woohaa3CanvasSerializedNode[], options: { migrated?: boolean; group?: Partial<Woohaa3CanvasSerializedNode> } = {}): ServerCanvas {
  const value = canvas();
  value.document.nodes.push({
    id: "film",
    type: "group",
    position: { x: 0, y: 0 },
    width: 260,
    height: 195,
    ...options.group
  }, ...members);
  value.nodeData.film = {
    filmSetGroup: createFilmSetGroupMarker({
      sceneBindings: [],
      ...(options.migrated === false ? {} : { migration: { version: 1, commandId: "migration", sourceNodeId: "legacy" } })
    })
  };
  return value;
}

describe("planFilmSetMemberGrid", () => {
  it("按文档顺序把成员铺成网格，气泡尺寸按成员最大可见尺寸计算", () => {
    const value = filmSet([member("a", { x: -1060, y: -917 }), member("b", { x: 0, y: 0 }), member("c", { x: 0, y: 0 })]);
    const plan = planFilmSetMemberGrid({ nodes: value.document.nodes, groupId: "film" });
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.positions.get("a")).toEqual({ x: groupPadding, y: groupPadding });
    expect(plan.positions.get("b")).toEqual({ x: groupPadding + 260 + FILM_SET_MEMBER_GAP, y: groupPadding });
    expect(plan.positions.get("c")).toEqual({ x: groupPadding + (260 + FILM_SET_MEMBER_GAP) * 2, y: groupPadding });
    expect(plan.width).toBe(3 * 260 + 2 * FILM_SET_MEMBER_GAP + groupPadding * 2);
    expect(plan.height).toBe(195 + groupPadding + groupBottomPadding);
  });

  it("成员多于四列时换行", () => {
    const members = Array.from({ length: 16 }, (_, index) => member(`m${index}`, { x: 0, y: 0 }));
    const plan = planFilmSetMemberGrid({ nodes: filmSet(members).document.nodes, groupId: "film" });
    expect(plan).not.toBeNull();
    if (!plan) return;
    // 第 5 个成员落到第二行第一列。
    expect(plan.positions.get("m4")).toEqual({ x: groupPadding, y: groupPadding + 195 + FILM_SET_MEMBER_GAP });
    expect(plan.width).toBe(4 * 260 + 3 * FILM_SET_MEMBER_GAP + groupPadding * 2);
    expect(plan.height).toBe(4 * 195 + 3 * FILM_SET_MEMBER_GAP + groupPadding + groupBottomPadding);
  });

  it("紧凑旧卡片按可见尺寸占位，不会叠在一起", () => {
    const plan = planFilmSetMemberGrid({ nodes: filmSet([member("a", { x: 0, y: 0 }, 180, 64), member("b", { x: 0, y: 0 }, 180, 64)]).document.nodes, groupId: "film" });
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.positions.get("b")).toEqual({ x: groupPadding + 248 + FILM_SET_MEMBER_GAP, y: groupPadding });
    expect(plan.height).toBe(232 + groupPadding + groupBottomPadding);
  });

  it("没有成员时不产出布局", () => {
    expect(planFilmSetMemberGrid({ nodes: filmSet([]).document.nodes, groupId: "film" })).toBeNull();
  });
});

describe("ensureFilmSetGroupMemberLayout", () => {
  it("迁移出来的片场把散在气泡外的成员重排进网格，并让气泡包住它们", () => {
    const value = filmSet([member("a", { x: 224, y: 32 }), member("b", { x: -1060, y: -917 }), member("c", { x: -1670, y: -1442 })]);
    const result = ensureFilmSetGroupMemberLayout(value);
    expect(result.changed).toEqual(["film"]);
    const group = result.canvas.document.nodes.find((node) => node.id === "film");
    const plan = planFilmSetMemberGrid({ nodes: result.canvas.document.nodes, groupId: "film" });
    expect(group).toMatchObject({ position: { x: 0, y: 0 }, width: plan?.width, height: plan?.height });
    for (const id of ["a", "b", "c"]) {
      const node = result.canvas.document.nodes.find((entry) => entry.id === id);
      expect(node?.position).toEqual(plan?.positions.get(id));
      // 重排后成员全部落在气泡内（含徽标页脚之外的可见区域）。
      expect(node!.position.x).toBeGreaterThanOrEqual(groupPadding);
      expect(node!.position.y).toBeGreaterThanOrEqual(groupPadding);
    }
  });

  it("幂等：重排后再跑一次不产生改动", () => {
    const first = ensureFilmSetGroupMemberLayout(filmSet([member("a", { x: -1060, y: -917 })]));
    expect(first.changed).toEqual(["film"]);
    const second = ensureFilmSetGroupMemberLayout(first.canvas);
    expect(second.changed).toEqual([]);
    expect(second.canvas).toBe(first.canvas);
  });

  it("成员本来就在气泡里时不动", () => {
    const value = filmSet([member("a", { x: 40, y: 40 })], { group: { width: 1000, height: 900 } });
    expect(ensureFilmSetGroupMemberLayout(value).changed).toEqual([]);
  });

  it("手搭的片场 group（没有迁移标记）完全不动", () => {
    const value = filmSet([member("a", { x: -1060, y: -917 })], { migrated: false });
    expect(ensureFilmSetGroupMemberLayout(value).changed).toEqual([]);
  });

  it("普通 group 与片场之外的节点不受影响", () => {
    const value = canvas();
    value.document.nodes.push(
      { id: "plain", type: "group", position: { x: 0, y: 0 }, width: 200, height: 200 },
      { id: "child", type: "model3d", parentId: "plain", position: { x: -900, y: -900 }, width: 260, height: 195 }
    );
    expect(ensureFilmSetGroupMemberLayout(value).changed).toEqual([]);
  });
});
