import { applyCanvasCommands } from "../../../test-support/managed-shot-commands.js";
import { mediaTimelineLocalTime } from "./media-time.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";
/**
 * 片场对象动作与对象级编辑契约测试
 * （change: 2026-10-09-add-film-set-object-motion-and-editing，任务 2.1/2.2/2.3/2.4）。
 */
import { describe, expect, it } from "vitest";
import {
  appendFilmSetItems,
  decodeFilmSetContent,
  decodeFilmSetPartId,
  encodeFilmSetPartId,
  filmSetItemAdapterHash,
  createFilmSetItemMotion,
  requiredFilmSetDuration,
  type FilmSetContent,
  type FilmSetItem
} from "./film-set-content.js";
import {
  applyFilmSetItemTransform,
  deleteFilmSetItem
} from "./film-set-item-ops.js";
import { composeFilmSetScene } from "./film-set-composition.js";
import { createModelSnapshot, createFilmSetSnapshot, filmSetNodeDataFields } from "./animation-snapshot.js";

import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";

function modelItem(id: string, script = `scene.box({ id: "body" });`): FilmSetItem {
  const model = createModelSnapshot({ modelScript: script, modelScriptVersion: "woohaa-model-js-v2" });
  return {
    id,
    kind: "model",
    name: id,
    localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    model
  };
}

describe("片场 schema 4 静态对象", () => {
  it("在线解码拒绝旧版本，并保留 schema 4 的静态对象", () => {
    // 旧客户端严格拒绝非 schema 3；新客户端同样严格拒绝非 schema 4（场景单位语义）。
    for (const schemaVersion of [1, 2, 3]) expect(decodeFilmSetContent({ schemaVersion, items: [modelItem("a")] }).ok).toBe(false);
    const decoded = decodeFilmSetContent({ schemaVersion: 4, items: [modelItem("a")] });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.items[0]).toEqual(modelItem("a"));
  });
  it("对象动作和时间映射只能放在片段 binding，不能夹带在 items", () => {
    const item = modelItem("a");
    const motion = createFilmSetItemMotion({ item, motionScript: `motion.model.rotate("body", { speed: 1 });` });
    expect(decodeFilmSetContent({ schemaVersion: 4, items: [{ ...item, motion }] }).ok).toBe(false);
    expect(decodeFilmSetContent({ schemaVersion: 4, items: [{ ...item, playback: { startTime: 0, duration: 2, timeScale: 1, loop: false } }] }).ok).toBe(false);
    expect(motion.basedOnModelVersion.contentHash).toBe(filmSetItemAdapterHash(item));
  });
});

describe("统一播放头局部时间映射（任务 5.1）", () => {
  it("延迟/变速/钳制/循环", () => {
    expect(mediaTimelineLocalTime({ startTime: 2, duration: 3, timeScale: 1, loop: false }, 1)).toBeNull();
    expect(mediaTimelineLocalTime({ startTime: 2, duration: 3, timeScale: 2, loop: false }, 3)).toBe(2);
    expect(mediaTimelineLocalTime({ startTime: 0, duration: 3, timeScale: 1, loop: false }, 5)).toBe(3);
    expect(mediaTimelineLocalTime({ startTime: 0, duration: 3, timeScale: 1, loop: true }, 7)).toBeCloseTo(1);
  });

  it("非循环动作扩展片场时长", () => {
    const item = modelItem("a");
    const motion = createFilmSetItemMotion({ item, motionScript: `motion.model.rotate("body", { speed: 1 });` });
    const withMotion = { ...item, motion, playback: { startTime: 2, duration: 3, timeScale: 2, loop: false } };
    expect(requiredFilmSetDuration(0, [withMotion])).toBe(3.5);
    expect(requiredFilmSetDuration(10, [withMotion])).toBe(10);
  });
});

describe("对象级权威操作（任务 2.3）", () => {
  const content: FilmSetContent = { schemaVersion: 4, items: [modelItem("a"), modelItem("b")] };

  it("transform 只改目标对象，precondition 冲突拒绝", () => {
    const result = applyFilmSetItemTransform({ content, itemId: "a", localTransform: { offset: { x: 1, y: 0, z: 0 }, scale: 2, yaw: 0.5 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items[1]).toEqual(content.items[1]);
    const conflict = applyFilmSetItemTransform({
      content,
      itemId: "a",
      localTransform: { offset: { x: 9, y: 0, z: 0 }, scale: 1, yaw: 0 },
      expectedLocalTransform: { offset: { x: 5, y: 0, z: 0 }, scale: 1, yaw: 0 }
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.code).toBe("precondition");
  });

  it("delete 目标不存在拒绝，成功移除", () => {
    expect(deleteFilmSetItem({ content, itemId: "x" }).ok).toBe(false);
    const result = deleteFilmSetItem({ content, itemId: "a" });
    expect(result.ok && result.value.items.map((i) => i.id)).toEqual(["b"]);
  });

});

describe("对象/部件无碰撞身份（任务 2.4）", () => {
  it("长度前缀编码不碰撞", () => {
    expect(decodeFilmSetPartId(encodeFilmSetPartId("a", "b"))).toEqual({ itemId: "a", partId: "b" });
    // "a" + "1:b" vs "a1" + ":b" 不碰撞。
    expect(encodeFilmSetPartId("a", "b")).not.toBe(encodeFilmSetPartId("a1", ":b".slice(1)));
    expect(decodeFilmSetPartId(encodeFilmSetPartId("", "root"))).toEqual({ itemId: "", partId: "root" });
    expect(decodeFilmSetPartId("bad")).toBeNull();
  });
});

describe("组合入口覆盖内部模型与地面（任务 3.1）", () => {
  function shapeAt(ops: ReturnType<typeof composeFilmSetScene>["ops"], id: string) {
    const op = ops.find((candidate) => candidate.t !== "material" && candidate.id === id) as
      | (typeof ops)[number] & { parent: string | null; position: number[] }
      | undefined;
    if (!op || op.t === "material") throw new Error(`missing shape ${id}`);
    return op;
  }

  it("顶层源码为空仍包含导入模型；对象根编码", () => {
    const composition = composeFilmSetScene({
      models: [{ itemId: "a", localTransform: { offset: { x: 1, y: 0, z: 0 }, scale: 1, yaw: 0 }, ops: [{ t: "box", id: "body", parent: null, position: [0,0,0], rotation: [0,0,0], scale: [1,1,1], material: null, color: "#f00", size: [1,1,1] }] }],
      grounds: [{ itemId: "g", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 8, depth: 8 } }]
    });
    const ids = composition.ops.map((op) => (op.t === "material" ? null : op.id));
    expect(ids).toContain(encodeFilmSetPartId("a", ""));
    expect(ids).toContain(encodeFilmSetPartId("a", "body"));
    expect(ids).toContain(encodeFilmSetPartId("g", "surface"));
    expect(composition.itemRoots.a).toBe(encodeFilmSetPartId("a", ""));
    // 内部部件 parent 归属自身对象根，不串到另一个对象。
    expect(shapeAt(composition.ops, encodeFilmSetPartId("a", "body")).parent).toBe(encodeFilmSetPartId("a", ""));
  });

  it("源模型 placement 作为内层 group 应用一次", () => {
    const composition = composeFilmSetScene({
      models: [{
        itemId: "a",
        localTransform: { offset: { x: 2, y: 0, z: 0 }, scale: 2, yaw: 0 },
        ops: [{ t: "box", id: "body", parent: null, position: [0,0,0], rotation: [0,0,0], scale: [1,1,1], material: null, color: "#f00", size: [1,1,1] }],
        placement: { offset: { x: 5, y: 0, z: 0 }, scale: 1, yaw: 0 }
      }]
    });
    expect(shapeAt(composition.ops, encodeFilmSetPartId("a", "")).position[0]).toBe(2);
    expect(shapeAt(composition.ops, encodeFilmSetPartId("a", "\u0000placement")).position[0]).toBe(5);
    expect(shapeAt(composition.ops, encodeFilmSetPartId("a", "body")).parent).toBe(encodeFilmSetPartId("a", "\u0000placement"));
  });
});

describe("旧对象命令不再写入快照", () => {
  it("新增旧 owner 与 itemPatch 均拒绝且输入不变", () => {
    const base = createEmptyWoohaa3ServerCanvas("c1");
    const data = filmSetNodeDataFields(createFilmSetSnapshot({ title: "片场", timeline: { duration: 0, loop: false }, filmSetContent: { schemaVersion: 4, items: [modelItem("a")] } }));
    expect(applyCanvasCommands(base, [{ type: "node.add", node: { id: "anim", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 0, y: 0 } }, nodeData: data as never }]).ok).toBe(false);
    base.document.nodes.push({ id: "anim", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 0, y: 0 } });
    base.nodeData.anim = data as never;
    const before = structuredClone(base);
    expect(applyCanvasCommands(base, [{ type: "filmSet.itemPatch", nodeId: "anim", itemId: "a", op: { kind: "delete" } } as never]).ok).toBe(false);
    expect(base).toEqual(before);
  });
});

describe("复制追加保留对象动作（任务 2.2）", () => {
  it("append 不改动已有内容", () => {
    const existing = explicitGroundContent();
    const appended = appendFilmSetItems(existing, [modelItem("new")]);
    expect(appended.items[0]).toEqual(existing.items[0]);
  });

});

function explicitGroundContent(): import("@woohaa3/contracts").FilmSetContent {
  return { schemaVersion: 4, items: [{ id: "ground", kind: "ground", name: "地面", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 8, depth: 8 } }] };
}
